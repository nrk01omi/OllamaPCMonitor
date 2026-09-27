$ErrorActionPreference = 'Stop'

# Legacy vLLM/Docker launcher. The active service uses Start-Qwen3Coder-SGLang.ps1.
# RTX 5090 has 32 GB of VRAM. Keep only one large model resident at a time.
docker stop vllm-qwen38 2>$null
docker start vllm-qwen3-coder | Out-Null

Write-Host 'Qwen3-Coder is starting at http://127.0.0.1:8000/v1'
Write-Host 'Model name: qwen3-coder    API key: local'
