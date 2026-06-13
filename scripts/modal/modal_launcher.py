"""
modal_launcher.py — Persistent Discord session launcher daemon running on Modal.

── Architecture ──────────────────────────────────────────────────────────────

  Discord /modal command
      │
      ▼
  Cloudflare LauncherDO  ──── WebSocket push ────►  THIS CONTAINER (always-on)
                                                           │  background thread
                                                           │  runs discord_session_launcher.py
                                                           ▼
                                                    tmux pane → claude-proxy.sh on prod

  The container runs as a Modal web_server endpoint (port 8080 serves /health).
  `min_containers=1` ensures at least one container is always warm and connected.
  The WebSocket daemon runs in a background thread inside the same container.
  Sessions are launched as detached tmux panes (LAUNCHER_BACKGROUND=1).

── Why web_server ─────────────────────────────────────────────────────────────

  Modal is serverless — containers normally scale to zero when idle.
  `@modal.web_server(8080)` turns this into a persistent web endpoint.
  Combined with `min_containers=1`, one container always stays alive.
  The HTTP server on port 8080 is just a health endpoint; the real work
  happens in the WS daemon background thread.

── Secrets ───────────────────────────────────────────────────────────────────

  Create a Modal secret named "claude-launcher-secrets" before deploying:

    modal secret create claude-launcher-secrets \\
        LAUNCHER_WS_URL=wss://claude-proxy.YOUR.workers.dev/launcher-ws \\
        PROXY_TOKEN=your-proxy-token \\
        LAUNCHER_TARGET=modal \\
        LAUNCHER_BACKGROUND=1

  For Claude Code auth, also store credentials via:
    modal secret create claude-auth \\
        ANTHROPIC_API_KEY=sk-ant-...   # optional if using Worker-proxied models

── Deploy ────────────────────────────────────────────────────────────────────

    modal deploy scripts/modal/modal_launcher.py

── Manage ────────────────────────────────────────────────────────────────────

  View logs:         modal app logs claude-discord-launcher
  Stop the app:      modal app stop claude-discord-launcher
  Restart:           modal deploy scripts/modal/modal_launcher.py  (redeploy)
  Check containers:  modal container list
"""

import modal

# ── App definition ────────────────────────────────────────────────────────────

app = modal.App("claude-discord-launcher")

# ── Container image ───────────────────────────────────────────────────────────
# Built from the Dockerfile in the same directory as this file.
# Contains: Python 3.11, Node.js 20, Claude Code, tmux, websockets.

import pathlib

_HERE = pathlib.Path(__file__).parent
_REPO_ROOT = _HERE.parent.parent

image = (
    modal.Image.from_dockerfile(
        _HERE / "Dockerfile.launcher",
        # Pass the repo root as the build context so COPY instructions work.
        context_mount=modal.Mount.from_local_dir(
            _REPO_ROOT,
            remote_path="/build-ctx",
            # Only include the files the Dockerfile needs.
            condition=lambda p: (
                p.name in ("discord_session_launcher.py", "claude-proxy.sh")
                or p.suffix in (".sh",)
            ),
        ),
    )
)

# ── Secrets ───────────────────────────────────────────────────────────────────
# "claude-launcher-secrets" must be created via:
#   modal secret create claude-launcher-secrets LAUNCHER_WS_URL=... PROXY_TOKEN=... ...
# See setup.sh for the exact command.

_secrets = [modal.Secret.from_name("claude-launcher-secrets")]

# ── Launcher function ─────────────────────────────────────────────────────────

@app.function(
    image=image,
    secrets=_secrets,
    # Keep at least one container always running so the WS daemon is always connected.
    min_containers=1,
    # 24-hour max per container lifetime. When Modal recycles the container,
    # discord_session_launcher.py's built-in reconnect loop re-connects automatically.
    timeout=86_400,
)
@modal.web_server(8080)
def launcher():
    """
    Starts two things in parallel:
      1. A background thread running the discord_session_launcher WS daemon
         (connects to LauncherDO, waits for /modal launch frames, runs sessions in tmux)
      2. A minimal HTTP server on port 8080 — this is what keeps the Modal
         container alive as a deployed web endpoint.
    """
    import sys
    import os
    import threading
    import asyncio
    import json
    import time
    from http.server import BaseHTTPRequestHandler, HTTPServer

    sys.path.insert(0, "/app")

    # ── Start WebSocket daemon in a background thread ─────────────────────────
    from discord_session_launcher import connect_and_listen, resolve_config  # type: ignore

    cfg = resolve_config()

    def run_ws_daemon() -> None:
        """Reconnecting WS loop — runs for the container's lifetime."""
        asyncio.run(connect_and_listen(cfg))

    ws_thread = threading.Thread(target=run_ws_daemon, name="ws-daemon", daemon=False)
    ws_thread.start()

    # ── HTTP health endpoint ──────────────────────────────────────────────────
    start_time = time.time()

    class HealthHandler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            uptime = int(time.time() - start_time)
            ws_alive = ws_thread.is_alive()
            body = json.dumps({
                "status": "running",
                "target": cfg.get("target", "modal"),
                "ws_daemon": "alive" if ws_alive else "dead",
                "uptime_seconds": uptime,
            }).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, fmt: str, *args: object) -> None:  # silence access logs
            pass

    HTTPServer(("", 8080), HealthHandler).serve_forever()
