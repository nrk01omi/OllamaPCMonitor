$ErrorActionPreference = 'Stop'

wsl.exe -d Ubuntu-22.04-RAG -- bash /mnt/c/Apps/OllamaPCMonitor/scripts/stop-qwen38-sglang.sh
Write-Host 'Qwen3.8 SGLang stopped.'
