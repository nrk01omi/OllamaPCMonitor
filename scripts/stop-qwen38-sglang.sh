#!/usr/bin/env bash
set -euo pipefail

pid_file=/root/run/sglang-qwen38.pid
if [[ -r "$pid_file" ]]; then
  pid=$(<"$pid_file")
  if kill -0 "$pid" 2>/dev/null; then
    kill -TERM "$pid"
    deadline=$((SECONDS + 60))
    while kill -0 "$pid" 2>/dev/null && (( SECONDS < deadline )); do sleep 1; done
    if kill -0 "$pid" 2>/dev/null; then
      echo "Timed out waiting for Qwen3.8 SGLang (pid $pid) to stop" >&2
      exit 1
    fi
  fi
  rm -f "$pid_file"
fi

# SGLang may briefly retain its listener while it drains child workers.  Do
# not allow a following start to race that graceful shutdown.
deadline=$((SECONDS + 20))
while ss -ltn "sport = :30000" | grep -q ':30000'; do
  if (( SECONDS >= deadline )); then
    echo 'Timed out waiting for TCP port 30000 to be released' >&2
    exit 1
  fi
  sleep 1
done
