#!/usr/bin/env bash
# claude-proxy.sh — launch Claude Code with the CF proxy (on) or direct Anthropic (off)
#
# Usage:
#   ./claude-proxy.sh on   — start wrangler dev (if not running), then launch claude via proxy
#   ./claude-proxy.sh off  — launch claude against real Anthropic API (standard ANTHROPIC_API_KEY)
#   ./claude-proxy.sh stop — stop the background wrangler dev server

set -euo pipefail

PROXY_HOST="${PROXY_HOST:-127.0.0.1}"
PROXY_PORT="${PROXY_PORT:-8787}"
PROXY_URL="http://${PROXY_HOST}:${PROXY_PORT}"
PIDFILE="/tmp/claude-cf-proxy-${PROXY_PORT}.pid"
LOGFILE="/tmp/claude-cf-proxy-${PROXY_PORT}.log"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

proxy_running() {
	if [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null && curl -sf "$PROXY_URL/health" > /dev/null 2>&1; then
		return 0
	fi
	return 1
}

start_proxy() {
	if proxy_running; then
		echo "  proxy already running (pid $(cat "$PIDFILE"))"
		return
	fi
	rm -f "$PIDFILE"

	echo "  starting wrangler dev server..."
	cd "$SCRIPT_DIR"
	npx wrangler dev --ip "$PROXY_HOST" --port "$PROXY_PORT" > "$LOGFILE" 2>&1 &
	echo $! > "$PIDFILE"

	# wait until the health endpoint responds (up to 15 s)
	for i in $(seq 1 30); do
		if curl -sf "$PROXY_URL/health" > /dev/null 2>&1; then
			echo "  proxy ready at $PROXY_URL (pid $(cat "$PIDFILE"))"
			return
		fi
		if ! kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
			echo "  proxy failed to start"
			echo "  wrangler log: $LOGFILE"
			tail -80 "$LOGFILE" || true
			rm -f "$PIDFILE"
			exit 1
		fi
		sleep 0.5
	done
	echo "  proxy did not respond within 15 s"
	echo "  wrangler log: $LOGFILE"
	tail -80 "$LOGFILE" || true
	rm -f "$PIDFILE"
	exit 1
}

stop_proxy() {
	if proxy_running; then
		echo "  stopping proxy (pid $(cat "$PIDFILE"))..."
		kill "$(cat "$PIDFILE")" 2>/dev/null && rm -f "$PIDFILE"
		echo "  proxy stopped"
	else
		echo "  proxy is not running"
		rm -f "$PIDFILE"
	fi
}

# ---------------------------------------------------------------------------
# commands
# ---------------------------------------------------------------------------

MODE="${1:-on}"

case "$MODE" in

on)
	echo "[proxy ON]"
	start_proxy

	# Read optional proxy token from .dev.vars
	TOKEN=""
	if [[ -f "$SCRIPT_DIR/.dev.vars" ]]; then
		TOKEN=$(grep -E '^PROXY_TOKEN=' "$SCRIPT_DIR/.dev.vars" | cut -d= -f2- | tr -d '"' | tr -d "'" || true)
	fi
	AUTH="${TOKEN:-dev-token}"

	echo "  ANTHROPIC_BASE_URL=$PROXY_URL"
	echo "  ANTHROPIC_AUTH_TOKEN=$AUTH"
	echo "  CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1"
	echo ""

	ANTHROPIC_BASE_URL="$PROXY_URL" \
	ANTHROPIC_AUTH_TOKEN="$AUTH" \
	CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY="1" \
	claude "${@:2}"
	;;

off)
	echo "[proxy OFF — using real Anthropic API]"
	if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
		echo "  warning: ANTHROPIC_API_KEY is not set"
	fi
	# Unset proxy vars if they happen to be in the environment
	env -u ANTHROPIC_BASE_URL \
	    -u ANTHROPIC_AUTH_TOKEN \
	    -u CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY \
	    claude "${@:2}"
	;;

stop)
	echo "[stopping proxy]"
	stop_proxy
	;;

*)
	echo "Usage: $0 [on|off|stop]"
	echo "  on   — run claude via CF Workers AI proxy (starts wrangler dev if needed)"
	echo "  off  — run claude via real Anthropic API"
	echo "  stop — stop the background wrangler dev server"
	exit 1
	;;
esac
