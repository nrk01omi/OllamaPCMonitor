$ErrorActionPreference = 'Stop'

wsl.exe -d Ubuntu-22.04-RAG -- bash /mnt/c/Apps/OllamaPCMonitor/scripts/stop-onejev-flide.sh
if ($LASTEXITCODE -ne 0) { throw 'OneJev Flide did not stop cleanly.' }
Write-Host 'OneJev Flide stopped.'
