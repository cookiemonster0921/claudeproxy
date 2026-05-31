#!/usr/bin/env python3
"""
Live log formatter for claude-proxy.
Reads from stdin (piped from `tail -F`), formats JSON proxy events into
colored one-line summaries. Non-JSON wrangler lines are shown dimmed.
"""
import sys
import json

# ANSI codes
R  = "\033[0m"
DIM    = "\033[2m"
BOLD   = "\033[1m"
GREEN  = "\033[32m"
RED    = "\033[31m"
YELLOW = "\033[33m"
CYAN   = "\033[36m"
MAGENTA = "\033[35m"
BLUE   = "\033[34m"
GRAY   = "\033[90m"

PROVIDER_LABELS = {
    "workers_ai":           "Workers AI  ",
    "nvidia_nim":           "NVIDIA NIM  ",
    "openrouter":           "OpenRouter  ",
    "deepseek":             "DeepSeek    ",
    "cloudflare_workers_ai":"CF Workers  ",
    "lm_studio":            "LM Studio   ",
    "ollama":               "Ollama      ",
}

def c_status(s: int) -> str:
    if s < 300: return f"{GREEN}{s}{R}"
    if s < 400: return f"{YELLOW}{s}{R}"
    return f"{RED}{BOLD}{s}{R}"

def c_dur(ms: int) -> str:
    if ms < 800:  return f"{GREEN}{ms}ms{R}"
    if ms < 4000: return f"{YELLOW}{ms}ms{R}"
    return f"{RED}{ms}ms{R}"

def fmt_provider(pid: str, pmodel: str) -> str:
    label = PROVIDER_LABELS.get(pid, f"{pid:<12}")
    return f"{CYAN}{label}{R}{DIM}→{R} {MAGENTA}{pmodel}{R}"

# Per-request accumulation keyed by requestId
pending: dict = {}

def emit(line: str) -> None:
    print(line, flush=True)

for raw in sys.stdin:
    raw = raw.rstrip()
    if not raw:
        continue

    # ── Try JSON ──────────────────────────────────────────────────────────────
    try:
        d = json.loads(raw)
    except json.JSONDecodeError:
        # Non-JSON: wrangler status / banner lines
        if any(x in raw for x in ["[wrangler:inf", "[wrangler:dbg"]):
            # Suppress duplicate request lines — we show our own formatted version
            if not any(m in raw for m in ["] GET ", "] POST ", "] OPTIONS "]):
                emit(f"{GRAY}{raw}{R}")
        elif "error" in raw.lower():
            emit(f"{RED}{raw}{R}")
        elif any(c in raw for c in ["⛅", "▲", "▌", "───", "▛", "▜"]):
            pass  # swallow wrangler banner decorations
        elif raw.strip():
            emit(f"{GRAY}{raw}{R}")
        continue

    # ── JSON proxy events ─────────────────────────────────────────────────────
    event = d.get("event", "")
    rid   = d.get("requestId", "")

    if event == "request":
        pending[rid] = {
            "method": d.get("method", "?"),
            "path":   d.get("path", "?"),
            "ts":     d.get("ts", ""),
        }

    elif event == "messages":
        if rid in pending:
            pending[rid].update({
                "model":        d.get("model", ""),
                "providerId":   d.get("providerId", ""),
                "providerModel":d.get("providerModel", ""),
                "stream":       d.get("stream", False),
                "inputTokens":  d.get("inputTokens", 0),
                "toolCount":    d.get("toolCount", 0),
            })

    elif event == "count_tokens":
        tok = d.get("inputTokens", "?")
        emit(f"  {GRAY}── count_tokens  {tok} tokens{R}")

    elif event == "response":
        p      = pending.pop(rid, {})
        status = d.get("status", 0)
        dur    = d.get("duration", 0)
        method = p.get("method", "?")
        path   = p.get("path", "?")
        pid_   = p.get("providerId", "")
        pmodel = p.get("providerModel", "")
        itok   = p.get("inputTokens", "")
        tools  = p.get("toolCount", 0)
        stream = p.get("stream", False)

        stream_mark = f"{BLUE}~{R}" if stream else " "
        method_col  = f"{BOLD}{method:<6}{R}"
        path_col    = f"{BOLD}{path}{R}"

        parts = [c_status(status), stream_mark, method_col, path_col]

        if pid_:
            parts.append("  " + fmt_provider(pid_, pmodel))
        if itok:
            parts.append(f"  {DIM}{itok}tok{R}")
        if tools:
            parts.append(f"  {YELLOW}{tools}tools{R}")
        parts.append("  " + c_dur(dur))

        emit("  " + "".join(parts))

    else:
        # Any other JSON (errors, etc.) — show dimmed raw
        emit(f"{GRAY}{raw}{R}")
