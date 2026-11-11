$ErrorActionPreference = 'Stop'
$root = 'C:\Apps\Strata'
$python = Join-Path $root '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $python)) { throw "Strata Python environment missing: $python" }
Push-Location $root
try {
    $config = Join-Path $root 'strata-iq3_xxs.json'
    $textConfig = Join-Path $root 'strata-iq3_xxs-text-setup.tmp'
    $visionConfig = Join-Path $root 'strata-iq3_xxs-vision-128k.json'
    $modelDir = 'D:\Strata-data\models\IQ3_XXS'
    $textReady = (Test-Path -LiteralPath (Join-Path $modelDir 'Qwen3.8-Flash-Next-GSQ-RCO-IQ3_XXS-00001-of-00002.gguf')) -and
        (Test-Path -LiteralPath (Join-Path $modelDir 'Qwen3.8-Flash-Next-GSQ-RCO-IQ3_XXS-00002-of-00002.gguf')) -and
        (Test-Path -LiteralPath 'D:\Strata-data\packs\iq3_xxs\tokenizer') -and (Test-Path -LiteralPath $config)
    if (-not $textReady) {
        & $python setup.py --setup --yes --family qwen --model IQ3_XXS --context 131072 --vision no --port 8082 --data-dir 'D:\Strata-data' --no-start
        if ($LASTEXITCODE -ne 0) { throw "Strata IQ3_XXS text setup failed (exit $LASTEXITCODE)" }
    }
    Copy-Item -LiteralPath $config -Destination $textConfig -Force
    try {
        & $python setup.py --setup --yes --family qwen --model IQ3_XXS --context 131072 --vision yes --port 8082 --data-dir 'D:\Strata-data' --no-start
        if ($LASTEXITCODE -ne 0) { throw "Strata IQ3_XXS vision setup failed (exit $LASTEXITCODE)" }
        Copy-Item -LiteralPath $config -Destination $visionConfig -Force
    } finally {
        if (Test-Path -LiteralPath $textConfig) {
            Copy-Item -LiteralPath $textConfig -Destination $config -Force
            Remove-Item -LiteralPath $textConfig -Force
        }
    }
} finally { Pop-Location }
