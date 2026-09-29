param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Apply', 'DisableSelfHeal')]
    [string]$Action
)

$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
    $scriptPath = $MyInvocation.MyCommand.Path
    $arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`" -Action $Action"
    $child = Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $arguments -Wait -PassThru
    if ($child.ExitCode -ne 0) { throw "Elevated $Action failed with exit code $($child.ExitCode)." }
    Write-Host "Elevated $Action completed."
    return
}

if ($Action -eq 'Apply') {
    & (Join-Path $PSScriptRoot 'apply-task.ps1')
} else {
    & (Join-Path $PSScriptRoot 'install-task.ps1') -DisableSelfHeal
}
