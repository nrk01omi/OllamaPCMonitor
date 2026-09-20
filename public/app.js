const $ = (id) => document.getElementById(id);
const colors = ['#36d399', '#54a6ff', '#f8c35c', '#c084fc', '#fb7185', '#22d3ee'];
const fmt = new Intl.NumberFormat('ja-JP');
let includeNonWork = false;
function duration(ms) { return ms >= 1000 ? `${(ms / 1000).toFixed(1)} 秒` : `${Math.round(ms)} ms`; }
function bytes(n) { return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`; }
function escapeHtml(s) { return String(s).replace(/[&<>'"]/g, (x) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[x]); }
function draw(data, powerHistory) {
  const canvas = $('timeline'); const dpr = devicePixelRatio || 1; const w = canvas.clientWidth; const h = 260; canvas.width = w * dpr; canvas.height = h * dpr;
  const c = canvas.getContext('2d'); c.scale(dpr, dpr); c.clearRect(0, 0, w, h); const pad = { l: 42, r: 12, t: 14, b: 30 }; const pw = w - pad.l - pad.r; const ph = h - pad.t - pad.b;
  const labels = data.models.slice(0, 6).map((x) => x.name); const max = Math.max(1, ...data.buckets.map((b) => b.total)); c.strokeStyle = '#1c324b'; c.fillStyle = '#93a7c0'; c.font = '11px system-ui';
  for (let v = 0; v <= 4; v++) { const y = pad.t + ph - (v / 4 * ph); c.beginPath(); c.moveTo(pad.l, y); c.lineTo(w - pad.r, y); c.stroke(); c.fillText(String(Math.ceil(max * v / 4)), 4, y + 4); }
  data.buckets.forEach((b, i) => { if (i % Math.max(1, Math.ceil(data.buckets.length / 8)) === 0) c.fillText(new Date(b.timestamp).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit' }), pad.l + pw * i / Math.max(1, data.buckets.length - 1) - 12, h - 7); });
  labels.forEach((name, j) => { c.strokeStyle = colors[j]; c.lineWidth = 2; c.beginPath(); data.buckets.forEach((b, i) => { const x = pad.l + pw * i / Math.max(1, data.buckets.length - 1); const y = pad.t + ph - (b.models[name] || 0) / max * ph; i ? c.lineTo(x, y) : c.moveTo(x, y); }); c.stroke(); });
  let awake = false; let eventIndex = 0;
  const powerEvents = (powerHistory && powerHistory.events || []).slice().sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  c.fillStyle = '#93a7c0'; c.fillText('電源', 4, h - 18);
  data.buckets.forEach((bucket, i) => {
    const at = Date.parse(bucket.timestamp);
    while (eventIndex < powerEvents.length && Date.parse(powerEvents[eventIndex].timestamp) <= at) {
      awake = powerEvents[eventIndex].type === 'start' || powerEvents[eventIndex].type === 'resume'; eventIndex++;
    }
    const x = pad.l + pw * i / Math.max(1, data.buckets.length - 1);
    const nextX = i === data.buckets.length - 1 ? w - pad.r : pad.l + pw * (i + 1) / Math.max(1, data.buckets.length - 1);
    c.fillStyle = awake ? '#36d399' : '#475569'; c.fillRect(x, h - 25, Math.max(1, nextX - x), 7);
  });
  $('legend').innerHTML = labels.map((name, i) => `<span><i style="background:${colors[i]}"></i>${escapeHtml(name)}</span>`).join('') || '<span>実作業の記録はありません</span>';
}
function ranking(el, items) { const max = Math.max(1, ...items.map((x) => x.calls)); $(el).innerHTML = items.length ? items.slice(0, 12).map((x) => `<div class="rank-row"><div><div class="rank-name" title="${escapeHtml(x.name)}">${escapeHtml(x.name)}</div><div class="bar"><b style="width:${x.calls / max * 100}%"></b></div></div><div class="rank-count">${fmt.format(x.calls)}</div></div>`).join('') : '<small>実作業の記録はありません</small>'; }
function setupNonWorkToggle() { const label = document.createElement('label'); label.className = 'non-work-toggle'; const input = document.createElement('input'); input.type = 'checkbox'; input.id = 'include-non-work'; label.append(input, document.createTextNode(' 照会・直近リクエストを表示')); $('range').closest('.actions').append(label); input.addEventListener('change', () => { includeNonWork = input.checked; update().catch(console.error); }); }
function setRecentVisible() { $('recent').closest('section').hidden = !includeNonWork; }
async function update() {
  setRecentVisible();
  const hours = +$('range').value; const suffix = includeNonWork ? '&include_non_work=1' : '';
  const [summary, live, powerHistory] = await Promise.all([fetch(`/monitor/api/summary?hours=${hours}${suffix}`).then((r) => r.json()), fetch('/monitor/api/live').then((r) => r.json()), fetch(`/monitor/api/power-history?hours=${hours}`).then((r) => r.json())]);
  $('total').textContent = fmt.format(summary.total); $('rate').textContent = `${(summary.total / hours).toFixed(1)} / 時間`; $('imported').textContent = fmt.format(summary.imported); $('loaded').textContent = live.loaded?.length ?? '—'; $('installed').textContent = `登録モデル: ${fmt.format(live.installedModels || 0)}`; $('memory').textContent = live.memory ? `${bytes(live.memory.total - live.memory.free)} 使用中` : '—'; $('cpu').textContent = live.cpuCount ? `${live.cpuCount} 論理CPU` : '—'; $('connection').textContent = live.connected ? `● Ollama 接続中 — ${live.host}` : `● 接続不可 — ${live.error || ''}`; $('connection').style.color = live.connected ? '#36d399' : '#fb7185'; $('bucket-label').textContent = hours <= 24 ? '5分ごと' : hours <= 168 ? '30分ごと' : '6時間ごと';
  draw(summary, powerHistory); ranking('models', summary.models); ranking('operations', summary.operations);
  $('recent').innerHTML = summary.recent.map((e) => `<tr><td>${new Date(e.timestamp).toLocaleString('ja-JP')}</td><td>${escapeHtml(e.model)}</td><td>${escapeHtml(e.operation)}</td><td class="${e.status >= 400 ? 'err' : 'ok'}">${e.status || '—'}</td><td>${duration(e.durationMs || 0)}</td><td>${e.source === 'proxy' ? 'プロキシ' : '既存ログ'}</td></tr>`).join('') || '<tr><td colspan="6"><small>実作業の記録はありません。</small></td></tr>';
}
setupNonWorkToggle(); $('refresh').onclick = () => update().catch(console.error); $('range').onchange = () => update().catch(console.error); update().catch(console.error); setInterval(() => $('refresh').click(), 10000);
