$ErrorActionPreference = 'Stop'
$root = 'C:\Apps\ProjectMaya'
$models = 'D:\Maya-data\models'
$modelDir = Join-Path $models 'Maya-XS-IQ1_S'
$markerPath = Join-Path $modelDir '.opm-verified.json'
$config = Join-Path $root 'maya-maya-xs-iq1_s.json'

$marker = $null
try { $marker = Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json } catch { throw "Maya-XS download is not verified: $markerPath" }
if ($marker.revision -ne '6728cf78a5b198a6a6f84b7fb88956a17ec56521' -or
    $marker.files.'GLM-5.3-Flash-Maya-XS-IQ1_S-00001-of-00002.gguf' -ne '711b427e55fa6da1cbe28933eb00174424f6201f0210b5e4a216d5e33b6222c7' -or
    $marker.files.'GLM-5.3-Flash-Maya-XS-IQ1_S-00002-of-00002.gguf' -ne 'a9841bc37abef5e3e5bc84e49e753b67f7e249098e8e9bc3dd17415104112885') {
    throw 'Maya-XS verification marker does not match the pinned official model files'
}
if (-not (Test-Path -LiteralPath (Join-Path $modelDir 'GLM-5.3-Flash-Maya-XS-IQ1_S-00001-of-00002.gguf')) -or
    -not (Test-Path -LiteralPath (Join-Path $modelDir 'GLM-5.3-Flash-Maya-XS-IQ1_S-00002-of-00002.gguf'))) {
    throw 'Both Maya-XS model shards must be present before setup'
}
if (Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue) {
    throw 'Port 8080 is occupied; stop the service using it before Project Maya setup'
}

$venv = Join-Path $root '.venv'
$python = Join-Path $venv 'Scripts\python.exe'
if (-not (Test-Path -LiteralPath $python)) {
    $created = $false
    $launcher = Get-Command py.exe -ErrorAction SilentlyContinue
    if ($launcher) {
        & $launcher.Source -3 -m venv $venv
        $created = $LASTEXITCODE -eq 0
    }
    if (-not $created) {
        $candidate = Get-Command python.exe -ErrorAction SilentlyContinue
        $systemPython = if ($candidate) { $candidate.Source } else { $null }
        if (-not $systemPython) {
            foreach ($version in '313', '312', '311', '310') {
                $path = Join-Path $env:LOCALAPPDATA "Programs\Python\Python$version\python.exe"
                if (Test-Path -LiteralPath $path) { $systemPython = $path; break }
            }
        }
        if (-not $systemPython) { throw '64-bit Python 3.10 or newer is required to prepare Project Maya' }
        & $systemPython -m venv $venv
        if ($LASTEXITCODE -ne 0) { throw "Could not create Project Maya's private Python environment (exit $LASTEXITCODE)" }
    }
}
if (-not (Test-Path -LiteralPath $python)) { throw "Project Maya Python environment was not created: $python" }
& $python -m pip --version | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Project Maya private Python environment has no working pip' }
$mayaPy = Join-Path $root 'maya.py'
$setupArgs = @('--setup', '--model', 'glm-maya-xs', '--models-dir', $models, '--context', '131072', '--no-vision', '--no-start', '--yes', '--plain')
$previousPythonIoEncoding = $env:PYTHONIOENCODING
$env:PYTHONIOENCODING = 'utf-8'
& $python $mayaPy @setupArgs
$env:PYTHONIOENCODING = $previousPythonIoEncoding
if ($LASTEXITCODE -ne 0) { throw "Project Maya setup failed with exit code $LASTEXITCODE" }
if (-not (Test-Path -LiteralPath $config)) { throw "Project Maya did not create its expected config: $config" }
Write-Output 'Project Maya Maya-XS is prepared for 128K text inference.'
