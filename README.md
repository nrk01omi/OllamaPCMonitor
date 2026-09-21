# Ollama PC Monitor

Ollama の呼び出し頻度を時系列・モデル別・処理別に可視化する、依存パッケージ不要の Node.js モニタです。プロンプト本文や生成内容は保存しません。

## このPCで見つかったOllama構成

- Windows サービス: `Ollama`（自動起動）
- 実行ファイル: `C:\Users\nrk01\AppData\Local\Programs\Ollama\ollama.exe serve`
- Ollama API: `0.0.0.0:11434`
- モデル格納先: `C:\ollama\models`
- アクセスログ: `C:\ollama\logs\ollama.out*.log`

既存のアクセスログからは、時刻・HTTPパス（処理種別）・応答時間・結果コードを復元します。Ollamaの標準アクセスログにはモデル名が残らないため、過去ログのモデルは `不明（既存ログ）` と表示されます。

## 起動

```powershell
node server.js
```

ブラウザで `http://127.0.0.1:11501` を開きます。起動時に直近35日間の既存ログを読み込み、以後は `data/requests.jsonl` に記録します。

## 再起動
Stop-ScheduledTask -TaskName OllamaPCMonitor
Start-ScheduledTask -TaskName OllamaPCMonitor

## 常時起動

cd C:\Apps\OllamaPCMonitor
powershell -ExecutionPolicy Bypass -File scripts\install-task.ps1
Start-ScheduledTask -TaskName OllamaPCMonitor

## 常時起動解除
powershell -ExecutionPolicy Bypass -File scripts\install-task.ps1 -Uninstall

## 状態確認
Get-ScheduledTask -TaskName OllamaPCMonitor
Get-Content C:\Apps\OllamaPCMonitor\data\monitor.log -Tail 50

## モデル別の詳細計測を有効にする

モニタは `0.0.0.0:11435` に透明プロキシを起動します。Ollamaを利用するアプリの接続先を、現在の `http://<このPCのIP>:11434` から `http://<このPCのIP>:11435` へ変更してください。API仕様はそのままで、ストリーミング応答にも対応します。

例: OpenAI互換APIを使うクライアントでは base URL を `http://<このPCのIP>:11435/v1` にします。

環境変数で変更できます。

```powershell
$env:MONITOR_PORT = '11501' # ダッシュボード（ローカルのみ公開）
$env:PROXY_PORT = '11435'  # 記録付きOllama API
$env:OLLAMA_URL = 'http://127.0.0.1:11434'
node server.js
```

終了は実行したターミナルで `Ctrl+C` です。

## 在席・作業宣言・ローカル占有（NAS 連携）

NAS（NKS）がこの PC を勝手に寝かせないよう、PC 側から**測った値だけ**を 30 秒ごとに送ります（`POST /api/power/pc-presence`）。在席かどうか・あと何分で寝るかは NAS が判定し、画面は NAS の応答をそのまま表示します（時刻は JST）。契約は `pc-presence-v1` v1.1、作業指示は `docs/ollama-pc-monitor-work-order.md`。

SGLang を RTX 5090 で安定運用するための GPU 排他・作業宣言連動は [SGLang 連携仕様](docs/sglang-integration-spec.md) を参照してください。

| 構成 | 内容 |
|---|---|
| `probe.ps1` | 常駐 PowerShell 1 本。`GetLastInputInfo` の無操作秒数・ロック状態を 1 秒ごとに出力し、スリープ/復帰を通知 |
| `presence.js` | 測定（無操作・`powercfg` の待機設定・ローカル占有）と NKS 通信（心拍・作業宣言・スリープ前の解除） |
| ダッシュボード上部 | 状態・作業宣言（30分/1時間/3時間/解除）・いまの押さえ・最後に NAS と話せた時刻 |
| `scripts/install-task.ps1` | ログオン時に自動起動するタスクを登録（`-Uninstall` で削除） |

```powershell
# 鍵はユーザー環境変数に置く（リポジトリ・設定ファイルには書かない）
[Environment]::SetEnvironmentVariable('NKS_URL',     'http://192.168.0.198:8000', 'User')
[Environment]::SetEnvironmentVariable('NKS_API_KEY', '<オーナーから受け取る>',      'User')
[Environment]::SetEnvironmentVariable('NKS_HOST_ID', '5090',                      'User')  # 3090 のPCでは '3090'
# 任意: NKS_HEARTBEAT_SEC=30 / LOCAL_BUSY_DECAY_MIN=10 / LOCAL_OLLAMA_URL=http://127.0.0.1:11500
powershell -ExecutionPolicy Bypass -File scripts\install-task.ps1
```

未設定でも動作します（ダッシュボードは「不明」、測定値のみ表示）。

### ローカル占有の判定

- 数えるのは**推論だけ**（`/api/chat` `/api/generate` `/api/embed*` `/v1/chat/completions` など）。`/api/ps` `/api/tags` は数えません（ダッシュボード自身の更新で常時 ON になるため）。
- 数える要求元は `127.0.0.1` / `::1` / この PC の LAN IP。NAS（192.168.0.198）は数えません。
- 見る場所は 3 つ: ①透明プロキシ（11435）②メイン Ollama のアクセスログ ③ローカル MCP の**専用 Ollama**（127.0.0.1:11500）の `/api/ps` の `expires_at` 変化。
- 最後のローカル要求から 10 分で解除。
- プロキシの上流接続は送信元を `127.0.0.2` にしています（Ollama のログ上でプロキシ中継と本当のローカル要求を区別するため）。

### ポート

ダッシュボードは **11501**（既定）。11500 は `ollama-mcp` が起動する専用 Ollama が使うため。
