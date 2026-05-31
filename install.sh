#!/usr/bin/env bash
# install.sh — add the `cproxy` command to your PATH so you can run it from any directory.
#
# Usage:
#   ./install.sh          — installs to ~/.local/bin/cproxy (no sudo required)
#   ./install.sh --global — installs to /usr/local/bin/cproxy (requires sudo)
#   ./install.sh --remove — uninstall

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROXY_SCRIPT="$SCRIPT_DIR/claude-proxy.sh"
CMD_NAME="cproxy"

if [[ ! -f "$PROXY_SCRIPT" ]]; then
	echo "Error: claude-proxy.sh not found at $PROXY_SCRIPT"
	exit 1
fi

# ---------------------------------------------------------------------------
# Determine install location
# ---------------------------------------------------------------------------

INSTALL_DIR="$HOME/.local/bin"
NEEDS_SUDO=false

case "${1:-}" in
	--global)
		INSTALL_DIR="/usr/local/bin"
		NEEDS_SUDO=true
		;;
	--remove)
		for dir in "$HOME/.local/bin" "/usr/local/bin"; do
			if [[ -f "$dir/$CMD_NAME" ]]; then
				echo "Removing $dir/$CMD_NAME ..."
				if [[ "$dir" == "/usr/local/bin" ]]; then
					sudo rm -f "$dir/$CMD_NAME"
				else
					rm -f "$dir/$CMD_NAME"
				fi
				echo "Removed."
			fi
		done
		exit 0
		;;
esac

DEST="$INSTALL_DIR/$CMD_NAME"

# ---------------------------------------------------------------------------
# Create install dir if needed
# ---------------------------------------------------------------------------

mkdir -p "$INSTALL_DIR"

# ---------------------------------------------------------------------------
# Write the wrapper script
# ---------------------------------------------------------------------------

WRAPPER=$(cat << EOF
#!/usr/bin/env bash
# cproxy — Claude Code proxy launcher
# Calls claude-proxy.sh from any directory; Claude Code opens in the current folder.
exec "$PROXY_SCRIPT" "\$@"
EOF
)

if $NEEDS_SUDO; then
	echo "$WRAPPER" | sudo tee "$DEST" > /dev/null
	sudo chmod +x "$DEST"
else
	echo "$WRAPPER" > "$DEST"
	chmod +x "$DEST"
fi

echo ""
echo "  ✓  Installed: $DEST"
echo "     Points to: $PROXY_SCRIPT"
echo ""

# ---------------------------------------------------------------------------
# Check PATH
# ---------------------------------------------------------------------------

if ! command -v "$CMD_NAME" &>/dev/null; then
	echo "  ⚠  $INSTALL_DIR is not in your PATH yet."
	echo ""

	SHELL_NAME="$(basename "${SHELL:-bash}")"
	case "$SHELL_NAME" in
		zsh)  RC="$HOME/.zshrc" ;;
		bash) RC="$HOME/.bashrc" ;;
		*)    RC="your shell rc file" ;;
	esac

	echo "  Add this line to $RC, then restart your terminal:"
	echo ""
	echo "      export PATH=\"\$HOME/.local/bin:\$PATH\""
	echo ""
	echo "  Or run it now (current session only):"
	echo ""
	echo "      export PATH=\"\$HOME/.local/bin:\$PATH\""
	echo ""
else
	echo "  ✓  $CMD_NAME is on your PATH and ready to use."
	echo ""
	echo "  Usage from any directory:"
	echo ""
	echo "      cproxy on            # interactive provider + model picker"
	echo "      cproxy on openrouter # pick OpenRouter model"
	echo "      cproxy on nvidia     # pick NVIDIA NIM model"
	echo "      cproxy on workers_ai # use Workers AI binding"
	echo "      cproxy off           # use real Anthropic API"
	echo "      cproxy log           # watch live request logs"
	echo "      cproxy status        # show proxy status"
	echo "      cproxy stop          # stop the proxy"
	echo ""
fi
