#!/usr/bin/env bash
# setup-deps.sh — Install all runtime dependencies for claude-proxy.
#
# Covers:
#   • Core tools      : Node.js, Bun, Python 3, tmux, rsync
#   • Python packages : websockets (discord_session_launcher.py)
#   • Node packages   : npm install (root), discord-router/, docker/discord-plugin/
#   • Global tools    : Claude Code CLI, Wrangler (via npx, no global install needed)
#   • Optional        : Modal CLI (for /modal feature)
#
# Safe to run multiple times — skips already-installed tools.
#
# Usage:
#   ./setup-deps.sh            # standard install
#   ./setup-deps.sh --with-modal   # also install Modal CLI (pip install modal)

set -euo pipefail

BOLD='\033[1m'
CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
DIM='\033[2m'
RESET='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WITH_MODAL=false
for arg in "$@"; do [[ "$arg" == "--with-modal" ]] && WITH_MODAL=true; done

info()    { echo -e "${CYAN}▶${RESET} $*"; }
ok()      { echo -e "${GREEN}✓${RESET} $*"; }
warn()    { echo -e "${YELLOW}⚠${RESET} $*"; }
die()     { echo -e "${RED}✗ ERROR:${RESET} $*" >&2; exit 1; }
step()    { echo -e "\n${BOLD}$*${RESET}"; }
dim()     { echo -e "${DIM}  $*${RESET}"; }

PLATFORM="$(uname -s)"   # Darwin | Linux
ARCH="$(uname -m)"       # arm64 | x86_64

echo ""
echo -e "${BOLD}claude-proxy dependency installer${RESET}"
echo -e "${DIM}Platform: $PLATFORM $ARCH${RESET}"
echo ""

# ── Helper: command exists ─────────────────────────────────────────────────────

has() { command -v "$1" &>/dev/null; }

# ── Helper: minimum version check (major.minor) ───────────────────────────────

version_gte() {
    # version_gte "20.0.0" "$(node --version | tr -d v)"
    local required="$1" actual="$2"
    printf '%s\n%s\n' "$required" "$actual" | sort -V -C 2>/dev/null || return 1
}

# ══════════════════════════════════════════════════════════════════════════════
# 1. Homebrew (macOS only)
# ══════════════════════════════════════════════════════════════════════════════
if [[ "$PLATFORM" == "Darwin" ]]; then
    step "1. Homebrew"
    if has brew; then
        ok "Homebrew already installed ($(brew --version | head -1))"
    else
        info "Installing Homebrew..."
        /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
        # Add to PATH for the rest of this script (Apple Silicon)
        if [[ "$ARCH" == "arm64" && -f /opt/homebrew/bin/brew ]]; then
            eval "$(/opt/homebrew/bin/brew shellenv)"
        fi
        ok "Homebrew installed"
    fi
fi

# ══════════════════════════════════════════════════════════════════════════════
# 2. Node.js (≥ 20)
# ══════════════════════════════════════════════════════════════════════════════
step "2. Node.js (≥ 20)"

NODE_OK=false
if has node; then
    NODE_VER="$(node --version | tr -d v)"
    if version_gte "20.0.0" "$NODE_VER"; then
        ok "Node.js $NODE_VER"
        NODE_OK=true
    else
        warn "Node.js $NODE_VER is too old (need ≥ 20)"
    fi
fi

if [[ "$NODE_OK" == false ]]; then
    if [[ "$PLATFORM" == "Darwin" ]]; then
        info "Installing Node.js via Homebrew..."
        brew install node
    elif [[ "$PLATFORM" == "Linux" ]]; then
        info "Installing Node.js 20.x via NodeSource..."
        curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
        sudo apt-get install -y --no-install-recommends nodejs
    fi
    ok "Node.js $(node --version)"
fi

# ══════════════════════════════════════════════════════════════════════════════
# 3. npm (comes with Node, just verify)
# ══════════════════════════════════════════════════════════════════════════════
step "3. npm"
ok "npm $(npm --version)"

# ══════════════════════════════════════════════════════════════════════════════
# 4. Bun (discord-plugin runtime)
# ══════════════════════════════════════════════════════════════════════════════
step "4. Bun (discord-plugin runtime)"
if has bun; then
    ok "Bun $(bun --version)"
else
    info "Installing Bun..."
    curl -fsSL https://bun.sh/install | bash
    # Add to PATH for rest of script
    export PATH="$HOME/.bun/bin:$PATH"
    ok "Bun $(bun --version)"
fi

# ══════════════════════════════════════════════════════════════════════════════
# 5. Python 3
# ══════════════════════════════════════════════════════════════════════════════
step "5. Python 3"

PY=""
if has python3; then
    PY="python3"
elif has python; then
    [[ "$(python --version 2>&1)" == *"Python 3"* ]] && PY="python"
fi

if [[ -z "$PY" ]]; then
    if [[ "$PLATFORM" == "Darwin" ]]; then
        info "Installing Python 3 via Homebrew..."
        brew install python3
        PY="python3"
    elif [[ "$PLATFORM" == "Linux" ]]; then
        sudo apt-get install -y --no-install-recommends python3 python3-pip
        PY="python3"
    else
        die "Python 3 not found and auto-install not supported on $PLATFORM. Install it manually."
    fi
fi

ok "Python $($PY --version)"

# ══════════════════════════════════════════════════════════════════════════════
# 6. pip / Python packages
# ══════════════════════════════════════════════════════════════════════════════
step "6. Python packages"

# Ensure pip is available
if ! $PY -m pip --version &>/dev/null; then
    if [[ "$PLATFORM" == "Darwin" ]]; then
        info "Installing pip via ensurepip..."
        $PY -m ensurepip --upgrade
    elif [[ "$PLATFORM" == "Linux" ]]; then
        sudo apt-get install -y python3-pip
    fi
fi

# websockets — required by discord_session_launcher.py
if $PY -c "import websockets" &>/dev/null; then
    WS_VER=$($PY -c "import websockets; print(websockets.__version__)" 2>/dev/null || echo "installed")
    ok "websockets $WS_VER"
else
    info "Installing websockets..."
    $PY -m pip install --quiet websockets
    ok "websockets installed"
fi

# Modal CLI (optional — needed for /modal feature)
if [[ "$WITH_MODAL" == true ]]; then
    if has modal; then
        ok "Modal CLI $(modal --version 2>/dev/null || echo 'installed')"
    else
        info "Installing Modal CLI..."
        $PY -m pip install --quiet modal
        ok "Modal CLI installed"
    fi
else
    dim "Modal CLI skipped (pass --with-modal to install)"
fi

# ══════════════════════════════════════════════════════════════════════════════
# 7. tmux (required for background session management + sessions web UI)
# ══════════════════════════════════════════════════════════════════════════════
step "7. tmux"
if has tmux; then
    ok "tmux $(tmux -V)"
else
    if [[ "$PLATFORM" == "Darwin" ]]; then
        info "Installing tmux via Homebrew..."
        brew install tmux
    elif [[ "$PLATFORM" == "Linux" ]]; then
        sudo apt-get install -y --no-install-recommends tmux
    else
        warn "tmux not found — install it manually. Background sessions will fall back to 'script'."
    fi
    has tmux && ok "tmux $(tmux -V)"
fi

# ══════════════════════════════════════════════════════════════════════════════
# 8. rsync (used by setup-launcher.sh --update and settings sync)
# ══════════════════════════════════════════════════════════════════════════════
step "8. rsync"
if has rsync; then
    ok "rsync $(rsync --version | head -1 | awk '{print $3}')"
else
    if [[ "$PLATFORM" == "Darwin" ]]; then
        brew install rsync
    elif [[ "$PLATFORM" == "Linux" ]]; then
        sudo apt-get install -y rsync
    fi
    ok "rsync installed"
fi

# ══════════════════════════════════════════════════════════════════════════════
# 9. Claude Code CLI
# ══════════════════════════════════════════════════════════════════════════════
step "9. Claude Code CLI"
if has claude; then
    ok "Claude Code $(claude --version 2>/dev/null | head -1 || echo 'installed')"
else
    info "Installing Claude Code globally..."
    npm install -g @anthropic-ai/claude-code
    ok "Claude Code $(claude --version 2>/dev/null | head -1 || echo 'installed')"
fi

# ══════════════════════════════════════════════════════════════════════════════
# 10. Node package installs
# ══════════════════════════════════════════════════════════════════════════════
step "10. Node packages"

# Root (wrangler, vitest, workers-types, agents SDK)
info "npm install (root)"
npm install --prefix "$SCRIPT_DIR" --silent
ok "Root packages installed"

# discord-router/
if [[ -f "$SCRIPT_DIR/discord-router/package.json" ]]; then
    info "npm install (discord-router)"
    npm install --prefix "$SCRIPT_DIR/discord-router" --silent
    ok "discord-router packages installed"
fi

# docker/discord-plugin/  — uses Bun
if [[ -f "$SCRIPT_DIR/docker/discord-plugin/package.json" ]]; then
    info "bun install (docker/discord-plugin)"
    bun install --cwd "$SCRIPT_DIR/docker/discord-plugin" --no-summary
    ok "discord-plugin packages installed"
fi

# ══════════════════════════════════════════════════════════════════════════════
# Summary
# ══════════════════════════════════════════════════════════════════════════════
echo ""
echo -e "${BOLD}${GREEN}All dependencies installed.${RESET}"
echo ""
echo -e "${DIM}Quick-start checklist:${RESET}"
echo -e "  ${DIM}1. Copy .dev.vars.example → .dev.vars and fill in secrets${RESET}"
echo -e "  ${DIM}2. Set LAUNCHER_TARGET in .dev.vars (macstudio / computeengine / local)${RESET}"
echo -e "  ${DIM}3. Start the session launcher daemon:${RESET}"
echo -e "  ${DIM}     python3 discord_session_launcher.py${RESET}"
echo -e "  ${DIM}4. Deploy the Worker:${RESET}"
echo -e "  ${DIM}     npx wrangler deploy${RESET}"
echo -e "  ${DIM}5. Register Discord slash commands:${RESET}"
echo -e "  ${DIM}     npx tsx scripts/register-discord-commands.mts${RESET}"
echo ""
