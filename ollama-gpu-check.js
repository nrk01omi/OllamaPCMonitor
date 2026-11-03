'use strict';

const fault = (status, code, message) => Object.assign(new Error(message), { status, code });

function createOllamaGpuCheck(urls, { request = fetch } = {}) {
  const targets = [...new Set(urls.map((url) => new URL(url).origin))];
  return async function checkOllamaGpu() {
    for (const base of targets) {
      let response;
      try {
        response = await request(`${base}/api/ps`, { signal: AbortSignal.timeout(3000) });
      } catch (error) {
        if (error.cause?.code === 'ECONNREFUSED') continue;
        throw fault(503, 'state_unavailable', `Ollama ${base} の状態を確認できません: ${error.message}`);
      }
      if (!response.ok) throw fault(503, 'state_unavailable', `Ollama ${base} /api/ps returned ${response.status}`);
      let body;
      try { body = await response.json(); } catch { throw fault(503, 'state_unavailable', `Ollama ${base} returned invalid JSON`); }
      if (!Array.isArray(body.models)) throw fault(503, 'state_unavailable', `Ollama ${base} returned an invalid /api/ps response`);
      if (body.models.length) throw fault(409, 'gpu_busy', `Ollama ${base} にモデルがロードされています`);
    }
  };
}

module.exports = { createOllamaGpuCheck };
