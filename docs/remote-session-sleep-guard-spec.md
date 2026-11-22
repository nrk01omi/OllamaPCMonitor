# リモート接続中のスリープ抑止仕様

更新日: 2026-11-22  
状態: OPM実装・実機確認済み（2026-11-22）。NAS応答で `remote_session` と抑止理由を確認。切断/再接続/ログオフの遷移試験と、NASの実際の電源命令が抑止されたことの確認は未完了。

## 目的

RTX 5090 PC にリモート接続して作業している間、Windows のアイドルタイマーとNASの電源管理の両方からスリープされないようにする。作業者がポータルの「作業宣言」を手で登録しなくてもよい状態にする。

作業宣言APIは呼ばない。OPMはWTSから取得したリモート状態を30秒ごとのPC在席心拍に含める。NASはその値を電源管理の判断材料にし、リモート利用中にスリープ命令を出さない。Windowsの時間切れ対策として、OPMのローカル sleep guard も併用する。

## 現状

- `sleep-guard.js` は `ES_CONTINUOUS | ES_SYSTEM_REQUIRED` を設定する PowerShell プロセスを維持する。
- 現在のローカル sleep guard の有効条件は、手動作業宣言、モデルセッション、SGLang 稼働のいずれか。
- `probe.ps1` は `GetLastInputInfo` による無操作秒数とロック状態を取得するが、Windows セッションがリモート接続中かは取得していない。
- タスクスケジューラには `RemoteConnect` と `SessionUnlock` の再起動トリガーがある。これらは OPM を起動するだけで、sleep guard の状態を切り替えない。
- 2026-11-22 10:01 のNAS記録では、NASが `powercfg /change standby-timeout-ac 1` を実行した後、WinRMで `rundll32 powrprof.dll,SetSuspendState 0,1,0` を直接実行し、10:01:22にスリープした。`SetThreadExecutionState(ES_SYSTEM_REQUIRED)` が防ぐのはWindowsのアイドル時間切れであり、この直接命令は防がない。
- `/monitor/api/work-hold` はNASへの作業宣言に加えてGPU補助サービスも操作するため、自動リモート検知からは呼び出さない。

## リモートセッションの判定

- Windows Terminal Services API（WTS）でセッション一覧、接続状態、クライアントプロトコル種別を取得する。
- RDP のクライアントプロトコル種別は `2`。状態が `WTSActive` の RDP セッションが1つ以上あれば「リモート作業中」とする。
- OPM 起動時に状態を照合し、その後も5秒間隔で再照合する。タスクスケジューラ通知だけに依存しない。
- セッションがロックされていても、RDP セッションが `WTSActive` ならリモート作業中として扱う。
- `WTSDisconnected` は切断状態とし、即時解除せず15分の再接続猶予を開始する。この間は `grace` を心拍に送る。猶予中に同じユーザーのRDPセッションが再び `WTSActive` になったら `active` に戻す。
- セッションのログオフを確認した場合は、そのセッションの猶予を直ちに取り消す。ほかにActiveなRDPセッションがあれば `active`、なければ `none` とする。
- コンソール接続、AnyDesk、Chrome Remote Desktop などRDP以外の接続は、この仕様の対象外。対象を広げる場合は別途検知方法を定義する。

## 心拍フィールド

既存の `POST /api/power/pc-presence` に次のフィールドを追加する。

```json
{ "remote_session": "active" }
```

許可する値:

| 値 | 意味 | NASの電源判断 |
|---|---|---|
| `active` | WTSでActiveなRDPセッションを確認 | 寝かせない理由として扱う |
| `grace` | RDP切断後15分の再接続猶予中 | 寝かせない理由として扱う |
| `none` | RDPの利用を確認していない | この理由では抑止しない |
| `unknown` | WTS照会失敗などで判定不能 | 在席とはみなさず、画面に判定不能を表示 |

OPMは推測で `active` を送らない。WTSの実測結果を送る。ユーザー名・接続元IPはこのフィールドに含めない。

`remote_session_since` には、現在の状態へ遷移したUTC時刻をISO 8601形式で入れる。これは任意フィールドだがOPMは送信する。probeの測定値が15秒より古い場合、状態を `unknown` に遷移させる。定義値以外は送らない。NKSが必須フィールドまたは値域を拒否した場合、422を受けて心拍失敗として表示・記録し、フィールドを落とした再送はしない。

## OPMローカルsleep guard

- ローカルsleep guardの有効条件に `remoteSessionActive` を加え、既存条件との論理和にする。
- 各理由を独立して保持する。リモートセッション終了時に、手動作業宣言・モデルセッション・SGLang稼働が継続中ならガードを止めない。
- RDPセッションがActiveになった時点でガードを有効にする。NASとの通信を待たない。
- 切断猶予が終了し、対象RDPセッションがActiveでなく、ほかの有効条件もない場合にだけローカルsleep guardを停止する。
- OPMプロセス停止時は、既存仕様どおりガードプロセスも終了し、Windowsへ設定した実行状態を解除する。

## NAS側の電源判断（別リポジトリ・別担当）

NAS側では受信した `remote_session` を `pc_block_reason` に反映し、`active` と `grace` の間は次の両方を実行しない。

- WinRM経由の強制スリープ（`SetSuspendState`）
- 待機時間を1分に短縮する設定（例: `powercfg /change standby-timeout-ac 1`）

`none` または `unknown` では、remote session をブロック理由に加えない。`unknown` はUIに判定不能として表示する。

PC心拍が途切れた場合は、現在の在席情報と同じ3分の猶予後にremote session理由を失効させる。古い `active` 値を無期限に保持しない。

2026-11-22の実機照合では、OPMが送った `remote_session=active` と `remote_session_since=2026-11-22T02:13:40.508Z` に対し、NKS応答は `remote_session=active`、`remote_session_since=2026-11-22T11:13:40.508+09:00`、`sleep_blocked_by=["work_hold","remote_session","presence"]` を返した。NKSの判断材料への反映は確認済み。WinRMの強制スリープ命令や待機時間変更が実際に抑止されたことは未確認であり、そこはNKS側ログまたは制御結果で別途照合する。

## 明示的に行わないこと

この機能から以下を実行しない。

- `POST /api/power/pc-work-hold` または `/monitor/api/work-hold`
- NASの受付停止・再開
- Whisper/Reranker/SGLang/Maya等の起動・停止
- GPUモデルセッションの作成・解放

ポータルの手動作業宣言と自動リモート状態は別々に開始・終了できる。心拍の `remote_session` は在席情報としてNASに実測値を伝えるものであり、手動作業宣言の代用や偽装ではない。

## 保護範囲と制約

- ローカルsleep guardは `SetThreadExecutionState(ES_SYSTEM_REQUIRED)` により、Windowsのアイドル起因の自動スリープを抑止する。
- 電源ボタン操作、明示的なシャットダウン、管理者・ファームウェアによる強制スリープまでは防がない。
- NASがWinRM等で `SetSuspendState` を直接実行する場合、ローカルsleep guardで止められない。NAS側に `remote_session` の判断を実装しない限り、この機能だけでは強制スリープを防げない。
- OPMが起動していない、WTS情報を取得できない、またはsleep guardプロセスを起動できない場合、リモート利用を保護できない可能性をUIとログに明示する。

## 表示・記録

- ダッシュボードに `リモートセッション: 接続中 / 切断猶予中 / なし / 判定不能` と、ローカルsleep guardの状態を表示する。
- sleep guard の状態と理由に `remote_session` を含め、他の理由と独立して確認できるようにする。
- 接続、切断猶予開始・取消・満了、ログオフ、WTS判定失敗、sleep guard起動失敗を時刻付きで記録する。
- `monitor.log` の各行にUTC ISO 8601時刻を付ける。
- ユーザー名や接続元IPは診断に必要な最小限だけ扱い、通常ログには出さない。セッション照合にはOSのセッションIDを使い、永続保存しない。

## 受け入れ条件

1. RDP接続中、画面ロック中を含めローカルsleep guardが有効になり、NAS心拍に `remote_session: active` が含まれる。
2. RDP切断後15分以内に再接続するとガードが連続して有効である。
3. 切断状態が15分続くとローカルガードのリモート理由だけが解除される。ほかの理由があればガードは継続する。NAS心拍は `none` に変わる。
4. RDPログオフ後はリモート理由が直ちに解除される。
5. OPM再起動後、すでに存在するRDPセッションを検出してガードを復元する。
6. active/graceの間、NASは強制スリープと待機1分設定のどちらも実行しない。心拍が3分途切れた後は既存の失効動作に戻る。
7. 有効・解除のいずれの遷移でもNAS work-hold、NAS routing、GPUサービス、モデルセッションが変化しない。
8. コンソール利用中の既存在席判定・手動作業宣言・モデル稼働時ガードの挙動が変わらない。
9. NASからの強制スリープ経路を含む実機試験で、両側の状態と命令実行有無を確認する。

## 実装時の確認項目

- Windows WTS APIで、Active / Disconnected / Logoff の遷移とRDPプロトコル判定がこの実機で取得できること。
- RDP接続、画面ロック、切断、再接続、ログオフ、OPM再起動を実機で確認する。
- 切断猶予15分は初期値。実際のリモート作業で再接続時間に問題があれば調整する。
- NAS側で `pc_block_reason` が更新されること、`active` / `grace` 中に電源管理命令が出ないことをNKS側担当が確認する。
