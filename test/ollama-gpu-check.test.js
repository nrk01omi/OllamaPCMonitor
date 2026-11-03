'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createOllamaGpuCheck } = require('../ollama-gpu-check');

test('allows startup when both Ollama instances have no loaded models', async () => {
  const calls = [];
  const request = async (url, options) => {
    calls.push({ url, method: options.method || 'GET' });
    return { ok: true, json: async () => ({ models: [] }) };
  };
  await createOllamaGpuCheck(['http://127.0.0.1:11434', 'http://127.0.0.1:11500'], { request })();
  assert.deepEqual(calls.map((call) => call.method), ['GET', 'GET']);
  assert.ok(calls.every((call) => call.url.endsWith('/api/ps')));
});

test('returns 409 gpu_busy when Ollama has a loaded model', async () => {
  const request = async () => ({ ok: true, json: async () => ({ models: [{ name: 'loaded' }] }) });
  await assert.rejects(createOllamaGpuCheck(['http://127.0.0.1:11434'], { request })(),
    (error) => error.status === 409 && error.code === 'gpu_busy');
});

test('returns state_unavailable when Ollama state cannot be read', async () => {
  const request = async () => { throw new Error('timeout'); };
  await assert.rejects(createOllamaGpuCheck(['http://127.0.0.1:11500'], { request })(),
    (error) => error.status === 503 && error.code === 'state_unavailable');
});
