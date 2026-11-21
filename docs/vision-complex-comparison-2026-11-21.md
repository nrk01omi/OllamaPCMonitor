# Vision複合画像比較 — Strata IQ3_XXS と Maya-XS（2026-11-21）

## 結果

4×4の位置付きグリッド画像を使い、図形総数、赤い図形数、青い三角形数、三角形が最も多い行（同点を含む）、隣接セル2件、D4の図形の計7項目をJSONで回答させた。両モデルとも同じ画像、質問、温度0、最大出力1024 tokensを使用し、OPMの `/v1/chat/completions` ゲートウェイ（8082）経由で3回計測した。

| 構成 | 正解数（7項目） | キャッシュなし初回 | キャッシュあり再試行平均 | 再試行の生成速度 |
|---|---:|---:|---:|---:|
| Strata Vision / IQ3_XXS | 7/7、3回とも | 6.52秒 | 4.60秒 | 約199.9 tok/s |
| Maya-XS Vision / IQ1_S | 5/7、5/7、6/7 | 27.92秒 | 9.57秒 | 約44.6 tok/s |

Strataは3回とも7項目を正答。Mayaは「三角形が最多の行」の同点（2・3行）を3回とも2行のみと答え、隣接セル「C2の下」は2回青い三角形と誤答した。Mayaの生成速度は3回の内部timingで26.1、42.3、46.8 tok/s、Strataはキャッシュなし145.9 tok/s、キャッシュあり185.0、214.7 tok/s。

## 手順と後始末

- 合成グリッド画像: `data/vision-complex-grid.jpg`（SHA-256: `1A4208F92986A53C926ECCAA957FDFE1E47FE54721B05BB5AD0EA3205A638352`）
- 起動はOPM `/monitor/api/sglang-services`、推論は外部向け8082ゲートウェイを使用。
- 試験中はNKS `work_hold` とsleep guardの有効を確認。終了後はOPMから停止し、8080/18082待受停止、OPM idleを確認。
- ユーザーの以前の指示により、NAS作業宣言は解除せず維持。解除は報告後のユーザー了解待ち。

## 制約

合成画像1枚の小規模試験で、実写真・文書・OCR・多様な照明条件を代表しない。繰り返し試行はKV cacheにより入力時間が短縮されるため、初回とキャッシュあり再試行を分けて記載した。速度値は当該設定・画像・質問の実測値で、一般性能保証ではない。

## WordPress記録状態

ユーザー指定の `C:\Apps\nas-knowledge-stack\.env` から認証情報を読み、既存の公開投稿ID 56「作業ログ（〜2026-10-18・凍結）」の先頭に本レポートを追記した。2026-11-21 13:10 JSTの公開REST GETで投稿status `publish`、Vision比較値、RTX 3090概要、MerPress `class="mermaid"` を別経路確認。URL: https://nas-ugreen.tail9ac64d.ts.net/session-progress-log/
## 2026-11-21 12:39 JST — OPM状態の再確認

- OPM state file indicates a separate model-session for `strata128kvision` in `ready`, started 12:33:16 JST and expiring 13:03:16 JST; session ID `6d3721a7-3eaa-4e3a-b056-d8b820183681`. Source was not determined in this task.
- `/monitor/api/sglang-services` reports Strata Vision active and port 18082 listening. The manual stop and work-hold extension endpoints both return HTTP 409 `OPM model session is active`; no direct process kill or model-session release was attempted.
- The prior work-hold deadline (12:33:10 JST) passed naturally. Independent presence reports `sleep_blocked_by=["external_session"]` and local `sleepGuard.active/running=true`. Work hold has not been cleared by this task, but is expired; user instruction to wait before releasing remains in force.

## 2026-11-21 13:10 JST — 公開記録後の状態

- WordPress公開済み作業ログID 56を更新。公開GETでタイトル、数値、MerPress描画を確認。
- OPMの別Strata model-sessionは13:03 JST期限後、13:09 JSTに operation=idle、active modelなし、8080/18082閉鎖を確認。
- 以前のwork-holdは自然期限切れ後、投稿前にユーザーの「了解まで解除しない」指示に従いOPM work-holdを30分再登録。NKS sleep_blocked_by に work_hold、sleepGuard active/runningを別経路確認。新期限13:39:36 JST。明示的解除は未実施。
