#!/usr/bin/env bash
set -euo pipefail

pid_file=/root/run/flide-onejev.pid
if [[ -r "$pid_file" ]]; then
  pid=$(<"$pid_file")
  if kill -0 "$pid" 2>/dev/null; then
    kill -TERM "$pid"
    deadline=$((SECONDS + 60))
    while kill -0 "$pid" 2>/dev/null && (( SECONDS < deadline )); do sleep 1; done
    if kill -0 "$pid" 2>/dev/null; then
      echo "Timed out waiting for OneJev Flide (pid $pid) to stop" >&2
      exit 1
    fi
  fi
  rm -f "$pid_file"
fi

# Do not report idle until the inference port is actually released.
deadline=$((SECONDS + 20))
while ss -ltn "sport = :8083" | grep -q ':8083'; do
  if (( SECONDS >= deadline )); then
    echo 'Timed out waiting for TCP port 8083 to be released' >&2
    exit 1
  fi
  sleep 1
done
