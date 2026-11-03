'use strict';

const http = require('node:http');

const BACKENDS = {
  strata128k: { port: 18082, model: 'qwen3.8-flash-next-iq2_xs' },
  strata128kvision: { port: 18082, model: 'qwen3.8-flash-next-iq2_xs' },
  qwen38: { port: 30000, model: 'qwen3.8-27b' },
  qwen3coder: { port: 30001, model: 'qwen3-coder-30b' },
  // Flide inside WSL2; reached through localhost forwarding like SGLang.
  onejev9b: { port: 8083, model: 'onejev1.6-9b' }
};

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function createInferenceGateway({ modelSessions, sglangServices, controlPort = 11502, backends = BACKENDS }) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://gateway.local');
    if (url.pathname === '/v1/models' && req.method === 'GET') return json(res, 200, modelSessions.models());
    if (url.pathname === '/control/v1/model-sessions' || url.pathname.startsWith('/control/v1/model-sessions/')) {
      const upstream = http.request({ host: '127.0.0.1', port: controlPort, path: req.url, method: req.method,
        headers: { ...req.headers, host: `127.0.0.1:${controlPort}` } }, (reply) => {
        res.writeHead(reply.statusCode, reply.headers);
        reply.pipe(res);
      });
      upstream.on('error', (error) => { if (!res.headersSent) json(res, 502, { error: { code: 'control_unavailable', message: error.message } }); else res.destroy(error); });
      req.pipe(upstream);
      return;
    }
    if (!url.pathname.startsWith('/v1/') && url.pathname !== '/health')
      return json(res, 404, { error: { code: 'not_found', message: 'Unknown inference endpoint' } });
    try {
      let selected = modelSessions.activeModel();
      if (!selected && !modelSessions.hasActive()) {
        const state = await sglangServices.status();
        selected = state.models.find((item) => item.id === state.selected && item.running)?.id ||
          (state.models.filter((item) => item.running).length === 1 ? state.models.find((item) => item.running).id : null);
      }
      const backend = backends[selected];
      if (!backend) return json(res, 503, { error: { code: 'model_not_ready', message: 'No model is ready on port 8082' } });
      if (url.pathname === '/health') return json(res, 200, { status: 'ok', model: selected });

      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 32 * 1024 * 1024) return json(res, 413, { error: { code: 'bad_request', message: 'Request body too large' } });
        chunks.push(chunk);
      }
      let body = Buffer.concat(chunks);
      if (body.length && String(req.headers['content-type'] || '').includes('application/json')) {
        let payload;
        try { payload = JSON.parse(body.toString('utf8')); }
        catch { return json(res, 400, { error: { code: 'bad_request', message: 'Invalid JSON' } }); }
        if (payload.model && payload.model !== selected && payload.model !== backend.model)
          return json(res, 409, { error: { code: 'model_mismatch', message: `Active model is ${selected}` } });
        if (payload.model) payload.model = backend.model;
        body = Buffer.from(JSON.stringify(payload));
      }
      const headers = { ...req.headers, host: `127.0.0.1:${backend.port}`, 'content-length': body.length };
      delete headers['transfer-encoding'];
      const upstream = http.request({ host: '127.0.0.1', port: backend.port, path: req.url, method: req.method, headers }, (reply) => {
        res.writeHead(reply.statusCode, reply.headers);
        reply.pipe(res);
      });
      upstream.on('error', (error) => { if (!res.headersSent) json(res, 502, { error: { code: 'upstream_unavailable', message: error.message } }); else res.destroy(error); });
      res.on('close', () => { if (!res.writableFinished) upstream.destroy(); });
      upstream.end(body);
    } catch (error) {
      if (!res.headersSent) json(res, 500, { error: { code: 'gateway_failed', message: error.message } });
    }
  });
}

module.exports = { createInferenceGateway };
