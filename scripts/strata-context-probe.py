#!/usr/bin/env python3
"""One near-limit context request with a middle-of-prompt recall check."""
import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from importlib.machinery import SourceFileLoader

eval_module = SourceFileLoader("strata_vision_eval", str(Path(__file__).with_name("strata-vision-eval.py"))).load_module()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--target", type=int, required=True)
    parser.add_argument("--label", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    base = "http://127.0.0.1:8082"
    status = eval_module.get(base + "/v1/status")
    filler = eval_module.prompt_of(args.target, 78341)
    middle = len(filler) // 2
    marker = "ORCHID-4827"
    prompt = (filler[:middle] + f"\nThe secret marker is {marker}.\n" + filler[middle:]
              + "\nReturn the secret marker exactly and nothing else.")
    before = eval_module.free_ram_gib()
    start = time.perf_counter()
    response = eval_module.post(base + "/v1/chat/completions", {
        "model": status["model"], "messages": [{"role": "user", "content": prompt}],
        "temperature": 0, "reasoning_effort": "none", "max_tokens": 32, "stream": False,
    }, timeout=900)
    elapsed = round(time.perf_counter() - start, 2)
    timing = eval_module.get(base + "/v1/status").get("last_timings") or {}
    answer = response["choices"][0]["message"]["content"].strip()
    row = {
        "label": args.label, "context": status["context"], "vision": status["vision"],
        "prompt_tokens": response["usage"]["prompt_tokens"],
        "completion_tokens": response["usage"]["completion_tokens"],
        "elapsed_s": elapsed, "prompt_tps": timing.get("prompt_per_second"),
        "decode_tps": timing.get("predicted_per_second"), "answer": answer,
        "needle_correct": answer == marker, "free_ram_before_gib": before,
        "free_ram_after_gib": eval_module.free_ram_gib(),
    }
    Path(args.output).write_text(json.dumps(row, indent=2), encoding="utf-8")
    print(json.dumps(row), flush=True)


if __name__ == "__main__":
    main()
