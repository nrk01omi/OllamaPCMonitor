'use strict';

const fs = require('node:fs');
const { execFile } = require('node:child_process');

const TASKS_BY_HOST = {
  '3090': { whisper: 'whisper-server', rerank: 'RerankServer' },
  '5090': { whisper: 'WhisperServer', rerank: 'RerankServer' }
};

function runPowerShell(command) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, timeout: 15000 }, (error, stdout, stderr) => {
      if (error) return reject(new Error(String(stderr || stdout || error.message).trim()));
      resolve(String(stdout));
    });
  });
}

function createGpuServiceManager({ hostId, stateFile, pauseFile, log = () => {} }) {
  const tasks = TASKS_BY_HOST[hostId] || null;
  let state = { pausedByMonitor: [], holdUntil: null };
  let resumeTimer = null;
  try { state = { ...state, ...JSON.parse(fs.readFileSync(stateFile, 'utf8')) }; } catch { /* first run */ }

  function save() { fs.writeFileSync(stateFile, JSON.stringify(state)); }
  function writePauseUntil(expiresAt) {
    if (!pauseFile) throw new Error('intentional-pause file is not configured');
    const pause = {
      schema: 1,
      source: 'ollama-pc-monitor',
      host_id: hostId,
      services: ['whisper', 'rerank'],
      paused: true,
      expires_at: expiresAt,
      updated_at: new Date().toISOString()
    };
    const temp = `${pauseFile}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(pause));
    fs.renameSync(temp, pauseFile);
    return pause.expires_at;
  }
  function writePause(minutes) { return writePauseUntil(new Date(Date.now() + minutes * 60000).toISOString()); }
  function clearPause() {
    if (!pauseFile) return;
    try { fs.unlinkSync(pauseFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  function scheduleResume() {
    if (resumeTimer) clearTimeout(resumeTimer);
    if (!state.holdUntil) return;
    if ((state.pausedByMonitor || []).length && Date.parse(state.holdUntil) > Date.now()) {
      try { writePauseUntil(state.holdUntil); } catch (error) { log('intentional pause write failed:', error.message); }
    }
    const delay = Date.parse(state.holdUntil) - Date.now();
    if (delay <= 0) return void resume().catch((error) => log('GPU service resume failed:', error.message));
    resumeTimer = setTimeout(() => resume().catch((error) => log('GPU service resume failed:', error.message)), delay);
    resumeTimer.unref();
  }
  async function taskStates() {
    if (!tasks) return [];
    const names = Object.values(tasks);
    const escaped = names.map((name) => `'${name.replaceAll("'", "''")}'`).join(',');
    const output = await runPowerShell(`Get-ScheduledTask -TaskName ${escaped} | Select-Object TaskName,State | ConvertTo-Json -Compress`);
    const parsed = JSON.parse(output || '[]');
    return Array.isArray(parsed) ? parsed : [parsed];
  }
  async function stop(names) {
    if (!names.length) return;
    const escaped = names.map((name) => `'${name.replaceAll("'", "''")}'`).join(',');
    await runPowerShell(`@(${escaped}) | ForEach-Object { Stop-ScheduledTask -TaskName $_ -ErrorAction Stop }`);
  }
  async function start(names) {
    if (!names.length) return;
    const escaped = names.map((name) => `'${name.replaceAll("'", "''")}'`).join(',');
    await runPowerShell(`@(${escaped}) | ForEach-Object { Start-ScheduledTask -TaskName $_ -ErrorAction Stop }`);
  }
  async function pause(minutes) {
    if (!tasks) return { supported: false, paused: [] };
    // Extending an existing declaration must not forget which tasks this
    // monitor stopped; otherwise the later expiry could not restart them.
    if ((state.pausedByMonitor || []).length) {
      state.holdUntil = writePause(minutes);
      save(); scheduleResume();
      return { supported: true, paused: state.pausedByMonitor, holdUntil: state.holdUntil };
    }
    const running = (await taskStates()).filter((task) => Number(task.State) === 4).map((task) => task.TaskName);
    const holdUntil = writePause(minutes);
    try { await stop(running); }
    catch (error) {
      // Do not leave only one model service down after a partial failure.
      try { await start(running); } catch { /* report original error */ }
      try { clearPause(); } catch { /* report original error */ }
      throw error;
    }
    state = { pausedByMonitor: running, holdUntil };
    save(); scheduleResume();
    return { supported: true, paused: running, holdUntil: state.holdUntil };
  }
  async function resume() {
    if (!tasks) return { supported: false, resumed: [] };
    const names = state.pausedByMonitor || [];
    await start(names);
    clearPause();
    state = { pausedByMonitor: [], holdUntil: null }; save();
    if (resumeTimer) { clearTimeout(resumeTimer); resumeTimer = null; }
    return { supported: true, resumed: names };
  }
  async function setWorkHold(minutes) { return minutes > 0 ? pause(minutes) : resume(); }
  async function getStatus() {
    if (!tasks) return { supported: false, hostId, services: [] };
    let taskList = []; let taskError = null;
    try { taskList = await taskStates(); } catch (error) { taskError = error.message; }
    const byName = new Map(taskList.map((task) => [task.TaskName, task]));
    const services = await Promise.all(Object.entries(tasks).map(async ([kind, taskName]) => {
      const port = kind === 'whisper' ? 11436 : 11437;
      let health = false;
      try { const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) }); health = response.ok; } catch { /* stopped or unavailable */ }
      const task = byName.get(taskName);
      return { kind, taskName, taskState: task ? task.State : null, running: task ? Number(task.State) === 4 : null, health };
    }));
    return { supported: true, hostId, pausedByMonitor: state.pausedByMonitor, holdUntil: state.holdUntil, taskError, services };
  }
  function getSnapshot() { return { supported: Boolean(tasks), hostId, pausedByMonitor: state.pausedByMonitor, holdUntil: state.holdUntil }; }
  scheduleResume();
  return { setWorkHold, getSnapshot, getStatus, resume };
}

module.exports = { createGpuServiceManager };
