# OllamaPCMonitor 進捗ログ

## 2026-10-08

**実施・確認**
- Strata Vision なし/あり、Qwen3.8-27B、Qwen3-Coder-30B を外部から選択可能にし、8082 を共通 API 入口にした。`/v1/models` は 11502 と 8082 で同じ4件を返す。
- Qwen3.8-27B は暫定 65536 コンテキストで実起動し、SGLang `context_length=65536`、KV 容量 117921、セッション `ready=true`、8082 経由の短い推論を確認。検証セッションは終了済み。

**後日タスク（未着手）**
- 4 構成それぞれの指定可能なコンテキストサイズを実機計測する。候補サイズごとに起動可否、実効コンテキスト、KV 容量・入力上限、境界付近の推論成否、GPU/メモリ使用量を記録する。
- 各構成の安定最大値を決定し、起動スクリプト、`/v1/models.context_window`、セッションの ready 判定と照合条件に反映する。Qwen3-Coder は実起動も未検証。

**残件**
- NKS 側の外部セッション用スリープ抑止と未コミット差分の整理。


## 2026-09-19

**やり取りの流れ**
- 作業指示書 `docs/ollama-pc-monitor-work-order.md` がプロジェクトに追加された（contract `pc-presence-v1` v1.1）
- 既存の `server.js` は Ollama 透明プロキシ（11435→11434）＋モニタリングダッシュボード（11501）のみ実装済み

**決定事項（作業指示書より）**
- NAS(NKS) が5分ごとにWinRMでスリープコマンドを直接撃つ問題に対処するため、PC側から在席・作業宣言・ローカル占有を申告する
- NKS API 確定済み（`http://192.168.0.198:8000`、X-Api-Key 認証）
- PC側では判定しない（NASに任せる）・依存パッケージなし方針維持
- `pending_approval` は当面 UI を作らない

**実施したこと**
- 作業指示書の格納のみ

**残件 / 次にやること**
1. `server.js` 追加実装:
   - ① 無操作秒数測定（常駐 PowerShell + GetLastInputInfo）
   - ② 待機設定読み取り（`powercfg /q`、1分ごと）
   - ③ ローカル占有判定（127.0.0.1/::1、10分減衰）
   - ④ 心拍送信（30秒ごと、`POST /api/power/pc-presence`）
   - ⑤ UI追加（在席状態・作業宣言トグル）
   - ⑥ スリープ時後始末（作業宣言解除）
   - ⑦ 常駐化（タスクスケジューラ）
2. 環境変数設定（`NKS_URL`, `NKS_API_KEY`, `NKS_HOST_ID`）

**未決の事項**
- `NKS_API_KEY`（オーナーから受け取る）
- NKS 側の実装完了タイミング

---
*2026-09-19 追記①: 新セッション開始。`server.js` は 193 行（プロキシ＋ダッシュボードのみ）。実装作業なし、残件に変更なし。*

---
*2026-09-19 追記②（実装完了セッション）:*

**実施したこと（実装完了）**
- `probe.ps1` — GetLastInputInfo 常駐計測スクリプト追加
- `presence.js` — 在席申告・心拍送信モジュール追加
- `public/presence.js` — UI（在席状態・作業宣言トグル）追加
- `scripts/install-task.ps1` — タスクスケジューラ登録スクリプト追加
- `server.js` — プロキシ + ダッシュボード + 在席申告（①〜⑧）統合
- `public/index.html` / `public/style.css` — 在席 UI を組み込み
- ダッシュボードポートを 11500 → **11501** に変更（11500 は ollama-mcp 占有）
- `.env` に `NKS_API_KEY` 設定済み（受領完了）

**残件 / 次にやること（新セッション 2026-09-19）**
1. `scripts\install-task.ps1` を実行してタスクスケジューラに登録
2. 実機で §7 検証項目（画面ロック・スリープ直前解除・実 NAS 疎通 など）を確認
3. git commit（確認後）

**未決の事項**
- NKS 側実装の完了タイミング（確認中）

---

## 2026-09-21（SGLang 連携実装）

**実施したこと（コミット済み）**
- `sglang-services.js`: SGLangServiceManager 実装（select/stopAll/setWorkHold/status）
- `server.js`: sglangServiceManager 組み込み・`/monitor/api/sglang-services` GET/POST 追加
- `public/presence.js` / `public/style.css`: SGLang パネル UI 追加
- SGLang 起動 PowerShell / bash スクリプト（Qwen3.8・Qwen3Coder）追加
- `docs/sglang-integration-spec.md`: 仕様書追加
- コミット群: `014d6f7`〜`e8f1280`（計5コミット）

**残件 / 次にやること**
1. `scripts\install-task.ps1` でタスクスケジューラ登録
2. 実機検証 §7（画面ロック・スリープ復帰・実 NAS 疎通）
3. SGLang 連携の実機検証
4. 未追跡ファイル（`data/`・`docs/sglang_5090_qwen3.827b.md`・`scripts/launch-qwen38-sglang.sh`）のコミット判断

**未決の事項**
- 実装差分（ポート変更・ローカル MCP 検知方式）のオーナー承認

---

## 2026-09-27

**やり取りの流れ**
- セッション開始直後に `/record-progress`。実装作業なし。
- git log にて 2026-09-21 以降のコミット 5 件を確認（SGLang 連携すべて確定済み）

**残件（変更なし）** — 上記 2026-09-21 の残件 1〜4 が継続中

---

## 2026-10-07

**やり取りの流れ**
- セッション開始直後に `/record-progress`（このセッションでの実装作業はなし）
- git log にて 2026-09-27 以降のコミット 7 件を確認

**前回以降のコミット（7件）**
- `0d75537`〜`f7216bf`: タスクスケジューラ自己修復・VS Code からの管理者昇格起動・self-heal 更新時のレガシートリガー除去
- `4949552`: Strata 128K/32K/Managed ダッシュボード制御、Tailscale ファイアウォール設定スクリプト、ベンチ結果ドキュメント追加
- `fb84b2d`: Strata vision/text の別個起動制御、視覚評価・コンテキストプローブスクリプト追加

**未コミット（現在）**
- `server.js`・`sleep-guard.js` — 修正あり（+54/+11 行）
- 未追跡: `model-sessions.js`、`docs/opm-strata-model-session-spec.md`、`scripts/Configure-ModelControl-TailscaleFirewall.ps1`、`scripts/Configure-Strata-LanFirewall.ps1`、`test/`、`docs/sglang_5090_qwen3.827b.md`

**残件 / 次にやること**
1. `scripts\install-task.ps1` でタスクスケジューラ登録
2. 実機検証 §7（画面ロック・スリープ復帰・実 NAS 疎通）
3. SGLang 連携の実機検証
4. 未コミットを整理してコミット

**未決の事項**
- 実装差分（ポート変更・ローカル MCP 検知方式）のオーナー承認（持ち越し）
- `model-sessions.js` / `docs/opm-strata-model-session-spec.md` の用途・コミット可否未確認
