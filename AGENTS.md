# OllamaPCMonitor — AGENTS.md

## OPMモデル試験の必須手順（スリープ防止）

- モデル試験を始めるときは、まずローカルOPMの `POST /monitor/api/work-hold` を呼び、NASへ作業宣言（例: `minutes: 30`, 試験対象を含む `reason`）を登録する。画面の「作業宣言」ボタンと同じ経路を使う。
- 応答だけで完了扱いにせず、別経路の `GET /monitor/api/presence?refresh=1` で `nks.response.sleep_blocked_by` に `work_hold` があり、`work_hold_until` が未来であることを確認する。
- その後 `POST /monitor/api/sglang-services` で対象モデルを起動する。OPM上で `running` / ready と `/monitor/api/presence` の `sleepGuard.active`・`sleepGuard.running` を確認してから推論する。
- この手動試験経路では `/control/v1/model-sessions` を使わない。モデルセッションAPIは人の作業宣言中に `human_work_hold` で意図的に拒否する別用途の経路。
- 試験終了後は対象モデルをOPMから停止し、`POST /monitor/api/work-hold` に `minutes: 0` を送り、NKSの解除とモデル停止を別経路で確認する。途中で失敗しても作業宣言を残したまま放置しない。
- 作業宣言の登録・確認に失敗したら、睡眠防止できたと仮定してモデルを起動しない。短時間の確認では30分、長時間の作業では必要時間に合わせて更新する。

## 進捗ログ

### 2026-11-21（CSV走行経路ビューア・コーディングエージェント比較）
- 同じ実走行CSV（89,884データ行、GPS有効89,880・無効4）と共通仕様でGLM-5.3-Flash / DeepSeek-V4.1-Flash / Qwen3.8-Flash-Nextを比較。課題はスマホ向けCSV読込・lap選択・速度色分け経路表示の静的Webアプリ。
- GLM: 67.7分、24ラウンド/32 tool calls。ブラウザテスト8回失敗。独立検証では21 lap・Canvas・統計・モバイル表示を確認したが、ヘッダーを行数に含め89,885/skip5と1行ずれ。
- DeepSeek: timeout 1,800秒で約1,799秒の応答が2度cancel。runner timeoutを7,200秒へ延長して再開後、62.2分/5ラウンド/8 tool callsで終了。検索まででコードを書かず、テスト・最終報告なし。
- Qwen: 9.3分、24ラウンド/28 tool calls。3ファイル生成・テスト6回失敗。HTMLに診断用の仮データ/偽Canvasスクリプトが残り、CSSのhidden要素も見える状態。21 lapとUI骨格はあるが完走基準未達。
- 詳細・ブラウザ検証・比較条件は `docs/coding-agent-circuit-csv-benchmark-2026-11-21.md`。成果物は `%TEMP%\opm-trackapp-bench-20261121-01\`。
- 全モデル停止、OPM `idle`、8080/18082閉鎖を確認。work-holdはユーザー了解待ちで維持（23:08:26 JST期限）。

### 2026-11-21（Maya context scaling・coding benchmark）
- Maya-XS-IQ1_S / GLM-5.3-Flash text-only をOPM経由で128K/256K/384K/512K設定にして比較。各設定で同じ220-token短文と、Maya tokenizer基準で約98%まで埋めた同一コーディング依頼を実行。詳細・全数値・条件は `docs/maya-context-scaling-coding-benchmark-2026-11-21.md`。
- 長文prefillは約1,900〜2,040 tok/s（prompt 127,788→517,328 token、65.5→272.2秒）。設定contextを上げただけの短文decodeは15.1〜16.7 tok/sで明確な単調差なし。長文後decodeは20.8〜23.9 tok/s（512Kは384-token出力上限に到達）。各条件1回。
- 512Kは実起動し、長文推論完了。推論中に観測した空きRAMは最低約5.1GiB、空きVRAM約0.5〜1.0GiB。
- テスト後MayaをOPM停止し8080閉鎖を確認。Maya configを131072に、`sglang-services.js`を試験前のSHA-256に復元し、OPMを再起動。OPM idle、NKS work_holdとsleepGuard active/runningを別経路で再確認。ユーザーの既存指示に従いholdは解除していない（NKS期限17:13:23 JST）。
- 実測JSON/プロンプトは `data/maya-context-coding-benchmark/`。WordPress投稿は今回依頼に含まれないため未実施。

### 2026-11-21（Vision複合画像比較・RTX 3090追加評価）
- 同じ合成4×4画像・質問・temperature 0・1024 token上限をOPMゲートウェイ8082経由で各3回試験。Strata IQ3_XXS Visionは7項目すべて3回正答（初回6.52秒、キャッシュあり平均4.60秒、再試行生成速度平均約199.9 tok/s）。Maya-XS Visionは5/7、5/7、6/7（初回27.92秒、キャッシュあり平均9.57秒、再試行生成速度平均約44.6 tok/s）。詳細は `docs/vision-complex-comparison-2026-11-21.md`。
- RTX 3090追加評価: Ryzen 9 9900X / ASUS X870 MAX GAMING WIFI7 / RTX 5090 32GB。追加GPU用PCIe 4.0 x16形状スロットは仕様上x1。現在のMaya/Strata構成はGPU 0指定で、3090は挿すだけでは利用されない。PSU・ケース寸法・3090型番は未確認。詳細は `docs/rtx-3090-addition-assessment-2026-11-21.md`。
- 12:39 JSTの再確認ではOPMがStrata Visionの別model-sessionをready（12:33:16〜13:03:16 JST）と記録し、手動停止/hold延長はHTTP 409。期限後の13:09再確認ではOPM idle、8080/18082閉鎖。発生元は未確認。
- ユーザー指定 `C:\Apps\nas-knowledge-stack\.env` を認証元に使用し、公開中の作業ログID 56へ比較結果とRTX 3090評価を追記。別経路の公開GETでstatus `publish`、各数値とMerPress描画を確認。URL: https://nas-ugreen.tail9ac64d.ts.net/session-progress-log/。
- 以前のwork-holdは13:03 JSTに自然期限切れ。ユーザーの「報告と了解まで解除しない」指示に沿い、投稿前にOPM work-holdを30分再登録。presenceで`work_hold`とsleepGuard active/runningを確認。新期限13:39:36 JST。モデルは停止、work-holdは明示解除していない。
### 2026-11-21（Qwen3.8-Flash / Maya-XS コンテキスト比較）
- 10:14 JST、外部model-session `idle` とmanual selector `idle` を確認後、OPM `work-hold` を180分登録。独立presenceでNKS `sleep_blocked_by=["work_hold"]`、期限13:14 JST、`sleepGuard.active/running=true` を確認。OPM経由でStrata IQ3_XXSとMaya-XS-IQ1_Sを順次起動し、text-only / 131,072 contextで試験。
- 一意マーカーを中央に一つだけ含む合成入力で両モデルとも約12K、24.6K、48.1K、95.1K、117.6K、127K、130.8K tokensを想起。最大はQwen 130,822+9 output tokens、Maya 130,815+18。詳細速度・条件・制約は `docs/model-context-comparison-2026-11-21.md`。
- 同じ200-token生成依頼: Qwen Strata timing 103.0 tok/s、Maya total-time estimate 24.8 tok/s（Maya側の内部decode timingなし）。各1回の参考値。
- 試験後OPM停止、8080/18082 closed、GPU使用137MiB、RAM空き45.4GiBを確認。OPM経由でwork-hold解除、独立presenceでNKS hold/blockなし・sleep guard停止を確認。Whisper/Rerank再開。比較試験終了。

### 2026-11-21（OPM作業宣言・Maya-XS再試験）
- 試験前にOPM `POST /monitor/api/work-hold` でNAS作業宣言を30分登録。presence再読込でNKS `sleep_blocked_by` に `work_hold`、OPM `sleepGuard.active/running=true` を確認。Maya専用guard PIDもready-marker後に記録され、推論中PID/start-time一致で生存を確認。
- OPM `/monitor/api/sglang-services` の `glm53flash` 起動は、旧OPMのMaya向け誤WSL portproxy呼び出しで失敗。`scripts/sync-sglang-portproxy.ps1` に、Maya選択中はWSL転送をスキップする互換ガードを追加し、OPM経由で起動成功。`sglang-services.js` / `model-sessions.js` 側もWSL対象をQwen3.8-27BとQwen3-Coderに限定する修正あり（実行中OPMへの読込は未確認）。
- OPMゲートウェイ8082経由の短文推論成功: `glm-5.3-flash`, 128K, 「2+2」→ `4`, 2.91秒, 25 prompt / 10 completion tokens, 参考3.438 tok/s。短文1回のみで持続速度は未評価。
- OPMから停止後、state `idle`, 8080閉鎖、Maya/guard PID消滅、VRAM 195 MiB使用を別経路で確認。OPM経由で作業宣言を解除し、NKS `work_hold_until=null`、local sleep guard停止、補助サービスhold解除を確認。
- Windows `powercfg /requests` は管理者権限不足で取得できず。native `SetThreadExecutionState` 呼び出しがmanaged-startのready-markerを通過し、guardが推論時点で生存したところまでの確認。詳細と制約は `docs/project-maya-xs-performance-2026-11-20.md`。

### 2026-11-20（Project Maya / GLM-5.3-Flash）
- RTX 5090 32GB + RAM 61.7GiB + Dドライブ空き約1,165GiBを確認。Maya-XS（128K、73.4GB）のモデル取得とSHA-256照合は完了。
- OPMにカタログID `glm53flash`、8082→Project Maya 8080の推論経路、セッション起動/停止、health ready判定、ダッシュボード準備UIを追加。
- 実機準備完了: Project Maya v1.1.68のPython依存・llama.cpp取得、RTX 5090 sm_120 CUDA engine build 205/205、Maya-XS pack/128K text-only config生成。Windows CP932出力で落ちたため、`Prepare-Maya.ps1` と `Start-Maya-Managed.ps1` に `PYTHONIOENCODING=utf-8` を追加。
- OPM route bug修正: `/monitor/api/maya*` を presence API handler に振り分ける条件を `server.js` に追加。検証中、既定ポート群が使えず、隔離OPMでも標準8082がbindできなかったため、今回は直接Managed起動で検証。OPM end-to-end session pathは未確認。
- Maya managed startと `/health` は成功（model `glm-5.3-flash`, max_context 131072, images false）。単発chat completionは199.78秒後にHTTP 503、0 tokens。Mayaログは会話復元180秒stall/exit 3、RAM available 309→202 MiB、commit 64,047 MiB、page faults 33,389,679を記録。tokens/s測定不可。
- Stall dumpを同ビルドPDBでWinDbg解析。メインthreadは `Glm5Model::reset()` 中の `cudaStreamSynchronize` で停止。MayaログのNVML `nvmlDeviceGetMemoryInfo` も20秒返答せずGPU readerが計測中止。RAM空き202MiB/VRAM空き1,789MiBは有力な増悪要因。詳細は性能レポート参照。
- 2026-11-21追加調査: ユーザーが管理者WinDbgで `WATCHDOG-20261120-1735.dmp` を開き、`!analyze -v` 出力を共有。`VIDEO_DXGKRNL_LIVEDUMP (193)`、Reason Code `0x815`、Mini Kernel Dump、faulting process `System`、stackはwatchdogのdump採取経路で、GPU/driver停止元のスタックは含まれないと判明。同時刻System/Applicationイベントログ照合では17:36:22 WER 1001を再確認し、17:30〜17:40にDisplay 4101/nvlddmkm/WHEA/Resource-Exhaustionの該当イベントは見つからず。17:26:41のS3 resume記録あり（watchdog約10分前、因果関係は不明）。詳細は性能レポートに追記。
- 停止後8080 closed。停止後RAM free 8.38 GiB。GPU使用量は起動前121 MiBから停止後21,557 MiBへ残ったが、nvidia-smi process listは空。残留VRAMの原因は未確認。Maya stall dump: `C:\Apps\ProjectMaya\maya-stall-114928.dmp`。
- 2026-11-21追跡時の `nvidia-smi`: RTX 5090は234 MiB使用/31,953 MiB空き（driver 610.88）。11/20停止後に観測した21,557 MiBの一時残留は現在解消。WERのsysdata XML/ReportArchiveは保護ACLのため読み出せず。
- OPM `power-events.jsonl` とSystemログ照合: Maya direct start後の14:36/15:57/16:57にS3 sleep。最後は16:57:56〜17:26:41 (約29分)で、最初の推論はresume約4分半後。直接起動経路はOPM `sessionActive` sleep guardに登録されないため、sleep/resume後のCUDA状態不整合が強い原因候補（未確定）。
- 対策コード: `Start-Maya-Managed.ps1` がMaya PID/start timeを監視する専用sleep guardを起動し、SetThreadExecutionState成功を確認できない場合はMayaを停止するよう変更。stop scriptは記録PID/start timeを検証してguardを終了。まだ実機検証していない。
- Mayaログを再照合: 128K設定時のKVはVRAM 0.58 GB + pinned RAM 0.78 GB、expert poolはVRAM 21.88 GB + pinned RAM 29.06 GB。全ロード後VRAM空き1,789 MiB。`src/core/glm_model.cu` の `Glm5Model::reset()` はstate/KVをasync clear後に `cudaStreamSynchronize` し、dumpの停止地点と一致。MTP drafting有効でother領域1.97GBにMTP/scratch/prompt等が合算、MTP単独消費は未計測。次はsleep guard有効の同一設定で短い要求を比較し、失敗が続く場合だけ `MAYA_GLM_NO_MTP=1` を一変数試験（未実施）。性能測定・OPM経由の起動は未完了。
- 詳細結果: `docs/project-maya-xs-performance-2026-11-20.md`。

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
