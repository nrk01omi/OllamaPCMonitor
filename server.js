const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const readline = require('node:readline');
const { createPresence } = require('./presence');

const root = __dirname;

// Optional .env next to server.js (git-ignored). Real environment variables win. Tolerates "KEY = value" and quotes.
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && !line.trimStart().startsWith('#') && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch { /* no .env */ }

const dataDir = path.join(root, 'data');
const eventFile = path.join(dataDir, 'requests.jsonl');
const publicDir = path.join(root, 'public');
const upstream = new URL(process.env.OLLAMA_URL || 'http://127.0.0.1:11434');
// 11500 is taken by the dedicated Ollama that the local MCP server (ollama-mcp) starts, so the dashboard uses 11501.
const monitorPort = Number(process.env.MONITOR_PORT || 11501);
const proxyPort = Number(process.env.PROXY_PORT || 11435);
const proxyHost = process.env.PROXY_HOST || '0.0.0.0';
const logDir = process.env.OLLAMA_LOG_DIR || 'C:\\ollama\\logs';
// Source address of the proxy's own upstream calls. The main Ollama log then shows 127.0.0.2 for forwarded
// requests (possibly from the NAS), which presence.js does not treat as local use.
const upstreamIsLoopback = upstream.hostname === '127.0.0.1';

const presence = createPresence({
  env: process.env,
  version: require('./package.json').version,
  localOllamaUrl: process.env.LOCAL_OLLAMA_URL || 'http://127.0.0.1:11500',
  ollamaLogFile: path.join(logDir, 'ollama.out.log'),
  probeScript: path.join(root, 'probe.ps1'),
  log: (...args) => console.log('[presence]', ...args)
});

let events = [];
let imported = 0;
let importError = '';

function operationFor(url) {
  const pathname = url.split('?')[0];
  if (pathname.includes('/chat')) return 'chat';
  if (pathname.includes('/generate')) return 'generate';
  if (pathname.includes('/embed') || pathname.includes('/embeddings')) return 'embedding';
  if (pathname.includes('/show')) return 'model-info';
  if (pathname.includes('/ps')) return 'loaded-models';
  if (pathname.includes('/tags')) return 'model-list';
  if (pathname.includes('/pull')) return 'pull';
  if (pathname.includes('/create')) return 'create';
  return pathname.replace(/^\//, '') || 'root';
}

function appendEvent(event) {
  events.push(event);
  // Keep memory bounded. The JSONL file remains the durable source.
  if (events.length > 250000) events.splice(0, events.length - 250000);
  fs.appendFile(eventFile, JSON.stringify(event) + '\n', () => {});
}

async function loadSavedEvents() {
  try {
    const stream = fs.createReadStream(eventFile, { encoding: 'utf8' });
    for await (const line of readline.createInterface({ input: stream, crlfDelay: Infinity })) {
      try { events.push(JSON.parse(line)); } catch { /* ignore incomplete final line */ }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('Could not read monitor data:', error.message);
  }
}

function parseGinLine(line, source) {
  // [GIN] 2026/09/18 - 00:12:46 | 200 | 10.0977ms | 192.168.0.198 | POST "/api/show"
  const match = line.match(/^\[GIN\]\s+(\d{4}\/\d\d\/\d\d)\s+-\s+(\d\d:\d\d:\d\d)\s+\|\s+(\d+)\s+\|\s+([^|]+)\|\s+([^|]+)\|\s+(\w+)\s+"([^"]+)"/);
  if (!match) return null;
  const [, date, time, status, duration, client, method, requestPath] = match;
  const dateIso = date.replaceAll('/', '-') + 'T' + time;
  let durationMs = 0;
  const d = duration.trim();
  if (d.endsWith('ms')) durationMs = Number.parseFloat(d);
  else if (d.endsWith('s')) durationMs = Number.parseFloat(d) * 1000;
  return { timestamp: new Date(dateIso).toISOString(), model: '不明（既存ログ）', operation: operationFor(requestPath), method, path: requestPath, status: Number(status), durationMs, client: client.trim(), source };
}

async function importOllamaLogs() {
  try {
    const files = await fsp.readdir(logDir, { withFileTypes: true });
    const cutoff = Date.now() - 35 * 24 * 60 * 60 * 1000;
    const candidates = [];
    for (const file of files) {
      if (!file.isFile() || !/^ollama\.out(?:-.*)?\.log$/i.test(file.name)) continue;
      const fullPath = path.join(logDir, file.name);
      const stat = await fsp.stat(fullPath);
      if (stat.mtimeMs >= cutoff) candidates.push(fullPath);
    }
    for (const fullPath of candidates) {
      const stream = fs.createReadStream(fullPath, { encoding: 'utf8' });
      for await (const line of readline.createInterface({ input: stream, crlfDelay: Infinity })) {
        const event = parseGinLine(line, 'ollama-log');
        if (event) { events.push(event); imported++; }
      }
    }
  } catch (error) {
    importError = error.message;
  }
}

function asJson(res, value, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

function selectedEvents(rangeHours) {
  const cutoff = Date.now() - rangeHours * 3600_000;
  return events.filter((event) => Date.parse(event.timestamp) >= cutoff);
}

function aggregate(rangeHours) {
  const relevant = selectedEvents(rangeHours);
  const bucketMs = rangeHours <= 24 ? 3600_000 : rangeHours <= 168 ? 6 * 3600_000 : 24 * 3600_000;
  const start = Math.floor((Date.now() - rangeHours * 3600_000) / bucketMs) * bucketMs;
  const buckets = new Map();
  const models = new Map();
  const operations = new Map();
  for (let t = start; t <= Date.now(); t += bucketMs) buckets.set(t, { timestamp: new Date(t).toISOString(), total: 0, models: {} });
  for (const event of relevant) {
    const key = Math.floor(Date.parse(event.timestamp) / bucketMs) * bucketMs;
    const bucket = buckets.get(key);
    if (bucket) { bucket.total++; bucket.models[event.model] = (bucket.models[event.model] || 0) + 1; }
    const model = models.get(event.model) || { name: event.model, calls: 0, errors: 0, durationMs: 0 };
    model.calls++; model.errors += event.status >= 400 ? 1 : 0; model.durationMs += event.durationMs || 0; models.set(event.model, model);
    const op = operations.get(event.operation) || { name: event.operation, calls: 0, errors: 0, durationMs: 0 };
    op.calls++; op.errors += event.status >= 400 ? 1 : 0; op.durationMs += event.durationMs || 0; operations.set(event.operation, op);
  }
  const sort = (a, b) => b.calls - a.calls;
  return { rangeHours, total: relevant.length, buckets: [...buckets.values()], models: [...models.values()].sort(sort), operations: [...operations.values()].sort(sort), recent: relevant.slice(-30).reverse(), imported, importError };
}

async function getOllama(pathname) {
  const response = await fetch(new URL(pathname, upstream));
  if (!response.ok) throw new Error(`Ollama returned ${response.status}`);
  return response.json();
}

async function liveStatus() {
  const [loadedResult, tagsResult] = await Promise.allSettled([getOllama('/api/ps'), getOllama('/api/tags')]);
  const error = [loadedResult, tagsResult].find((r) => r.status === 'rejected');
  return {
    connected: !error,
    error: error ? error.reason.message : '',
    loaded: loadedResult.status === 'fulfilled' ? loadedResult.value.models || [] : [],
    installedModels: tagsResult.status === 'fulfilled' ? (tagsResult.value.models || []).length : 0,
    host: upstream.href.replace(/\/$/, ''),
    cpuCount: os.cpus().length,
    memory: { total: os.totalmem(), free: os.freemem() }
  };
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    // Keep the body intact when proxying. Images and other multimodal payloads
    // can exceed a small arbitrary limit, and must not be truncated.
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function proxyRequest(req, res) {
  const began = Date.now();
  let body = Buffer.alloc(0);
  try { body = await readRequestBody(req); } catch { res.writeHead(400).end('Bad request'); return; }
  let model = 'なし';
  try { model = JSON.parse(body.toString('utf8')).model || model; } catch { /* non-JSON API request */ }
  presence.noteProxyRequest({ remoteAddress: req.socket.remoteAddress, url: req.url, model });
  const headers = { ...req.headers, host: upstream.host, 'content-length': String(body.length) };
  const upstreamReq = http.request({ protocol: upstream.protocol, hostname: upstream.hostname, port: upstream.port, method: req.method, path: req.url, headers, ...(upstreamIsLoopback && { localAddress: '127.0.0.2' }) }, (upstreamRes) => {
    res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
    upstreamRes.pipe(res);
    const record = () => appendEvent({ timestamp: new Date().toISOString(), model, operation: operationFor(req.url), method: req.method, path: req.url.split('?')[0], status: upstreamRes.statusCode || 0, durationMs: Date.now() - began, client: req.socket.remoteAddress || '', source: 'proxy' });
    upstreamRes.once('end', record);
    upstreamRes.once('aborted', record);
  });
  upstreamReq.once('error', (error) => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: `Ollama upstream unavailable: ${error.message}` }));
    appendEvent({ timestamp: new Date().toISOString(), model, operation: operationFor(req.url), method: req.method, path: req.url.split('?')[0], status: 502, durationMs: Date.now() - began, client: req.socket.remoteAddress || '', source: 'proxy' });
  });
  upstreamReq.end(body);
}

const contentTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
// The dashboard can declare a work hold on the NAS, so refuse requests that did not come from a page we served
// (DNS rebinding / another website posting to localhost).
function isSameOriginRequest(req) {
  const host = String(req.headers.host || '');
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return false;
  const origin = req.headers.origin;
  return !origin || origin === `http://${host}`;
}

async function handlePresenceApi(req, res, url) {
  if (!isSameOriginRequest(req)) return asJson(res, { error: 'forbidden' }, 403);
  if (url.pathname === '/monitor/api/presence' && req.method === 'GET') {
    return asJson(res, url.searchParams.has('refresh') ? await presence.refresh() : presence.getSnapshot());
  }
  if (url.pathname === '/monitor/api/work-hold' && req.method === 'POST') {
    let input;
    try { input = JSON.parse((await readRequestBody(req)).toString('utf8')); } catch { return asJson(res, { error: 'JSON が不正です' }, 400); }
    try { return asJson(res, await presence.setWorkHold(input.minutes, input.reason)); }
    catch (error) {
      const status = error.code === 'BAD_REQUEST' ? 400 : error.code === 'UNCONFIGURED' ? 503 : 502;
      return asJson(res, { error: error.message, snapshot: presence.getSnapshot() }, status);
    }
  }
  return asJson(res, { error: 'not found' }, 404);
}

const monitor = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/monitor/api/presence' || url.pathname === '/monitor/api/work-hold') {
    return handlePresenceApi(req, res, url).catch((error) => asJson(res, { error: error.message }, 500));
  }
  if (url.pathname === '/monitor/api/summary') return asJson(res, aggregate(Number(url.searchParams.get('hours')) || 24));
  if (url.pathname === '/monitor/api/live') { try { return asJson(res, await liveStatus()); } catch (e) { return asJson(res, { connected: false, error: e.message }, 502); } }
  if (url.pathname === '/monitor/api/config') return asJson(res, { monitorPort, proxyPort, proxyHost, logDir, upstream: upstream.href.replace(/\/$/, '') });
  const file = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\//, '');
  const target = path.resolve(publicDir, file);
  if (!target.startsWith(publicDir + path.sep) && target !== path.join(publicDir, 'index.html')) return res.writeHead(403).end();
  try { const bytes = await fsp.readFile(target); res.writeHead(200, { 'content-type': contentTypes[path.extname(target)] || 'application/octet-stream' }); res.end(bytes); }
  catch { res.writeHead(404).end('Not found'); }
});

async function main() {
  await fsp.mkdir(dataDir, { recursive: true });
  await loadSavedEvents();
  monitor.listen(monitorPort, '127.0.0.1', () => console.log(`Monitor: http://127.0.0.1:${monitorPort}`));
  http.createServer(proxyRequest).listen(proxyPort, proxyHost, () => console.log(`Ollama capture proxy: http://${proxyHost}:${proxyPort} -> ${upstream.href}`));
  importOllamaLogs().then(() => console.log(`Imported ${imported} historic access-log events from ${logDir}`));
  presence.start();
  console.log(presence.getSnapshot().configured ? `NKS presence: host ${process.env.NKS_HOST_ID} -> ${process.env.NKS_URL}` : 'NKS presence: not configured (set NKS_URL / NKS_API_KEY / NKS_HOST_ID); local measurements only');
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { presence.stop(); process.exit(0); });
main().catch((error) => { console.error(error); process.exitCode = 1; });
