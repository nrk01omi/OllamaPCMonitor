---
id: DEC-2026-09-29-ollamapcmonitor-task-scheduler-self-heal
project: coordination-lab
type: decision
title: OllamaPCMonitor（3090/5090）のタスクスケジューラ設定に自己回復を追加
description: 在席heartbeatアプリ(OllamaPCMonitor)がクラッシュ・セッション切断で無音のまま何日も気づかれない障害を、タスクスケジューラの設定変更3点で自己修復するようにした記録。
date: 2026-09-29
session: coordination-lab 2026-09-29（調停役）
generated:
  by: coordinator
  at: 2026-09-29
domains: [pc-presence, gpu, power, ollamapcmonitor]
related_adr: []
related_runbook: []
tags: [ollamapcmonitor, task-scheduler, session-state-change, self-heal, pc-presence-v1]
status: stable
---

## 状況

- `pc-presence-v1`（人が触っているPCを寝かせない）の心拍元である `OllamaPCMonitor`（3090/5090でそれぞれ常駐）が、実際には**両機とも無音**になっていた。
  - 3090: 最後の心拍が約14時間前。実プロセスが存在せず、タスクの `Last Result: 1`（クラッシュ）。
  - 5090: 最後の心拍が約3.5時間前。プロセス自体は生きていたが、セッションがRDP切断で `Disconnected` になり、`GetLastInputInfo`（無操作秒数の取得元）が実入力を受け取れない状態だった。
- WinRM経由で実機の `schtasks /query /fo LIST /v` とセッション表（`query session`）を直接確認して特定（憶測ではなく実測）。
- 両機とも `OllamaPCMonitor` タスクは **「ログオン時起動・対話セッションのみ (Interactive only)」** で登録されていた。`GetLastInputInfo` は呼び出し元の対話セッションでしか正しい値が取れないため、この起動方式自体は妥当（Session 0 の通常サービス化はできない制約）。
- 問題は起動方式ではなく、**死んだ後に誰も気づかず・誰も直さない**こと。既存の RestartOnFailure（`RestartInterval=PT1M`, `RestartCount=3`）は入っていたが、**切断中の再起動リトライも同じ理由（対話セッション不在）で失敗し、3回で力尽きて以後無音**になっていたと推測される（3090の障害と整合）。

## 決定

`OllamaPCMonitor` タスク定義（両機）に、既存の「ログオン時」トリガーと Principal（RunAsUser・対話トークン）はそのまま残し、**以下3点を追加**した。

1. **5分おき・無期限リピートの時刻トリガー**（本命）

   - `TASK_TRIGGER_TIME`、`Repetition.Interval = PT5M`、`Repetition.Duration` は空（無期限）。
   - `MultipleInstances = IgnoreNew` を設定し、既に動いていれば何もしない・死んでいれば5分以内に立て直る。
   - ログオンかRDP再接続かクラッシュか、原因を問わず再起動を試みる安全網。

2. **セッション状態変化トリガー（`TASK_TRIGGER_SESSION_STATE_CHANGE`）を2本**

   - `StateChange = RemoteConnect(3)` — リモートデスクトップ接続時。その場で復帰する。
   - `StateChange = SessionUnlock(8)` — 画面ロック解除時。物理コンソールでの復帰にも対応。
   - `UserId` はタスク本来の実行ユーザー（3090=`omik`、5090=`nrk01`）に合わせた。

3. **RestartOnFailure の強化**

   - `RestartInterval = PT1M`（変更なし）
   - `RestartCount: 3 → 999`
   - 切断中の再起動は失敗しうるが、二重の保険として維持。

## 根拠

- **セッション0サービス化はできない**: `GetLastInputInfo` は呼び出し元の対話セッションの入力キューしか見えないため、常駐が対話ログオン依存になるのは設計上の必然。直すべきは起動方式ではなく「死んだ後の回復力」。
- **既存のRestartOnFailure(3回)だけでは不十分だった実測**: 3090はクラッシュ後長時間無音のままだった。切断中の再起動試行が失敗する条件下では、時間ベースの独立したトリガーが回復機会を作る。
- **`IgnoreNew` で多重起動を防止**: タスクスケジューラ自身がそのタスクの実行中インスタンスを追跡しているため、5分おきの再評価でも二重起動しない。

## 結果

- WinRM経由でCOM (`Schedule.Service`) を使い、両機の実タスク定義に直接適用。適用後に `Triggers.Count` と `RestartCount` を読み戻して検証済み（3090: trigger数 1→4・RestartCount 999／5090: 同様）。
- 適用直後、3090・5090とも心拍（`nfs.power_pc_presence.pc_presence_seen_at`）が数十秒以内の鮮度まで復旧したことをDB直読みで確認済み。
- **未検証のまま持ち越し**: 実際にセッションが切断・プロセスがクラッシュする条件下で、5分以内に自動回復するかどうかは**次にその状況が起きたときに初めて確認できる**（今回は手動介入後の状態確認のみ）。
- この障害の間、`pc-presence-v1` の在席判定は実質「unknown」（3090は特に長期間）だったため、その間に強制sleep等の判定に依存する機能があれば影響していた可能性がある。今回は該当する自動アクションが無かったため実害は確認されていない。
