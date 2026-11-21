# Qwen3.8-Flash と Project Maya Maya-XS 比較（2026-11-21）

## 2026-11-21 実機比較（10:14〜10:33 JST）

### 条件と手順

- RTX 5090 32GB / RAM 61.7GiB。QwenはStrata IQ3_XXS、131,072 context、text only。MayaはMaya-XS-IQ1_S、131,072 context、text only。各構成をOPMの手動モデル選択経路で一つずつ起動した。
- 試験開始時に以前の外部Qwen model-sessionは `idle`、OPM manual selectorも `idle` であることを確認。その後NAS作業宣言を180分登録し、別経路のpresenceで期限13:14 JST、`sleep_blocked_by=["work_hold"]`、`sleepGuard.active/running=true` を確認してから起動した。各推論前にもguardを再確認した。
- 約12K〜131Kの文脈に一意の検索コードを中央へ一度だけ挿入し、末尾で答えを求めた。各サイズ1回、temperature 0、出力上限24 tokens。全ケースで `cached_tokens=0`、コードを正答。コンテキスト品質全般ではなく、長文中の一項目想起試験である。
- Qwenのprompt速度はStrata `/v1/status` の `prompt_per_second`。Mayaは内部prompt timingを返さないため、実prompt tokens ÷ API全体の経過秒で示す概算値（短い回答生成も時間に含む）。速度の計測方法は完全一致しない。

### 一意コード想起と入力処理

| 実測入力tokens | Qwen IQ3_XXS: 全体秒 / prompt tok/s | Maya-XS: 全体秒 / 概算prompt tok/s | 想起 |
|---:|---:|---:|:---:|
| 約12K | 4.08 / 4,490 | 9.07 / 1,331 | 両方成功 |
| 約24.6K | 5.69 / 5,712 | 14.90 / 1,649 | 両方成功 |
| 約48.1K | 9.68 / 5,860 | 22.12 / 2,173 | 両方成功 |
| 約95.1K | 17.86 / 5,884 | 45.60 / 2,085 | 両方成功 |
| 約117.6K | 22.23 / 5,758 | 58.20 / 2,020 | 両方成功 |
| 約127.0K | 23.86 / 5,761 | 58.39 / 2,175 | 両方成功 |
| 約130.8K | 24.62 / 5,739 | 59.05 / 2,215 | 両方成功 |

各行は単発の合成文書試験であり、中央値ではない。最大ケースの実値はQwen 130,822 prompt tokens + 9 completion tokens、Maya 130,815 + 18。どちらも総token数は131,072未満だった。131,072ちょうどのprompt、長文文書の理解品質、長時間・並列利用は未試験。

### 生成速度

同じ約53-token依頼から200-token回答を生成した。Qwenは3.66秒、Strata内部計測で103.0 decode tok/s。Mayaは8.05秒、usageは52 prompt / 200 completionで、全体時間から単純計算した約24.8 completion tok/s。Mayaはpromptとdecodeを分離した内部timingを返さないため参考値であり、厳密なdecode速度比較ではない。いずれも短い1回のサンプル。

### メモリと終了確認

- Qwen IQ3_XXS起動後のRAM使用はStrata状態表示で約58.7GiB、空き約2.9GiB。試験中の最低観測空きRAMは約1.95GiB、GPU使用は約31,251MiB/32,607MiB（空き約936MiB）。上限近くまで動いたが、RAM余裕は小さい。
- Maya起動後の試験前空きRAMは約5.4〜6.0GiB、GPUは約30,860MiB使用（空き約1,327MiB）。最大文脈試験後の空きRAMは約8.8GiB、GPU空き約1,149MiB。ピーク値の連続サンプリングはしていない。
- 各モデルは次のモデル起動前にOPM停止。試験後は両ポート8080/18082が閉じ、OPMがidle、GPU使用137MiB、RAM空き45.4GiBを確認。続けて作業宣言をOPMから解除し、別経路でNKS `work_hold_until=null` / blockなし、sleep guard停止を確認。Whisper/Rerank補助サービスはOPMから再開された。

### 結論

- **ネイティブ128K文脈:** 今回の一意コード試験では、Qwen IQ3_XXSとMaya-XS-IQ1_Sの両方が130.8K入力まで成功。よって、Maya-XSも設定値だけでなく、ほぼ上限までの実入力を処理できることを確認した。
- **速度:** Qwen IQ3_XXSは入力処理で約5.7K tok/s（12K初回以外）、Mayaの全体時間ベース概算は約1.3K〜2.2K tok/s。130.8K例の全体時間はQwen 24.62秒、Maya 59.05秒。今回の合成入力ではQwenが約2.4倍速かった。ベンチ文面・内部timingの有無・量子化が異なるため一般性能の倍率とはみなさない。
- **生成:** 200-token依頼ではQwenが明確に速かった（103.0 tok/s 対 Maya概算24.8 tok/s）。Maya値は総時間割算で、真のdecode tok/sより低く出る可能性がある。
- **実用余裕:** Qwen IQ3_XXSはRAM空き約2GiB・VRAM空き1GiB未満で動作したため、同時に大きなアプリを使う余裕が少ない。MayaもVRAM空きは約1.1GiBで、並列GPU処理は避けるべき。
- **拡張コンテキスト:** 以前の512K成功記録はQwen IQ2_XSのvision/YaRN/q4_0 KV実験構成。今回のIQ3_XXS構成やMayaの512K性能を示すものではない。今回の実機比較が確認した上限は、双方とも131,072設定の約130.8K入力。

比較を完了した範囲は、単一リクエストの合成長文想起と200-token短文生成速度。知識品質、実文書要約、画像、512K、複数同時要求は評価していない。

## 外部クライアントからモデルを指定する方法

`GET http://<GPU-PCの到達可能アドレス>:8082/v1/models` の `data[].id` が指定値。表示名ではなくカタログIDを使う。現行一覧では、Qwen text-only=`strata128k`、Qwen vision=`strata128kvision`、Maya-XS=`glm53flash`。実効モデル名はそれぞれ `/v1/models` の `inference_model` を参照する（今回のStrataはIQ3_XXS）。

モデルセッションを起動するときは同じIDを制御APIに渡し、`ready=true` を確認してから推論する。

```http
POST /control/v1/model-sessions
Content-Type: application/json

{"model":"glm53flash","ttl_seconds":1800,"request_id":"client-unique-id"}
```

状態を `GET /control/v1/model-sessions/{session_id}` で確認し、ready後に共通推論入口へ同じカタログIDを渡す。

```http
POST /v1/chat/completions
Content-Type: application/json

{"model":"glm53flash","messages":[{"role":"user","content":"こんにちは"}]}
```

Qwenを使う場合は上の両方の `model` を `strata128k`（visionなし）または `strata128kvision`（visionあり）に置き換える。完了したら `DELETE /control/v1/model-sessions/{session_id}` で終了する。`/v1/models` の `session_state` が `idle` のときは起動されていないため、推論要求の前にセッションを開始する。

## 試験前に残していた記録（参考）

以下は今回の実機比較前に記録した状態と、過去の別量子化データ。現行IQ3_XXS / Maya-XS-IQ1_Sの今回の測定結果と区別する。

同日09時台の状態確認では、外部セッション `e21df170-218a-4988-9c09-f8e888279716` が `ready`、`strata128kvision` / IQ3_XXS / 131,072 context / vision有効だった。その時間帯は推論・停止・解除をせず、10:14 JSTに `idle` を確認した後で今回の試験を開始した。

## 比較表

| 項目 | Qwen3.8-Flash-Next / Strata | GLM-5.3-Flash / Project Maya Maya-XS |
|---|---|---|
| 当時確認した構成 | OPM外部セッションのIQ3_XXS、vision有効、131,072 context | Maya-XS-IQ1_S、text only、131,072 context |
| 実測速度 | IQ2_XS過去測定: 入力5,383 tok/s（118,968 tokens）、生成172 tok/s。短〜中入力では入力約5,300〜5,750、生成約182〜243 tok/s | OPM経由の短文1回: 25 prompt / 10 completion tokens、全体2.91秒。単純割算3.44 tok/sは短文応答の参考値で、生成速度の測定値ではない |
| 128K付近の入力 | IQ2_XSで118,968 tokensを処理。別のneedle試験で128K設定の長文想起も成功 | 設定とhealthのmax_context=131,072は確認。上限付近入力・想起は未試験 |
| 拡張コンテキスト | IQ2_XSの実験的vision構成で、YaRN 2倍 + q4_0 KV、513,969-token入力でneedle想起成功。512K設定の実験結果で通常設定の保証ではない | 131,072設定のみ。128K超は未確認 |
| vision | 現在の外部セッションで有効。過去のIQ2_XSで画像入力成功 | 対象Maya設定はimages=false、text only |
| メモリ/安定性 | IQ2_XSの128K sweepでシステムRAMピーク54〜55.5 GiB、VRAMピーク約31,114 MiB。現在のIQ3_XXSで同じ数値は未計測 | 前回direct試験で推論停止。RAM空き約202 MiB、VRAM空き約1,789 MiBまで逼迫。対策後のOPM短文要求は成功。長時間・長文負荷は未評価 |

## 試験前の解釈

- **長い入力への対応実績は現状Qwen側が明確に多い。** 128K上限近くの約119K入力と、実験的512K構成での約514K入力を処理した保存済み実績がある。これらはIQ2_XSの記録で、現在外部セッションのIQ3_XXS構成にそのまま当てはめられない。
- **Mayaの128Kは現状「設定・起動確認」であり、128K入力成功を意味しない。** 実測は短い質問1回のみ。Mayaが長文でも安定して動くか、またQwenとどちらが速いかは結論できない。
- **速度数値は直接比較不可。** Qwenは合成入力を含む複数回の中央値、Mayaは短文1回の総時間。Mayaの3.44 tok/sを通常生成速度として扱わない。
- **実用余裕は別の懸念がある。** Qwen IQ2_XSの過去計測ではRAM余裕が約7GiB、VRAMもほぼ満杯。Mayaの前回停止ではRAM/VRAM双方が逼迫した。バックグラウンドアプリを含む同時利用条件での再評価が必要。

## 試験前の暫定判定（今回の試験前）

- Qwen: **128K近傍の長文実績あり**（IQ2_XS）。**512Kは拡張設定での実験実績あり**（IQ2_XS vision）。現在のIQ3_XXSの同一条件性能は未測定。
- Maya-XS: **OPM経由で短文応答を確認**。**128K近傍の入力対応、速度、長時間安定性は未判定**。
- この暫定判定は上記の2026-11-21実機比較前のもの。今回、外部セッションがidleであることと作業宣言/sleep guardを確認した後に短/中/長入力を測定し、上の実機比較セクションへ結果を追加した。

## 根拠ファイル

- Qwen 128K性能: `strata-bench-2026-10-04.md`（IQ2_XS、各条件3回中央値）
- Qwen vision/512K: `strata-vision-bench-2026-10-04.md`（IQ2_XSの実験構成）
- Maya: `project-maya-xs-performance-2026-11-20.md`（2026-11-21 OPM再試験を含む）
- 現在の量子化記録: `data/strata-quant.json`（IQ3_XXS）
