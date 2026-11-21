$ErrorActionPreference = 'Stop'
$root = 'C:\Apps\ProjectMaya'
$models = 'D:\Maya-data\models'
$modelDir = Join-Path $models 'Maya-XS-IQ1_S'
$markerPath = Join-Path $modelDir '.opm-verified.json'
$textConfig = Join-Path $root 'maya-maya-xs-iq1_s.json'
$visionConfig = Join-Path $root 'maya-maya-xs-iq1_s-vision.json'
$visionDir = Join-Path $modelDir 'vision'
$expected = @{
    'mmproj-GLM-5.3-Flash-F16.gguf' = '3627575df16bd152db0f3fd7e488d270b33f3a9e6c7fa3b1b8ac381faafde882'
    'GLM-5.3-Flash-vocab.gguf' = '8f53cb1bd2e631c14ef413e3284735d9e53f3c508d07a6f609e705b487105912'
}
if (Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue) { throw 'Stop Project Maya before Vision setup' }
if (-not (Test-Path -LiteralPath $textConfig)) { throw 'Prepare Maya text mode first' }
$marker = Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json
if ($marker.revision -ne '6728cf78a5b198a6a6f84b7fb88956a17ec56521') { throw 'Maya-XS verification marker does not match the pinned model revision' }
New-Item -ItemType Directory -Force -Path $visionDir | Out-Null
$baseUrl = 'https://huggingface.co/peasantsmith/GLM-5.3-Flash-Maya-GGUF/resolve/f16ee4ba50d8fd2bb726ea1862ca6ca14ba188da/vision'
foreach ($name in $expected.Keys) {
    $file = Join-Path $visionDir $name
    if (-not (Test-Path -LiteralPath $file) -or (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected[$name]) {
        & curl.exe -L --fail --retry 5 --retry-all-errors --retry-delay 3 -C - -o $file "$baseUrl/$name"
        if ($LASTEXITCODE -ne 0) { throw "Download failed for $name" }
    }
    $actual = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $expected[$name]) { throw "SHA-256 mismatch for $name (expected $($expected[$name]), got $actual)" }
    Write-Output "Verified $name"
}
$visionManifest = @{ files = @{} }
foreach ($name in $expected.Keys) { $visionManifest.files[$name] = $expected[$name] }
$visionManifest | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath (Join-Path $visionDir '.opm-verified.json') -Encoding ascii
$configBackup = "$textConfig.opm-vision-backup"
if (Test-Path -LiteralPath $configBackup) { throw 'A prior Maya Vision build did not finish; restore/check the saved text config before retrying.' }
$originalConfigHash = (Get-FileHash -LiteralPath $textConfig -Algorithm SHA256).Hash
Copy-Item -LiteralPath $textConfig -Destination $configBackup
$venvPython = Join-Path $root '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $venvPython)) { throw 'Project Maya Python environment is missing; prepare text mode first' }
$env:PYTHONIOENCODING = 'utf-8'
Push-Location $root
try {
    & $venvPython 'maya.py' '--config' $textConfig '--setup' '--model' 'glm-maya-xs' '--models-dir' $models '--context' '131072' '--no-start' '--yes' '--plain'
    if ($LASTEXITCODE -ne 0) { throw "Maya Vision engine/config setup exited with code $LASTEXITCODE" }
} catch {
    Copy-Item -LiteralPath $configBackup -Destination $textConfig -Force
    Remove-Item -LiteralPath $configBackup -Force
    throw
} finally { Pop-Location }
$generatedConfig = $textConfig
if (-not (Test-Path -LiteralPath $generatedConfig)) { throw "Maya setup did not create expected config: $generatedConfig" }
$cfg = Get-Content -LiteralPath $generatedConfig -Raw | ConvertFrom-Json
if (-not $cfg.vision -or -not (Test-Path -LiteralPath $cfg.vision.exe)) {
    Copy-Item -LiteralPath $configBackup -Destination $textConfig -Force; Remove-Item -LiteralPath $configBackup -Force
    throw 'Maya Vision encoder is not present in the generated config'
}
if ((Get-FileHash -LiteralPath $configBackup -Algorithm SHA256).Hash -ne $originalConfigHash) { throw 'Saved text config backup changed unexpectedly' }
Copy-Item -LiteralPath $generatedConfig -Destination $visionConfig -Force
Copy-Item -LiteralPath $configBackup -Destination $textConfig -Force
Remove-Item -LiteralPath $configBackup -Force
Write-Output 'Project Maya Maya-XS Vision is prepared for 128K image and text inference.'
