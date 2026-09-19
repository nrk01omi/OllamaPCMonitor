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

  let snap = null;
  let unreachable = false;
  let busy = false;

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
    render();
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
