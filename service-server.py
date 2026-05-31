#!/usr/bin/env python3
"""
service-server.py — Minimal HTTP server that wraps `claude --print`.

Cloud Run Services must listen on $PORT and respond to HTTP. This server:
  GET  /health         → {"ok": true}   (used by Cloud Run for readiness probes)
  POST /run            → runs `claude --print <prompt>`, returns output as JSON
  POST /run  stream=1  → same, but streams SSE lines as claude writes them

Request format:
  curl -X POST https://SERVICE_URL/run \\
    -H 'Content-Type: application/json' \\
    -d '{"prompt": "list the files in /workspace"}'

Streaming request:
  curl -X POST https://SERVICE_URL/run \\
    -H 'Content-Type: application/json' \\
    -d '{"prompt": "explain this repo", "stream": true}'

The WORKER_URL, PROXY_TOKEN, and CLAUDE_CODE_* env vars are set by the
container entrypoint (docker-entrypoint.sh) before this server starts —
they are inherited by every `claude` subprocess automatically.
"""

import http.server
import json
import os
import subprocess
import sys
import threading

PORT = int(os.environ.get("PORT", 8080))


class Handler(http.server.BaseHTTPRequestHandler):

    # ── silence the default per-request access log line ──────────────────────
    def log_message(self, fmt, *args):
        print(f"[service] {self.command} {self.path} → {args[1] if len(args) > 1 else ''}", flush=True)

    # ── health probe — Cloud Run calls this before sending real traffic ───────
    def do_GET(self):
        if self.path == "/health":
            self._json(200, {"ok": True, "service": "claude-proxy-service"})
        else:
            self._json(404, {"error": "not found"})

    # ── main endpoint ─────────────────────────────────────────────────────────
    def do_POST(self):
        if self.path != "/run":
            self._json(404, {"error": "POST /run or GET /health"})
            return

        # Read and parse the request body
        length = int(self.headers.get("Content-Length", 0))
        try:
            body = json.loads(self.rfile.read(length))
        except json.JSONDecodeError as exc:
            self._json(400, {"error": f"invalid JSON: {exc}"})
            return

        prompt = body.get("prompt", "").strip()
        if not prompt:
            self._json(400, {"error": "missing or empty 'prompt' field"})
            return

        stream = bool(body.get("stream", False))

        # Build the command — `claude --print` runs one turn non-interactively
        # and exits. The env vars set by docker-entrypoint.sh are inherited.
        cmd = ["claude", "--print", prompt]

        if stream:
            self._run_streaming(cmd)
        else:
            self._run_blocking(cmd)

    # ── blocking mode: wait for claude to finish, return full output ──────────
    def _run_blocking(self, cmd):
        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=600,   # 10 min hard limit per request
            )
        except subprocess.TimeoutExpired:
            self._json(504, {"error": "claude timed out after 600 s"})
            return
        except FileNotFoundError:
            self._json(500, {"error": "'claude' binary not found on PATH"})
            return

        if result.returncode == 0:
            self._json(200, {"output": result.stdout})
        else:
            self._json(500, {
                "error": "claude exited with non-zero status",
                "stderr": result.stderr,
                "returncode": result.returncode,
            })

    # ── streaming mode: push lines as SSE (text/event-stream) ─────────────────
    # Each line of claude's output is sent as an SSE `data:` event so the
    # caller can display progress in real time with `curl -N` or EventSource.
    def _run_streaming(self, cmd):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Accel-Buffering", "no")  # disable nginx proxy buffering
        self.end_headers()

        try:
            proc = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
        except FileNotFoundError:
            self._sse_event("error", "claude binary not found on PATH")
            return

        # Stream stdout line by line
        for line in proc.stdout:
            self._sse_event("data", line.rstrip("\n"))

        proc.wait()

        # Send a final event so the client knows the run is complete
        if proc.returncode == 0:
            self._sse_event("done", json.dumps({"ok": True}))
        else:
            stderr = proc.stderr.read()
            self._sse_event("error", json.dumps({
                "returncode": proc.returncode,
                "stderr": stderr,
            }))

    # ── helpers ───────────────────────────────────────────────────────────────
    def _json(self, status, body):
        payload = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _sse_event(self, event, data):
        try:
            self.wfile.write(f"event: {event}\ndata: {data}\n\n".encode())
            self.wfile.flush()
        except BrokenPipeError:
            pass   # client disconnected mid-stream


# ── Threaded server so concurrent /health probes don't block running jobs ─────
class ThreadedHTTPServer(http.server.HTTPServer):
    def process_request(self, request, client_address):
        t = threading.Thread(target=self._new_request, args=(request, client_address))
        t.daemon = True
        t.start()

    def _new_request(self, request, client_address):
        self.finish_request(request, client_address)
        self.shutdown_request(request)


if __name__ == "__main__":
    # Validate required env var before we start accepting traffic
    worker_url = os.environ.get("WORKER_URL", "").rstrip("/")
    if not worker_url:
        print("ERROR: WORKER_URL is not set", file=sys.stderr)
        sys.exit(1)

    proxy_token = os.environ.get("PROXY_TOKEN", "dev-token")

    # Mirror the `cproxy on prod` environment so every claude subprocess
    # routes through the Worker instead of calling api.anthropic.com directly.
    os.environ["ANTHROPIC_BASE_URL"] = worker_url
    os.environ["ANTHROPIC_AUTH_TOKEN"] = proxy_token
    os.environ["CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY"] = "1"
    os.environ["CLAUDE_CODE_SKIP_TELEMETRY"] = "1"
    os.environ["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"] = "1"
    # Unset bypass vars — prevents claude from routing around the proxy
    for var in (
        "CLAUDE_CODE_USE_VERTEX", "ANTHROPIC_VERTEX_PROJECT_ID", "ANTHROPIC_VERTEX_BASE_URL",
        "CLOUD_ML_REGION", "CLAUDE_CODE_USE_BEDROCK", "ANTHROPIC_BEDROCK_BASE_URL",
        "CLAUDE_CODE_USE_ANTHROPIC_AWS", "ANTHROPIC_AWS_BASE_URL",
    ):
        os.environ.pop(var, None)

    print(f"[service] listening on port {PORT}", flush=True)
    print(f"[service] proxy: {worker_url}", flush=True)

    server = ThreadedHTTPServer(("0.0.0.0", PORT), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("[service] shutting down", flush=True)
