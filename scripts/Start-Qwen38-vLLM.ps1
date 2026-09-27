$ErrorActionPreference = 'Stop'

# Legacy vLLM/Docker launcher. The active service uses Start-Qwen38-SGLang.ps1.
# RTX 5090 has 32 GB of VRAM. Keep only one large model resident at a time.
docker stop vllm-qwen3-coder 2>$null
docker start vllm-qwen38 | Out-Null

Write-Host 'Qwen3.8-27B is starting at http://127.0.0.1:8001/v1'
Write-Host 'Model name: qwen3.8    API key: local'
