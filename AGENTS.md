# OllamaPCMonitor — AGENTS.md

## 進捗ログ

### 2026-10-08
- 外部モデル選択を 4 構成（Strata 128K の Vision なし/あり、Qwen3.8-27B、Qwen3-Coder-30B）に拡張し、外部 API を 8082 に統一。`/v1/models` は 11502/8082 で同じ一覧を返す。
- Qwen3.8-27B は現在 65536 コンテキストに固定。実機で `context_length=65536`、KV 容量 117921、セッション `ready=true`、8082 経由の短い推論を確認し、検証セッションは終了済み。Qwen3-Coder の実起動は未検証。
- **後日タスク**: 4 構成それぞれで指定可能なコンテキストサイズを実機で段階的に計測する。各サイズについて起動可否、SGLang/Strata の実効コンテキスト、KV 容量・入力上限、境界付近の推論成否、GPU/メモリ使用量を記録し、安定して使える最大値を決める。結果に合わせて起動スクリプト、`/v1/models` の `context_window`、セッション ready 判定を更新する。未着手。
- 残件: NKS 側の外部セッション用スリープ抑止、Qwen3-Coder 実機検証、コンテキストサイズ計測、未コミット差分の整理。

### 2026-09-19
- 作業指示書 `docs/ollama-pc-monitor-work-order.md` 追加（contract `pc-presence-v1` v1.1）
- 現状: Ollama 透明プロキシ（11435→11434）＋ダッシュボード（11500）のみ動作中
- 次: server.js に①〜⑦を実装（在席申告・作業宣言・ローカル占有・心拍・UI・スリープ後始末・常駐化）
- 未決: NKS_API_KEY（オーナーから受け取る）
- *新セッション開始（2026-09-19）: 実装作業なし、残件に変更なし*
- **実装完了（①〜⑧、未コミット）**: `probe.ps1` / `presence.js` / `public/presence.js` / `scripts/install-task.ps1` 追加、`server.js`・`index.html`・`style.css` 変更。コード原案はローカル qwen3-coder で生成 → 欠陥（心拍タイマー無し・履歴の全読み・スリープ前解除が3秒遅れ 等）を修正して採用
- **指示書との差分（要確認）**:
  - ダッシュボード既定ポートを 11500 → **11501** に変更。11500 は `C:\Apps\ollama-mcp` が起動する専用 Ollama（ローカル MCP の実体）が使用中
  - ローカル MCP は 11435 も 11434 のログも通らないため、専用 Ollama の `/api/ps` `expires_at` 変化で検知（プロキシ・メインログ追跡と併用）
  - ローカル占有は推論系パスのみ数える（`/api/ps` `/api/tags` はダッシュボード自身の更新で常時 ON になるため除外）
  - プロキシ上流の送信元を 127.0.0.2 に固定（NAS 経由の中継が 127.0.0.1 = ローカルと誤認されるのを防ぐ）
- 検証済み（モック NKS）: 心拍/作業宣言/ローカル占有/NAS 断と自動復帰/UI(JST)/不正 Origin 拒否。**未検証（実機が必要）**: 画面ロック時の `session_locked`、スリープ直前の解除送信、実 NAS との疎通
- 残件: ①~~`NKS_API_KEY` 受領 → 設定済み（.env 確認済み）~~ ②`scripts\install-task.ps1` 実行（タスク登録は未実施）③実機で指示書 §7 の 1〜7 を確認 ④コミット
- *新セッション開始（2026-09-19）: 作業なし。.env に NKS_API_KEY 設定済みを確認。残件は②③④のみ。*

### 2026-09-21（SGLang 連携実装）
- `sglang-services.js` / `server.js` 更新 / `public/presence.js` SGLang パネル追加 / `public/style.css` 更新 / SGLang 起動 PowerShell & bash スクリプト追加 / `docs/sglang-integration-spec.md` 追加 → 複数コミットで確定済み
- 最新コミット: `e8f1280` Label legacy vLLM launchers（2026-09-27 時点）
- 未追跡: `data/`・`docs/sglang_5090_qwen3.827b.md`・`scripts/launch-qwen38-sglang.sh`
- 残件: ①タスクスケジューラ登録（`scripts\install-task.ps1`）②実機検証 §7 ③SGLang 実機検証 ④未追跡ファイルのコミット判断

### 2026-09-27
- セッション開始直後に `/record-progress`。実装作業なし。残件は上記と同じ。

### 2026-10-07
- セッション開始直後に `/record-progress`。実装作業なし。
- 前回（2026-09-27）以降にコミット 7 件: タスクスケジューラ自己修復・管理者昇格対応（`0d75537`〜`f7216bf`）、Strata 128K ダッシュボード制御・Tailscale API アクセス（`4949552`）、Strata vision/text 別個起動制御・評価スクリプト追加（`fb84b2d`）
- 未コミット: `server.js`・`sleep-guard.js`（修正）、`model-sessions.js`・`docs/opm-strata-model-session-spec.md`・firewall スクリプト 2 本・`test/`（未追跡）
- 残件: ①タスクスケジューラ登録 ②実機検証 §7 ③SGLang 実機検証 ④未コミット整理 & git commit
