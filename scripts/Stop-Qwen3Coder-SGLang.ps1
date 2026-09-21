$ErrorActionPreference = 'Stop'

wsl.exe -d Ubuntu-22.04-RAG -- bash /mnt/c/Apps/OllamaPCMonitor/scripts/stop-qwen3coder-sglang.sh
Write-Host 'Qwen3-Coder SGLang stopped.'
