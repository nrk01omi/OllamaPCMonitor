# Project Maya Maya-XS 实機検証レポート

実施日: 2026-11-20   
対象: GLM-5.3-Flash Maya-XS-IQ1_S / Project Maya v1.1.68  
結果: **エンジン構築・サーバー起動・health確認は成功。推論はCUDA/DXGKRNL watchdog停止で失敗。RAM/VRAM圧迫は有力な要因だが、根因は未確定。性能値は取得できず。**

## 環境

- GPU: NVIDIA GeForce RTX 5090, 32,607 MiB VRAM, CUDA 13.0, driver 610.88
- CPU: AMD Ryzen 9 9900X, 12 cores / 24 threads
- RAM: 61.7 GiB total
- Model: 73.4 GB, two GGUF shards, IQ1_S; both shards were SHA-256 checked by Project Maya during setup
- Context: 131,072 tokens; text only; MTP drafting; `expert-cache=auto`, `kv-streaming=on`, `kv=int8`

## 実施内容と結果

1. 初期GPU使用量は121 MiBで、Strata/Mayaの待受けはありませんでした。
2. Project MayaのPython依存パッケージと固定commitのllama.cppを取得し、RTX 5090のsm_120向けCUDAエンジンをビルドしました（205項目完了）。Maya-XSのpackと128K設定を生成しました。
3. Managed起動でサーバーが起動し、`GET /health` は `status=ok`, `model=glm-5.3-flash`, `max_context=131072`, `images=false`, `version=1.1.68` を返しました。
4. `POST /v1/chat/completions` に「2+2は？」の短い入力、最大48出力tokenで1回だけ要求しました。
5. サーバーは専門家層9,904個（53.9 GB）を17秒、ログ上3,171.2 MB/sでウォームアップしました。ロード後のログ上の空きVRAMは1,789 MiBでした。
6. その後、会話復元段階で180秒進捗がなく、エンジンがexit code 3で自動停止しました。最終的にAPIは199.78秒後にHTTP 503を返し、生成token数は0でした。したがって応答速度・tokens/sは測定できていません。
7. Mayaログの失敗時点ではRAM available 309 MiB、2秒後には202 MiB、commit 64,047 MiB、累積page faultsは33,389,679でした。リクエスト中のGPU使用量は8,617 MiBまで下がったログ採取もあります。
8. Managed stop後は8080が閉じたことを確認しました。後の`nvidia-smi`では21,557/32,607 MiB使用、GPUプロセス一覧は空でした。これは初期121 MiBに戻っておらず、WDDM上の残留割当か別要因かは確認できていません。WindowsのGlobalMemoryStatusExで停止後RAM空き8.38 GiBを確認しました。

## 評価

この構成ではモデルロードとAPIのhealth確認までは動きましたが、今回の標準設定では推論を完了できませんでした。主要な観測は推論時のRAM逼迫（使用可能RAMが約0.2 GiB）とProject Mayaの無進捗停止です。速度評価や「使える」とする結論は出せません。128K contextでの実用可否も未検証です。

GPU停止後の使用量が初期値へ戻っていないため、Strata等がアンロード済みとは断定できません。今回の起動前に確認できたGPU使用量は121 MiBでしたが、停止後のGPUプロセス一覧は空で、使用量は21,557 MiBでした。原因調査前に別の重い推論を重ねるべきではありません。

## 追加調査: stall dump

`maya-stall-114928.dmp` をWinDbgで、同じビルドの `C:\Apps\ProjectMaya\build\maya.pdb` を使って解析しました。メインスレッドのスタックは次の通りです。

```text
nvcuda64!cuStreamSynchronize
maya!cudaStreamSynchronize
maya!strata::core::Glm5Model::reset
maya!glm_pack_generate::<lambda_26>  (generate.cpp:1944)
```

該当する `reset()` はKV/状態領域の非同期zero clearをCUDA streamに積んだ後、その完了を同期で待ちます。したがって、stall地点の直接の事実は「最初の要求で状態をreset中にCUDA streamの完了待ちから戻らなかった」です。ログ上の `restoring a conversation` はこの区間全体のprogressラベルで、会話checkpointファイルの読み込み中だったことを意味しません。要求はprompt計算やtoken生成に進まず、0 tokenで終わりました。

同時に、stall時のOS空きRAMは202 MiB、engineのresident working setは2,102 MiB、process commitは64,047 MiBでした。Windows実装で報告されるpage fault数は全page faults（hard faultsだけではない）です。2秒間の約170万増加はメモリ圧迫を示唆しますが、これだけでpagefile I/O量は断定できません。起動ログにはRAM tier 29.06 GB pinned、KV latent cache 0.78 GB pinned、CUDA poolのRAM/VRAM tierを出し、全体の空きVRAMは1,789 MiBでした。

## 原因判定

- **直接原因（確定）**: CUDA driverのstream synchronizeが進まず、最初のprompt前のstate resetが完了しなかった。
- **ロード時のmemory配置（既存Mayaログを再確認、2026-11-21）**: 131,072 contextのKVはVRAM 0.58 GB + pinned RAM 0.78 GB、expert poolはVRAM 21.88 GB、RAM tier 29.06 GB pinned。専門家53.9 GBを全tierへ17秒でwarmした後、全ロード状態の空きVRAMは1,789 MiBだった。engine configにはMTP draftingが有効で、ログ上のdense weightsは5.24 GB、context/KV 0.58 GB、other（context/MTP/scratch/prompt等）合計1.97 GB。この内訳にMTP単独の消費量はない。次の切り分け候補は、他条件を揃えて `MAYA_GLM_NO_MTP=1` でNextN draft blockだけをoffにし、RAM/VRAM配置とreset完了を比較すること。MayaのSETTINGS.mdと実装がこの設定をサポートしている。これは原因確定ではなく、まだ実施していない候補。
- **reset実装との照合（ソース読み取り、2026-11-21）**: `src/core/glm_model.cu` の `Glm5Model::reset()` は `state_` とKV stream map等を非同期zero clearした後 `cudaStreamSynchronize(fast_->cs)` を呼ぶ。成功時以外の戻り値はここではログに出さず、同期が返らないと要求処理が待つ。ユーザーダンプのスタック地点と一致する。ダンプはGPU queue/kernelの中身を含まないので、同期を止めたCUDA workやdriver内部の原因までは特定できない。
- **独立なGPU driver停滞の兆候**: 同じMaya実行ログの末尾に、GPU読み取り用スレッドがNVML `nvmlDeviceGetMemoryInfo` の応答を20秒待って失敗し、その後の読み取りを諦めてサーバーは継続した記録がある。これはメインスレッドのCUDA同期とは別経路でもGPU状態照会が応答しなかった証拠で、driver/device全体の応答性低下と整合する。ただし原因（メモリ圧迫、driver defect、GPU firmware/hardware）はなお不明。
- **有力な増悪要因**: 実際の要求中に物理RAM空きが約0.2 GiBまで枯れ、commit/page-fault pressureも極端だった。これはCUDAの進行遅延/driver側の待ちと整合するが、ダンプ単独では因果までは確定できない。
- **VRAM余裕の不足も疑い**: 起動後空き1,789 MiB。Project Mayaの公式READMEはWindowsで回答が急に遅い場合の対策として、2,048 MiBをreserveしてVRAMを空ける設定を案内しており、今回の空きはその目安を下回る。ただしreserveを上げるとexpert poolが小さくなり、RAM/SSD側の負荷が増える可能性があるため、RAM側の条件を整えず単独変更して再試行はしない。
- **Windows側の追加証拠**: 管理権限でApplicationログを読み、2026-11-20 17:36:22のWindows Error Reporting Event 1001を確認。bucketは `LKD_0x193_DxgkrnlLiveDump:815__watchdog!WdpDbgCaptureTriageDump`、添付ダンプは `C:\Windows\LiveKernelReports\WATCHDOG\WATCHDOG-20261120-1735.dmp`。Maya engineのCUDA waitと同じ時間帯にWindows graphics-kernel watchdogもlive dumpを記録していた。Microsoftによれば0x193はdxgkrnlがlive dumpを生成した識別コードで、単独で根因までは示さず、通常のbugcheck/BSODではない。
- **WATCHDOG dumpを追加解析（2026-11-21）**: 管理者WinDbgの `!analyze -v` で `VIDEO_DXGKRNL_LIVEDUMP (193)`、Arg1/Reason Code `0x815`、`PROCESS_NAME: System`、`FAILURE_BUCKET_ID: LKD_0x193_watchdog!WdpDbgCaptureTriageDump` を確認。ダンプはMini Kernel Dumpでレジスタと採取スレッドのスタックのみ。スタックは `watchdog!WdpDbgCaptureTriageDump` → `watchdog!WdDbgReport...` → `nt!ExpWorkerThread` で、問題を検出したGPU/ドライバー側の実行スタックは含まれていない。Microsoftの資料も0x193をdxgkrnlが生成したlive dumpの識別子と説明している。したがって0x815の詳しい意味、NVIDIA TDR/resetの実行有無、GPU停止元はこのダンプだけでは確定できない。[Microsoft: Bug Check 0x193](https://learn.microsoft.com/en-us/windows-hardware/drivers/debugger/bug-check-0x193--video-dxgkrnl-livedump)
- **同時刻イベントログ照合（2026-11-21）**: System/Applicationログを管理者権限で17:25〜17:50に確認。17:36:22に上記LiveKernelEvent/WER 1001、17:36:02に同じダンプを指すWER報告あり。17:30〜17:40にDisplay 4101、nvlddmkm、WHEA、Resource-Exhaustion等の該当記録は見つからなかった（これらのイベントが無かったことは、GPUリセットが絶対に無かった証明ではない）。17:26:41にはKernel-PowerのS3 resume記録、17:26:43にはSxTransition/session transition、17:29:43にはSessionUnlockがあり、watchdog発生の約10分前に復帰している。時間的に近い事実として記録するが、スリープ復帰が原因だったとの証拠はない。
- **スリープ時系列の照合（2026-11-21）**: Mayaサーバーは14:30に起動済み。OPMの `power-events.jsonl` とSystemイベントに、Maya稼働中の14:36、15:57、16:57にS3へのsleepがあり、16:57:56から17:26:41まで約29分間sleepしていた記録がある。APIの最初のchat completion要求は17:31:11で、復帰約4分半後。試験はOPM model-session APIではなく `Start-Maya-Managed.ps1` から直接起動しており、OPMのsession-active sleep guardに登録されない経路だった。したがって**sleep/resume後のGPU/CUDA状態不整合が今回の強い原因候補**になった。メモリ逼迫も実測済みのため、どちらか一方と決め打ちはしない。
- **対策（コード準備、未実機検証）**: `Start-Maya-Managed.ps1` にMaya Pythonプロセスの生存を追跡する専用 sleep guard の起動と、SetThreadExecutionStateの成功確認を追加。ガード開始を確認できない場合はMayaを停止して未保護起動を避ける。`Stop-Maya-Managed.ps1` は記録済みPIDと起動時刻を照合してガードを終了する。通常のOPM session guardと併用される場合も要求はスレッドごとに独立する。これは直接起動経路のスリープ再発を防ぐ対策だが、スクリプトはまだ実行確認しておらず、今回の原因を確定したことにもならない。
- **後日のGPU状態確認（2026-11-21）**: `nvidia-smi` はRTX 5090 driver 610.88、使用234 MiB/32,607 MiB、空き31,953 MiBを報告。11/20の停止後に記録した21,557 MiB残留は現在は解消しており、今回の追跡時点ではGPU全体に大きなVRAM占有はない。ただし、これは11/20停止直後の一時的残留原因を説明するものではない。
- **切り分け済み**: Maya server自体と `/health` は正常。OPM API route問題は別の検証上の欠陥で、今回の直接接続 `/v1/chat/completions` のstall原因ではない。stall dumpは前回の短い要求を処理したengine PID 114928由来で、そこにCUDA waitが記録されている。

結論: 単純な「モデルが非対応」ではありません。**MayaのCUDA stream同期と、別経路のNVML GPU照会がどちらも応答しなくなり、同時刻にWindows graphics-kernel watchdogがlive dumpを作った**ことまで確認できました。新たに、直接起動したMayaを残したままPCが複数回S3 sleepし、最後のresume約4分半後に最初の推論を投げたことも判明しました。**主なトリガー候補はsleep/resume後のGPU/CUDA状態不整合、増悪要因候補はRAM逼迫**です。両方が重なった可能性があります。根本は、sleep guardを付けた同一構成で単発要求が通るか比較するまで確定できません。

## 実行上の補足

- Windows既定CP932でProject MayaがUnicode出力時に落ちたため、準備とmanaged起動スクリプトで`PYTHONIOENCODING=utf-8`を指定しました。
- OPMルート振り分けにMaya APIが含まれていなかったため、`server.js`のMayaルート条件を修正しました。
- 一時的に起動したsleep guardは検証終了後に停止します。管理者専用の`powercfg /requests`は実行環境から照会できず、Windowsの要求一覧による独立確認はできませんでした。

## 次に確認すること

1. （追跡時点で解消を確認）`nvidia-smi` でGPU使用234 MiB/空き31,953 MiB。11/20停止直後の一時的な21.6 GiB残留原因は未特定。
2. （確認済み）管理者権限のSystem/Applicationイベントログで、当該時間帯のNVIDIA display driver reset/TDR、WHEA、Resource Exhaustionを照合。該当イベントは見つからず。WERに添付されたsysdata XMLもまだ読み取れていない。
3. 次回は今回と同じ設定・同じ短い要求で、更新したManaged起動経路のsleep guardだけを有効にして再比較する。要求前にguard activeと十分なRAMを別経路で確かめる。夜間無監視では実行しない。
4. sleepを止めてもCUDA同期が再び止まる場合は、次の一変数試験として `MAYA_GLM_NO_MTP=1` を検討し、RAM/VRAM配置と同期を比較する。成功した場合のみTTFT、生成tokens/s、GPU/RAMピークを測る。

## 2026-11-21 OPM経由の再試験

- **作業宣言とsleep guard**: 推論前にOPM `POST /monitor/api/work-hold` で30分のNAS作業宣言を登録。独立したpresence再読込で `sleep_blocked_by=["work_hold","presence"]`、`work_hold_until=2026-11-21T09:20:01+09:00`、`sleepGuard.active=true` / `running=true` を確認。期限更新後は `work_hold_until=09:41:35+09:00`。Maya managed startは専用guard PIDをready-markerとPID/start-time照合後に記録し、推論時点でPID 14712が生存していた。Windowsの `powercfg /requests` は管理者権限不足で照会できていないため、Windows表示上の要求一覧を確認したとは主張しない。
- **OPM起動経路**: OPMの `/monitor/api/sglang-services` で `glm53flash` を選択。旧実行中OPMがMayaにもWSL2ポート転送更新を呼ぶ欠陥があったため、`sync-sglang-portproxy.ps1` にMaya選択中のスキップを加え、子PowerShellでこの修正版を反映した。OPM応答は `operation=running`, `selected=glm53flash`, `sleepBlocked=true`。Project Mayaは09:23:47 JSTに `ready`, model `glm-5.3-flash`, context `131072` を報告。
- **短い推論**: OPM共通ゲートウェイ `127.0.0.1:8082/v1/chat/completions` に「2+2は？答えは数字だけ」を1回送信。HTTP成功、回答 `4`、経過2.91秒、prompt 25 tokens / completion 10 tokens。総応答時間をcompletion tokensで割った参考値は3.438 tokens/s。1回の短文試験なので、持続生成速度やTTFTの代表値とは扱わない。
- **後始末の独立確認**: OPM停止応答後にstate fileを読み直し `operation=idle`, `selected=null`、8080待受なし、Maya/guard PIDなし、`nvidia-smi` 195 MiB使用 / 31,992 MiB空きを確認。続けてOPMから作業宣言を解除し、presence再読込で `work_hold_until=null`、`sleepGuard.active=false` / `running=false` を確認。`data/gpu-services-state.json` は `pausedByMonitor=[]`, `holdUntil=null`。
- **結論**: Maya-XSはOPMの作業宣言・管理起動・8082経由で、少なくとも短い1要求に成功した。前回の直接起動失敗を解消したとは一般化せず、RAM/VRAMピーク、長文/長時間生成、持続tokens/sは未測定。次はスリープ抑止状態を維持したまま、より長い生成を計測する。

## 2026-11-21 Qwenとのコンテキスト比較による追記

上記の「長文/長時間生成は未測定」は、この追記前の状態。10:14〜10:33 JSTにOPM作業宣言とsleep guardを確認した状態で、Maya-XS-IQ1_S / 131,072 context / text-onlyを再起動し、中央に一度だけ入れた一意コードを約12K、24.6K、48.1K、95.1K、117.6K、127K、130.8K入力から想起できることを確認。最大試験は130,815 prompt tokens + 18 completion tokens、59.05秒で成功。別途、同一200-token出力依頼は8.05秒で完了したが、Mayaの内部decode timingがないため単純総時間からの参考値のみ。

同じ環境でQwen3.8-Flash-Next IQ3_XXS / Strataも順次試験し、約130.8K入力まで想起成功。Maya対Qwenの条件・速度比較、メモリ観測、制約は `docs/model-context-comparison-2026-11-21.md` を参照。これらは合成文書からの一意コード想起で、一般的な長文品質や同時要求の評価ではない。
