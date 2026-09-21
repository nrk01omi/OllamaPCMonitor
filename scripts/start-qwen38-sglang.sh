#!/usr/bin/env bash
set -euo pipefail

source /root/venvs/sglang/bin/activate
mkdir -p /root/logs
mkdir -p /root/run
exec >>/root/logs/qwen38-sglang.log 2>&1

export TVM_FFI_GPU_BACKEND=cuda
# Blackwell FP4 kernels are JIT-compiled on first launch.  Parallel NVCC jobs
# each consume several GB of RAM, so WSL2 needs this limit to avoid its OOM killer.
export MAX_JOBS=1
export CMAKE_BUILD_PARALLEL_LEVEL=1
echo $$ >/root/run/sglang-qwen38.pid
trap 'rm -f /root/run/sglang-qwen38.pid' EXIT
exec sglang serve \
  --model-path /root/models/Qwen3.8-27B-NVFP4 \
  --served-model-name qwen3.8-27b \
  --trust-remote-code \
  --tp-size 1 \
  --mem-fraction-static 0.89 \
  --max-running-requests 1 \
  --context-length 81920 \
  --kv-cache-dtype nvfp4 \
  --mamba-full-memory-ratio 3 \
  --mamba-ssm-dtype bfloat16 \
  --attention-backend flashinfer \
  --host 0.0.0.0 \
  --port 30000
