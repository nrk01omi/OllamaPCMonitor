'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createModelSessions } = require('../model-sessions');

function manager(workHoldUntil = null, checkOllamaGpu = async () => {}) {
  let pauses = 0;
  const instance = createModelSessions({
    stateFile: path.join(os.tmpdir(), `opm-session-test-${crypto.randomUUID()}.json`),
    scriptsDir: '.',
    gpuServices: {
      getStatus: async () => ({ supported: true, taskError: null, services: [
        { running: true, health: true }, { running: true, health: true }
      ] }),
      getSnapshot: () => ({ holdUntil: null }),
      setWorkHold: async () => { pauses++; }
    },
    sglangServices: { status: async () => ({ operation: 'idle', models: [] }) },
    presence: { getSnapshot: () => ({ nks: { status: 'ok', response: { work_hold_until: workHoldUntil } }, local: { busy: false } }) },
    sleepGuard: { setSessionActive: () => {} },
    policyReady: () => true,
    checkOllamaGpu,
    readStrataStatus: async () => null,
    isStrataPortOpen: async () => false
  });
  return { instance, pauses: () => pauses };
}

test('all four model sessions return 409 before reserving GPU when Ollama is loaded', async () => {
  const busy = async () => { throw Object.assign(new Error('Ollama model loaded'), { status: 409, code: 'gpu_busy' }); };
  for (const model of ['strata128k', 'strata128kvision', 'qwen38', 'qwen3coder']) {
    const { instance, pauses } = manager(null, busy);
    const availability = await instance.availability();
    assert.equal(availability.http_status, 409);
    assert.equal(availability.code, 'gpu_busy');
    await assert.rejects(instance.create({ model, ttl_seconds: 1800, request_id: `busy-${model}` }),
      { status: 409, code: 'gpu_busy' });
    assert.equal(pauses(), 0);
  }
});

test('availability reports a human hold without changing GPU services', async () => {
  const { instance, pauses } = manager(new Date(Date.now() + 60_000).toISOString());
  const result = await instance.availability();
  assert.equal(result.available, false);
  assert.equal(result.code, 'human_work_hold');
  assert.equal(result.http_status, 409);
  assert.equal(result.retry_after_s, 30);
  assert.equal(pauses(), 0);
  await assert.rejects(instance.create({ model: 'strata128k', ttl_seconds: 1800, request_id: 'test-hold' }),
    { status: 409, code: 'human_work_hold' });
  assert.equal(pauses(), 0);
  await assert.rejects(instance.create({ model: 'strata128kvision', ttl_seconds: 1800, request_id: 'test-vision-hold' }),
    { status: 409, code: 'human_work_hold' });
  assert.equal(pauses(), 0);
});

test('unknown model is rejected before attempting to reserve the GPU', async () => {
  const { instance, pauses } = manager();
  await assert.rejects(instance.create({ model: 'strata128kother', ttl_seconds: 1800, request_id: 'test-unknown' }),
    { status: 400, code: 'bad_request' });
  assert.equal(pauses(), 0);
});

test('model catalog exposes all selectable variants while stopped', () => {
  const { instance } = manager();
  const catalog = instance.models();
  assert.equal(catalog.object, 'list');
  assert.deepEqual(catalog.data.map(({ id, vision, ready }) => ({ id, vision, ready })), [
    { id: 'strata128k', vision: false, ready: false },
    { id: 'strata128kvision', vision: true, ready: false },
    { id: 'qwen38', vision: false, ready: false },
    { id: 'qwen3coder', vision: false, ready: false },
    { id: 'onejev9b', vision: false, ready: false }
  ]);
  assert.equal(catalog.data.find(({ id }) => id === 'qwen38').context_window, 65536);
  const onejev = catalog.data.find(({ id }) => id === 'onejev9b');
  assert.deepEqual([onejev.api, onejev.inference_port, onejev.inference_model, onejev.context_window],
    ['systemone', 8082, 'onejev1.6-9b', 16384]);
  assert.deepEqual(catalog.data.filter(({ id }) => id !== 'onejev9b').map(({ api, inference_port }) => [api, inference_port]),
    Array(4).fill(['openai', 8082]));
});

test('Qwen session selects SGLang launcher and reports the served model ID', async () => {
  const scripts = [];
  const instance = createModelSessions({
    stateFile: path.join(os.tmpdir(), `opm-session-test-${crypto.randomUUID()}.json`), scriptsDir: '.',
    gpuServices: {
      getStatus: async () => ({ supported: true, taskError: null, services: [{ running: false, health: false }] }),
      getSnapshot: () => ({ holdUntil: null }), setWorkHold: async () => {}, resume: async () => {}
    },
    sglangServices: { status: async () => ({ operation: 'idle', models: [] }) },
    presence: { getSnapshot: () => ({ nks: { status: 'ok', response: {} }, local: { busy: false } }) },
    sleepGuard: { setSessionActive: () => {} }, policyReady: () => true,
    readGpuStatus: async () => [{ freeMiB: 24000 }], readStrataStatus: async () => null,
    isStrataPortOpen: async () => false,
    readSglangStatus: async () => ({ ready: true, context: { max_positions: 65536 }, vision: { enabled: false, available: false } }),
    runScript: async (file) => { scripts.push(path.basename(file)); }
  });
  const session = await instance.create({ model: 'qwen38', ttl_seconds: 1800, request_id: 'test-qwen' });
  for (let i = 0; i < 30 && !instance.get(session.session_id).ready; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  const state = instance.get(session.session_id);
  assert.equal(state.ready, true);
  assert.equal(state.effective_model, 'qwen3.8-27b');
  assert.equal(state.context.max_positions, 65536);
  assert.deepEqual(scripts.slice(0, 2), ['sync-sglang-portproxy.ps1', 'Start-Qwen38-SGLang.ps1']);
  await instance.release(session.session_id);
  assert.equal(scripts.at(-1), 'Stop-Qwen38-SGLang.ps1');
});

test('OneJev session keeps Whisper and the reranker running and releases with an empty stopped list', async () => {
  const scripts = [];
  let holds = 0;
  const instance = createModelSessions({
    stateFile: path.join(os.tmpdir(), `opm-session-test-${crypto.randomUUID()}.json`), scriptsDir: '.',
    gpuServices: {
      getStatus: async () => ({ supported: true, taskError: null, services: [{ running: true, health: true }] }),
      getSnapshot: () => ({ holdUntil: null }), setWorkHold: async () => { holds++; }, resume: async () => { holds++; }
    },
    sglangServices: { status: async () => ({ operation: 'idle', models: [] }) },
    presence: { getSnapshot: () => ({ nks: { status: 'ok', response: {} }, local: { busy: false } }) },
    sleepGuard: { setSessionActive: () => {} }, policyReady: () => true,
    readGpuStatus: async () => [{ freeMiB: 21000 }], readStrataStatus: async () => null,
    isStrataPortOpen: async () => false,
    readSglangStatus: async () => ({ ready: true, context: { max_positions: 16384 }, vision: { enabled: false, available: false } }),
    runScript: async (file) => { scripts.push(path.basename(file)); }
  });
  const session = await instance.create({ model: 'onejev9b', ttl_seconds: 1800, request_id: 'test-onejev' });
  for (let i = 0; i < 30 && !instance.get(session.session_id).ready; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  const state = instance.get(session.session_id);
  assert.equal(state.ready, true);
  assert.equal(state.effective_model, 'onejev1.6-9b');
  assert.equal(state.context.max_positions, 16384);
  assert.equal(state.vision.enabled, false);
  await instance.extend(session.session_id, 1800);
  await assert.rejects(() => instance.create({ model: 'strata128k', ttl_seconds: 1800, request_id: 'other' }),
    { code: 'session_conflict' });
  assert.deepEqual(await instance.release(session.session_id), { state: 'idle', stopped_by_session: [], restored: [] });
  assert.deepEqual(scripts, ['sync-sglang-portproxy.ps1', 'Start-OneJev-Flide.ps1', 'Stop-OneJev-Flide.ps1']);
  assert.equal(holds, 0);
});

test('OneJev is refused when too little VRAM is free', async () => {
  const instance = createModelSessions({
    stateFile: path.join(os.tmpdir(), `opm-session-test-${crypto.randomUUID()}.json`), scriptsDir: '.',
    gpuServices: {
      getStatus: async () => ({ supported: true, taskError: null, services: [{ running: true, health: true }] }),
      getSnapshot: () => ({ holdUntil: null }), setWorkHold: async () => {}, resume: async () => {}
    },
    sglangServices: { status: async () => ({ operation: 'idle', models: [] }) },
    presence: { getSnapshot: () => ({ nks: { status: 'ok', response: {} }, local: { busy: false } }) },
    sleepGuard: { setSessionActive: () => {} }, policyReady: () => true,
    readGpuStatus: async () => [{ freeMiB: 12000 }], readStrataStatus: async () => null,
    isStrataPortOpen: async () => false, runScript: async () => { throw new Error('must not start'); }
  });
  const session = await instance.create({ model: 'onejev9b', ttl_seconds: 1800, request_id: 'test-lowvram' });
  for (let i = 0; i < 30 && instance.get(session.session_id).state !== 'failed'; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(instance.get(session.session_id).error_code, 'gpu_busy');
});

test('vision session selects its launcher and waits for image input availability', async () => {
  let launched = false;
  let imageAvailable = false;
  const scripts = [];
  const instance = createModelSessions({
    stateFile: path.join(os.tmpdir(), `opm-session-test-${crypto.randomUUID()}.json`),
    scriptsDir: '.',
    gpuServices: {
      getStatus: async () => ({ supported: true, taskError: null, services: [{ running: false, health: false }] }),
      getSnapshot: () => ({ holdUntil: null }),
      setWorkHold: async () => {}, resume: async () => {}
    },
    sglangServices: { status: async () => ({ operation: 'idle', models: [] }) },
    presence: { getSnapshot: () => ({ nks: { status: 'ok', response: {} }, local: { busy: false } }) },
    sleepGuard: { setSessionActive: () => {} }, policyReady: () => true,
    readGpuStatus: async () => [{ freeMiB: 24000 }], isStrataPortOpen: async () => false,
    readStrataStatus: async () => launched ? {
      loaded: true, model: 'qwen3.8-flash-next-iq2_xs', context: { max_positions: 131072 },
      vision: { enabled: true, available: imageAvailable }
    } : null,
    runScript: async (file) => { scripts.push(path.basename(file)); launched = true; }
  });
  const session = await instance.create({ model: 'strata128kvision', ttl_seconds: 1800, request_id: 'test-vision' });
  assert.equal(session.model, 'strata128kvision');
  for (let i = 0; i < 30 && !launched; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(scripts[0], 'Start-Strata-Vision-Managed.ps1');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(instance.get(session.session_id).ready, false);
  imageAvailable = true;
  for (let i = 0; i < 30 && !instance.get(session.session_id).ready; i++)
    await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(instance.get(session.session_id).ready, true);
  assert.equal(instance.models().data.find(({ id }) => id === 'strata128kvision').ready, true);
  await instance.release(session.session_id);
});

test('availability reports a clear preflight and unknown IDs use session_not_found', async () => {
  const { instance, pauses } = manager();
  const result = await instance.availability();
  assert.equal(result.available, true);
  assert.equal(result.code, null);
  assert.equal(result.http_status, null);
  assert.equal(pauses(), 0);
  const id = crypto.randomUUID();
  assert.throws(() => instance.get(id), { status: 404, code: 'session_not_found' });
  await assert.rejects(instance.extend(id, 1800), { status: 404, code: 'session_not_found' });
  await assert.rejects(instance.release(id), { status: 404, code: 'session_not_found' });
});
