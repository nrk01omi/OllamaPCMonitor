# Qwen3.8-Flash-Next local setup (RTX 5090)

This is a standalone Windows llama.cpp setup. It does not use the WSL2 SGLang service manager.

- Runtime: `C:\Apps\llama.cpp\b11387\llama-server.exe` (Windows CUDA 13.4 release)
- Model: `D:\Models\Qwen3.8-Flash-Next-GGUF\UD-Q2_K_XL\` (three GGUF shards)
- Launcher: `scripts\Start-Qwen38-Flash-Next.ps1`
- API: `http://127.0.0.1:30002/v1` (local machine only)

Before launch, stop any active SGLang model in the OllamaPCMonitor dashboard so the RTX 5090 has enough VRAM. Run the launcher in PowerShell from this repository:

```powershell
.\scripts\Start-Qwen38-Flash-Next.ps1
```

The initial context size is 8192. Pass `-ContextSize 16384` to try a longer context after the baseline works. The server runs in the foreground; press Ctrl+C to stop it. Check `http://127.0.0.1:30002/health` for readiness. The OpenAI-compatible base URL is `http://127.0.0.1:30002/v1`.

The first launch may take time while the model is mapped and the CUDA backend initializes. The PLE/N-gram table is read lazily from the NVMe SSD. The model is larger than VRAM, so some layers remain in system RAM and generation speed depends on RAM/PCIe bandwidth.

Validated on 2026-10-04 with llama.cpp build b11387: all three GGUF shards matched the SHA-256 values published by Hugging Face, `/health` returned 200, and an OpenAI-compatible chat request returned `Hello!`. That short run generated at about 14 tokens/s. Contexts of 8K, 16K, 24K and 32K loaded, but longer prompts left little free system RAM (about 1 GiB at 16K with an 8,207-token prompt). Strata was selected for practical use. The llama.cpp test server was stopped afterward to release the GPU.

Sources: [Qwen model repository](https://github.com/QwenLM/Qwen3.8-Flash-Next), [Unsloth GGUF](https://huggingface.co/unsloth/Qwen3.8-Flash-Next-GGUF), [Unsloth running guide](https://unsloth.ai/docs/models/qwen3.8-next).
