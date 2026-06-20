#!/usr/bin/env python3
"""
discord_session_launcher.py — Local daemon that receives launch commands from a
Cloudflare Durable Object over WebSocket and opens Claude Code sessions in new
terminal tabs on this machine.

─── Architecture ────────────────────────────────────────────────────────────
  Discord user
      │  (sends message)
      ▼
  Cloudflare Worker + Durable Object  ──(WebSocket push)──▶  THIS DAEMON
                                                                    │
                                                                    │ opens new tab
                                                                    ▼
                                                         terminal → claude-proxy.sh

The Durable Object holds the WebSocket endpoint. When a "start session" event
arrives (e.g. from a slash command or bot message), the DO sends a JSON frame:

  {
    "command": "claude-proxy.sh on prod --discord-channel 1234 --discord-users 5678",
    "session_id": "optional-correlation-id"
  }

This daemon parses it, launches the command in a new terminal tab/window, and
ACKs or NACKs back to the DO over the same WebSocket.

─── Running as a service ────────────────────────────────────────────────────
macOS (launchd):
  Create ~/Library/LaunchAgents/ai.jortelligence.session-launcher.plist with:

    <key>ProgramArguments</key>
    <array>
      <string>/usr/bin/python3</string>
      <string>/path/to/claude-proxy/discord_session_launcher.py</string>
    </array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>EnvironmentVariables</key>
    <dict>
      <key>LAUNCHER_WS_URL</key><string>wss://your-worker.workers.dev/launcher-ws</string>
      <key>PROXY_TOKEN</key><string>your-secret</string>
    </dict>

  Then: launchctl load ~/Library/LaunchAgents/ai.jortelligence.session-launcher.plist

Linux (systemd):
  Create /etc/systemd/system/session-launcher.service:

    [Unit]
    Description=Claude Code Discord Session Launcher

    [Service]
    ExecStart=/usr/bin/python3 /path/to/claude-proxy/discord_session_launcher.py
    Restart=always
    Environment="LAUNCHER_WS_URL=wss://your-worker.workers.dev/launcher-ws"
    Environment="PROXY_TOKEN=your-secret"

    [Install]
    WantedBy=default.target

  Then: systemctl enable --now session-launcher

Windows (NSSM / Task Scheduler):
  Use NSSM (Non-Sucking Service Manager) to wrap the Python script as a Windows
  service, or register it in Task Scheduler with "Run whether user is logged on
  or not" and trigger "At system startup".

─── Dependencies ─────────────────────────────────────────────────────────────
  pip install websockets            # async WebSocket client (RFC 6455)

─── Configuration (environment variables) ────────────────────────────────────
  LAUNCHER_WS_URL   WebSocket endpoint of the Durable Object
                    e.g. wss://claude-proxy.YOUR.workers.dev/launcher-ws
                    Default: read from .dev.vars WORKER_URL with /launcher-ws appended
  PROXY_TOKEN       Shared secret — sent as Authorization header on connect
                    Default: read from .dev.vars PROXY_TOKEN
  LAUNCHER_TERMINAL macOS terminal app override: "Terminal" | "iTerm" (default auto)
  CPROXY_SCRIPT     Path to claude-proxy.sh (default: same dir as this file)
"""

import asyncio
import json
import logging
import os
import platform
import shlex
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Optional

# ── Optional rich logging; fall back gracefully ────────────────────────────────
try:
    import websockets
    import websockets.exceptions
except ImportError:
    print(
        "ERROR: 'websockets' is not installed.\n"
        "Install it with:  pip install websockets",
        file=sys.stderr,
    )
    sys.exit(1)

# ── Logging setup ──────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("launcher")

# ── Constants ──────────────────────────────────────────────────────────────────
RECONNECT_DELAY_MIN = 1      # seconds
RECONNECT_DELAY_MAX = 60     # seconds
RECONNECT_BACKOFF   = 2.0    # multiply delay by this on each failure

# ── Config resolution ──────────────────────────────────────────────────────────

def _read_dev_vars() -> dict[str, str]:
    """Parse .dev.vars (KEY=value, KEY="value") from the repo root."""
    here = Path(__file__).parent
    path = here / ".dev.vars"
    result: dict[str, str] = {}
    if not path.exists():
        return result
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        v = v.strip().strip('"').strip("'")
        result[k.strip()] = v
    return result


def resolve_config() -> dict:
    """
    Build config from (highest priority first):
      1. Environment variables
      2. .dev.vars file
      3. Defaults

    Key env vars:
      LAUNCHER_WS_URL    WebSocket endpoint (derived from WORKER_URL if not set)
      PROXY_TOKEN        Bearer token for WebSocket auth
      CPROXY_SCRIPT      Absolute path to claude-proxy.sh
      LAUNCHER_TERMINAL  macOS only: "Terminal" | "iTerm" (auto-detected if unset)
      LAUNCHER_BACKGROUND  "1" to default all sessions to background (silent) mode
                           Per-session "mode" field in the JSON frame overrides this.
      DISCORD_ROUTER_URL WebSocket URL of the discord-router process (for multi-instance mode)
                         When set, launched Claude sessions connect to the router instead of
                         holding their own Discord gateway connection.
      ROUTER_TOKEN       Shared secret the plugin sends to authenticate with the router.
    """
    dev = _read_dev_vars()

    proxy_token = os.environ.get("PROXY_TOKEN") or dev.get("PROXY_TOKEN") or "dev-token"
    worker_url  = os.environ.get("WORKER_URL")  or dev.get("WORKER_URL") or ""

    # Derive default WebSocket URL from WORKER_URL: replace https:// with wss://
    default_ws = ""
    if worker_url:
        default_ws = worker_url.rstrip("/").replace("https://", "wss://").replace("http://", "ws://")
        default_ws += "/launcher-ws"

    ws_url = os.environ.get("LAUNCHER_WS_URL") or dev.get("LAUNCHER_WS_URL") or default_ws

    cproxy = os.environ.get("CPROXY_SCRIPT") or str(Path(__file__).parent / "claude-proxy.sh")

    background = os.environ.get("LAUNCHER_BACKGROUND", "0") == "1"

    # Target identity: each daemon only handles frames whose "target" field matches.
    # local         → your local machine (default; matches frames with no "target" field)
    # computeengine → Google Compute Engine VM daemon  (/computeengine command)
    # oracle        → Oracle Cloud Infrastructure VM daemon  (/oracle command)
    # modal         → Modal web_server container  (/modal command)
    # northflank    → Northflank deployment service  (/northflank command)
    # Set LAUNCHER_TARGET in the environment or .dev.vars on each machine.
    target = os.environ.get("LAUNCHER_TARGET") or dev.get("LAUNCHER_TARGET") or "local"

    # Router mode: if DISCORD_ROUTER_URL is set (env or .dev.vars), launched Claude
    # sessions will use the router instead of a direct Discord gateway connection.
    router_url   = os.environ.get("DISCORD_ROUTER_URL") or dev.get("DISCORD_ROUTER_URL") or ""
    router_token = os.environ.get("ROUTER_TOKEN")       or dev.get("ROUTER_TOKEN")       or ""

    return {
        "ws_url":           ws_url,
        "proxy_token":      proxy_token,
        "cproxy":           cproxy,
        "terminal":         os.environ.get("LAUNCHER_TERMINAL", ""),
        "background_mode":  background,
        "router_url":       router_url,
        "router_token":     router_token,
        "target":           target,
    }

# ── Shared helpers ─────────────────────────────────────────────────────────────

def _write_launch_script(
    command: str,
    keep_open: bool = True,
    env_vars: Optional[dict] = None,
) -> str:
    """
    Write `command` to a temp .sh file with Unix line endings and return its path.

    Using a script file instead of embedding the command in a shell/AppleScript
    string avoids all quoting issues:
      • double quotes  (e.g. --channels "plugin:discord@...")
      • backslash-newline continuations  (e.g. arg \\\n  arg2)
    Both are valid bash syntax inside a .sh file.

    If env_vars is provided, they are exported before the command so that the
    launched process inherits them (used to pass DISCORD_ROUTER_URL, ROUTER_TOKEN, etc.)

    If keep_open=True the script replaces itself with an interactive bash shell
    after the command finishes so the tab stays open for inspection.
    The script deletes itself before exec so /tmp doesn't accumulate files.
    """
    fd, path = tempfile.mkstemp(suffix=".sh", prefix="cproxy_launch_")
    try:
        with os.fdopen(fd, "w", newline="\n") as f:   # Unix line endings (required for WSL)
            f.write("#!/usr/bin/env bash\n")
            f.write("# Auto-generated by discord_session_launcher.py — safe to delete\n\n")
            if env_vars:
                for k, v in env_vars.items():
                    if v:
                        f.write(f"export {k}={shlex.quote(str(v))}\n")
                f.write("\n")
            f.write(command + "\n\n")
            f.write("echo '--- session ended ---'\n")
            if keep_open:
                f.write(f"rm -f {shlex.quote(path)}\n")   # self-delete before exec
                f.write("exec bash\n")
        os.chmod(path, 0o755)
    except Exception:
        try:
            os.unlink(path)
        except OSError:
            pass
        raise
    return path


def _to_wsl_path(windows_path: str) -> Optional[str]:
    """
    Convert a Windows absolute path to its WSL /mnt/... equivalent.
    Returns None if WSL is not installed or the conversion fails.
    """
    try:
        result = subprocess.run(
            ["wsl", "wslpath", "-u", windows_path],
            capture_output=True, text=True, check=True, timeout=5,
        )
        return result.stdout.strip()
    except (subprocess.CalledProcessError, FileNotFoundError, subprocess.TimeoutExpired):
        return None


def _find_git_bash() -> Optional[str]:
    """
    Return the path to Git Bash (bash.exe) on Windows, or None if not found.
    Checks common install locations and the PATH.
    """
    candidates = [
        r"C:\Program Files\Git\bin\bash.exe",
        r"C:\Program Files (x86)\Git\bin\bash.exe",
        os.path.join(
            os.environ.get("LOCALAPPDATA", ""),
            r"Programs\Git\bin\bash.exe",
        ),
    ]
    for path in candidates:
        if path and os.path.isfile(path):
            return path
    # Also check PATH
    try:
        result = subprocess.run(
            ["where", "bash"], capture_output=True, text=True, check=True,
        )
        first = result.stdout.strip().splitlines()[0]
        if first:
            return first
    except (subprocess.CalledProcessError, FileNotFoundError):
        pass
    return None


# ── GUI terminal launch ────────────────────────────────────────────────────────
# These functions open a visible terminal window/tab on the user's desktop.
# The tab stays open after the session ends so output can be inspected.

def _launch_macos_gui(command: str, terminal: str) -> None:
    """
    macOS: open a new tab in Terminal.app or iTerm2.

    LAUNCHER_TERMINAL env var overrides auto-detection:
      "Terminal" — built-in macOS Terminal.app (default)
      "iTerm"    — iTerm2  (https://iterm2.com)
    """
    if not terminal:
        check = subprocess.run(["pgrep", "-x", "iTerm2"], capture_output=True)
        terminal = "iTerm" if check.returncode == 0 else "Terminal"

    script_path = _write_launch_script(command, keep_open=True)

    if terminal.lower() == "iterm":
        applescript = f"""
tell application "iTerm"
    activate
    tell current window
        create tab with default profile
        tell current session
            write text "bash {script_path}"
        end tell
    end tell
end tell
"""
    else:
        applescript = f"""
tell application "Terminal"
    activate
    do script "bash {script_path}"
end tell
"""
    subprocess.run(["osascript", "-e", applescript], check=True)


def _launch_linux_gui(command: str) -> None:
    """
    Linux: open a new terminal window using the first available emulator.
    Tries gnome-terminal → konsole → xfce4-terminal → tilix → xterm.
    """
    script_path = _write_launch_script(command, keep_open=True)
    shell_cmd = f"bash {shlex.quote(script_path)}"

    candidates = [
        ["gnome-terminal", "--", "bash", "-c", shell_cmd],
        ["konsole",        "--noclose", "-e", "bash", "-c", shell_cmd],
        ["xfce4-terminal", "--hold",    "-x", "bash", "-c", shell_cmd],
        ["tilix",                       "-e", "bash", "-c", shell_cmd],
        ["xterm",          "-hold",     "-e", "bash", "-c", shell_cmd],
    ]

    for args in candidates:
        try:
            subprocess.Popen(args)
            log.info("Launched via %s", args[0])
            return
        except FileNotFoundError:
            continue

    raise RuntimeError(
        "No supported terminal emulator found. "
        "Install one of: gnome-terminal, konsole, xfce4-terminal, tilix, xterm"
    )


def _launch_windows_gui(command: str, terminal: str) -> None:
    """
    Windows: open a visible terminal window running the command via WSL or Git Bash.

    claude-proxy.sh is a bash script so a POSIX environment is required.
    Tries in order:
      1. Windows Terminal (wt.exe) + WSL  — best experience
      2. cmd + WSL                        — always available if WSL is installed
      3. Git Bash terminal                — fallback if WSL is absent

    Set LAUNCHER_TERMINAL=gitbash to force Git Bash even if WSL is present.
    """
    script_path_win = _write_launch_script(command, keep_open=True)

    force_gitbash = terminal.lower() == "gitbash"

    wsl_path = None if force_gitbash else _to_wsl_path(script_path_win)

    if wsl_path:
        # WSL is available — prefer it
        candidates = [
            # Windows Terminal with WSL tab
            ["wt.exe", "wsl", "bash", "--noprofile", "--norc", wsl_path],
            # Plain cmd + WSL window
            ["cmd", "/c", "start", "wsl", "bash", "--noprofile", "--norc", wsl_path],
        ]
    else:
        # Fall back to Git Bash
        git_bash = _find_git_bash()
        if not git_bash:
            raise RuntimeError(
                "Neither WSL nor Git Bash found on this Windows machine.\n"
                "Install WSL (https://learn.microsoft.com/en-us/windows/wsl/install)\n"
                "or Git for Windows (https://git-scm.com/download/win) to run claude-proxy.sh."
            )
        # Git Bash opens its own mintty window
        candidates = [
            [git_bash, "--login", "-c",
             f"bash {shlex.quote(script_path_win.replace(os.sep, '/'))} ; exec bash"],
        ]

    for args in candidates:
        try:
            subprocess.Popen(args)
            log.info("Launched via %s", args[0])
            return
        except (FileNotFoundError, OSError):
            continue

    raise RuntimeError(
        "Could not open a terminal window on Windows. "
        "Ensure WSL or Git Bash is installed and accessible."
    )


def launch_in_terminal(command: str, terminal: str = "") -> None:
    """
    Open `command` in a new **visible** GUI terminal tab/window.
    The window stays open after the session ends for inspection.
    """
    system = platform.system()
    log.info("Launching in GUI terminal [%s]: %s", system, command)

    if system == "Darwin":
        _launch_macos_gui(command, terminal)
    elif system == "Linux":
        _launch_linux_gui(command)
    elif system == "Windows":
        _launch_windows_gui(command, terminal)
    else:
        raise RuntimeError(f"Unsupported OS: {system}")


# ── Background (silent) launch ─────────────────────────────────────────────────
# Runs the session with no visible window.
# On Unix: uses tmux (preferred) or screen for a detached PTY session —
#   the session can be re-attached any time with `tmux attach -t <name>`.
# On Windows: runs via WSL in a fully detached subprocess.
#
# Output is always logged to:
#   ~/.claude/discord-sessions/logs/<session_id>.log

def _session_log_path(session_id: str) -> Path:
    log_dir = Path.home() / ".claude" / "discord-sessions" / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    name = session_id or f"session_{int(time.time())}"
    return log_dir / f"{name}.log"


def _launch_background_unix(command: str, session_id: str) -> dict:
    """
    macOS / Linux: run in a detached tmux session (screen → script → error as fallbacks).

    IMPORTANT — why we do NOT pipe to tee:
      Piping stdout (cmd | tee log) makes the subprocess see a pipe, not a PTY.
      Claude Code detects this and falls back to --print mode, which then errors
      because no prompt was provided. Running the command directly in tmux keeps
      the PTY intact; we use `tmux pipe-pane` for log capture instead.

    Session management:
      tmux attach -t cproxy_<session_id>        — watch live output
      tmux kill-session -t cproxy_<session_id>  — stop the session
      tail -f ~/.claude/discord-sessions/logs/<id>.log  — follow log file
    """
    log_path   = _session_log_path(session_id)
    script_path = _write_launch_script(command, keep_open=False)
    session_name = f"cproxy_{session_id or int(time.time())}"

    # ── tmux (preferred) ──────────────────────────────────────────────────────
    # Run the script directly — no pipes — so tmux's PTY is inherited by Claude.
    # pipe-pane tees a copy of the pane's output to the log file after the fact.
    try:
        subprocess.run(
            [
                "tmux", "new-session",
                "-d",                    # detached — no terminal window opens
                "-s", session_name,
                "-x", "220", "-y", "50", # reasonable virtual window size
                f"bash {shlex.quote(script_path)}",   # ← no pipe, PTY preserved
            ],
            check=True,
        )
        # pipe-pane taps the pane's output stream into the log file.
        # We strip ANSI escape sequences before writing so `tail -f` is readable:
        #   ESC[...m   — color / SGR codes
        #   ESC[...    — cursor movement, erase, scroll
        #   ESC(       — character-set designations
        #   \r         — carriage returns (PTY line endings → plain newlines)
        # printf '\033' produces the ESC byte portably on both BSD (macOS) and
        # GNU sed (Linux); \x1b is not recognised by BSD sed.
        ansi_strip = (
            r"ESC=$(printf '\033');"
            r" sed \"s/${ESC}\[[0-9;?]*[a-zA-Z@]//g;"
            r" s/${ESC}[()]//g;"
            r" s/\r//g\""
        )
        subprocess.run(
            ["tmux", "pipe-pane", "-t", session_name, "-o",
             f"{ansi_strip} >> {shlex.quote(str(log_path))}"],
            check=False,
        )
        log.info("Background session started via tmux: %s", session_name)
        log.info("  Attach : tmux attach -t %s", session_name)
        log.info("  Log    : tail -f %s", log_path)
        return {"runner": "tmux", "name": session_name, "log": str(log_path)}
    except (FileNotFoundError, subprocess.CalledProcessError):
        pass

    # ── screen (fallback) ─────────────────────────────────────────────────────
    # -L enables logging; -Logfile sets path (GNU screen ≥ 4.6).
    # screen also provides a PTY, so Claude Code works correctly.
    try:
        subprocess.run(
            ["screen", "-L", "-Logfile", str(log_path), "-dmS", session_name,
             "bash", script_path],
            check=True,
        )
        log.info("Background session started via screen: %s", session_name)
        log.info("  Attach : screen -r %s", session_name)
        log.info("  Log    : tail -f %s", log_path)
        return {"runner": "screen", "name": session_name, "log": str(log_path)}
    except (FileNotFoundError, subprocess.CalledProcessError):
        pass

    # ── `script` command (second fallback) ────────────────────────────────────
    # `script` creates a PTY, records its output, then exits.
    # BSD (macOS): script -q logfile command [args...]
    # GNU (Linux): script -q -c "command" logfile
    try:
        sys_name = platform.system()
        if sys_name == "Darwin":
            script_cmd = ["script", "-q", str(log_path), "bash", script_path]
        else:
            script_cmd = ["script", "-q", "-c", f"bash {shlex.quote(script_path)}", str(log_path)]

        proc = subprocess.Popen(
            script_cmd,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
            close_fds=True,
        )
        log.info("Background session started via script (PID %d). Log: %s", proc.pid, log_path)
        return {"runner": "script", "pid": proc.pid, "log": str(log_path)}
    except (FileNotFoundError, OSError):
        pass

    raise RuntimeError(
        "Could not start a background session. "
        "Install tmux (brew install tmux) and try again."
    )


def _launch_background_windows(command: str, session_id: str) -> dict:
    """
    Windows: run via WSL in a fully detached background subprocess.
    No window opens. Output is logged to the standard log path.

    To re-attach: open WSL and check the log file, or attach to the tmux
    session inside WSL if tmux is installed there.
    """
    log_path = _session_log_path(session_id)
    script_path_win = _write_launch_script(command, keep_open=False)
    wsl_path = _to_wsl_path(script_path_win)
    wsl_log = _to_wsl_path(str(log_path))

    if not wsl_path:
        raise RuntimeError(
            "WSL not found. Background mode on Windows requires WSL.\n"
            "Install WSL: https://learn.microsoft.com/en-us/windows/wsl/install"
        )

    DETACHED_PROCESS = 0x00000008
    CREATE_NO_WINDOW = 0x08000000

    bash_cmd = f"bash {shlex.quote(wsl_path)}"
    if wsl_log:
        bash_cmd += f" > {shlex.quote(wsl_log)} 2>&1"

    with open(log_path, "w") as lf:
        lf.write(f"# Discord session — {time.strftime('%Y-%m-%d %H:%M:%S')}\n")

    proc = subprocess.Popen(
        ["wsl", "bash", "-c", bash_cmd],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=DETACHED_PROCESS | CREATE_NO_WINDOW,
        close_fds=True,
    )
    log.info("Background session started (PID %d). Log: %s", proc.pid, log_path)
    return {"runner": "wsl-subprocess", "pid": proc.pid, "log": str(log_path)}


def launch_background(command: str, session_id: str = "") -> dict:
    """
    Run `command` silently with no visible window.

    Returns a dict with runner info and log path for ACK/NACK reporting.
    """
    system = platform.system()
    log.info("Launching in background [%s]: %s", system, command)

    if system in ("Darwin", "Linux"):
        return _launch_background_unix(command, session_id)
    elif system == "Windows":
        return _launch_background_windows(command, session_id)
    else:
        raise RuntimeError(f"Unsupported OS for background launch: {system}")


# ── Unified launcher ───────────────────────────────────────────────────────────

def launch(command: str, mode: str, terminal: str = "", session_id: str = "") -> dict:
    """
    Dispatch to either GUI terminal or background mode.

    mode:
      "terminal"   — open a visible terminal tab/window (default, good for debugging)
      "background" — run silently with no window (set LAUNCHER_BACKGROUND=1 or
                     pass "mode": "background" in the JSON frame from Discord)
    """
    if mode == "background":
        return launch_background(command, session_id)
    else:
        launch_in_terminal(command, terminal)
        return {"runner": "terminal", "mode": mode}

# ── Message handling ───────────────────────────────────────────────────────────

async def handle_message(raw: str, ws, cfg: dict) -> None:
    """
    Parse a JSON frame from the Durable Object and launch a Claude session.

    Expected frame shape:
      {
        "command":    "claude-proxy.sh on prod --discord-channel 1234 ...",
        "session_id": "optional-string",  // echoed in ACK/NACK
        "mode":       "terminal" | "background"  // optional, overrides LAUNCHER_BACKGROUND
      }

    mode resolution (highest priority first):
      1. "mode" field in the JSON frame
      2. LAUNCHER_BACKGROUND=1 env var  → "background"
      3. Default: "terminal"  (opens a visible GUI window)
    """
    try:
        msg = json.loads(raw)
    except json.JSONDecodeError as e:
        log.warning("Received non-JSON frame (ignored): %s — %s", raw[:120], e)
        return

    command    = msg.get("command", "").strip()
    session_id = msg.get("session_id", "")
    # Per-frame mode override; falls back to daemon-wide default
    default_mode = "background" if cfg.get("background_mode") else "terminal"
    mode       = msg.get("mode", default_mode)

    # Target routing: only handle frames addressed to this daemon's identity.
    # Frames with no "target" field default to "local" for backwards compatibility.
    frame_target = msg.get("target", "local")
    my_target    = cfg.get("target", "local")
    if frame_target != my_target:
        log.debug(
            "Ignoring frame (target=%s, I am target=%s session_id=%s)",
            frame_target, my_target, session_id or "(none)",
        )
        return

    # compute_* frames come from the sessions web UI (no "command" field).
    frame_type = msg.get("frame_type", "")
    if frame_type.startswith("compute_"):
        await handle_compute_frame(msg, ws)
        return

    if not command:
        log.warning("Frame has no 'command' field: %s", msg)
        return

    # Resolve relative claude-proxy.sh path against the script's directory.
    # Use "in" not startswith — the command may be prefixed with env var exports
    # (e.g. DISCORD_STATE_DIR=... claude-proxy.sh ...) since the code fix for
    # per-channel state isolation prepends env vars before the script name.
    if "claude-proxy.sh" in command:
        command = command.replace("claude-proxy.sh", cfg["cproxy"], 1)

    # ── Router mode env vars ──────────────────────────────────────────────────
    # If DISCORD_ROUTER_URL is configured, prepend export statements so the
    # launched Claude process connects to the router instead of its own Discord
    # gateway. These appear at the top of the generated launch script so all
    # sub-processes (including the MCP plugin) inherit them.
    router_exports: list[str] = []
    if cfg.get("router_url"):
        router_exports.append(f'export DISCORD_ROUTER_URL={shlex.quote(cfg["router_url"])}')
        if cfg.get("router_token"):
            router_exports.append(f'export ROUTER_TOKEN={shlex.quote(cfg["router_token"])}')
        log.info("Router mode: sessions will connect to %s", cfg["router_url"])
    if router_exports:
        command = "\n".join(router_exports) + "\n\n" + command

    try:
        result = launch(command, mode=mode, terminal=cfg["terminal"], session_id=session_id)
        ack = json.dumps({
            "status": "launched",
            "mode":   mode,
            "session_id": session_id,
            **result,
        })
        await ws.send(ack)
        log.info("ACK sent for session_id=%s mode=%s", session_id or "(none)", mode)

    except Exception as exc:
        log.error("Failed to launch [mode=%s]: %s", mode, exc)
        nack = json.dumps({
            "status": "error",
            "mode":   mode,
            "session_id": session_id,
            "error": str(exc),
        })
        try:
            await ws.send(nack)
        except Exception:
            pass  # WebSocket may be broken; reconnect loop will handle it

# ── WebSocket connection loop ──────────────────────────────────────────────────

async def handle_compute_frame(msg: dict, ws) -> None:
    """Handle compute_* control frames from the sessions web UI.

    These are sent BY the Worker TO the daemon to inspect/manage tmux sessions.
    Each handler echoes request_id so the Worker can correlate the response.
    Session names are validated: must start with cproxy_ and contain no path separators.
    """
    frame_type = msg.get("frame_type", "")
    request_id = msg.get("request_id", "")
    session    = msg.get("session", "").strip()

    log.info(
        "[compute] frame_type=%s session=%r request_id=%s",
        frame_type, session or "(none)", request_id or "(none)",
    )

    async def respond(data: dict) -> None:
        await ws.send(json.dumps({"request_id": request_id, **data}))

    def _valid_session(s: str) -> bool:
        return bool(s) and s.startswith("cproxy_") and "/" not in s and ".." not in s

    if frame_type == "compute_list_sessions":
        try:
            r = subprocess.run(
                ["tmux", "ls", "-F", "#{session_name}\t#{session_attached}"],
                capture_output=True, text=True, timeout=5,
            )
            sessions = []
            for line in r.stdout.strip().splitlines():
                parts = line.split("\t")
                name = parts[0] if parts else ""
                if not name.startswith("cproxy_"):
                    continue
                sessions.append({
                    "name": name,
                    "attached": parts[1] == "1" if len(parts) > 1 else False,
                })
            await respond({"status": "ok", "sessions": sessions})
        except FileNotFoundError:
            await respond({"status": "error", "error": "tmux not found"})
        except subprocess.TimeoutExpired:
            await respond({"status": "error", "error": "tmux ls timed out"})
        except Exception as exc:
            await respond({"status": "error", "error": str(exc)})

    elif frame_type == "compute_capture_session":
        if not _valid_session(session):
            await respond({"status": "error", "error": "Invalid or missing session name (must start with cproxy_)"})
            return
        try:
            r = subprocess.run(
                ["tmux", "capture-pane", "-t", session, "-p", "-S", "-200"],
                capture_output=True, text=True, timeout=10,
            )
            if r.returncode != 0:
                await respond({"status": "error", "error": r.stderr.strip() or "capture-pane failed"})
            else:
                await respond({"status": "ok", "output": r.stdout})
        except subprocess.TimeoutExpired:
            await respond({"status": "error", "error": "capture-pane timed out"})
        except Exception as exc:
            await respond({"status": "error", "error": str(exc)})

    elif frame_type == "compute_send_text":
        if not _valid_session(session):
            await respond({"status": "error", "error": "Invalid or missing session name (must start with cproxy_)"})
            return
        text = msg.get("text", "")
        if not isinstance(text, str):
            await respond({"status": "error", "error": "text must be a string"})
            return
        log.info("[compute] send-keys to %s: %r", session, text[:80])
        try:
            # -l sends text literally (not as key names), then a separate Enter key
            subprocess.run(
                ["tmux", "send-keys", "-t", session, "-l", text],
                capture_output=True, text=True, timeout=5, check=True,
            )
            subprocess.run(
                ["tmux", "send-keys", "-t", session, "Enter"],
                capture_output=True, text=True, timeout=5, check=True,
            )
            await respond({"status": "ok"})
        except subprocess.CalledProcessError as exc:
            await respond({"status": "error", "error": exc.stderr.strip() or "send-keys failed"})
        except subprocess.TimeoutExpired:
            await respond({"status": "error", "error": "send-keys timed out"})
        except Exception as exc:
            await respond({"status": "error", "error": str(exc)})

    elif frame_type == "compute_kill_session":
        if not _valid_session(session):
            await respond({"status": "error", "error": "Invalid or missing session name (must start with cproxy_)"})
            return
        log.info("[compute] killing session %s", session)
        try:
            r = subprocess.run(
                ["tmux", "kill-session", "-t", session],
                capture_output=True, text=True, timeout=5,
            )
            if r.returncode != 0:
                await respond({"status": "error", "error": r.stderr.strip() or "kill-session failed"})
            else:
                await respond({"status": "ok"})
        except subprocess.TimeoutExpired:
            await respond({"status": "error", "error": "kill-session timed out"})
        except Exception as exc:
            await respond({"status": "error", "error": str(exc)})

    else:
        log.warning("[compute] Unknown frame_type: %s", frame_type)
        await respond({"status": "error", "error": f"Unknown frame_type: {frame_type}"})


async def connect_and_listen(cfg: dict) -> None:
    """
    Maintain a persistent WebSocket connection to the Durable Object.
    Reconnects automatically with exponential backoff on any disconnect or error.
    """
    ws_url = cfg["ws_url"]
    if not ws_url:
        log.error(
            "LAUNCHER_WS_URL is not configured. "
            "Set it in the environment or in .dev.vars."
        )
        sys.exit(1)

    headers = {
        "Authorization": f"Bearer {cfg['proxy_token']}",
        "X-Launcher-Version": "1.0",
    }

    delay = RECONNECT_DELAY_MIN

    while True:
        try:
            log.info("Connecting to %s …", ws_url)
            async with websockets.connect(
                ws_url,
                additional_headers=headers,
                ping_interval=30,        # send WS pings every 30 s to keep the DO alive
                ping_timeout=15,         # if no pong in 15 s, treat as disconnected
                close_timeout=10,
            ) as ws:
                # Announce our target so the DO can route compute_* frames to us.
                await ws.send(json.dumps({"type": "hello", "target": cfg["target"]}))
                log.info("Connected (target=%s). Waiting for commands …", cfg["target"])
                delay = RECONNECT_DELAY_MIN   # reset backoff on successful connect

                async for raw in ws:
                    await handle_message(raw, ws, cfg)

        except websockets.exceptions.ConnectionClosedOK:
            log.info("Server closed connection cleanly. Reconnecting …")

        except websockets.exceptions.ConnectionClosedError as e:
            log.warning("Connection closed with error: %s. Reconnecting in %ds …", e, delay)

        except OSError as e:
            log.warning("Network error: %s. Reconnecting in %ds …", e, delay)

        except Exception as e:
            log.error("Unexpected error: %s. Reconnecting in %ds …", e, delay)

        await asyncio.sleep(delay)
        delay = min(delay * RECONNECT_BACKOFF, RECONNECT_DELAY_MAX)

# ── Entry point ────────────────────────────────────────────────────────────────

def _acquire_singleton_lock(target: str) -> None:
    """Ensure only one launcher daemon for this `target` runs on this machine.

    Each running daemon opens its own WebSocket to LauncherDO. LauncherDO's
    /dispatch broadcasts every launch frame to ALL connected sockets, and
    each daemon independently checks `frame_target == my_target` and, if it
    matches, runs `claude-proxy.sh` itself. So if two daemons with the same
    target (e.g. two leftover "local" processes from re-running this script
    without killing the previous one) are connected at once, a single
    `/local` launch command spawns TWO Claude sessions — and once those
    sessions open their own Discord gateway connections, every subsequent
    message in that channel gets delivered to both.

    To prevent this, on startup we write our PID to a per-target lock file
    in the system temp dir. If a previous process is still alive there, we
    terminate it first so only the newest instance stays connected. This is
    plain os.kill/signal based (no extra deps), so it works the same on a
    local machine, GCE, Oracle, or any other VM.
    """
    pid_file = Path(tempfile.gettempdir()) / f"discord_session_launcher_{target}.pid"
    my_pid = os.getpid()

    old_pid: Optional[int] = None
    if pid_file.exists():
        try:
            old_pid = int(pid_file.read_text().strip())
        except (ValueError, OSError):
            old_pid = None

    if old_pid and old_pid != my_pid:
        try:
            os.kill(old_pid, 0)  # raises if not running / not ours
        except OSError:
            old_pid = None  # already gone

        if old_pid:
            log.warning(
                "Found existing launcher daemon (pid %d, target=%s) still "
                "running — terminating it so only one instance (this one, "
                "pid %d) stays connected and reacts to launch commands.",
                old_pid, target, my_pid,
            )
            try:
                os.kill(old_pid, signal.SIGTERM)
                for _ in range(30):  # wait up to ~3s for graceful exit
                    time.sleep(0.1)
                    try:
                        os.kill(old_pid, 0)
                    except OSError:
                        break
                else:
                    log.warning("pid %d did not exit in time — sending SIGKILL", old_pid)
                    os.kill(old_pid, signal.SIGKILL)
            except OSError as e:
                log.warning("Could not terminate pid %d: %s", old_pid, e)

    try:
        pid_file.write_text(str(my_pid))
    except OSError as e:
        log.warning("Could not write lock file %s: %s", pid_file, e)


def main() -> None:
    cfg = resolve_config()
    _acquire_singleton_lock(cfg["target"])

    log.info("─" * 60)
    log.info("Discord Session Launcher")
    log.info("  WS endpoint : %s", cfg["ws_url"] or "(NOT SET)")
    log.info("  cproxy path : %s", cfg["cproxy"])
    log.info("  platform    : %s %s", platform.system(), platform.machine())
    log.info("  target      : %s  (LAUNCHER_TARGET)", cfg["target"])
    log.info("─" * 60)

    if not Path(cfg["cproxy"]).exists():
        log.warning(
            "claude-proxy.sh not found at %s — commands may fail at launch time",
            cfg["cproxy"],
        )

    try:
        asyncio.run(connect_and_listen(cfg))
    except KeyboardInterrupt:
        log.info("Interrupted — shutting down.")


if __name__ == "__main__":
    main()
