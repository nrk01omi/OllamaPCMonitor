'use strict';

const fs = require('node:fs');
const { execFile } = require('node:child_process');

const MODELS = {
  qwen38: { label: 'Qwen3.8-27B', port: 30000, start: 'Start-Qwen38-SGLang.ps1', stop: 'Stop-Qwen38-SGLang.ps1', pidFile: '\\\\wsl$\\Ubuntu-22.04-RAG\\root\\run\\sglang-qwen38.pid' },
  qwen3coder: { label: 'Qwen3-Coder-30B', port: 30001, start: 'Start-Qwen3Coder-SGLang.ps1', stop: 'Stop-Qwen3Coder-SGLang.ps1', pidFile: '\\\\wsl$\\Ubuntu-22.04-RAG\\root\\run\\sglang-qwen3coder.pid' },
  onejev9b: { label: 'OneJev 9B (判定専用)', port: 8083, api: 'systemone', inferenceModel: 'onejev1.6-9b', start: 'Start-OneJev-Flide.ps1', stop: 'Stop-OneJev-Flide.ps1', pidFile: '\\\\wsl$\\Ubuntu-22.04-RAG\\root\\run\\flide-onejev.pid' },
  glm53flash: { label: 'GLM-5.3-Flash / Project Maya Maya-XS 128K (Vision なし)', port: 8080, api: 'maya', inferenceModel: 'glm-5.3-flash', contextWindow: 131072, vision: false, start: 'Start-Maya-Managed.ps1', stop: 'Stop-Maya-Managed.ps1', pidFile: require('node:path').join(__dirname, 'data', 'maya-managed.pid') },
  glm53flashvision: { label: 'GLM-5.3-Flash / Project Maya Maya-XS 128K (Vision あり)', port: 8080, api: 'maya', inferenceModel: 'glm-5.3-flash', contextWindow: 131072, vision: true, start: 'Start-Maya-Managed.ps1', stop: 'Stop-Maya-Managed.ps1', pidFile: require('node:path').join(__dirname, 'data', 'maya-managed.pid') },
  deepseekflashvision: { label: 'DeepSeek-V4.1-Flash / Project Maya Maya-XS 64K (Vision あり)', port: 8080, api: 'maya', inferenceModel: 'deepseek-v4.1-flash', contextWindow: 65536, vision: true, start: 'Start-DeepSeek-Managed.ps1', stop: 'Stop-DeepSeek-Managed.ps1', pidFile: require('node:path').join(__dirname, 'data', 'deepseek-managed.pid') },
  strata128k: { label: 'Qwen3.8-Flash-Next / Strata 128K (Vision なし)', port: 18082, vision: false, start: 'Start-Strata-Managed.ps1', stop: 'Stop-Strata-Managed.ps1', pidFile: require('node:path').join(__dirname, 'data', 'strata-managed.pid') },
  strata128kvision: { label: 'Qwen3.8-Flash-Next / Strata 128K (Vision あり)', port: 18082, vision: true, start: 'Start-Strata-Vision-Managed.ps1', stop: 'Stop-Strata-Managed.ps1', pidFile: require('node:path').join(__dirname, 'data', 'strata-managed.pid') }
};

function runScript(script, args = []) {
  return new Promise((resolve, reject) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args], { windowsHide: true, timeout: 30000 }, (error, stdout, stderr) => {
    if (error) return reject(new Error(String(stderr || stdout || error.message).trim()));
    resolve(String(stdout));
  }));
}

function createSglangServiceManager({ scriptsDir, stateFile, checkOllamaGpu = async () => {}, getStrataQuant = () => ({ selected: 'IQ2_XS', prepared: false }), getMayaSettings = () => ({ prepared: false }), getDeepSeekSettings = () => ({ prepared: false }), log = () => {}, onActivityChange = () => {} }) {
  let state = { holdUntil: null, operation: 'idle', selected: null, startedAt: null, lastError: null };
  let timer = null;
  let serial = Promise.resolve();
  try { state = { ...state, ...JSON.parse(fs.readFileSync(stateFile, 'utf8')) }; } catch { /* first start */ }
  const save = () => fs.writeFileSync(stateFile, JSON.stringify(state));
  const reportActivity = (active) => Promise.resolve(onActivityChange(active)).catch((error) => log('sleep guard update failed:', error.message));
  const scheduleStop = () => {
    if (timer) clearTimeout(timer);
    if (!state.holdUntil) return;
    const delay = Date.parse(state.holdUntil) - Date.now();
    if (delay <= 0) return void stopAll({ clearHold: true }).catch((error) => log('expiry stop failed:', error.message));
    timer = setTimeout(() => stopAll({ clearHold: true }).catch((error) => log('expiry stop failed:', error.message)), delay);
    timer.unref();
  };
  const health = async (model) => {
    try {
      if (model.api === 'systemone') {
        // Running means OneJev can actually answer a judgement, not just that the port is open.
        const reply = await fetch(`http://127.0.0.1:${model.port}/v1/systemone`, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(3000),
          body: JSON.stringify({ model: model.inferenceModel, state: { question: '冷蔵庫の在庫を調べたい' }, questions: { best: { type: 'choice', instructions: '質問の答えに最も近い項目を選ぶ。', criteria: { 0: '冷蔵庫 — 食品の在庫管理', 1: 'ゴルフ — スコアの記録' } } } }) });
        const probabilities = reply.ok ? (await reply.json()).answers?.best?.probabilities : null;
        return [probabilities?.[0], probabilities?.[1]].every((value) => typeof value === 'number' && value >= 0 && value <= 1);
      }
      const statusPath = model.api === 'maya' || model.vision === undefined ? 'health' : 'v1/status';
      const response = await fetch(`http://127.0.0.1:${model.port}/${statusPath}`, { signal: AbortSignal.timeout(1200) });
      if (!response.ok) return false;
      const status = await response.json();
      if (model.api === 'maya') return status.status === 'ok' && status.model === model.inferenceModel && Number(status.max_context) === model.contextWindow && status.images === model.vision;
      if (model.vision === undefined) return true;
      return status.loaded === true && status.context?.max_positions === 131072 &&
        status.vision?.enabled === model.vision && (!model.vision || status.vision?.available === true);
    } catch { return false; }
  };
  const run = (fn) => { serial = serial.then(fn, fn); return serial; };
  async function status() {
    const maya = getMayaSettings();
    const deepseek = getDeepSeekSettings();
    const models = await Promise.all(Object.entries(MODELS).map(async ([id, model]) => ({ id, label: model.label, port: model.port,
      running: await health(model), ...(id === 'glm53flash' || id === 'glm53flashvision' ? { prepared: Boolean(maya.variants ? maya.variants[id]?.prepared : maya.prepared) } : {}),
      ...(id === 'deepseekflashvision' ? { prepared: Boolean(deepseek.prepared) } : {}) })));
    const selected = models.find((model) => model.id === state.selected);
    if (state.operation === 'starting' && selected?.running) {
      state.operation = 'running'; state.lastError = null; save();
    } else if (state.operation === 'starting' && state.startedAt && Date.now() - Date.parse(state.startedAt) > 8 * 1000 && !fs.existsSync(MODELS[state.selected]?.pidFile || '')) {
      state.operation = 'failed'; state.lastError = 'SGLang 起動プロセスが開始されませんでした。停止完了またはポート転送のエラーを確認してください。'; save();
    } else if (state.operation === 'starting' && state.startedAt && Date.now() - Date.parse(state.startedAt) > 10 * 60 * 1000) {
      state.operation = 'failed'; state.lastError = '10 分以内に SGLang API が起動しませんでした。ログを確認してください。'; save();
    }
    const active = state.operation === 'starting' || models.some((model) => model.running);
    reportActivity(active);
    return { models, holdUntil: state.holdUntil, operation: state.operation, selected: state.selected, startedAt: state.startedAt, lastError: state.lastError, sleepBlocked: active };
  }
  async function stop(id) {
    const model = MODELS[id];
    if (!model) throw Object.assign(new Error('unknown SGLang model'), { code: 'BAD_REQUEST' });
    await runScript(require('node:path').join(scriptsDir, model.stop));
  }
  async function stopAll({ clearHold = false } = {}) {
    return run(async () => {
      const previous = { operation: state.operation, selected: state.selected };
      const current = await status();
      state.operation = 'stopping'; save();
      const runningIds = new Set(current.models.filter((model) => model.running).map((model) => model.id));
      // A start may still be warming up and not answer health checks yet. Keep
      // stopping that explicitly selected service, and retry stale "stopping"
      // state only when its managed process/port is still present.
      if (previous.selected && ['starting', 'running'].includes(previous.operation)) runningIds.add(previous.selected);
      if (previous.operation === 'stopping' && previous.selected) {
        const model = MODELS[previous.selected];
        const pidFileExists = Boolean(model?.pidFile && fs.existsSync(model.pidFile));
        if (pidFileExists || current.models.some((item) => item.id === previous.selected && item.running))
          runningIds.add(previous.selected);
      }
      const stopScripts = [...new Set(Object.entries(MODELS)
        .filter(([id]) => runningIds.has(id))
        .map(([, model]) => model.stop))];
      await Promise.all(stopScripts.map((script) => runScript(require('node:path').join(scriptsDir, script))));
      if (clearHold) state.holdUntil = null;
      state.operation = 'idle'; state.selected = null; state.startedAt = null; state.lastError = null; save();
      if (timer) { clearTimeout(timer); timer = null; }
      await reportActivity(false);
      return status();
    });
  }
  async function select(id) {
    if (!MODELS[id]) throw Object.assign(new Error('unknown SGLang model'), { code: 'BAD_REQUEST' });
    if (!state.holdUntil || Date.parse(state.holdUntil) <= Date.now()) throw Object.assign(new Error('作業宣言中のみ SGLang モデルを選択できます'), { code: 'NO_WORK_HOLD' });
    return run(async () => {
      if (state.operation === 'starting') {
        if (state.selected === id) return status();
        throw Object.assign(new Error('別モデルの起動処理中です。完了または停止までお待ちください。'), { code: 'STARTING' });
      }
      const current = await status();
      if (state.operation === 'running' && state.selected === id && current.models.find((model) => model.id === id)?.running) return current;
      await checkOllamaGpu();
      // Only call stop scripts for services confirmed running. Calling every
      // WSL stop script can fail when its distro is unavailable, even though
      // that service is already stopped, and would prevent Strata from starting.
      const runningIds = new Set(current.models.filter((model) => model.running).map((model) => model.id));
      const stopScripts = [...new Set(Object.entries(MODELS)
        .filter(([other]) => other !== id && runningIds.has(other))
        .map(([, model]) => model.stop))];
      await Promise.all(stopScripts.map((script) => runScript(require('node:path').join(scriptsDir, script))));
      state.operation = 'starting'; state.selected = id; state.startedAt = new Date().toISOString(); state.lastError = null; save();
      await reportActivity(true);
      try {
        // Only the WSL2 SGLang services use Windows portproxy on 30000/30001.
        // Native Project Maya (8080) must start under its work hold without
        // touching the administrator-only WSL portproxy configuration.
        if (id === 'qwen38' || id === 'qwen3coder')
          await runScript(require('node:path').join(scriptsDir, 'sync-sglang-portproxy.ps1'));
        const scriptArgs = [];
        if (MODELS[id].vision !== undefined && id.startsWith('strata')) {
          const quant = getStrataQuant();
          if (!['IQ2_XS', 'IQ3_XXS'].includes(quant.selected)) throw new Error(`Unsupported Strata quantization: ${quant.selected}`);
          if (quant.selected === 'IQ3_XXS' && !quant.prepared) throw new Error('IQ3_XXS is selected but not prepared');
          scriptArgs.push('-Quant', quant.selected);
        }
        if (id === 'glm53flash' || id === 'glm53flashvision') {
          if (!getMayaSettings().variants?.[id]?.prepared)
            throw new Error(`${MODELS[id].label} is not prepared. Use the Project Maya setup button first.`);
          if (MODELS[id].vision) scriptArgs.push('-Vision');
        }
        if (id === 'deepseekflashvision' && !getDeepSeekSettings().prepared)
          throw new Error(`${MODELS[id].label} is not prepared. Complete the Project Maya DeepSeek setup first.`);
        await runScript(require('node:path').join(scriptsDir, MODELS[id].start), scriptArgs);
      }
      catch (error) { state.operation = 'failed'; state.lastError = error.message; save(); await reportActivity(false); throw error; }
      return status();
    });
  }
  function setWorkHold(minutes) {
    state.holdUntil = minutes > 0 ? new Date(Date.now() + minutes * 60000).toISOString() : null;
    save(); scheduleStop();
    return minutes > 0 ? status() : stopAll({ clearHold: true });
  }
  scheduleStop();
  // Reconcile persisted state with the health endpoints immediately after a
  // monitor restart; do not wait for somebody to open the dashboard.
  status().catch((error) => log('initial SGLang status failed:', error.message));
  return { status, select, stopAll, setWorkHold };
}

module.exports = { createSglangServiceManager };
