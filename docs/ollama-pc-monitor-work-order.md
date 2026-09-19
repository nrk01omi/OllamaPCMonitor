# 作業指示: OllamaPCMonitor に「在席・作業宣言・ローカル占有」を足す

- 宛先: `github.com/nrk01omi/OllamaPCMonitor` を実装する人／セッション
- 出どころ: 契約 `pc-presence-v1` v1.1（オーナー裁定済み）。**この 1 枚だけで着手できるように書いてある**ので、契約本体を読まなくてよい
- 相手側（NKS）の API は **確定済み**。以降変わらない（変えるときは先に連絡が来る）
- 日付: 2026-09-19

---

## 1. 何のために作るか

**NAS（NKS）が、人の使っている PC を勝手に寝かせてしまう。**

NAS は GPU 機を 2 つの経路で寝かせる。片方は Windows の待機タイマに任せる形だが、もう片方は
**NAS が 5 分ごとに WinRM で `rundll32 powrprof.dll,SetSuspendState` を直接撃つ**形で、
こちらには **idle 判定も・仕事の判定も・人が触っているかの判定も無い**。
2026-09-19 未明、オーナーが 5090 を使用中に 5 分ごとに寝かされた。

**PC の中を見ないと「人が居るか」は分からない。**だから PC 側から教える。あわせて、
ローカルの MCP サーバー（`qwen3-coder-30b-q5-256k`）が動いている間に外から別モデルを
呼ばれると VRAM から追い出されるので、**それも PC 側から申告して止める**。

作るものは 3 つ。

```
① 在席          人が触っている → NAS は寝かせない
② 作業宣言      人が「今は自分が使う」と押した → NAS は仕事を振らない
③ ローカル占有  ローカル推論が動いている → 自動で仕事を振らない（押し忘れても効く）
```

---

## 2. 前提（いまのアプリ）

```
リポジトリ    github.com/nrk01omi/OllamaPCMonitor
実装          Node.js（**依存パッケージなし**）・server.js 1 本
ダッシュボード http://127.0.0.1:11500     ローカルのみ公開
透明プロキシ   0.0.0.0:11435 → Ollama 11434   記録つきの Ollama 互換口
記録           data/requests.jsonl
```

**依存を増やさない方針は維持する。**下の実装項目はすべて Node 標準ライブラリと
`powershell.exe` の呼び出しだけで足りる。

---

## 3. 実装項目

### ① 無操作秒数を測る

Windows の `GetLastInputInfo` を使う。Node からは直接呼べないので、**常駐の PowerShell を
1 本持って読む**。

```
やること   起動時に powershell.exe を1つ起動して標準入出力を繋いだまま保持し、
           1 秒ごとに idle 秒数を1行で吐かせる
やらないこと 30 秒ごとに powershell.exe を起動し直す
           （起動コストと、環境によっては出るダイアログを避けるため）
```

### ② 待機設定を読む

`powercfg /q` の現在のプランの `standby-timeout-ac` を分で取る。**0 は「無効（寝かせない）」**。
1 分ごとに読み直せば足りる（頻繁には変わらないが、**NAS がこの値を書き換える**ので固定しない）。

### ③ ローカル占有を判定する

**要求元で分ける。**透明プロキシ（11435）と Ollama のアクセスログの両方を見る。

```
ローカル扱い   127.0.0.1 / ::1 / この PC 自身の LAN IP からの要求
外から扱い     192.168.0.198（NAS）からの要求 → **数えない**
判定           直近にローカル要求が 1 件でもあれば local_busy = true
減衰           最後のローカル要求から 10 分で false へ戻す
```

**減衰を持つ理由**: MCP の対話は飛び飛びに来る。1 件終わるたびに解放すると、次の一言までの
間に外からの要求が入ってモデルが VRAM から落ち、再ロードに数十秒かかる。
**沈黙している間も押さえておく。**

### ④ 心拍を送る

30 秒ごとに §4 の API を叩く。加えて**起動直後**と**スリープ復帰直後**は即送信する。

```
失敗しても落ちない   例外で常駐が死なないこと
連続失敗中の表示     「NAS と通信できていません（寝かされる可能性があります）」
                     **黙って成功に見せない**
```

### ⑤ UI を 1 枚足す（11500 のダッシュボード内）

出すもの:

```
いまの状態        「人が使用中なので寝ません」／「あと 8 分で寝ます」／「不明」
作業宣言のトグル   30 分 / 1 時間 / 3 時間 / 解除
いまの押さえ       作業宣言（〜03:30・動画編集）／ローカル占有（qwen3-coder…）
最後に NAS と話せた時刻
```

**表示は NAS の応答をそのまま出す。**残り時間は `server_time` との差で描く。
**PC 側で判定や残り時間を再計算しない**（写しを 2 つ持つと必ずずれる）。

### ⑥ スリープに入るときの後始末

Windows の suspend を拾い、**落ちる前に作業宣言の解除（`minutes: 0`）を送る**。
送れずに落ちても NAS 側が機体停止を見て解除するので、二重の受け皿になる。

### ⑦ 常駐にする

いまは `node server.js` を手で起動する形。**ログオン時に自動起動**するようにする
（タスクスケジューラの「ログオン時」。この PC は自動ログオンが設定済み）。

### ⑧ `pending_approval` は**まだ描かない**

API の応答に欄はあるが、**当面は常に `null`** が返る（NAS 側の段④が未実装）。
**null のまま UI を作らない** — 押せないボタンが生まれるだけ。段④が入るときに改めて連絡が来る。

---

## 4. API（NKS 側・確定版）

### 4.0 共通

```
Base            http://192.168.0.198:8000        LAN 内
                （tailnet 経由なら https://nas-ugreen.tail9ac64d.ts.net:10445）
認証            X-Api-Key: <この機体の鍵>        Basic 認証は免除
Content-Type    application/json
時刻            ISO-8601。**NKS が返すのは UTC**。画面には JST で出すこと
失敗            {"detail": "..."} で 4xx/5xx
```

```
401  鍵が違う
403  鍵と host の対応が食い違う（他機の在席は書けない）
404  host が台帳に無い
400  minutes が範囲外
```

**鍵はオーナーから受け取る。リポジトリにも設定ファイルにも書かない**（環境変数）。

### 4.1 心拍

```
POST /api/power/pc-presence
```

**送る**（`host` 以外はすべて任意。**送らない欄は「分からない」**で、false ではない）

| 欄 | 型 | 必須 | 意味 |
|---|---|---|---|
| `host` | `"3090"` \| `"5090"` | ✔ | どの機体か |
| `idle_sec` | int ≥ 0 | | `GetLastInputInfo`。**測った値をそのまま** |
| `session_locked` | bool | | true なら**無条件で在席は無効**（ロックしたまま離席するため） |
| `standby_timeout_min` | int ≥ 0 | | `powercfg` の現在値。**0 は「無効」** |
| `local_busy` | bool | | ローカル推論が動いている（§3 ③） |
| `local_last_at` | str | | 最後のローカル要求の時刻 |
| `local_model` | str | | 記録と表示のみ。**判定には使われない** |
| `source` | str | | `"ollama-pc-monitor/<version>"` |
| `sent_at` | str | | 記録のみ。**判定には使われない**（PC の時計を信用しない設計） |

**返る（200）**

```json
{
  "presence_active": true,
  "presence_expires_at": "2026-09-19T02:41:00+00:00",
  "presence_source": "idle_sec",
  "threshold_min": 3,
  "threshold_source": "pc",
  "sleep_blocked_by": ["presence"],
  "sleep_eta_at": null,
  "sleep_eta_reason": "人が触っているので寝かせません",
  "work_hold_until": null,
  "work_hold_reason": null,
  "local_busy_until": null,
  "routing": "accepting",
  "pending_approval": null,
  "server_time": "2026-09-19T02:31:00+00:00"
}
```

**欄の意味**

```
presence_active    bool。**null にならない**
presence_source    "idle_sec" | "locked" | "no_idle_sec"
                   idle_sec を送らなければ在席は立たない（NAS は推測しない）
threshold_min      実際に使われたしきい値（分）
threshold_source   "pc"       この PC が申告した standby_timeout_min を使った
                   "fallback" 0 を申告した or 欄が無い → 退避値（既定 10 分）
sleep_blocked_by   [] | ["presence"] | ["work_hold"] | ["local_busy"] | ["ci_hold"] …
                   **複数入りうる。空配列は「何も押さえていない」**
sleep_eta_at       寝る見込み。**押さえがあれば null**
routing            "accepting" | "blocked"（blocked = 外からの仕事を振られない）
pending_approval   当面つねに null（§3 ⑧）
server_time        **残り時間はこれを基準に描く**
```

### 4.2 作業宣言

```
POST /api/power/pc-work-hold
{ "host": "5090", "minutes": 60, "reason": "動画編集" }    宣言（reason は任意）
{ "host": "5090", "minutes": 0 }                           解除
```

- `minutes` は **0〜480**（上限 8 時間）。範囲外は 400
- **返るのは心拍と同じ本文**（`work_hold_until` が入った状態）。**レンダラは 1 つで済む**
- NAS は受けた瞬間に反映する（巡回を待たない）

### 4.3 引くだけ

```
GET /api/power/pc-presence?host=5090
```

心拍と同じ本文。副作用なし。心拍を送らずに画面だけ更新したいときに使う。

---

## 5. やってはいけないこと

```
1  PC 側で「在席かどうか」「あと何分で寝るか」を**判定しない**。
   送るのは測った値だけで、判定は NAS が持つ。表示は応答をそのまま
2  応答が無い間を「大丈夫」と描かない。**不明と出す**
3  鍵をリポジトリ・設定ファイルに書かない（環境変数）
4  pending_approval で UI を作らない（当面つねに null）
5  依存パッケージを足さない（Node 標準 + powershell.exe で足りる）
6  時刻を UTC のまま人に見せない。**画面は JST**
```

---

## 6. 設定（環境変数）

既存と同じ方式で追加する。

```powershell
$env:NKS_URL      = 'http://192.168.0.198:8000'
$env:NKS_API_KEY  = '<オーナーから受け取る>'
$env:NKS_HOST_ID  = '5090'          # 3090 に入れるときは '3090'
# 任意
$env:NKS_HEARTBEAT_SEC     = '30'
$env:LOCAL_BUSY_DECAY_MIN  = '10'
```

---

## 7. 確かめ方（PC 側だけで確認できるもの）

```
1  心拍が 200 で返り、presence_active が true になる（画面を触りながら）
2  10 分放置 → presence_active が false になり、sleep_eta_at に時刻が入る。
   **画面の残り時間がその時刻と一致している**
3  画面をロック → session_locked=true を送り、即座に presence_active=false になる
4  作業宣言 60 分 → routing が "blocked" になる。解除 → "accepting" に戻る
5  ローカルの MCP に 1 件投げる → local_busy_until に時刻が入り、10 分後に消える。
   **NAS からの要求では立たない**（ここが混ざると全部おかしくなるので必ず確認）
6  LAN ケーブルを抜く → 画面が「NAS と通信できていません」に変わる。
   繋ぎ直すと自動で復帰する（再起動が要らないこと）
7  PC をスリープさせる → 作業宣言が解除されている（復帰後に画面で確認）
```

---

## 8. 相手側の状況

```
NKS 側   実装中（段①: 欄 3 本 + この API + 強制スリープの抑止）
         **API の形はこの文書のとおりで確定**。先に PC 側を書き始めてよい
段④     「振り先が無いとき PC の画面で実施/拒否を聞く」は**後回し**。
         入るときは pending_approval に中身が入り、別途連絡が来る
```

質問・仕様の食い違いは**オーナー経由で調停役へ**。この文書の出どころは
`coordination-lab/contracts/pc-presence-v1.md` v1.1 で、**食い違ったら契約が正**。
