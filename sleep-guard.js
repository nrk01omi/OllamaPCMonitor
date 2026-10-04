'use strict';

// Keeps one PowerShell thread alive with ES_SYSTEM_REQUIRED.  The execution
// state is scoped to that thread, and Windows drops it automatically if the
// child dies, so a monitor crash cannot leave the machine awake indefinitely.
const { spawn } = require('node:child_process');

function createSleepGuard({ script, log = () => {} }) {
  let child = null;
  let wanted = false;
  let sglangActive = false;
  let workHoldUntil = 0;
  let expiryTimer = null;

  function start() {
    if (!wanted || child) return;
    try {
      const spawned = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
        windowsHide: true,
        stdio: 'ignore'
      });
      child = spawned;
      spawned.once('error', (error) => log('sleep guard error:', error.message));
      spawned.once('exit', (code) => {
        if (child === spawned) child = null;
        if (wanted && !child) {
          log(`sleep guard exited (${code}); retrying`);
          setTimeout(start, 3000).unref();
        }
      });
    } catch (error) { log('sleep guard start failed:', error.message); }
  }

  function update() {
    const next = sglangActive || workHoldUntil > Date.now();
    if (next !== wanted) log(`sleep prevention ${next ? 'on' : 'off'} (work hold: ${workHoldUntil > Date.now()}, SGLang: ${sglangActive})`);
    wanted = next;
    if (wanted) start();
    else if (child) { child.kill(); child = null; }
  }

  function setActive(active) {
    sglangActive = Boolean(active);
    update();
  }

  function setWorkHoldUntil(value) {
    if (expiryTimer) { clearTimeout(expiryTimer); expiryTimer = null; }
    const parsed = value ? Date.parse(value) : NaN;
    workHoldUntil = Number.isFinite(parsed) && parsed > Date.now() ? parsed : 0;
    if (workHoldUntil) {
      expiryTimer = setTimeout(() => { workHoldUntil = 0; expiryTimer = null; update(); }, workHoldUntil - Date.now());
      expiryTimer.unref();
    }
    update();
  }

  function stop() {
    sglangActive = false;
    setWorkHoldUntil(null);
  }

  return { setActive, setWorkHoldUntil, stop, get active() { return wanted; }, get running() { return Boolean(child); } };
}

module.exports = { createSleepGuard };
