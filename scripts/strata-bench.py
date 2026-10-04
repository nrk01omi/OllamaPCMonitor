#!/usr/bin/env python3
"""Strata: context size vs memory and speed (Windows).

For each context size: reconfigure with `setup --setup --context N` (setup picks KV streaming etc.),
start the server, sample VRAM / RAM / page file once per second, run fresh prompts of several
lengths, record the server's own timings (/v1/status last_timings), then stop the server.

  python scripts\\strata-bench.py --contexts 8192,32768,65536,131072 --runs 3
Results: docs/strata-bench-<date>.json and .md
"""
import argparse, ctypes, json, subprocess, sys, threading, time, urllib.request, datetime, statistics
from pathlib import Path

STRATA = Path(r"C:\Apps\Strata")
PY = STRATA / ".venv" / "Scripts" / "python.exe"
DATA = r"D:\Strata-data"
MODEL, FAMILY = "IQ2_XS", "qwen"
OUT = Path(__file__).resolve().parent.parent / "docs"


class MEMSTATUS(ctypes.Structure):
    _fields_ = [("l", ctypes.c_ulong), ("load", ctypes.c_ulong)] + [(n, ctypes.c_ulonglong) for n in
                ("tot", "avail", "ptot", "pavail", "vtot", "vavail", "ext")]


def sys_mem():
    m = MEMSTATUS(); m.l = ctypes.sizeof(m); ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(m))
    g = 2 ** 30
    return {"ram_used_gib": (m.tot - m.avail) / g, "commit_used_gib": (m.ptot - m.pavail) / g}


def gpu_mem():
    o = subprocess.check_output(["nvidia-smi", "--query-gpu=memory.used,power.draw,temperature.gpu,utilization.gpu",
                                 "--format=csv,noheader,nounits"], text=True).strip().split(",")
    return {"vram_mib": float(o[0]), "power_w": float(o[1]), "temp_c": float(o[2]), "util": float(o[3])}


class Sampler(threading.Thread):
    def __init__(self):
        super().__init__(daemon=True); self.rows = []; self.stop = False

    def run(self):
        while not self.stop:
            try: self.rows.append({"t": time.time(), **sys_mem(), **gpu_mem()})
            except Exception: pass
            time.sleep(1)

    def peak(self, since=0):
        r = [x for x in self.rows if x["t"] >= since]
        return {k: round(max(x[k] for x in r), 2) for k in ("ram_used_gib", "commit_used_gib", "vram_mib")} if r else {}


def http(url, body=None, timeout=3600):
    req = urllib.request.Request(url, data=json.dumps(body).encode() if body else None,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def wait_ready(base, proc, limit=1800):
    t0 = time.time()
    while time.time() - t0 < limit:
        if proc.poll() is not None: raise RuntimeError("server exited: %s" % proc.returncode)
        try:
            if http(base + "/health", timeout=5).get("loaded"): return time.time() - t0
        except Exception: pass
        time.sleep(3)
    raise TimeoutError("not ready")


def prompt_of(tokens, nonce):
    # ~1.3 tokens per short English word; actual count comes back in usage.prompt_tokens
    words = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima".split()
    body = " ".join(words[(i * 7 + nonce) % 12] + str((i * 31 + nonce) % 97) for i in range(int(tokens / 2.2)))
    return f"[{nonce}] Summarize the start of this text in one sentence.\n" + body


def measure(base, target, nonce, max_tokens=200):
    r = http(base + "/v1/chat/completions", {
        "model": "strata", "messages": [{"role": "user", "content": prompt_of(target, nonce)}],
        "temperature": 0, "reasoning_effort": "none", "max_tokens": max_tokens})
    t = (http(base + "/v1/status").get("last_timings") or {})
    return {"target": target, "prompt_tokens": r["usage"]["prompt_tokens"], "gen": r["usage"]["completion_tokens"],
            "prompt_tps": t.get("prompt_per_second"), "decode_tps": t.get("predicted_per_second"),
            "prompt_ms": t.get("prompt_ms"), "decode_ms": t.get("predicted_ms"), "raw": t}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--contexts", default="8192,32768,65536,131072")
    ap.add_argument("--lengths", default="1024,4096,16384,32768,65536,120000")
    ap.add_argument("--runs", type=int, default=3)
    ap.add_argument("--port", type=int, default=8082)
    a = ap.parse_args()
    base = f"http://127.0.0.1:{a.port}"
    results = []
    for ctx in [int(x) for x in a.contexts.split(",")]:
        print(f"=== context {ctx}", flush=True)
        subprocess.run(["cmd", "/c", str(STRATA / "START-HERE.bat"), "--setup", "--yes", "--family", FAMILY, "--model", MODEL,
                        "--context", str(ctx), "--vision", "no", "--port", str(a.port), "--data-dir", DATA,
                        "--no-start"], cwd=STRATA, check=True)
        cfg = STRATA / f"strata-{MODEL.lower()}.json"
        cfg_args = json.loads(cfg.read_text())["args"]
        s = Sampler(); s.start(); t_start = time.time()
        idle0 = sys_mem()
        proc = subprocess.Popen([str(PY), "serve/server.py", "--engine", "strata", "--config", str(cfg),
                                 "--host", "127.0.0.1", "--port", str(a.port)], cwd=STRATA,
                                stdout=open(STRATA / "bench-server.out", "w"), stderr=subprocess.STDOUT)
        row = {"context": ctx, "config_args": cfg_args, "baseline_before": idle0, "runs": []}
        try:
            row["load_s"] = round(wait_ready(base, proc), 1)
            time.sleep(5)
            row["after_load"] = s.rows[-1] if s.rows else {}
            row["peak_load"] = s.peak(t_start)
            t_inf = time.time()
            measure(base, 256, 0, 32)                                  # warm-up
            for L in [int(x) for x in a.lengths.split(",")]:
                if L * 1.47 > ctx * 0.92: continue   # ~1.47 real tokens per target unit
                for n in range(a.runs):
                    m = measure(base, L, 1000 * L + n + 1)
                    print(f"  {L:>7} -> {m['prompt_tokens']:>7} tok  prompt {m['prompt_tps']}  decode {m['decode_tps']}", flush=True)
                    row["runs"].append(m)
        except Exception as e:
            row["error"] = repr(e); print("  ERROR", e, flush=True)
        finally:
            row["peak_inference"] = s.peak(t_inf)
            proc.terminate()
            try: proc.wait(30)
            except Exception: subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)])
            s.stop = True
            time.sleep(8)                                              # let the GPU free before the next one
        results.append(row)

    stamp = datetime.date.today().isoformat()
    (OUT / f"strata-bench-{stamp}.json").write_text(json.dumps(results, indent=1))
    md = [f"# Strata {MODEL} context sweep ({stamp})", "",
          "| context | load s | VRAM peak MiB | RAM used peak GiB | prompt tokens | prompt tok/s | decode tok/s |",
          "|---:|---:|---:|---:|---:|---:|---:|"]
    for r in results:
        pk = r.get("peak_inference", {})
        by = {}
        for m in r["runs"]: by.setdefault(m["target"], []).append(m)
        for L, ms in by.items():
            med = lambda k: round(statistics.median([x[k] for x in ms if x[k]]), 1)
            md.append(f"| {r['context']} | {r.get('load_s')} | {pk.get('vram_mib')} | {pk.get('ram_used_gib')} | "
                      f"{int(statistics.median([x['prompt_tokens'] for x in ms]))} | {med('prompt_tps')} | {med('decode_tps')} |")
        if r.get("error"): md.append(f"| {r['context']} | ERROR {r['error']} | | | | | |")
    (OUT / f"strata-bench-{stamp}.md").write_text("\n".join(md) + "\n")
    print("\n".join(md))


if __name__ == "__main__":
    main()
