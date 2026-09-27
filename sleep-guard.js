'use strict';

// Keeps one PowerShell thread alive with ES_SYSTEM_REQUIRED.  The execution
// state is scoped to that thread, and Windows drops it automatically if the
// child dies, so a monitor crash cannot leave the machine awake indefinitely.
const { spawn } = require('node:child_process');

function createSleepGuard({ script, log = () => {} }) {
  let child = null;
  let wanted = false;

  function start() {
    if (!wanted || child) return;
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
        windowsHide: true,
        stdio: 'ignore'
      });
      child.once('error', (error) => log('sleep guard error:', error.message));
      child.once('exit', (code) => {
        child = null;
        if (wanted) {
          log(`sleep guard exited (${code}); retrying`);
          setTimeout(start, 3000).unref();
        }
      });
    } catch (error) { log('sleep guard start failed:', error.message); }
  }

  function setActive(active) {
    wanted = Boolean(active);
    if (wanted) start();
    else if (child) { child.kill(); child = null; }
  }

  return { setActive, get active() { return wanted; }, get running() { return Boolean(child); } };
}

module.exports = { createSleepGuard };
