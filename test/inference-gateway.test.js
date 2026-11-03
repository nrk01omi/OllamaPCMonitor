'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createInferenceGateway } = require('../inference-gateway');

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

test('8082 gateway lists choices and maps the selected ID to the backend model', async (t) => {
  const backend = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ path: req.url, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
  });
  const backendPort = await listen(backend);
  t.after(() => backend.close());
  const gateway = createInferenceGateway({
    modelSessions: {
      models: () => ({ object: 'list', data: [{ id: 'qwen38' }] }),
      activeModel: () => 'qwen38', hasActive: () => true
    },
    sglangServices: { status: async () => ({ models: [] }) },
    backends: { qwen38: { port: backendPort, model: 'qwen3.8-27b' } }
  });
  const gatewayPort = await listen(gateway);
  t.after(() => gateway.close());
  const base = `http://127.0.0.1:${gatewayPort}`;
  const catalog = await (await fetch(`${base}/v1/models`)).json();
  assert.deepEqual(catalog.data.map(({ id }) => id), ['qwen38']);
  const response = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'qwen38', messages: [{ role: 'user', content: 'hello' }] })
  });
  assert.equal(response.status, 200);
  const forwarded = await response.json();
  assert.equal(forwarded.path, '/v1/chat/completions');
  assert.equal(forwarded.body.model, 'qwen3.8-27b');
  const mismatch = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'strata128k' })
  });
  assert.equal(mismatch.status, 409);
});

test('gateway does not forward while a session is still starting', async (t) => {
  const gateway = createInferenceGateway({
    modelSessions: { models: () => ({ object: 'list', data: [] }), activeModel: () => null, hasActive: () => true },
    sglangServices: { status: async () => { throw new Error('must not inspect dashboard fallback'); } }
  });
  const port = await listen(gateway);
  t.after(() => gateway.close());
  const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'qwen38' })
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'model_not_ready');
});

test('8082 gateway forwards model session control requests', async (t) => {
  const control = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    res.writeHead(202, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ path: req.url, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
  });
  const controlPort = await listen(control);
  t.after(() => control.close());
  const gateway = createInferenceGateway({
    modelSessions: { models: () => ({ object: 'list', data: [] }), activeModel: () => null, hasActive: () => false },
    sglangServices: { status: async () => ({ models: [] }) }, controlPort
  });
  const port = await listen(gateway);
  t.after(() => gateway.close());
  const response = await fetch(`http://127.0.0.1:${port}/control/v1/model-sessions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'qwen3coder', ttl_seconds: 1800, request_id: 'test' })
  });
  assert.equal(response.status, 202);
  const forwarded = await response.json();
  assert.equal(forwarded.path, '/control/v1/model-sessions');
  assert.equal(forwarded.body.model, 'qwen3coder');
});

test('8082 gateway forwards /v1/systemone to OneJev and rewrites the model to the effective name', async (t) => {
  const backend = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ path: req.url, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
  });
  const backendPort = await listen(backend);
  t.after(() => backend.close());
  const gateway = createInferenceGateway({
    modelSessions: { models: () => ({ object: 'list', data: [] }), activeModel: () => 'onejev9b', hasActive: () => true },
    sglangServices: { status: async () => ({ models: [] }) },
    backends: { onejev9b: { port: backendPort, model: 'onejev1.6-9b' } }
  });
  const gatewayPort = await listen(gateway);
  t.after(() => gateway.close());
  const base = `http://127.0.0.1:${gatewayPort}`;
  const sent = { model: 'onejev9b', state: { question: 'q' }, questions: { best: { type: 'choice', criteria: { 0: 'a' } } } };
  const response = await fetch(`${base}/v1/systemone`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sent) });
  assert.equal(response.status, 200);
  const forwarded = await response.json();
  assert.equal(forwarded.path, '/v1/systemone');
  assert.equal(forwarded.body.model, 'onejev1.6-9b');
  assert.deepEqual(forwarded.body.questions, sent.questions);
  const mismatch = await fetch(`${base}/v1/systemone`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...sent, model: 'qwen38' }) });
  assert.equal(mismatch.status, 409);
});
