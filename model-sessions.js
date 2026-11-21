'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const { execFile } = require('node:child_process');
const net = require('node:net');
const { getGpuStatus } = require('./gpu');

const MODEL = 'qwen3.8-flash-next-iq2_xs';
const MODEL_IQ3 = 'qwen3.8-flash-next-iq3_xxs';
const QUANT_STATE_FILE = path.join(__dirname, 'data', 'strata-quant.json');
const QUANT_SETUP_PID_FILE = path.join(__dirname, 'data', 'strata-iq3xxs-setup.pid');
const MAYA_ROOT = 'C:\\Apps\\ProjectMaya';
const MAYA_MODELS = 'D:\\Maya-data\\models';
const DEEPSEEK_CONFIG = path.join(MAYA_ROOT, 'maya-ds4.json');
const DEEPSEEK_MODEL_DIR = 'D:\\ProjectMaya\\Models\\DeepSeek-V4.1-Flash-1017-GGUF';
const MAYA_DATA = path.join(__dirname, 'data');
const MAYA_VISION_DIR = path.join(MAYA_MODELS, 'Maya-XS-IQ1_S', 'vision');
const MAYA_VISION_FILES = [
  ['mmproj-GLM-5.3-Flash-F16.gguf', '3627575df16bd152db0f3fd7e488d270b33f3a9e6c7fa3b1b8ac381faafde882'],
  ['GLM-5.3-Flash-vocab.gguf', '8f53cb1bd2e631c14ef413e3284735d9e53f3c508d07a6f609e705b487105912']
];
const MAYA_QUANT = 'Maya-XS-IQ1_S';
const MAYA_MODEL = 'glm-5.3-flash';
const MAYA_CONTEXT = 131072;
const MAYA_FILES = [
  ['GLM-5.3-Flash-Maya-XS-IQ1_S-00001-of-00002.gguf', '711b427e55fa6da1cbe28933eb00174424f6201f0210b5e4a216d5e33b6222c7'],
  ['GLM-5.3-Flash-Maya-XS-IQ1_S-00002-of-00002.gguf', 'a9841bc37abef5e3e5bc84e49e753b67f7e249098e8e9bc3dd17415104112885']
];
const VARIANTS = {
  strata128k: { name: 'Qwen3.8-Flash-Next / Strata 128K (Vision なし)', startScript: 'Start-Strata-Managed.ps1', stopScript: 'Stop-Strata-Managed.ps1', port: 18082, inferenceModel: MODEL, contextWindow: 131072, vision: false },
  strata128kvision: { name: 'Qwen3.8-Flash-Next / Strata 128K (Vision あり)', startScript: 'Start-Strata-Vision-Managed.ps1', stopScript: 'Stop-Strata-Managed.ps1', port: 18082, inferenceModel: MODEL, contextWindow: 131072, vision: true },
  qwen38: { name: 'Qwen3.8-27B', startScript: 'Start-Qwen38-SGLang.ps1', stopScript: 'Stop-Qwen38-SGLang.ps1', port: 30000, inferenceModel: 'qwen3.8-27b', contextWindow: 65536, vision: false },
  qwen3coder: { name: 'Qwen3-Coder-30B', startScript: 'Start-Qwen3Coder-SGLang.ps1', stopScript: 'Stop-Qwen3Coder-SGLang.ps1', port: 30001, inferenceModel: 'qwen3-coder-30b', contextWindow: 65536, vision: false },
  glm53flash: { name: 'GLM-5.3-Flash / Project Maya Maya-XS 128K (Vision なし)', api: 'maya', startScript: 'Start-Maya-Managed.ps1', stopScript: 'Stop-Maya-Managed.ps1', port: 8080, inferenceModel: MAYA_MODEL, contextWindow: MAYA_CONTEXT, vision: false, minFreeMiB: 24576, startupTries: 600 },
  glm53flashvision: { name: 'GLM-5.3-Flash / Project Maya Maya-XS 128K (Vision あり)', api: 'maya', startScript: 'Start-Maya-Managed.ps1', stopScript: 'Stop-Maya-Managed.ps1', port: 8080, inferenceModel: MAYA_MODEL, contextWindow: MAYA_CONTEXT, vision: true, minFreeMiB: 24576, startupTries: 600 },
  deepseekflashvision: { name: 'DeepSeek-V4.1-Flash / Project Maya Maya-XS 64K (Vision あり)', api: 'maya', startScript: 'Start-DeepSeek-Managed.ps1', stopScript: 'Stop-DeepSeek-Managed.ps1', port: 8080, inferenceModel: 'deepseek-v4.1-flash', contextWindow: 65536, vision: true, minFreeMiB: 24576, startupTries: 600 },
  // Judge-only model served by Flide in WSL.  Whisper and the reranker stay loaded
  // next to it (fp8 weights, ~18 GB), so the session never pauses them.
  onejev9b: { name: 'OneJev 9B', startScript: 'Start-OneJev-Flide.ps1', stopScript: 'Stop-OneJev-Flide.ps1', port: 8083, inferenceModel: 'onejev1.6-9b', contextWindow: 16384, vision: false,
    api: 'systemone', inferencePort: 8082, pauseAux: false, minFreeMiB: 20000, startupTries: 90 }
};
const apiOf = (variant) => variant.api || 'openai';
const inferencePortOf = (variant) => variant.inferencePort || 8082;
const pausesAux = (variant) => variant.pauseAux !== false;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fault = (status, code, message) => Object.assign(new Error(message), { status, code });

function script(file, quant, extraArgs = []) {
  return new Promise((resolve, reject) => execFile('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, ...(quant ? ['-Quant', quant] : []), ...extraArgs.filter(Boolean)],
    { windowsHide: true, timeout: 45000 }, (error, stdout, stderr) =>
      error ? reject(new Error(String(stderr || stdout || error.message).trim())) : resolve()));
}

function createModelSessions({ stateFile, scriptsDir, gpuServices, sglangServices, presence, sleepGuard, policyReady,
  readStrataStatus, readSglangStatus, isStrataPortOpen, runScript = script, readGpuStatus = getGpuStatus,
  checkOllamaGpu = async () => {}, log = () => {}, startQuantSetupRunner = async () => {},
  startMayaSetupRunner = async () => { throw new Error('Project Maya setup runner is unavailable'); },
  startMayaVisionSetupRunner = async () => { throw new Error('Project Maya Vision setup runner is unavailable'); } }) {
  let current = null;
  let timer = null;
  let serial = Promise.resolve();
  let strataQuant = 'IQ2_XS';
  let quantSetup = { state: 'idle', output: '', error: null, started_at: null };
  let mayaSetup = { state: 'idle', output: '', error: null, started_at: null };
  let mayaVisionSetup = { state: 'idle', output: '', error: null, started_at: null };
  try { mayaVisionSetup = { ...mayaVisionSetup, ...JSON.parse(fs.readFileSync(path.join(MAYA_DATA, 'maya-vision-setup-state.json'), 'utf8')) }; } catch { /* first use */ }
  try {
    const saved = JSON.parse(fs.readFileSync(QUANT_STATE_FILE, 'utf8'));
    if (['IQ2_XS', 'IQ3_XXS'].includes(saved.quant)) strataQuant = saved.quant;
  } catch { /* default quant */ }
  function setStrataQuant(value) {
    if (!['IQ2_XS', 'IQ3_XXS'].includes(value)) throw fault(400, 'bad_request', 'Unsupported Strata quantization');
    if (current && current.state !== 'idle') throw fault(409, 'session_conflict', 'Release the active model session before changing Strata quantization');
    if (value === 'IQ3_XXS' && !quantSettings().prepared) throw fault(409, 'quant_not_prepared', 'IQ3_XXS setup has not completed');
    strataQuant = value;
    fs.mkdirSync(path.dirname(QUANT_STATE_FILE), { recursive: true });
    fs.writeFileSync(QUANT_STATE_FILE, JSON.stringify({ quant: value, updated_at: new Date().toISOString() }, null, 2));
    return quantSettings();
  }
  function quantSettings() {
    const modelsDir = path.join('D:\\Strata-data', 'models', 'IQ3_XXS');
    const firstPart = path.join(modelsDir, 'Qwen3.8-Flash-Next-GSQ-RCO-IQ3_XXS-00001-of-00002.gguf.part');
    const firstShard = path.join(modelsDir, 'Qwen3.8-Flash-Next-GSQ-RCO-IQ3_XXS-00001-of-00002.gguf');
    const secondPart = path.join(modelsDir, 'Qwen3.8-Flash-Next-GSQ-RCO-IQ3_XXS-00002-of-00002.gguf.part');
    const secondShard = path.join(modelsDir, 'Qwen3.8-Flash-Next-GSQ-RCO-IQ3_XXS-00002-of-00002.gguf');
    const prepared = fs.existsSync(path.join('D:\\Strata-data', 'packs', 'iq3_xxs', 'tokenizer')) &&
      fs.existsSync(firstShard) && fs.existsSync(secondShard) &&
      fs.existsSync(path.join('C:\\Apps\\Strata', 'strata-iq3_xxs.json')) &&
      fs.existsSync(path.join('C:\\Apps\\Strata', 'strata-iq3_xxs-vision-128k.json'));
    let setup = quantSetup;
    if (setup.state === 'idle') {
      try {
        const pid = Number(fs.readFileSync(QUANT_SETUP_PID_FILE, 'utf8'));
        process.kill(pid, 0);
        setup = { ...setup, state: 'running', output: 'IQ3_XXS model and Strata pack setup is running' };
      } catch { /* no active external setup */ }
    }
    if (setup.state === 'idle' && (fs.existsSync(firstPart) || fs.existsSync(secondPart))) {
      const shard = fs.existsSync(firstPart) ? firstPart : secondPart;
      const size = fs.statSync(shard).size;
      const target = shard === firstPart ? 47.04 : 28.76;
      setup = { ...setup, state: 'running', output: `Downloading shard ${shard === firstPart ? 1 : 2}: ${(size / 1e9).toFixed(2)} / ${target} GB` };
    }
    return { selected: strataQuant, prepared, setup,
      choices: ['IQ2_XS', 'IQ3_XXS'] };
  }
  function mayaSettings() {
    const modelDir = path.join(MAYA_MODELS, MAYA_QUANT);
    const files = MAYA_FILES.map(([name]) => path.join(modelDir, name));
    const downloadedBytes = files.reduce((total, file) => total + (fs.existsSync(file) ? fs.statSync(file).size : 0), 0);
    let verified = false;
    try {
      const marker = JSON.parse(fs.readFileSync(path.join(modelDir, '.opm-verified.json'), 'utf8'));
      verified = marker.revision === '6728cf78a5b198a6a6f84b7fb88956a17ec56521' &&
        MAYA_FILES.every(([name, sha256]) => marker.files?.[name] === sha256 && fs.existsSync(path.join(modelDir, name)));
    } catch { /* model download has not been verified yet */ }
    const modelDownloaded = verified;
    const config = path.join(MAYA_ROOT, 'maya-maya-xs-iq1_s.json');
    const basePrepared = modelDownloaded && fs.existsSync(config) && fs.existsSync(path.join(MAYA_ROOT, '.venv', 'Scripts', 'python.exe')) &&
      fs.existsSync(path.join(MAYA_ROOT, 'build', 'maya.exe'));
    const visionConfig = path.join(MAYA_ROOT, 'maya-maya-xs-iq1_s-vision.json');
    let visionMarker = null;
    try { visionMarker = JSON.parse(fs.readFileSync(path.join(MAYA_VISION_DIR, '.opm-verified.json'), 'utf8')); } catch { /* setup has not verified images yet */ }
    const visionFiles = visionMarker?.files && MAYA_VISION_FILES.every(([name, hash]) =>
      visionMarker.files[name] === hash && fs.existsSync(path.join(MAYA_VISION_DIR, name)));
    if (mayaVisionSetup.state === 'running' && visionFiles && fs.existsSync(path.join(MAYA_ROOT, 'build-vision', 'bin', 'maya-vision.exe')) && fs.existsSync(path.join(MAYA_ROOT, 'maya-glm-maya-xs.json'))) {
      try {
        const generated = JSON.parse(fs.readFileSync(path.join(MAYA_ROOT, 'maya-glm-maya-xs.json'), 'utf8'));
        if (generated.vision) {
          fs.copyFileSync(path.join(MAYA_ROOT, 'maya-glm-maya-xs.json'), path.join(MAYA_ROOT, 'maya-maya-xs-iq1_s-vision.json'));
          mayaVisionSetup = { ...mayaVisionSetup, state: 'complete', output: `${mayaVisionSetup.output}\nVision config finalized after monitor restart` };
          fs.writeFileSync(path.join(MAYA_DATA, 'maya-vision-setup-state.json'), JSON.stringify(mayaVisionSetup, null, 2));
        }
      } catch { /* incomplete setup remains running for recovery */ }
    }
    const visionPrepared = basePrepared && visionFiles && fs.existsSync(visionConfig) &&
      fs.existsSync(path.join(MAYA_ROOT, 'build-vision', 'bin', 'maya-vision.exe'));
    return { model: 'glm53flash', name: VARIANTS.glm53flash.name, model_downloaded: modelDownloaded, prepared: basePrepared,
      variants: {
        glm53flash: { name: VARIANTS.glm53flash.name, prepared: basePrepared },
        glm53flashvision: { name: VARIANTS.glm53flashvision.name, prepared: visionPrepared, files_verified: visionFiles }
      },
      downloaded_bytes: downloadedBytes, expected_bytes: 73400000000, setup: mayaSetup, vision_setup: mayaVisionSetup,
      models_dir: modelDir, context_window: MAYA_CONTEXT };
  }
  function deepSeekSettings() {
    let config = null;
    try { config = JSON.parse(fs.readFileSync(DEEPSEEK_CONFIG, 'utf8')); } catch { /* not prepared */ }
    const packArg = config?.args?.findIndex((value) => value === '--pack') ?? -1;
    const pack = packArg >= 0 ? config.args[packArg + 1] : null;
    const contextArg = config?.args?.findIndex((value) => value === '--max-context') ?? -1;
    const context = contextArg >= 0 ? Number(config.args[contextArg + 1]) : 0;
    const visionOff = config?.args?.some((value, index) => value === '--vision' && config.args[index + 1] === 'off');
    const prepared = config?.model_name === 'deepseek-v4.1-flash' && config?.port === 8080 && context === 65536 && !visionOff &&
      Boolean(config.exe && fs.existsSync(config.exe)) && Boolean(pack && fs.existsSync(pack)) &&
      fs.existsSync(path.join(pack || '', 'tokenizer')) && fs.existsSync(path.join(DEEPSEEK_MODEL_DIR, 'vision', 'vision.bin'));
    return { model: 'deepseekflashvision', name: VARIANTS.deepseekflashvision.name, prepared,
      model_dir: DEEPSEEK_MODEL_DIR, pack, context_window: context, vision: !visionOff };
  }
  async function startMayaSetup() {
    return queue(async () => {
      if (mayaVisionSetup.state === 'running') throw fault(409, 'setup_running', 'Project Maya Vision setup is already running');
      if (mayaSetup.state === 'running' || mayaVisionSetup.state === 'running') throw fault(409, 'setup_running', 'Project Maya setup is already running');
      if (mayaSettings().prepared) throw fault(409, 'setup_complete', 'Project Maya Maya-XS is already prepared');
      if (!mayaSettings().model_downloaded) throw fault(409, 'model_not_downloaded', 'Download and verify both Maya-XS model shards first');
      if (current && current.state !== 'idle') throw fault(409, 'session_conflict', 'Release the active model session before setup');
      const services = await sglangServices.status();
      if (services.operation !== 'idle' || services.models.some((model) => model.running))
        throw fault(409, 'gpu_busy', 'Stop the running model before Project Maya setup');
      if (await portOpen() || await isPortOpen(8080)) throw fault(409, 'gpu_busy', 'Stop the running model before Project Maya setup');
      await checkOllamaGpu();
      const cards = await readGpuStatus();
      if (!cards || !cards.length || cards[0].freeMiB < 24576)
        throw fault(409, 'gpu_busy', 'Project Maya setup needs the GPU to be released first');
      mayaSetup = { state: 'running', output: '', error: null, started_at: new Date().toISOString() };
      sleepGuard.setSessionActive(true);
      void (async () => {
        try {
          await startMayaSetupRunner((line) => { mayaSetup.output = (mayaSetup.output + line + '\n').slice(-12000); });
          mayaSetup = { ...mayaSetup, state: 'complete' };
        } catch (error) { mayaSetup = { ...mayaSetup, state: 'failed', error: error.message }; }
        finally { sleepGuard.setSessionActive(false); }
      })();
      return mayaSettings();
    });
  }
  async function startMayaVisionSetup() {
    return queue(async () => {
      const settings = mayaSettings();
      if (!settings.prepared) throw fault(409, 'model_not_prepared', 'Prepare Maya text mode first');
      if (settings.variants.glm53flashvision.prepared) throw fault(409, 'setup_complete', 'Maya Vision is already prepared');
      if (mayaVisionSetup.state === 'running' || mayaSetup.state === 'running') throw fault(409, 'setup_running', 'Project Maya setup is already running');
      if (current && current.state !== 'idle') throw fault(409, 'session_conflict', 'Release the active model session before setup');
      const services = await sglangServices.status();
      if (services.operation !== 'idle' || services.models.some((model) => model.running)) throw fault(409, 'gpu_busy', 'Stop the running model before Project Maya Vision setup');
      if (await portOpen() || await isPortOpen(8080)) throw fault(409, 'gpu_busy', 'Stop the running model before Project Maya Vision setup');
      await checkOllamaGpu();
      const cards = await readGpuStatus();
      if (!cards || !cards.length || cards[0].freeMiB < 24576) throw fault(409, 'gpu_busy', 'Project Maya Vision setup needs at least 24576 MiB free on GPU 0');
      mayaVisionSetup = { state: 'running', output: '', error: null, started_at: new Date().toISOString() };
      fs.mkdirSync(MAYA_DATA, { recursive: true });
      fs.writeFileSync(path.join(MAYA_DATA, 'maya-vision-setup-state.json'), JSON.stringify(mayaVisionSetup, null, 2));
      sleepGuard.setSessionActive(true);
      void (async () => {
        try { await startMayaVisionSetupRunner((line) => { mayaVisionSetup.output = (mayaVisionSetup.output + line + '\n').slice(-12000); fs.writeFileSync(path.join(MAYA_DATA, 'maya-vision-setup-state.json'), JSON.stringify(mayaVisionSetup, null, 2)); });
          mayaVisionSetup = { ...mayaVisionSetup, state: 'complete' };
        } catch (error) { mayaVisionSetup = { ...mayaVisionSetup, state: 'failed', error: error.message }; }
        finally { fs.writeFileSync(path.join(MAYA_DATA, 'maya-vision-setup-state.json'), JSON.stringify(mayaVisionSetup, null, 2)); sleepGuard.setSessionActive(false); }
      })();
      return mayaSettings();
    });
  }
  async function startQuantSetup() {
    if (mayaSetup.state === 'running' || mayaVisionSetup.state === 'running') throw fault(409, 'setup_running', 'Project Maya setup is already running');
    if (quantSetup.state === 'running') throw fault(409, 'setup_running', 'IQ3_XXS setup is already running');
    if (current && current.state !== 'idle') throw fault(409, 'session_conflict', 'Release the active model session before setup');
    const services = await sglangServices.status();
    if (services.operation !== 'idle' || services.models.some((model) => model.running))
      throw fault(409, 'gpu_busy', 'Stop the other managed model before setup');
    if (await portOpen()) throw fault(409, 'gpu_busy', 'Stop the running Strata backend before setup');
    await checkOllamaGpu();
    quantSetup = { state: 'running', output: '', error: null, started_at: new Date().toISOString() };
    void (async () => {
      try { await startQuantSetupRunner((line) => { quantSetup.output = (quantSetup.output + line + '\n').slice(-12000); });
        quantSetup = { ...quantSetup, state: 'complete' };
      } catch (error) { quantSetup = { ...quantSetup, state: 'failed', error: error.message }; }
    })();
    return quantSettings();
  }
  try { current = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { /* first start */ }
  function save() {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    const temp = `${stateFile}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(current));
    fs.renameSync(temp, stateFile);
  }
  function queue(fn) {
    const result = serial.then(fn, fn);
    serial = result.catch(() => {});
    return result;
  }
  function schedule() {
    if (timer) clearTimeout(timer);
    if (!current || ['idle', 'failed'].includes(current.state)) return;
    const delay = Math.max(0, Date.parse(current.expires_at) - Date.now());
    timer = setTimeout(() => { release(current.session_id).catch((error) => log('session expiry cleanup:', error.message)); }, delay);
    timer.unref();
  }
  async function defaultStrataStatus() {
    try {
      const response = await fetch('http://127.0.0.1:18082/v1/status', { signal: AbortSignal.timeout(1800) });
      return response.ok ? await response.json() : null;
    } catch { return null; }
  }
  async function isPortOpen(port) {
    return new Promise((resolve) => {
      const socket = net.connect({ host: '127.0.0.1', port });
      socket.setTimeout(600);
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('timeout', () => { socket.destroy(); resolve(false); });
      socket.once('error', () => { socket.destroy(); resolve(false); });
    });
  }
  async function sglangStatus(variant) {
    try {
      const health = await fetch(`http://127.0.0.1:${variant.port}/health`, { signal: AbortSignal.timeout(1800) });
      if (!health.ok) return null;
      const models = await fetch(`http://127.0.0.1:${variant.port}/v1/models`, { signal: AbortSignal.timeout(1800) });
      if (!models.ok) return null;
      const catalog = await models.json();
      const info = await fetch(`http://127.0.0.1:${variant.port}/server_info`, { signal: AbortSignal.timeout(1800) });
      if (!info.ok) return null;
      const runtime = await info.json();
      const context = Number(runtime.context_length);
      const capacity = Number(runtime.max_total_num_tokens);
      return { ready: catalog.data?.some((item) => item.id === variant.inferenceModel) &&
        context === variant.contextWindow && capacity >= variant.contextWindow,
        context: { max_positions: context },
        vision: { enabled: false, available: false } };
    } catch { return null; }
  }
  async function mayaStatus(variant) {
    try {
      const response = await fetch(`http://127.0.0.1:${variant.port}/health`, { signal: AbortSignal.timeout(1800) });
      if (!response.ok) return null;
      const health = await response.json();
      const images = health.images === true;
      return { ready: health.status === 'ok' && health.model === variant.inferenceModel && Number(health.max_context) === variant.contextWindow && images === variant.vision,
        context: { max_positions: Number(health.max_context) }, vision: { enabled: images, available: images } };
    } catch { return null; }
  }
  // Ready only once OneJev has actually answered a judgement, not on a bare TCP/health check.
  async function systemoneStatus(variant) {
    try {
      const response = await fetch(`http://127.0.0.1:${variant.port}/v1/systemone`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(5000),
        body: JSON.stringify({ model: variant.inferenceModel, state: { question: '冷蔵庫の在庫を調べたい' },
          questions: { best: { type: 'choice', instructions: '質問の答えに最も近い項目を選ぶ。',
            criteria: { 0: '冷蔵庫 — 食品の在庫管理', 1: 'ゴルフ — スコアの記録' } } } }) });
      if (!response.ok) return null;
      const probabilities = (await response.json()).answers?.best?.probabilities;
      const values = [probabilities?.[0], probabilities?.[1]];
      if (!values.every((value) => typeof value === 'number' && value >= 0 && value <= 1)) return null;
      return { ready: true, context: { max_positions: variant.contextWindow }, vision: { enabled: false, available: false } };
    } catch { return null; }
  }
  const effectiveStatus = readStrataStatus || defaultStrataStatus;
  const portOpen = isStrataPortOpen || (() => new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port: 18082 });
    socket.setTimeout(600);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
    socket.once('error', () => { socket.destroy(); resolve(false); });
  }));
  function view() {
    if (!current) return null;
    const { session_id, state, model, expires_at, error, error_code, effective_model, context, vision } = current;
    return { session_id, state, model, expires_at, ready: state === 'ready', error: error || null,
      error_code: error_code || null,
      effective_model: effective_model || null, context: context || null, vision: vision || null };
  }
  function models() {
    return { object: 'list', data: Object.entries(VARIANTS).map(([id, variant]) => ({
      id, object: 'model', owned_by: 'ollama-pc-monitor',
      name: variant.name, vision: variant.vision,
      context_window: variant.contextWindow,
      inference_model: id.startsWith('strata') ? (strataQuant === 'IQ3_XXS' ? MODEL_IQ3 : MODEL) : variant.inferenceModel,
      api: apiOf(variant), inference_port: inferencePortOf(variant),
      session_state: current?.model === id ? current.state : 'idle',
      ready: current?.model === id && current.state === 'ready'
    })) };
  }
  async function cleanUp() {
    if (!current) return;
    current.state = 'stopping'; save();
    // Stop only the model owned by this session.
    await runScript(path.join(scriptsDir, VARIANTS[current.model].stopScript));
    const restored = current.paused_services;
    if (restored) await gpuServices.resume();
    current.state = 'idle'; current.error = null; current.restored = restored; save(); schedule();
    sleepGuard.setSessionActive(false);
  }
  async function release(id) {
    return queue(async () => {
      if (!current || current.session_id !== id) throw fault(404, 'session_not_found', 'Unknown session');
      const released = () => ({ state: 'idle', stopped_by_session: [],
        restored: current.restored ? ['whisper', 'rerank'] : [] });
      if (current.state === 'idle') return released();
      try { await cleanUp(); return released(); }
      catch (error) { current.state = 'failed'; current.error = error.message; save();
        throw fault(500, 'stop_failed', error.message); }
    });
  }
  async function preflight() {
    if (mayaSetup.state === 'running' || mayaVisionSetup.state === 'running') throw fault(409, 'setup_running', 'Project Maya setup is running');
    if (current && current.state !== 'idle') throw fault(409, 'session_conflict', 'Previous model session must be released');
    if (!policyReady()) throw fault(503, 'policy_blocked', 'External session power policy is unavailable');
    const presenceState = presence.getSnapshot();
    if (presenceState.nks.status !== 'ok') throw fault(503, 'policy_blocked', 'NKS power policy is unavailable');
    if (presenceState.nks.response?.work_hold_until && Date.parse(presenceState.nks.response.work_hold_until) > Date.now())
      throw fault(409, 'human_work_hold', 'Local work declaration is active');
    if (presenceState.local.busy) throw fault(409, 'gpu_busy', 'Local inference is active');
    await checkOllamaGpu();
    const models = await sglangServices.status();
    if (models.operation !== 'idle' || models.models.some((model) => model.running))
      throw fault(409, 'gpu_busy', 'Another managed model is active');
    if (await effectiveStatus() || await portOpen() || await isPortOpen(8080)) throw fault(409, 'gpu_busy', 'A managed model backend port is already occupied');
    const gpu = await gpuServices.getStatus();
    if (!gpu.supported || gpu.taskError || gpu.services.some((service) => service.running === null))
      throw fault(503, 'state_unavailable', 'Auxiliary task state is unavailable');
    const holdUntil = gpuServices.getSnapshot().holdUntil;
    if (holdUntil && Date.parse(holdUntil) > Date.now())
      throw fault(409, 'human_work_hold', 'Auxiliary services are held by a local declaration');
  }
  async function availability() {
    const checked_at = new Date().toISOString();
    try {
      await preflight();
      return { available: true, code: null, message: null, http_status: null, retry_after_s: null, checked_at };
    } catch (error) {
      return { available: false, code: error.code || 'state_unavailable', message: error.message,
        http_status: error.status || 503, retry_after_s: 30, checked_at };
    }
  }
  async function create(input) {
    if (!Object.hasOwn(VARIANTS, input?.model) || !Number.isInteger(input.ttl_seconds) || input.ttl_seconds < 60 || input.ttl_seconds > 3600 ||
        typeof input.request_id !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(input.request_id))
      throw fault(400, 'bad_request', 'model, ttl_seconds, or request_id is invalid');
    return queue(async () => {
      if (current?.request_id === input.request_id && current.state !== 'idle') {
        if (current.model !== input.model) throw fault(409, 'session_conflict', 'Request ID belongs to another model');
        return view();
      }
      await preflight();
      if (VARIANTS[input.model]?.api === 'maya') {
        const mayaVariant = VARIANTS[input.model];
        const prepared = input.model.startsWith('deepseek') ? deepSeekSettings().prepared : mayaSettings().variants?.[input.model]?.prepared;
        if (!prepared)
          throw fault(409, 'model_not_prepared', `${mayaVariant.name} is not prepared yet. Run its setup from the dashboard first.`);
        if (await isPortOpen(mayaVariant.port)) throw fault(409, 'gpu_busy', 'Project Maya API port 8080 is already occupied');
      }
      current = { session_id: crypto.randomUUID(), request_id: input.request_id, state: 'starting', model: input.model,
        expires_at: new Date(Date.now() + input.ttl_seconds * 1000).toISOString(), started_at: new Date().toISOString(),
        paused_services: false, error: null };
      save(); schedule(); sleepGuard.setSessionActive(true);
      const result = view();
      void queue(async () => {
        try {
          const variant = VARIANTS[input.model];
          if (pausesAux(variant)) {
            await gpuServices.setWorkHold(Math.ceil(input.ttl_seconds / 60));
            current.paused_services = true; save();
            for (let i = 0; i < 20; i++) {
              const state = await gpuServices.getStatus();
              if (!state.taskError && state.services.every((service) => service.running === false && !service.health)) break;
              if (i === 19) throw new Error('Auxiliary services did not release the GPU');
              await sleep(1000);
            }
          }
          const gpuMemory = await readGpuStatus();
          if (!gpuMemory || gpuMemory.some((card) => card.freeMiB < (variant.minFreeMiB || 22000)))
            throw fault(409, 'gpu_busy', `GPU memory is not sufficiently free for ${variant.name}`);
          await checkOllamaGpu();
          // Only the WSL2 SGLang backends use the 30000/30001 port proxies.
          // Native Project Maya (8080) and other backends must not require the
          // administrator-only WSL portproxy refresh before they can start.
          if (input.model === 'qwen38' || input.model === 'qwen3coder')
            await runScript(path.join(scriptsDir, 'sync-sglang-portproxy.ps1'));
          const quantForSession = input.model.startsWith('strata') ? strataQuant : null;
          if (input.model.startsWith('strata') && quantForSession === 'IQ3_XXS' && !quantSettings().prepared)
            throw fault(409, 'quant_not_prepared', 'IQ3_XXS is not prepared. Use the dashboard setup button first.');
          if (input.model.startsWith('strata')) {
            await runScript(path.join(scriptsDir, variant.startScript), quantForSession);
          } else if (variant.api === 'maya') {
            await runScript(path.join(scriptsDir, variant.startScript), null, input.model === 'glm53flashvision' ? ['-Vision'] : []);
          } else await runScript(path.join(scriptsDir, variant.startScript));
          for (let i = 0; i < (variant.startupTries || (input.model.startsWith('strata') ? 90 : 300)); i++) {
            const status = input.model.startsWith('strata') ? await effectiveStatus()
              : variant.api === 'maya' ? await mayaStatus(variant)
                : variant.api === 'systemone' ? await (readSglangStatus || systemoneStatus)(variant)
                : await (readSglangStatus || sglangStatus)(variant);
            if (input.model.startsWith('strata') && status) {
              const expectedModel = quantForSession === 'IQ3_XXS' ? MODEL_IQ3 : MODEL;
              status.ready = status.loaded === true && status.model === expectedModel && status.context?.max_positions === 131072 &&
                status.vision?.enabled === variant.vision && (!variant.vision || status.vision?.available === true);
            }
            if (status?.ready) {
              if (Date.now() >= Date.parse(current.expires_at)) throw fault(500, 'ready_timeout', 'Session expired during startup');
              current.state = 'ready'; current.effective_model = input.model.startsWith('strata') ? (quantForSession === 'IQ3_XXS' ? MODEL_IQ3 : MODEL) : variant.inferenceModel;
              current.context = status.context || null; current.vision = status.vision || { enabled: false, available: false }; save(); return;
            }
            await sleep(2000);
          }
          throw fault(500, 'ready_timeout', 'Model did not become ready before the startup deadline');
        } catch (error) {
          current.state = 'failed'; current.error = error.message; current.error_code = error.code || 'start_failed'; save();
          try { await cleanUp(); } catch (cleanupError) { log('failed start cleanup:', cleanupError.message); }
          current.state = 'failed'; current.error = error.message; current.error_code = error.code || 'start_failed'; save();
        }
      });
      return result;
    });
  }
  async function extend(id, ttl) {
    if (!Number.isInteger(ttl) || ttl < 60 || ttl > 3600) throw fault(400, 'bad_request', 'Invalid ttl_seconds');
    return queue(async () => {
      if (!current || current.session_id !== id) throw fault(404, 'session_not_found', 'Unknown session');
      if (!['starting', 'ready'].includes(current.state)) throw fault(409, 'session_conflict', 'Session is not active');
      if (!policyReady()) throw fault(503, 'policy_blocked', 'NKS external session hold is unavailable');
      if (pausesAux(VARIANTS[current.model])) await gpuServices.setWorkHold(Math.ceil(ttl / 60));
      current.expires_at = new Date(Date.now() + ttl * 1000).toISOString(); save(); schedule();
      return view();
    });
  }
  function get(id) {
    if (!current || current.session_id !== id) throw fault(404, 'session_not_found', 'Unknown session');
    return view();
  }
  if (current && current.state !== 'idle') {
    sleepGuard.setSessionActive(true);
    // A monitor restart cannot prove the NAS still owns the session. Reconcile
    // by stopping the managed process; the NAS can create a fresh session.
    release(current.session_id).catch((error) => log('restart cleanup:', error.message));
  }
  return { availability, create, get, extend, release, models, quantSettings, setStrataQuant, startQuantSetup, mayaSettings, deepSeekSettings, startMayaSetup, startMayaVisionSetup,
    activeModel: () => current?.state === 'ready' ? current.model : null,
    activeInferenceModel: () => current?.state === 'ready' ? current.effective_model : null,
    hasActive: () => Boolean(current && current.state !== 'idle') };
}

module.exports = { createModelSessions };
