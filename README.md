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

ブラウザで `http://127.0.0.1:11500` を開きます。起動時に直近35日間の既存ログを読み込み、以後は `data/requests.jsonl` に記録します。

## モデル別の詳細計測を有効にする

モニタは `0.0.0.0:11435` に透明プロキシを起動します。Ollamaを利用するアプリの接続先を、現在の `http://<このPCのIP>:11434` から `http://<このPCのIP>:11435` へ変更してください。API仕様はそのままで、ストリーミング応答にも対応します。

例: OpenAI互換APIを使うクライアントでは base URL を `http://<このPCのIP>:11435/v1` にします。

環境変数で変更できます。

```powershell
$env:MONITOR_PORT = '11500' # ダッシュボード（ローカルのみ公開）
$env:PROXY_PORT = '11435'  # 記録付きOllama API
$env:OLLAMA_URL = 'http://127.0.0.1:11434'
node server.js
```

終了は実行したターミナルで `Ctrl+C` です。
