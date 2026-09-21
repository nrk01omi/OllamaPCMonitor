'use strict';

const fs = require('node:fs');
const { execFile } = require('node:child_process');

const MODELS = {
  qwen38: { label: 'Qwen3.8-27B', port: 30000, start: 'Start-Qwen38-SGLang.ps1', stop: 'Stop-Qwen38-SGLang.ps1', pidFile: '\\\\wsl$\\Ubuntu-22.04-RAG\\root\\run\\sglang-qwen38.pid' },
  qwen3coder: { label: 'Qwen3-Coder-30B', port: 30001, start: 'Start-Qwen3Coder-SGLang.ps1', stop: 'Stop-Qwen3Coder-SGLang.ps1', pidFile: '\\\\wsl$\\Ubuntu-22.04-RAG\\root\\run\\sglang-qwen3coder.pid' }
};

function runScript(script) {
  return new Promise((resolve, reject) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { windowsHide: true, timeout: 30000 }, (error, stdout, stderr) => {
    if (error) return reject(new Error(String(stderr || stdout || error.message).trim()));
    resolve(String(stdout));
  }));
}

function createSglangServiceManager({ scriptsDir, stateFile, log = () => {} }) {
  let state = { holdUntil: null, operation: 'idle', selected: null, startedAt: null, lastError: null };
  let timer = null;
  let serial = Promise.resolve();
  try { state = { ...state, ...JSON.parse(fs.readFileSync(stateFile, 'utf8')) }; } catch { /* first start */ }
  const save = () => fs.writeFileSync(stateFile, JSON.stringify(state));
  const scheduleStop = () => {
    if (timer) clearTimeout(timer);
    if (!state.holdUntil) return;
    const delay = Date.parse(state.holdUntil) - Date.now();
    if (delay <= 0) return void stopAll({ clearHold: true }).catch((error) => log('expiry stop failed:', error.message));
    timer = setTimeout(() => stopAll({ clearHold: true }).catch((error) => log('expiry stop failed:', error.message)), delay);
    timer.unref();
  };
  const health = async (model) => {
    try { const response = await fetch(`http://127.0.0.1:${model.port}/health`, { signal: AbortSignal.timeout(1200) }); return response.ok; } catch { return false; }
  };
  const run = (fn) => { serial = serial.then(fn, fn); return serial; };
  async function status() {
    const models = await Promise.all(Object.entries(MODELS).map(async ([id, model]) => ({ id, label: model.label, port: model.port, running: await health(model) })));
    const selected = models.find((model) => model.id === state.selected);
    if (state.operation === 'starting' && selected?.running) {
      state.operation = 'running'; state.lastError = null; save();
    } else if (state.operation === 'starting' && state.startedAt && Date.now() - Date.parse(state.startedAt) > 8 * 1000 && !fs.existsSync(MODELS[state.selected]?.pidFile || '')) {
      state.operation = 'failed'; state.lastError = 'SGLang 起動プロセスが開始されませんでした。停止完了またはポート転送のエラーを確認してください。'; save();
    } else if (state.operation === 'starting' && state.startedAt && Date.now() - Date.parse(state.startedAt) > 10 * 60 * 1000) {
      state.operation = 'failed'; state.lastError = '10 分以内に SGLang API が起動しませんでした。ログを確認してください。'; save();
    }
    return { models, holdUntil: state.holdUntil, operation: state.operation, selected: state.selected, startedAt: state.startedAt, lastError: state.lastError };
  }
  async function stop(id) {
    const model = MODELS[id];
    if (!model) throw Object.assign(new Error('unknown SGLang model'), { code: 'BAD_REQUEST' });
    await runScript(require('node:path').join(scriptsDir, model.stop));
  }
  async function stopAll({ clearHold = false } = {}) {
    return run(async () => {
      state.operation = 'stopping'; save();
      await Promise.all(Object.keys(MODELS).map((id) => stop(id)));
      if (clearHold) state.holdUntil = null;
      state.operation = 'idle'; state.selected = null; state.startedAt = null; state.lastError = null; save();
      if (timer) { clearTimeout(timer); timer = null; }
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
      await Promise.all(Object.keys(MODELS).filter((other) => other !== id).map((other) => stop(other)));
      state.operation = 'starting'; state.selected = id; state.startedAt = new Date().toISOString(); state.lastError = null; save();
      try {
        await runScript(require('node:path').join(scriptsDir, 'sync-sglang-portproxy.ps1'));
        await runScript(require('node:path').join(scriptsDir, MODELS[id].start));
      }
      catch (error) { state.operation = 'failed'; state.lastError = error.message; save(); throw error; }
      return status();
    });
  }
  function setWorkHold(minutes) {
    state.holdUntil = minutes > 0 ? new Date(Date.now() + minutes * 60000).toISOString() : null;
    save(); scheduleStop();
    return minutes > 0 ? status() : stopAll({ clearHold: true });
  }
  scheduleStop();
  return { status, select, stopAll, setWorkHold };
}

module.exports = { createSglangServiceManager };
