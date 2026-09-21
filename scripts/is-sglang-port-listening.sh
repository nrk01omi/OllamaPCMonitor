#!/usr/bin/env bash
set -euo pipefail

port=${1:?port is required}
ss -ltn "sport = :$port" | grep -q ":$port"
