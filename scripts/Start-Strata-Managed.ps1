param([switch]$Vision, [ValidateSet('IQ2_XS', 'IQ3_XXS')][string]$Quant = 'IQ2_XS')

$ErrorActionPreference = 'Stop'
$root = 'C:\Apps\Strata'
$tag = $Quant.ToLowerInvariant()
$config = Join-Path $root $(if ($Vision) { "strata-$tag-vision-128k.json" } else { "strata-$tag.json" })
$pidFile = Join-Path (Split-Path $PSScriptRoot -Parent) 'data\strata-managed.pid'

if (-not (Test-Path -LiteralPath $config)) { throw "Strata config missing: $config" }
if (Test-Path -LiteralPath $pidFile) {
    $saved = Get-Content -LiteralPath $pidFile -Raw | ConvertFrom-Json
    $oldPid = [int]$saved.pid
    if (Get-Process -Id $oldPid -ErrorAction SilentlyContinue) { throw "Managed Strata process $oldPid is already running" }
    Remove-Item -LiteralPath $pidFile
}
if (Get-NetTCPConnection -LocalPort 18082 -State Listen -ErrorAction SilentlyContinue) { throw 'Port 18082 is already in use' }

$launcher = Join-Path $PSScriptRoot 'Start-Strata.ps1'
$startArgs = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $launcher,
    '-ContextSize', '131072', '-Port', '18082', '-ConfigPath', $config)
$quotedArgs = $startArgs | ForEach-Object { '"' + $_.Replace('"', '\\"') + '"' }
$process = Start-Process -FilePath 'powershell.exe' -ArgumentList ($quotedArgs -join ' ') -WorkingDirectory $root -WindowStyle Hidden -PassThru
@{ pid = $process.Id; startedAt = $process.StartTime.ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress | Set-Content -LiteralPath $pidFile -NoNewline
Start-Sleep -Seconds 2
if ($process.HasExited) {
    Remove-Item -LiteralPath $pidFile -ErrorAction SilentlyContinue
    throw "Strata launcher exited immediately (code $($process.ExitCode))"
}
Write-Host "Strata 128K $Quant $(if ($Vision) { 'Vision' } else { 'Text' }) launch started (PID $($process.Id), API http://127.0.0.1:18082/v1)"
