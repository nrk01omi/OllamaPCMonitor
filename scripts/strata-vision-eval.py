#!/usr/bin/env python3
"""Repeatable text-only throughput probe against an already running Strata server.

Run the same targets against the text and vision configs. The request does not
include an image; image encoding is verified separately.
"""
import argparse
import ctypes
import json
import statistics
import time
import urllib.request
from pathlib import Path


class MemStatus(ctypes.Structure):
    _fields_ = [("length", ctypes.c_ulong), ("load", ctypes.c_ulong)] + [
        (name, ctypes.c_ulonglong) for name in
        ("total", "available", "page_total", "page_available", "virtual_total", "virtual_available", "extended")
    ]


def free_ram_gib():
    memory = MemStatus()
    memory.length = ctypes.sizeof(memory)
    if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(memory)):
        raise OSError("GlobalMemoryStatusEx failed")
    return round(memory.available / 2**30, 2)


def get(url, timeout=30):
    with urllib.request.urlopen(url, timeout=timeout) as response:
        return json.load(response)


def post(url, payload, timeout=600):
    request = urllib.request.Request(url, json.dumps(payload).encode(),
                                     headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.load(response)


def prompt_of(target, nonce):
    # Identical across variants; nonce defeats cross-request prompt cache reuse.
    words = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima".split()
    body = " ".join(words[(i * 7 + nonce) % 12] + str((i * 31 + nonce) % 97)
                    for i in range(int(target / 2.2)))
    return (f"Trial {nonce}. Read the following data and then give a numbered list of "
            "ten practical steps for checking a local inference server.\n" + body)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--targets", default="4096,16384")
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument("--max-output", type=int, default=180)
    parser.add_argument("--label", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    base = "http://127.0.0.1:8082"
    status = get(base + "/v1/status")
    rows = []
    for target in [int(item) for item in args.targets.split(",")]:
        for run in range(args.runs):
            nonce = target * 100 + run
            before = free_ram_gib()
            start = time.perf_counter()
            response = post(base + "/v1/chat/completions", {
                "model": status["model"],
                "messages": [{"role": "user", "content": prompt_of(target, nonce)}],
                "temperature": 0,
                "reasoning_effort": "none",
                "max_tokens": args.max_output,
                "stream": False,
            })
            elapsed = round(time.perf_counter() - start, 2)
            timing = get(base + "/v1/status").get("last_timings") or {}
            row = {
                "target": target, "run": run, "prompt_tokens": response["usage"]["prompt_tokens"],
                "completion_tokens": response["usage"]["completion_tokens"],
                "elapsed_s": elapsed, "prompt_tps": timing.get("prompt_per_second"),
                "decode_tps": timing.get("predicted_per_second"),
                "free_ram_before_gib": before, "free_ram_after_gib": free_ram_gib(),
            }
            rows.append(row)
            print(json.dumps(row), flush=True)
    result = {"label": args.label, "model": status["model"], "context": status["context"],
              "vision": status["vision"], "rows": rows,
              "median": {str(target): {
                  "prompt_tps": round(statistics.median(row["prompt_tps"] for row in rows if row["target"] == target), 1),
                  "decode_tps": round(statistics.median(row["decode_tps"] for row in rows if row["target"] == target), 1),
                  "elapsed_s": round(statistics.median(row["elapsed_s"] for row in rows if row["target"] == target), 2),
              } for target in set(row["target"] for row in rows)}}
    Path(args.output).write_text(json.dumps(result, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
