# Maya-XS context scaling: coding benchmark (2026-11-21)

## Setup

- Hardware: Ryzen 9 9900X, RTX 5090 32 GB, 64 GB system RAM.
- Model: Project Maya v1.1.68, GLM-5.3-Flash Maya-XS-IQ1_S, text-only, GPU 0, INT8 KV, KV streaming on, prefill auto.
- Tested configured contexts: 131,072 / 262,144 / 393,216 / 524,288 tokens (128K/256K/384K/512K).
- Each request went through the OPM inference gateway on port 8082. Model startup and shutdown went through `/monitor/api/sglang-services`; NKS work-hold and sleep guard were independently checked.
- Context prompts were counted with Maya's own tokenizer and `/tokenize`. Requests used temperature 0, top_p 1, seed 1234, reasoning_effort low, thinking disabled, and max_tokens 384.
- At each setting, a 220-token fixed coding prompt was sent, followed by the same coding task with a synthetic repository archive filling nearly the configured context. The long task asked for an HTTP `Retry-After` parser.
- OPM's Maya ready check was temporarily relaxed from exact 128K equality to `max_context >= 131072` so the existing OPM model route could accept the larger temporary configurations. After measurement, the original OPM source and 128K config were restored by file hash; OPM was restarted and verified idle. The work-hold remains active pending the user's acknowledgement.

## Results

Maya's `timings` provide prompt and decode rates. Wall time is measured by the client through OPM. Each cell is one run.

| Configured context | Fixed prompt: decode | Long prompt tokens | Long prompt prefill | Long answer decode | Client wall time |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 128K | 16.7 tok/s (202 tokens) | 127,788 | 1,950.9 tok/s · 65.5 s | 23.9 tok/s (224 tokens) | 76.2 s |
| 256K | 15.2 tok/s (193 tokens) | 257,616 | 2,039.5 tok/s · 126.3 s | 23.4 tok/s (223 tokens) | 137.2 s |
| 384K | 15.4 tok/s (200 tokens) | 387,365 | 2,004.4 tok/s · 193.3 s | 22.5 tok/s (196 tokens) | 203.3 s |
| 512K | 15.1 tok/s (187 tokens) | 517,328 | 1,900.5 tok/s · 272.2 s | 20.8 tok/s (384 tokens) | 292.2 s |

The fixed prompt was 220 rendered tokens at every setting. Its prompt processing was 53.9–57.1 tok/s. The long-prompt counts include 12 chat-template tokens beyond the content count.

## Reading the measurements

- Raising the configured context alone did not create a clear speed change on the fixed prompt: decode varied from 15.1 to 16.7 tok/s with no repeated trials.
- For long inputs, prefill stayed near 1,900–2,040 tok/s. Moving from 127,788 to 517,328 prompt tokens increased input size 4.05× and prefill time 4.16×. The added delay is mainly the time to read the larger prompt; throughput was about 2.6% lower at 512K than at 128K.
- Decode after the long prompts ranged from 20.8 to 23.9 tok/s. The 512K response reached the 384-token output cap (`finish_reason=length`); its code block was complete, but the model continued with extra commentary until the cap. Treat the 512K decode rate as less directly comparable.
- All four long-prompt code blocks used the correct future-date subtraction. The short-prompt answer reversed that subtraction at 128K and 384K, but not at 256K and 512K. This inconsistency, plus one run per case, is not enough to claim a context-related quality trend.
- 512K started and processed the full prompt. During the run, observed free system RAM stayed at or above about 5.1 GiB; observed GPU free memory was about 0.5–1.0 GiB. This shows the configuration can complete this task on this machine, not that 512K is a generally safe maximum under other GPU workloads.

The input is a synthetic archive used to fill context, so these are throughput measurements rather than a representative repository benchmark. Raw prompts and responses are in `data/maya-context-coding-benchmark/`. The 512K result JSON was written successfully; the local runner then hit a CP932 console-encoding error while printing its Unicode answer. The saved response and timing fields were read back from the JSON.

## State after the run

- Maya stopped through OPM; port 8080 closed; OPM operation `idle`.
- Maya text config restored to `--max-context 131072`.
- `sglang-services.js` restored to its pre-run SHA-256; OPM restarted with that source.
- NKS `work_hold` and `sleepGuard.active/running` remain active. Hold expiration reported by NKS: 2026-11-21 17:13:23 JST. It was not explicitly released.
