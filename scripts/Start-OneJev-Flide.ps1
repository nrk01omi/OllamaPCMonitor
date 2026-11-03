$ErrorActionPreference = 'Stop'

$portCheck = '/mnt/c/Apps/OllamaPCMonitor/scripts/is-sglang-port-listening.sh'
& wsl.exe -d Ubuntu-22.04-RAG -- bash $portCheck 8083
if ($LASTEXITCODE -eq 0) { throw 'OneJev Flide is already running or still stopping on port 8083.' }

$script = '/mnt/c/Apps/OllamaPCMonitor/scripts/start-onejev-flide.sh'
Start-Process -FilePath 'wsl.exe' `
    -ArgumentList @('-d', 'Ubuntu-22.04-RAG', '--', 'bash', $script) `
    -WindowStyle Hidden

Write-Host 'OneJev Flide is starting. API: http://127.0.0.1:8083/v1/systemone'
Write-Host 'Model: onejev1.6-9b'
