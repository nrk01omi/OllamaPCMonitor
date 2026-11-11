$ErrorActionPreference = 'Stop'
$root = 'C:\Apps\OllamaPCMonitor'
$pidFile = Join-Path $root 'data\strata-iq3xxs-setup.pid'
while ($true) {
    $setupProcessId = 0
    try { $setupProcessId = [int](Get-Content -LiteralPath $pidFile -Raw) } catch { break }
    if (-not (Get-Process -Id $setupProcessId -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Seconds 15
}
Set-Content -LiteralPath $pidFile -Value $PID -NoNewline
try {
    while (Get-NetTCPConnection -LocalPort 18082 -State Listen -ErrorAction SilentlyContinue) {
        Start-Sleep -Seconds 30
    }
    & (Join-Path $root 'scripts\Prepare-Strata-IQ3XXS.ps1')
    if (-not $?) { throw 'IQ3_XXS follow-up setup failed' }
    "$(Get-Date -Format o) IQ3_XXS text and vision configurations are ready." | Add-Content -LiteralPath (Join-Path $root 'data\strata-iq3xxs-followup.log')
} catch {
    "$(Get-Date -Format o) $($_.Exception.Message)" | Add-Content -LiteralPath (Join-Path $root 'data\strata-iq3xxs-followup.log')
    exit 1
} finally {
    Remove-Item -LiteralPath $pidFile -ErrorAction SilentlyContinue
}
