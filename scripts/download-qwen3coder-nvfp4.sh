#!/usr/bin/env bash
set -euo pipefail

exec /root/venvs/sglang/bin/python -c "from huggingface_hub import snapshot_download; print(snapshot_download(repo_id='NVFP4/Qwen3-Coder-30B-A3B-Instruct-FP4', local_dir='/root/models/Qwen3-Coder-30B-A3B-Instruct-FP4'))"
