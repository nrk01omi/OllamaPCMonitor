// Presence panel. Renders the NKS response as delivered: nothing here decides presence or sleep ETA.
(() => {
  const $ = (id) => document.getElementById(id);
  const TZ = 'Asia/Tokyo'; // NKS sends UTC; people always see JST
  const hhmm = (iso) => new Date(iso).toLocaleTimeString('ja-JP', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
  const dayOf = (iso) => new Date(iso).toLocaleDateString('ja-JP', { timeZone: TZ });
  // HH:MM, with the date prefixed when it is not today (JST)
  const when = (iso) => (dayOf(iso) === dayOf(Date.now()) ? hhmm(iso) : `${new Date(iso).toLocaleDateString('ja-JP', { timeZone: TZ, month: 'numeric', day: 'numeric' })} ${hhmm(iso)}`);
  const full = (iso) => new Date(iso).toLocaleString('ja-JP', { timeZone: TZ, hour12: false });
  const buttons = () => document.querySelectorAll('#presence .pr-actions button');
  const dash = (iso) => iso ? full(iso) : '—';

  function createPowerPanel() {
    const panel = document.createElement('section');
    panel.className = 'power-card';
    panel.setAttribute('aria-live', 'polite');
    panel.innerHTML = '<div><span class="power-label">PC 電源状態</span><strong id="power-state">確認中</strong><small id="power-detail">状態を取得しています</small></div><div class="power-history"><span>監視開始 <time id="power-started">—</time></span><span>最終スリープ <time id="power-suspend">—</time></span><span>最終復帰 <time id="power-resume">—</time></span></div>';
    $('presence').before(panel);
  }

  function renderPower() {
    if (!$('power-state')) createPowerPanel();
    const power = snap && snap.power;
    const operating = Boolean(power && power.operating);
    const response = snap && snap.nks && snap.nks.response;
    const holds = response && Array.isArray(response.sleep_blocked_by) ? response.sleep_blocked_by : [];
    const localBusy = Boolean(snap && snap.local && snap.local.busy);
    const workHeld = holds.includes('work_hold');
    if (!operating) {
      $('power-state').textContent = '○ 状態を確認できません';
      $('power-state').className = 'power-unknown';
      $('power-detail').textContent = '監視プローブからの応答がありません';
    } else if (localBusy) {
      $('power-state').textContent = '● 稼働中・Ollama 作業中';
      $('power-state').className = 'power-ok';
      $('power-detail').textContent = `直近 ${snap.local.decayMin} 分以内にローカル推論を確認しました`;
    } else if (workHeld) {
      $('power-state').textContent = '● 稼働中・作業宣言中';
      $('power-state').className = 'power-ok';
      $('power-detail').textContent = 'Ollama 作業のため、NAS にスリープ抑止を宣言しています';
    } else {
      $('power-state').textContent = '● 待機中（仕事なし・寝てない）';
      $('power-state').className = 'power-idle';
      $('power-detail').textContent = 'PC は稼働中ですが、Ollama の推論・作業宣言は確認されていません';
    }
    $('power-started').textContent = dash(power && power.startedAt);
    $('power-suspend').textContent = dash(power && power.lastSuspendAt);
    $('power-resume').textContent = dash(power && power.lastResumeAt);
  }

  let snap = null;
  let live = null;
  let gpuServices = null;
  let unreachable = false;
  let busy = false;

  const gib = (bytes) => `${(Number(bytes || 0) / 1024 ** 3).toFixed(1)} GB`;

  function createGpuPanel() {
    const panel = document.createElement('section');
    panel.className = 'gpu-card';
    panel.innerHTML = '<div class="gpu-title"><span>ロード中のモデル / GPU メモリ</span><small id="gpu-total">確認中</small></div><div id="gpu-models" class="gpu-models"></div>';
    const usage = document.createElement('div');
    usage.className = 'gpu-vram';
    usage.innerHTML = '<div class="gpu-vram-label"><span id="gpu-vram-label">GPU 全体の VRAM</span><span id="gpu-vram-detail">確認中</span></div><div class="gpu-vram-bar"><b id="gpu-vram-other"></b><b id="gpu-vram-ollama"></b></div>';
    panel.append(usage);
    $('power-state').closest('section').after(panel);
  }

  function renderGpu() {
    if (!$('gpu-models')) createGpuPanel();
    const models = live && Array.isArray(live.loaded) ? live.loaded : [];
    const box = $('gpu-models');
    const totalVram = models.reduce((sum, model) => sum + Number(model.size_vram || 0), 0);
    const gpu = live && Array.isArray(live.gpu) ? live.gpu[0] : null;
    const ollamaMiB = totalVram / 1024 / 1024;
    if (gpu) {
      const ollamaPct = Math.min(gpu.usedPct, Math.round(ollamaMiB / gpu.totalMiB * 100));
      const otherPct = Math.max(0, gpu.usedPct - ollamaPct);
      $('gpu-vram-label').textContent = `${gpu.name} の専用 VRAM`;
      $('gpu-vram-detail').textContent = `${(gpu.usedMiB / 1024).toFixed(1)} / ${(gpu.totalMiB / 1024).toFixed(1)} GB (${gpu.usedPct}%) · GPU ${gpu.utilizationPct}%`;
      $('gpu-vram-other').style.width = `${otherPct}%`;
      $('gpu-vram-ollama').style.width = `${ollamaPct}%`;
      $('gpu-total').textContent = `Ollama ${gib(totalVram)} / その他 約 ${(Math.max(0, gpu.usedMiB - ollamaMiB) / 1024).toFixed(1)} GB`;
    } else {
      $('gpu-vram-label').textContent = 'GPU 全体の VRAM';
      $('gpu-vram-detail').textContent = 'NVIDIA 使用量を取得できません';
      $('gpu-vram-other').style.width = '0%';
      $('gpu-vram-ollama').style.width = '0%';
    }
    $('gpu-total').textContent = models.length ? `モデル使用 VRAM 合計 ${gib(totalVram)}` : 'ロード中のモデルなし';
    if (gpu && models.length) $('gpu-total').textContent = `Ollama ${gib(totalVram)} / その他 約 ${(Math.max(0, gpu.usedMiB - ollamaMiB) / 1024).toFixed(1)} GB`;
    box.replaceChildren();
    if (!models.length) {
      box.textContent = live ? 'ロード中のモデルはありません' : 'モデル情報を取得できません';
      return;
    }
    for (const model of models) {
      const row = document.createElement('div');
      row.className = 'gpu-model';
      const total = Number(model.size || 0);
      const vram = Number(model.size_vram || 0);
      const ratio = total > 0 ? Math.min(100, Math.round(vram / total * 100)) : 0;
      const offload = vram === 0 ? 'CPU' : ratio >= 98 ? 'GPU 全載' : `GPU ${ratio}%`;
      const name = document.createElement('b');
      name.textContent = model.name || model.model || '名称不明';
      const meta = document.createElement('small');
      meta.textContent = `${offload} · VRAM ${gib(vram)} / モデル ${gib(total)}`;
      row.append(name, meta);
      box.append(row);
    }
  }

  function createGpuServicesPanel() {
    const panel = document.createElement('section');
    panel.className = 'agent-services-card';
    panel.innerHTML = '<div class="agent-services-title"><span>ローカル AI 補助サービス</span><small id="agent-services-note">確認中</small></div><div id="agent-services-list" class="agent-services-list"></div>';
    $('gpu-models').closest('section').after(panel);
  }

  function renderGpuServices() {
    if (!$('agent-services-list')) createGpuServicesPanel();
    const list = $('agent-services-list');
    list.replaceChildren();
    if (!gpuServices || !gpuServices.supported) {
      $('agent-services-note').textContent = '状態を取得できません';
      list.textContent = 'Whisper／rerank のタスク情報を取得できません';
      return;
    }
    $('agent-services-note').textContent = gpuServices.pausedByMonitor?.length
      ? `作業宣言中：${when(gpuServices.holdUntil)} まで停止`
      : '通常稼働';
    for (const service of gpuServices.services) {
      const item = document.createElement('div');
      item.className = `agent-service ${service.running && service.health ? 'running' : 'stopped'}`;
      const name = document.createElement('b');
      name.textContent = service.kind === 'whisper' ? 'Whisper' : 'rerank';
      const status = document.createElement('small');
      const task = service.running === null ? 'タスク状態不明' : service.running ? '稼働' : '停止';
      status.textContent = `${task} / health ${service.health ? 'OK' : 'なし'}`;
      item.append(name, status);
      list.append(item);
    }
  }

  function setStatus(text, kind, detail) {
    $('pr-status').textContent = text;
    $('pr-status').className = `pr-status ${kind}`;
    $('pr-detail').textContent = detail || '';
  }

  function chips(names) {
    const box = $('pr-holds');
    box.replaceChildren(...names.map((name) => Object.assign(document.createElement('span'), { textContent: name })));
  }

  function render() {
    renderPower();
    const setButtons = () => buttons().forEach((b) => { b.disabled = busy || !snap || !snap.configured; });
    setButtons();
    if (unreachable || !snap) {
      setStatus('不明', 'unknown', 'ダッシュボードのサーバーと通信できません');
      chips(['不明']);
      return;
    }
    $('pr-host').textContent = snap.configured ? `host ${snap.hostId}` : '';
    const { nks } = snap;
    const r = nks.response;
    $('pr-lastok').textContent = (nks.lastOkAt ? full(nks.lastOkAt) : '—') + (nks.status === 'failing' && nks.consecutiveFailures ? `（${nks.consecutiveFailures} 回連続で失敗）` : '');
    const { probe } = snap;
    $('pr-measure').textContent = probe.alive
      ? `無操作 ${probe.idleSec} 秒 ／ ロック: ${probe.locked ? 'あり' : 'なし'} ／ 待機設定: ${snap.standbyTimeoutMin === null ? '不明' : snap.standbyTimeoutMin === 0 ? '無効' : `${snap.standbyTimeoutMin} 分`}`
      : '無操作: 測定できていません';

    if (nks.status === 'unconfigured') { setStatus('不明', 'unknown', 'NKS が未設定です（環境変数 NKS_URL / NKS_API_KEY / NKS_HOST_ID）'); chips(['不明']); return; }
    if (nks.status === 'failing') { setStatus('不明', 'unknown', `NAS と通信できていません（寝かされる可能性があります）${nks.lastError ? `\n${nks.lastError}` : ''}`); chips(['不明']); return; }
    if (nks.status !== 'ok' || !r) { setStatus('不明', 'unknown', 'NAS の応答を待っています'); chips(['不明']); return; }

    const blockedBy = r.sleep_blocked_by || [];
    if (r.sleep_eta_at) {
      // Remaining time = (eta - server_time) minus the time since we received the response.
      const remaining = Date.parse(r.sleep_eta_at) - Date.parse(r.server_time) - (Date.now() - nks.receivedAt);
      const text = remaining <= 0 ? 'まもなく寝ます' : remaining < 60000 ? 'あと 1 分未満で寝ます' : `あと ${Math.ceil(remaining / 60000)} 分で寝ます`;
      setStatus(text, 'sleeping-soon', `${when(r.sleep_eta_at)} に寝る見込み${r.sleep_eta_reason ? ` — ${r.sleep_eta_reason}` : ''}`);
    } else {
      setStatus(r.sleep_eta_reason || '寝かせない状態です', blockedBy.length ? 'blocked' : 'unknown', `しきい値 ${r.threshold_min} 分（${r.threshold_source === 'pc' ? 'この PC の申告' : '退避値'}）`);
    }

    const label = {
      presence: () => '在席',
      work_hold: () => `作業宣言（${r.work_hold_until ? `〜${when(r.work_hold_until)}` : ''}${r.work_hold_reason ? `・${r.work_hold_reason}` : ''}）`,
      local_busy: () => `ローカル占有（${snap.local.model || 'モデル不明'}${r.local_busy_until ? `・〜${when(r.local_busy_until)}` : ''}）`
    };
    const names = blockedBy.map((name) => (label[name] ? label[name]() : name));
    if (!names.length) names.push('押さえなし');
    names.push(r.routing === 'blocked' ? '外からの仕事: 受付停止' : '外からの仕事: 受付中');
    chips(names);
  }

  async function poll() {
    try {
      const response = await fetch('/monitor/api/presence', { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      snap = await response.json();
      unreachable = false;
    } catch { unreachable = true; }
    try {
      const response = await fetch('/monitor/api/live', { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      live = await response.json();
    } catch { live = null; }
    try {
      const response = await fetch('/monitor/api/gpu-services', { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      gpuServices = await response.json();
    } catch { gpuServices = null; }
    render();
    renderGpu();
    renderGpuServices();
  }

  async function declare(minutes) {
    const message = $('pr-message');
    busy = true;
    render();
    message.className = 'pr-message';
    message.textContent = '送信中…';
    try {
      const body = { minutes };
      const reason = $('pr-reason').value.trim();
      if (minutes > 0 && reason) body.reason = reason;
      const response = await fetch('/monitor/api/work-hold', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const data = await response.json();
      if (!response.ok) { if (data.snapshot) snap = data.snapshot; throw new Error(data.error || `HTTP ${response.status}`); }
      snap = data;
      message.textContent = minutes ? '作業宣言を反映しました' : '作業宣言を解除しました';
    } catch (error) {
      message.className = 'pr-message err';
      message.textContent = `失敗: ${error.message}`;
    } finally { busy = false; render(); }
  }

  buttons().forEach((button) => button.addEventListener('click', () => declare(Number(button.dataset.minutes))));
  poll();
  setInterval(poll, 2000);
  setInterval(render, 1000); // keeps the countdown moving between fetches
})();
