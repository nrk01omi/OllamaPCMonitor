param(
    [int]$ContextSize = 8192,
    [int]$Port = 30002
)

$ErrorActionPreference = 'Stop'
$server = 'C:\Apps\llama.cpp\b11387\llama-server.exe'
$modelDir = 'D:\Models\Qwen3.8-Flash-Next-GGUF\UD-Q2_K_XL'
$model = Join-Path $modelDir 'Qwen3.8-Flash-Next-UD-Q2_K_XL-00001-of-00003.gguf'

if (-not (Test-Path -LiteralPath $server)) {
    throw "llama-server.exe not found: $server"
}

$expectedSizes = @(10946624, 49979779296, 28878402944)
foreach ($part in 1..3) {
    $path = Join-Path $modelDir ('Qwen3.8-Flash-Next-UD-Q2_K_XL-{0:D5}-of-00003.gguf' -f $part)
    if (-not (Test-Path -LiteralPath $path)) {
        throw "Model shard not found: $path"
    }
    $actualSize = (Get-Item -LiteralPath $path).Length
    if ($actualSize -ne $expectedSizes[$part - 1]) {
        throw "Model shard has an unexpected size: $path ($actualSize bytes)"
    }
}

if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
    throw "Port $Port is already listening"
}

# Keep this in the foreground so Ctrl+C stops only this model.
# llama.cpp's fit mode chooses a GPU layer count that leaves VRAM headroom.
& $server `
    --model $model `
    --host 127.0.0.1 `
    --port $Port `
    --ctx-size $ContextSize `
    --parallel 1 `
    --gpu-layers auto `
    --fit on `
    --lazy-mode on `
    --flash-attn on `
    --cache-type-k q8_0 `
    --cache-type-v q8_0

exit $LASTEXITCODE
