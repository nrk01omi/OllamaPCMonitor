'use strict';
// PC presence reporter for NKS (contract pc-presence-v1 v1.1).
// This module only MEASURES and SENDS. It never decides "is someone here" or "when will it sleep":
// the NKS response is passed through unchanged (getSnapshot().nks.response).
const { spawn, execFile } = require('node:child_process');
const fsp = require('node:fs/promises');
const os = require('node:os');
const readline = require('node:readline');

const POWERCFG_ARGS = ['/q', 'SCHEME_CURRENT', '238c9fa8-0aad-41ed-83f4-97be242c8f20', '29f6c1db-86da-48c5-9fdb-f2b67b1f44da']; // SUB_SLEEP / STANDBYIDLE
// Only real inference counts as "local use". Polling calls (/api/ps, /api/tags) must not,
// otherwise the dashboard's own status refresh would keep local_busy on forever.
const INFERENCE_PATH = /^\/(api\/(chat|generate|embed|embeddings)|v1\/(chat\/completions|completions|embeddings))\/?$/;
const PROBE_FRESH_MS = 5000;

function isInferencePath(url) {
  return INFERENCE_PATH.test(String(url || '').split('?')[0]);
}

function createPresence(opts) {
  const env = opts.env || process.env;
  const log = opts.log || (() => {});
  const version = opts.version || '0.0.0';
  const onPowerEvent = opts.onPowerEvent || (() => {});
  const nksUrl = String(env.NKS_URL || '').replace(/\/+$/, '');
  const apiKey = env.NKS_API_KEY || '';
  const hostId = env.NKS_HOST_ID || '';
  const heartbeatSec = Math.max(5, parseInt(env.NKS_HEARTBEAT_SEC, 10) || 30);
  const decayMin = Math.max(1, parseInt(env.LOCAL_BUSY_DECAY_MIN, 10) || 10);
  const configured = Boolean(nksUrl && apiKey && (hostId === '3090' || hostId === '5090'));

  let stopped = false;
  let probeChild = null;
  let probe = { idleSec: null, locked: null, updatedAt: 0 };
  let standbyTimeoutMin = null;
  let localLastAt = null;
  let localModel = null;
  const nks = { response: null, receivedAt: null, lastOkAt: null, lastAttemptAt: null, consecutiveFailures: 0, lastError: null };
  const timers = [];
  let heartbeatInFlight = false;
  let lastResumeAt = 0;
  const power = {
    startedAt: new Date().toISOString(),
    lastSuspendAt: null,
    lastResumeAt: null
  };
  function recordPowerEvent(type, timestamp = new Date().toISOString()) {
    try { onPowerEvent({ type, timestamp }); } catch (error) { log('power event write failed:', error.message); }
  }

  // ---- local addresses -------------------------------------------------------------------
  let lanAddresses = new Set();
  function refreshLanAddresses() {
    const found = new Set();
    for (const list of Object.values(os.networkInterfaces())) {
      for (const info of list || []) if (info.family === 'IPv4' || info.family === 4) found.add(info.address);
    }
    lanAddresses = found;
  }
  // 127.0.0.2 is deliberately NOT local: server.js uses it as the source address of the proxy's own
  // upstream calls, so that forwarded (possibly NAS) requests are not mistaken for local use.
  function isLocalAddress(addr) {
    const clean = String(addr || '').replace(/^::ffff:/, '');
    return clean === '127.0.0.1' || clean === '::1' || lanAddresses.has(clean);
  }

  // ---- local busy ------------------------------------------------------------------------
  function noteLocal(model) {
    localLastAt = Date.now();
    if (model && model !== 'なし') localModel = model;
  }
  function localBusy(now = Date.now()) {
    return localLastAt != null && now - localLastAt < decayMin * 60000;
  }
  function noteProxyRequest({ remoteAddress, url, model }) {
    if (isLocalAddress(remoteAddress) && isInferencePath(url)) noteLocal(model);
  }

  // Dedicated Ollama (the local MCP server's own instance). Its requests reach neither our proxy nor
  // the main access log, but every request refreshes the loaded model's expires_at.
  let psSeeded = false;
  let psExpires = new Map();
  async function pollLocalOllama() {
    if (!opts.localOllamaUrl) return;
    let models;
    try {
      const res = await fetch(new URL('/api/ps', opts.localOllamaUrl), { signal: AbortSignal.timeout(3000) });
      if (!res.ok) return;
      models = (await res.json()).models || [];
    } catch { return; }
    const next = new Map(models.map((m) => [m.name, m.expires_at]));
    if (psSeeded) for (const [name, expires] of next) if (psExpires.get(name) !== expires) noteLocal(name);
    psExpires = next;
    psSeeded = true; // the first successful poll only seeds: models that were already loaded are not "activity"
  }

  // Main Ollama access log: count only inference calls from this machine.
  let logOffset = null;
  let logRemainder = '';
  function scanLogLine(line) {
    // [GIN] 2026/09/19 - 13:45:08 | 200 |  4.6ms |   192.168.0.198 | POST     "/api/chat"
    const parts = line.split('|');
    if (parts.length < 5 || !line.startsWith('[GIN]')) return;
    const requestPath = parts[4].match(/"([^"]+)"/);
    if (requestPath && isLocalAddress(parts[3].trim()) && isInferencePath(requestPath[1])) noteLocal(null);
  }
  async function tailOllamaLog() {
    if (!opts.ollamaLogFile) return;
    try {
      const { size } = await fsp.stat(opts.ollamaLogFile);
      if (logOffset === null) { logOffset = size; return; } // first run: skip history
      if (size < logOffset) { logOffset = 0; logRemainder = ''; } // shrunk: rotated
      if (size === logOffset) return;
      const handle = await fsp.open(opts.ollamaLogFile, 'r');
      try {
        const buffer = Buffer.alloc(Math.min(1024 * 1024, size - logOffset));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, logOffset);
        logOffset += bytesRead;
        const lines = (logRemainder + buffer.toString('utf8', 0, bytesRead)).split('\n');
        logRemainder = lines.pop();
        lines.forEach(scanLogLine);
      } finally { await handle.close(); }
    } catch { /* log missing or locked: try again next tick */ }
  }

  // ---- standby timeout -------------------------------------------------------------------
  function readStandbyTimeout() {
    return new Promise((resolve) => {
      execFile('powercfg', POWERCFG_ARGS, { windowsHide: true, timeout: 10000 }, (error, stdout) => {
        // Output is localised: rely on the hex values only. The last two are AC then DC (seconds).
        const hex = !error && String(stdout).match(/0x[0-9a-fA-F]+/g);
        if (hex && hex.length >= 2) standbyTimeoutMin = Math.round(parseInt(hex[hex.length - 2], 16) / 60); // 0 = disabled, still sent
        resolve();
      });
    });
  }

  // ---- resident probe --------------------------------------------------------------------
  function spawnProbe() {
    if (stopped || probeChild) return;
    let child;
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', opts.probeScript, '-ParentPid', String(process.pid)], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (error) { log('probe spawn failed:', error.message); setTimeout(spawnProbe, 5000).unref(); return; }
    probeChild = child;
    let gone = false;
    const onGone = () => {
      if (gone) return;
      gone = true;
      if (probeChild === child) probeChild = null;
      if (!stopped) setTimeout(spawnProbe, 5000).unref();
    };
    child.once('error', (error) => { log('probe error:', error.message); onGone(); });
    child.once('exit', onGone);
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      const sample = line.match(/^S (\d+) ([01])$/);
      if (sample) { probe = { idleSec: Number(sample[1]), locked: sample[2] === '1', updatedAt: Date.now() }; return; }
      if (line === 'E suspend') onSuspend();
      else if (line === 'E resume') onResume();
    });
  }
  const probeAlive = (now = Date.now()) => now - probe.updatedAt < PROBE_FRESH_MS;

  // ---- NKS -------------------------------------------------------------------------------
  async function nksRequest(method, pathAndQuery, payload, timeoutMs = 10000) {
    nks.lastAttemptAt = new Date().toISOString();
    try {
      const response = await fetch(nksUrl + pathAndQuery, {
        method,
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
        body: payload === undefined ? undefined : JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs)
      });
      const text = await response.text();
      let body = null;
      try { body = JSON.parse(text); } catch { /* reported below */ }
      if (!response.ok) {
        const detail = body && body.detail !== undefined ? body.detail : text.slice(0, 200);
        throw new Error(`HTTP ${response.status}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
      }
      if (!body || typeof body !== 'object') throw new Error('NKS の応答が JSON ではありません');
      Object.assign(nks, { response: body, receivedAt: Date.now(), lastOkAt: new Date().toISOString(), consecutiveFailures: 0, lastError: null });
      return body;
    } catch (error) {
      nks.consecutiveFailures++;
      // The previous response is kept as-is (getSnapshot marks it stale via status)
      nks.lastError = error.name === 'TimeoutError' ? `タイムアウト（${timeoutMs / 1000} 秒）`
        : error.cause && error.cause.code ? `接続できません（${error.cause.code}）` : error.message;
      throw error;
    }
  }

  async function sendHeartbeat() {
    if (!configured || heartbeatInFlight) return;
    heartbeatInFlight = true;
    try {
      const now = Date.now();
      const body = { host: hostId, source: `ollama-pc-monitor/${version}`, sent_at: new Date(now).toISOString(), local_busy: localBusy(now) };
      if (probeAlive(now)) { body.idle_sec = probe.idleSec; body.session_locked = probe.locked; } // stale/unknown is omitted, never sent as 0/false
      if (standbyTimeoutMin !== null) body.standby_timeout_min = standbyTimeoutMin;
      if (localLastAt) body.local_last_at = new Date(localLastAt).toISOString();
      if (localModel) body.local_model = localModel;
      await nksRequest('POST', '/api/power/pc-presence', body);
    } catch (error) {
      log('heartbeat failed:', nks.lastError);
    } finally { heartbeatInFlight = false; }
  }

  function onResume() {
    if (Date.now() - lastResumeAt < 10000) return;
    lastResumeAt = Date.now();
    power.lastResumeAt = new Date(lastResumeAt).toISOString();
    recordPowerEvent('resume', power.lastResumeAt);
    sendHeartbeat();
  }
  // The PC is about to sleep: release the work declaration NOW (no delay, short timeout).
  // If this does not get through, NKS releases it when it sees the machine stop.
  function onSuspend() {
    power.lastSuspendAt = new Date().toISOString();
    recordPowerEvent('suspend', power.lastSuspendAt);
    if (!configured) return;
    nksRequest('POST', '/api/power/pc-work-hold', { host: hostId, minutes: 0 }, 3000).catch(() => {});
  }

  async function setWorkHold(minutes, reason) {
    if (!configured) { const error = new Error('NKS が未設定です（NKS_URL / NKS_API_KEY / NKS_HOST_ID）'); error.code = 'UNCONFIGURED'; throw error; }
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > 480) { const error = new Error('minutes は 0〜480 の整数です'); error.code = 'BAD_REQUEST'; throw error; }
    const body = { host: hostId, minutes };
    if (minutes > 0 && typeof reason === 'string' && reason.trim()) body.reason = reason.trim().slice(0, 100);
    await nksRequest('POST', '/api/power/pc-work-hold', body);
    return getSnapshot();
  }

  async function refresh() {
    if (!configured) return getSnapshot();
    await nksRequest('GET', `/api/power/pc-presence?host=${encodeURIComponent(hostId)}`).catch(() => {});
    return getSnapshot();
  }

  // ---- snapshot --------------------------------------------------------------------------
  function nksStatus(now) {
    if (!configured) return 'unconfigured';
    if (!nks.lastAttemptAt) return 'pending';
    if (nks.consecutiveFailures >= 2) return 'failing';
    if (nks.receivedAt === null) return nks.consecutiveFailures > 0 ? 'failing' : 'pending';
    return now - nks.receivedAt > 3 * heartbeatSec * 1000 ? 'failing' : 'ok';
  }

  function getSnapshot() {
    const now = Date.now();
    const alive = probeAlive(now);
    return {
      now, version, configured,
      hostId: configured ? hostId : null,
      nksUrl: configured ? nksUrl : null,
      probe: { alive, idleSec: alive ? probe.idleSec : null, locked: alive ? probe.locked : null, updatedAt: probe.updatedAt || null },
      // This process only runs while Windows is awake. A live probe therefore means
      // the PC is operating; the timestamps retain the most recent sleep cycle.
      power: { operating: alive, startedAt: power.startedAt, lastSuspendAt: power.lastSuspendAt, lastResumeAt: power.lastResumeAt },
      standbyTimeoutMin,
      local: { busy: localBusy(now), lastAt: localLastAt ? new Date(localLastAt).toISOString() : null, model: localModel, decayMin },
      nks: { status: nksStatus(now), response: nks.response, receivedAt: nks.receivedAt, lastOkAt: nks.lastOkAt, lastAttemptAt: nks.lastAttemptAt, consecutiveFailures: nks.consecutiveFailures, lastError: nks.lastError }
    };
  }

  // ---- lifecycle -------------------------------------------------------------------------
  function every(ms, fn) {
    const timer = setInterval(() => { Promise.resolve().then(fn).catch((error) => log('timer error:', error.message)); }, ms);
    timer.unref();
    timers.push(timer);
  }

  function start() {
    recordPowerEvent('start', power.startedAt);
    refreshLanAddresses();
    spawnProbe();
    pollLocalOllama();
    tailOllamaLog();
    // First heartbeat right away, but give the first measurements (idle time, standby setting) up to 3 s so it is not sent blind.
    const firstProbeSample = new Promise((resolve) => {
      const began = Date.now();
      const wait = setInterval(() => { if (probeAlive() || Date.now() - began > 3000) { clearInterval(wait); resolve(); } }, 100);
    });
    Promise.all([readStandbyTimeout(), firstProbeSample]).then(sendHeartbeat);
    every(60000, refreshLanAddresses);
    every(60000, readStandbyTimeout);
    every(5000, pollLocalOllama);
    every(3000, tailOllamaLog);
    every(heartbeatSec * 1000, sendHeartbeat);
    // Resume fallback: a long gap between ticks means the machine was asleep.
    let lastTick = Date.now();
    every(5000, () => { const now = Date.now(); const slept = now - lastTick > 30000; lastTick = now; if (slept) onResume(); });
  }

  function stop() {
    recordPowerEvent('stop');
    stopped = true;
    timers.forEach(clearInterval);
    if (probeChild) probeChild.kill();
  }

  return { start, stop, noteProxyRequest, getSnapshot, refresh, setWorkHold, isLocalAddress };
}

module.exports = { createPresence, isInferencePath };
