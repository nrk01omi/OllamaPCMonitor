# SGLang 連携仕様

## 目的

RTX 5090 で SGLang を安定稼働させるため、SGLang 実行中は GPU を他のローカル AI 補助サービスから解放し、GPU を一つの大規模モデルに占有させる。

対象は次の二つの排他モデルである。

| ID | モデル | SGLang API |
| --- | --- | --- |
| `qwen38` | Qwen3.8-27B NVFP4 | `127.0.0.1:30000/v1` |
| `qwen3coder` | Qwen3-Coder-30B-A3B NVFP4 | `127.0.0.1:30001/v1` |

同時に起動できる SGLang モデルは一つだけとする。

## 状態遷移

```text
通常
  └─ 利用者が作業宣言
       └─ NAS に作業宣言を登録
            └─ Whisper・Reranker を停止
                 └─ 停止済みかつ health endpoint が停止したことを確認
                      └─ SGLang モデルの選択・起動を許可

作業宣言の解除・期限到達
  └─ SGLang を停止
       └─ Whisper・Reranker を再開
            └─ NAS の作業宣言を解除
```

## 必須要件

1. SGLang の起動・切替は、作業宣言が有効な間だけ許可する。
2. 起動前に Whisper と Reranker のスケジュールタスクが停止し、各 health endpoint が応答不能であることを確認する。未確認・確認不能時は SGLang を起動しない。
3. 切替時は先にもう一方の SGLang モデルを停止する。二つの SGLang API が同時に正常応答してはならない。
4. 作業宣言の解除、宣言期限の到達、スリープ前処理では全 SGLang モデルを停止する。
5. 排他、作業宣言の期限、GPU 解放確認はサーバー側で判定する。ブラウザ表示やボタンの無効化だけに依存しない。
6. SGLang の停止はモデル別 PID で行う。汎用的な `pkill -f 'sglang serve'` は使用しない。
7. 停止は `SIGTERM` を送るだけでは完了としない。対象 PID の消滅と対象 TCP ポートの解放を確認してから、次の SGLang 起動を許可する。停止完了の上限は PID 60 秒、ポート 20 秒とする。

## API

## Network exposure

SGLang listens inside WSL2.  On every dashboard-driven SGLang start, `scripts/sync-sglang-portproxy.ps1` refreshes Windows `portproxy` entries for TCP 30000 and 30001 using the current WSL2 IP address.  This is required because the WSL2 NAT address changes after a WSL restart.  The monitor task must run elevated; Windows Firewall still limits allowed callers to the LAN and Tailscale ranges.

The Windows `portproxy` listener is not a SGLang readiness signal.  Start/stop checks inspect the listener inside WSL2, while API readiness is confirmed through `/health`.

Qwen3.8 starts with `--context-length 81920`, `--mem-fraction-static 0.89`, and `--kv-cache-dtype nvfp4` to increase the usable context while reducing KV-cache VRAM consumption.  The runtime log must report the allocated KV cache dtype and token capacity after every configuration change.

### `GET /monitor/api/sglang-services`

SGLang モデルの health 状態、作業宣言期限、`gpuReleased` を返す。`gpuReleased: true` は Whisper・Reranker が停止済みで GPU 解放を確認できたことを表す。

### `POST /monitor/api/sglang-services`

```json
{ "model": "qwen38" }
```

または

```json
{ "model": "qwen3coder" }
```

作業宣言が有効で、かつ `gpuReleased` が `true` のときだけ起動する。`{ "model": null }` は全 SGLang モデルを停止する。

## UI

「SGLang モデル」パネルは作業宣言中だけ操作可能とする。GPU 解放が未確認の場合は起動ボタンを無効化し、「Whisper・Reranker の停止と GPU 解放を確認中」と表示する。
