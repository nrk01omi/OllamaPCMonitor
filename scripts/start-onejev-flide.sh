#!/usr/bin/env bash
set -euo pipefail

source /root/venvs/flide/bin/activate
mkdir -p /root/logs
mkdir -p /root/run
exec >>/root/logs/onejev-flide.log 2>&1

echo $$ >/root/run/flide-onejev.pid
trap 'rm -f /root/run/flide-onejev.pid' EXIT
# fp8: same ranking as bf16 on the Japanese probes, ~7 GB less VRAM, so Whisper
# and the reranker can stay loaded next to it.
exec flide serve \
  --model /root/models/OneJev1.6-9B \
  --name onejev1.6-9b \
  --quantize fp8 \
  --max-request-tokens 16384 \
  --host 0.0.0.0 \
  --port 8083
