param([int]$Port = 8082, [switch]$Open)

# Strata at a 128K (131072) context (measured: ~31 GB VRAM, ~54 GiB RAM, decode ~172-215 tok/s; docs/strata-bench-2026-10-04.md).
# Reconfigures Strata to 131072 when the installed setting differs, then starts it in the foreground.
& (Join-Path $PSScriptRoot 'Start-Strata.ps1') -ContextSize 131072 -Port $Port -Open:$Open
exit $LASTEXITCODE
