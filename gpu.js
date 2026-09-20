'use strict';

const { execFile } = require('node:child_process');

function runNvidiaSmi(args) {
  return new Promise((resolve) => {
    execFile('nvidia-smi.exe', args, { windowsHide: true, timeout: 3000 }, (error, stdout) => {
      if (error) return resolve(null);
      resolve(String(stdout).trim());
    });
  });
}

// NVIDIA reports these values in MiB.  This is GPU-wide usage, so it includes
// Ollama and independent local services such as Whisper or rerankers.
async function getGpuStatus() {
  const output = await runNvidiaSmi(['--query-gpu=name,memory.total,memory.used,memory.free,utilization.gpu', '--format=csv,noheader,nounits']);
  if (!output) return null;
  const gpus = output.split(/\r?\n/).map((line) => {
    const [name, totalMiB, usedMiB, freeMiB, utilizationPct] = line.split(',').map((value) => value.trim());
    const total = Number(totalMiB); const used = Number(usedMiB);
    if (!Number.isFinite(total) || !Number.isFinite(used)) return null;
    return { name, totalMiB: total, usedMiB: used, freeMiB: Number(freeMiB), utilizationPct: Number(utilizationPct), usedPct: Math.min(100, Math.round(used / total * 100)) };
  }).filter(Boolean);
  return gpus.length ? gpus : null;
}

module.exports = { getGpuStatus };
