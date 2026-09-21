$ErrorActionPreference = 'Stop'

$health = $false
try { $health = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 http://127.0.0.1:30000/health).StatusCode -eq 200 } catch { }
if ($health) {
    Write-Host 'Qwen3.8 SGLang is already running at http://127.0.0.1:30000/v1'
    exit 0
}
$portCheck = '/mnt/c/Apps/OllamaPCMonitor/scripts/is-sglang-port-listening.sh'
& wsl.exe -d Ubuntu-22.04-RAG -- bash $portCheck 30000
if ($LASTEXITCODE -eq 0) { throw 'Qwen3.8 SGLang is still stopping. Wait for port 30000 to be released before starting it again.' }

$script = '/mnt/c/Apps/OllamaPCMonitor/scripts/start-qwen38-sglang.sh'
Start-Process -FilePath 'wsl.exe' `
    -ArgumentList @('-d', 'Ubuntu-22.04-RAG', '--', 'bash', $script) `
    -WindowStyle Hidden

Write-Host 'Qwen3.8 SGLang is starting. API: http://127.0.0.1:30000/v1'
Write-Host 'Model: qwen3.8-27b   API key: any non-empty string'
