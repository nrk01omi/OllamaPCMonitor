# RTX 5090 PCへのRTX 3090追加 — 事前評価（2026-11-21）

## このPCで確認できたこと

- CPU: AMD Ryzen 9 9900X
- マザーボード: ASUS X870 MAX GAMING WIFI7
- 現在のGPU: RTX 5090 32GB。`nvidia-smi` はPCIe Gen5 x16、power limit 400Wを報告（400Wは上限表示であり、常時消費電力ではない）。
- PSU型番、空き電源ケーブル、ケース内のカード寸法余裕は未確認。

ASUSの仕様では、Ryzen 9000搭載時にCPU直結PCIe 5.0 x16が1本。チップセット側の追加PCIe 4.0 x16形状スロット2本はx1動作で、PCIe 3.0 x16形状スロット1本もx1動作。追加GPUのモデル並列化ではこのx1リンクが通信制約になりうる。

RTX 3090は24GB GDDR6X、標準Graphics Card Power 350W。RTX 5090 Founders Editionの仕様は32GB GDDR7、575W、メモリ帯域1,792 GB/s。今回PCで報告された5090 power limit 400Wは標準TGPより低い値。

## 期待できる利点

1. **VRAMを使い分ける**: 3090専用の推論プロセスをGPU1へ割り当て、5090上の処理と並行実行できれば、複数リクエストや別モデルの合計処理量を増やせる。増加率は、実際のモデル・設定・同時負荷を測るまで数値化できない。
2. **単体に収まらないモデル**: 推論エンジンが複数GPUへの重み/KV分割に対応し、GPU1のPCIe x1リンクで成立するなら、名目上は合計56GB（32+24GB）のVRAMへ分散できる。VRAMは自動的に一つの連続メモリになるわけではなく、利用可能量はruntime予約などの分だけ小さい。
3. **今のOPM構成への即時効果**: なし。現在のMaya設定は`gpu:[0]`、Strata設定も`gpu:0`。Strata起動スクリプトの空きVRAM検査もGPU 0のみを見る。3090を挿すだけではOPMモデルがGPU1や両GPUを使う構成にならない。

## 速度への見立て

単一リクエストの生成速度が増えるとは見込まない。5090はメモリ帯域1,792 GB/s、3090は公式仕様上のGPU帯域が約936 GB/sで、単純な帯域比でも3090は5090の約52%。さらにこのマザーボードの追加スロットはx1接続なので、層/テンソル分割時の通信を含めた速度は推論runtime依存で、5090単体より遅くなる可能性がある。llama.cppの公式multi-GPU文書も、モデルが単GPUに入るなら分散推論は不要なこと、GPU間接続が速度を制限しうることを説明している。

## 導入前に必要な確認

- PSUのメーカー・型番・容量、3090用の独立したPCIe 8-pin電源線、5090の給電線。GPU定格だけで5090は最大575W、3090は350W（合計925W相当）で、CPU・基板・瞬間負荷を含む余力が必要。
- ケースとカードの長さ・厚さ・排熱。カードのAIBモデルで寸法が変わり、隣接スロットや吸気を塞ぐ可能性がある。
- 2枚挿し後のPCIe接続表示、GPU番号、CUDA runtime、各サービスのGPU pinning、VRAM監視、同時起動制御。
- メリットの中心が「大きなモデルを分割して動かす」か「独立した2モデルを並行処理する」か。後者の方がこのボードでは現実的だが、OPMとエンジン側のGPU1対応改修が必要。

## 暫定結論

追加3090の最大の潜在価値は、単発速度の向上ではなく、独立GPUでの並行推論または単GPUのVRAM不足解消。現行OPMではGPU0固定で、追加スロットもx1のため、挿すだけの性能向上は期待できない。電源・ケースが不明なため、物理導入可否も未判定。

参考: [ASUS X870 MAX GAMING WIFI7 specifications](https://dlcdnets.asus.com/pub/ASUS/mb/SocketAM5/X870_MAX_GAMING_WIFI/E25880_X870_MAX_GAMING_WIFI7_SERIES_EM_WEB.pdf?model=X870+MAX+GAMING+WIFI7), [NVIDIA RTX 5090 specs](https://www.nvidia.com/en-us/geforce/graphics-cards/50-series/rtx-5090.html), [NVIDIA RTX 3090 specs](https://www.nvidia.com/en-us/geforce/graphics-cards/30-series/rtx-3090-3090ti/), [llama.cpp multi-GPU guide](https://github.com/ggml-org/llama.cpp/blob/master/docs/multi-gpu.md), [vLLM parallelism guide](https://docs.vllm.ai/en/latest/serving/parallelism_scaling/).