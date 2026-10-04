param([int]$Port = 8082, [switch]$Open)

# Strata at a 32K context (measured: ~31 GB VRAM, ~54 GiB RAM, decode ~197-242 tok/s; docs/strata-bench-2026-10-04.md).
# Reconfigures Strata to 32768 when the installed setting differs, then starts it in the foreground.
& (Join-Path $PSScriptRoot 'Start-Strata.ps1') -ContextSize 32768 -Port $Port -Open:$Open
exit $LASTEXITCODE
