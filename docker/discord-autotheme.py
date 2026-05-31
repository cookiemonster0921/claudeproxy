#!/usr/bin/env python3
"""
discord-autotheme.py — PTY wrapper that auto-selects Claude Code's first-run
theme picker, then runs transparently as the session's main process.

Problem: Claude Code shows a theme selector on the very first run in a fresh
~/.claude environment. In a headless container with no one attached, this
blocks forever. The bot never comes online.

Solution: Fork claude under a PTY, watch the output stream for the selector
prompt, inject Enter automatically (Dark mode is pre-highlighted), then relay
all subsequent I/O between the container's stdio and the claude PTY
transparently.

Output behaviour:
  - When stdout IS a TTY (docker attach --sig-proxy=false, or run without -d):
    raw PTY bytes are relayed so colours/UI render correctly.
  - When stdout is NOT a TTY (docker logs, Docker Desktop, default detached
    docker run -d without -t): ANSI escape sequences are stripped so the log
    output is clean, readable plain text.

Usage: called by discord-entrypoint.sh instead of exec'ing claude directly.
  python3 /usr/local/bin/discord-autotheme.py [extra-claude-flags...]
"""

import fcntl
import os
import pty
import re
import select
import signal
import struct
import sys
import termios
import time

# The ✔ checkmark (U+2714, UTF-8: \xe2\x9c\x94) appears next to the
# currently-highlighted theme option in Claude Code's picker. It's the only
# reliable detector because ANSI cursor-position codes break "Choose the text
# style" into non-contiguous bytes in the raw PTY stream.
THEME_PROMPT = b'\xe2\x9c\x94'   # ✔ heavy check mark
# Option 2 (Dark mode) is already highlighted (❯ cursor on it).
# Just send Enter (\r) to confirm the selection.
THEME_CHOICE = b'\r'

COLS = 220
ROWS = 50

# Cursor-column-absolute codes (ESC [ <n> G) that React Ink uses to position
# words at specific columns.  Replacing them with a single space prevents words
# from running together once the rest of the ANSI codes are removed.
_COL_RE = re.compile(rb'\x1b\[\d+G')

# All remaining standard ANSI / VT100 escape sequences:
#   CSI sequences:  ESC [ <params> <final-byte>
#   OSC sequences:  ESC ] <text> BEL   (window title, hyperlinks, …)
#   Fe sequences:   ESC <single-char>  (e.g. ESC M = reverse index)
_ANSI_RE = re.compile(
    rb'\x1b'
    rb'(?:'
    rb'\[[0-9;?]*[ -/]*[@-~]'       # CSI — ESC [ … final-byte
    rb'|\][^\x07]*(?:\x07|\x1b\\)'  # OSC — ESC ] … BEL or ST
    rb'|[@-Z\\-_]'                  # Fe  — ESC + single char
    rb')'
)


def _strip_ansi(data: bytes) -> bytes:
    """Convert column-jump codes to spaces then remove all other ANSI sequences."""
    data = _COL_RE.sub(b' ', data)
    return _ANSI_RE.sub(b'', data)


def _set_winsize(fd: int) -> None:
    """Give the PTY a reasonable window size so Claude's UI renders correctly."""
    try:
        winsize = struct.pack('HHHH', ROWS, COLS, 0, 0)
        fcntl.ioctl(fd, termios.TIOCSWINSZ, winsize)
    except OSError:
        pass


def main() -> None:
    # Create a master/slave PTY pair. Claude will run on the slave side
    # and think it has a real terminal.
    master_fd, slave_fd = pty.openpty()
    _set_winsize(master_fd)

    pid = os.fork()

    if pid == 0:
        # ── Child: become claude ─────────────────────────────────────────────
        os.close(master_fd)
        os.setsid()                              # new session leader
        fcntl.ioctl(slave_fd, termios.TIOCSCTTY, 0)  # attach controlling TTY
        for i in range(3):
            os.dup2(slave_fd, i)                 # stdin/stdout/stderr → slave
        os.close(slave_fd)
        # exec replaces this process — extra args (e.g. from entrypoint) forwarded
        os.execlp('claude', 'claude', *sys.argv[1:])
        os._exit(1)  # unreachable, but keeps linters happy

    # ── Parent: relay I/O and handle theme auto-selection ───────────────────
    os.close(slave_fd)

    theme_handled = False
    output_buf = b''

    stdout_fd = sys.stdout.buffer.fileno()
    stdin_fd  = sys.stdin.fileno()

    # When stdout is a real TTY (e.g. the user ran docker attach or launched
    # the container interactively without -d), pass raw bytes so colours render.
    # When stdout is a pipe (docker run -d, docker logs, Docker Desktop), strip
    # ANSI codes so the log viewer shows clean, readable text.
    stdout_is_tty = os.isatty(stdout_fd)

    # Forward SIGTERM/SIGINT to the child (Claude) so `docker stop` is clean
    def forward_signal(signum: int, _frame) -> None:
        try:
            os.kill(pid, signum)
        except ProcessLookupError:
            pass

    signal.signal(signal.SIGTERM, forward_signal)
    signal.signal(signal.SIGINT, forward_signal)

    # Make master non-blocking so reads don't stall the relay loop
    fl = fcntl.fcntl(master_fd, fcntl.F_GETFL)
    fcntl.fcntl(master_fd, fcntl.F_SETFL, fl | os.O_NONBLOCK)

    # Track which fds to watch; remove stdin from the set once it hits EOF
    # so select() doesn't busy-spin when running detached with no one attached.
    watch_fds = [master_fd, stdin_fd]

    while True:
        # ── Check if Claude has exited ────────────────────────────────────────
        try:
            wpid, status = os.waitpid(pid, os.WNOHANG)
            if wpid == pid:
                sys.exit(os.waitstatus_to_exitcode(status))
        except ChildProcessError:
            break

        # ── Wait for activity on Claude's PTY output or our own stdin ────────
        try:
            readable, _, _ = select.select(watch_fds, [], [], 0.1)
        except (ValueError, select.error):
            break

        # ── Data from Claude → write to our stdout (container logs / attach) ─
        if master_fd in readable:
            try:
                data = os.read(master_fd, 4096)
            except OSError:
                break

            if data:
                output_buf += data

                # Write raw bytes if attached to a real TTY (docker attach),
                # otherwise strip ANSI so docker logs / Docker Desktop are clean.
                if stdout_is_tty:
                    os.write(stdout_fd, data)
                else:
                    os.write(stdout_fd, _strip_ansi(data))

                # Detect the theme selector and auto-pick Dark mode
                if not theme_handled and THEME_PROMPT in output_buf:
                    time.sleep(0.4)   # small delay so the UI is fully drawn
                    # Send Enter 3× with short gaps — dismisses the theme picker
                    # plus any subsequent first-run dialogs (security notes,
                    # trust-this-folder) that also require Enter to dismiss.
                    for _ in range(3):
                        os.write(master_fd, THEME_CHOICE)
                        time.sleep(0.15)
                    theme_handled = True
                    output_buf = b''  # reset — no need to keep the prompt
                # Limit buffer to last 8 KB to avoid unbounded growth
                elif not theme_handled and len(output_buf) > 8192:
                    output_buf = output_buf[-4096:]

        # ── Data from our stdin → forward to Claude (for `docker attach`) ───
        if stdin_fd in readable and stdin_fd in watch_fds:
            try:
                data = os.read(stdin_fd, 4096)
                if data:
                    os.write(master_fd, data)
                else:
                    # EOF on stdin — nobody attached. Stop watching it so we
                    # don't busy-spin; Claude's PTY still relays output fine.
                    watch_fds.remove(stdin_fd)
            except OSError:
                watch_fds.remove(stdin_fd)

    # ── Cleanup ──────────────────────────────────────────────────────────────
    try:
        os.close(master_fd)
    except OSError:
        pass

    try:
        _, status = os.waitpid(pid, 0)
        sys.exit(os.waitstatus_to_exitcode(status))
    except Exception:
        pass


if __name__ == '__main__':
    main()
