#!/usr/bin/env bash
set -euo pipefail

source /root/venvs/sglang/bin/activate
mkdir -p /root/logs /root/run
exec >>/root/logs/qwen3coder-sglang.log 2>&1

model=/root/models/Qwen3-Coder-30B-A3B-Instruct-FP4
test -f "$model/config.json"
echo $$ >/root/run/sglang-qwen3coder.pid
trap 'rm -f /root/run/sglang-qwen3coder.pid' EXIT

exec sglang serve \
  --model-path "$model" \
  --served-model-name qwen3-coder-30b \
  --trust-remote-code \
  --tp-size 1 \
  --mem-fraction-static 0.82 \
  --max-running-requests 1 \
  --context-length 65536 \
  --attention-backend flashinfer \
  --moe-runner-backend flashinfer_cutlass \
  --tool-call-parser qwen3_coder \
  --host 0.0.0.0 \
  --port 30001
