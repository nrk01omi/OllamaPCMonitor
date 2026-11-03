'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const { execFile } = require('node:child_process');
const net = require('node:net');
const { getGpuStatus } = require('./gpu');

const MODEL = 'qwen3.8-flash-next-iq2_xs';
const VARIANTS = {
  strata128k: { name: 'Qwen3.8-Flash-Next / Strata 128K (Vision なし)', startScript: 'Start-Strata-Managed.ps1', stopScript: 'Stop-Strata-Managed.ps1', port: 18082, inferenceModel: MODEL, contextWindow: 131072, vision: false },
  strata128kvision: { name: 'Qwen3.8-Flash-Next / Strata 128K (Vision あり)', startScript: 'Start-Strata-Vision-Managed.ps1', stopScript: 'Stop-Strata-Managed.ps1', port: 18082, inferenceModel: MODEL, contextWindow: 131072, vision: true },
  qwen38: { name: 'Qwen3.8-27B', startScript: 'Start-Qwen38-SGLang.ps1', stopScript: 'Stop-Qwen38-SGLang.ps1', port: 30000, inferenceModel: 'qwen3.8-27b', contextWindow: 65536, vision: false },
  qwen3coder: { name: 'Qwen3-Coder-30B', startScript: 'Start-Qwen3Coder-SGLang.ps1', stopScript: 'Stop-Qwen3Coder-SGLang.ps1', port: 30001, inferenceModel: 'qwen3-coder-30b', contextWindow: 65536, vision: false },
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

function script(file) {
  return new Promise((resolve, reject) => execFile('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file],
    { windowsHide: true, timeout: 45000 }, (error, stdout, stderr) =>
      error ? reject(new Error(String(stderr || stdout || error.message).trim())) : resolve()));
}

function createModelSessions({ stateFile, scriptsDir, gpuServices, sglangServices, presence, sleepGuard, policyReady,
  readStrataStatus, readSglangStatus, isStrataPortOpen, runScript = script, readGpuStatus = getGpuStatus,
  checkOllamaGpu = async () => {}, log = () => {} }) {
  let current = null;
  let timer = null;
  let serial = Promise.resolve();
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
      inference_model: variant.inferenceModel,
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
    if (await effectiveStatus() || await portOpen()) throw fault(409, 'gpu_busy', 'Strata backend port is already occupied');
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
          if (!input.model.startsWith('strata')) await runScript(path.join(scriptsDir, 'sync-sglang-portproxy.ps1'));
          await runScript(path.join(scriptsDir, variant.startScript));
          for (let i = 0; i < (variant.startupTries || (input.model.startsWith('strata') ? 90 : 300)); i++) {
            const status = input.model.startsWith('strata') ? await effectiveStatus()
              : variant.api === 'systemone' ? await (readSglangStatus || systemoneStatus)(variant)
                : await (readSglangStatus || sglangStatus)(variant);
            if (input.model.startsWith('strata') && status)
              status.ready = status.loaded === true && status.model === MODEL && status.context?.max_positions === 131072 &&
                status.vision?.enabled === variant.vision && (!variant.vision || status.vision?.available === true);
            if (status?.ready) {
              if (Date.now() >= Date.parse(current.expires_at)) throw fault(500, 'ready_timeout', 'Session expired during startup');
              current.state = 'ready'; current.effective_model = variant.inferenceModel;
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
  return { availability, create, get, extend, release, models,
    activeModel: () => current?.state === 'ready' ? current.model : null,
    hasActive: () => Boolean(current && current.state !== 'idle') };
}

module.exports = { createModelSessions };
