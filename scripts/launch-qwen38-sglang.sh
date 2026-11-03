#!/usr/bin/env bash
set -euo pipefail

mkdir -p /root/logs
nohup bash /mnt/c/Users/nrk01/OneDrive/Apps/PDFtoCSV/start-qwen38-sglang.sh \
  >/root/logs/qwen38-sglang.log 2>&1 &
echo $!
