#!/usr/bin/env bash
# claude-proxy.sh — launch Claude Code via a Cloudflare Worker proxy
#
# Usage:
#   ./claude-proxy.sh on                 — interactive backend + provider + model picker
#   ./claude-proxy.sh on local           — local wrangler dev, then pick provider + model
#   ./claude-proxy.sh on prod            — connect to deployed Worker URL (set WORKER_URL in .dev.vars)
#   ./claude-proxy.sh on nvidia          — local, pick NVIDIA NIM model interactively
#   ./claude-proxy.sh on openrouter      — local, pick OpenRouter model interactively
#   ./claude-proxy.sh on cloudflare      — local, pick Cloudflare Workers AI model interactively
#   ./claude-proxy.sh on google_ai       — local, pick Google AI Studio (Gemini) model interactively
#   ./claude-proxy.sh on workers_ai      — local, use Workers AI binding (no external key needed)
#   ./claude-proxy.sh on local nvidia    — local, pick NVIDIA NIM model interactively
#   ./claude-proxy.sh on prod            — prod Worker (WORKER_URL from .dev.vars)
#   ./claude-proxy.sh off                — run claude against real Anthropic API
#   ./claude-proxy.sh stop               — stop the background wrangler dev server
#   ./claude-proxy.sh status             — show current proxy status and active model

set -euo pipefail

# Save the directory where Claude Code will open.
# Honour a pre-set LAUNCH_DIR env var (set by the launcher daemon for per-channel
# project folders); fall back to $PWD when running the script manually.
LAUNCH_DIR="${LAUNCH_DIR:-$PWD}"

PROXY_HOST="${PROXY_HOST:-127.0.0.1}"
PROXY_PORT="${PROXY_PORT:-8787}"
PROXY_URL="http://${PROXY_HOST}:${PROXY_PORT}"
PIDFILE="/tmp/claude-cf-proxy-${PROXY_PORT}.pid"
LOGFILE="/tmp/claude-cf-proxy-${PROXY_PORT}.log"
MODELFILE="/tmp/claude-cf-proxy-${PROXY_PORT}.model"
BACKENDFILE="/tmp/claude-cf-proxy-${PROXY_PORT}.backend"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Read the deployed Worker URL from .dev.vars (WORKER_URL=https://...)
# Set this once: echo 'WORKER_URL=https://claude-proxy.YOUR-ACCOUNT.workers.dev' >> .dev.vars
WORKER_URL=""
if [[ -f "$SCRIPT_DIR/.dev.vars" ]]; then
	WORKER_URL=$(grep -E '^WORKER_URL=' "$SCRIPT_DIR/.dev.vars" | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'" || true)
fi

# ---------------------------------------------------------------------------
# Model catalogs — edit these to add/remove models
# Format: "Display label|provider_id/model-id"
# ---------------------------------------------------------------------------

NVIDIA_MODELS=(
	"Llama 3.3 70B Instruct (fast)         |nvidia_nim/meta/llama-3.3-70b-instruct"
	"Llama 4 Maverick 17B Instruct         |nvidia_nim/meta/llama-4-maverick-17b-128e-instruct"
	"DeepSeek V4 Flash                     |nvidia_nim/deepseek-ai/deepseek-v4-flash"
	"Nemotron Super 49B (reasoning)        |nvidia_nim/nvidia/llama-3.3-nemotron-super-49b-v1"
	"Nemotron Nano 8B (fast/cheap)         |nvidia_nim/nvidia/llama-3.1-nemotron-nano-8b-v1"
)

OPENROUTER_MODELS=(
	"Llama 3.3 70B Instruct (free)         |openrouter/meta-llama/llama-3.3-70b-instruct"
	"DeepSeek Chat V3                      |openrouter/deepseek/deepseek-chat-v3-0324"
	"DeepSeek R1 (reasoning)               |openrouter/deepseek/deepseek-r1"
	"Qwen3 235B A22B                       |openrouter/qwen/qwen3-235b-a22b"
	"Gemini 2.0 Flash                      |openrouter/google/gemini-2.0-flash-001"
	"Mistral Small 3.1                     |openrouter/mistralai/mistral-small-3.1-24b-instruct"
)

CLOUDFLARE_MODELS=(
	"Llama 3.3 70B fp8-fast                |cloudflare_workers_ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast"
	"Llama 3.1 8B Instruct                 |cloudflare_workers_ai/@cf/meta/llama-3.1-8b-instruct"
	"Qwen 2.5 Coder 32B                    |cloudflare_workers_ai/@cf/qwen/qwen2.5-coder-32b-instruct"
	"Kimi K2 Instruct (Moonshot AI)        |cloudflare_workers_ai/@cf/moonshotai/kimi-k2-instruct"
)

GOOGLE_AI_MODELS=(
	"Gemini 3.5 Flash (recommended)        |google_ai/gemini-3.5-flash"
	"Gemini 3.1 Flash Lite                 |google_ai/gemini-3.1-flash-lite"
	"Gemini 3 Flash Preview                |google_ai/gemini-3-flash-preview"
	"Gemini 2.5 Pro                        |google_ai/gemini-2.5-pro"
	"Gemini 2.5 Flash                      |google_ai/gemini-2.5-flash"
	"Gemini 2.5 Flash Lite                 |google_ai/gemini-2.5-flash-lite"
	"Gemini 2.0 Flash                      |google_ai/gemini-2.0-flash"
)

# Workers AI uses env.AI binding — shows which CF model handles each Claude tier
WORKERS_AI_LABEL=(
	"claude-sonnet / claude-opus → @cf/meta/llama-3.3-70b-instruct-fp8-fast"
	"claude-haiku                → @cf/qwen/qwen2.5-coder-32b-instruct"
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# NOTE: all user-facing output in pick_* functions goes to stderr so that
# command-substitution captures only the return value on stdout.

proxy_running() {
	if [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null && curl -sf "$PROXY_URL/health" > /dev/null 2>&1; then
		return 0
	fi
	return 1
}

port_listener_pids() {
	if command -v lsof >/dev/null 2>&1; then
		lsof -t -nP -iTCP:"$PROXY_PORT" -sTCP:LISTEN 2>/dev/null || true
	fi
}

port_has_listener() {
	[[ -n "$(port_listener_pids)" ]]
}

health_ok() {
	curl -sf "$PROXY_URL/health" > /dev/null 2>&1
}

cleanup_stale_proxy() {
	# If the health check works, leave the listener alone even if the pidfile is missing.
	if health_ok; then
		return
	fi

	local pids
	pids="$(port_listener_pids)"
	if [[ -z "$pids" ]]; then
		return
	fi

	echo "  found stale listener on $PROXY_URL: $pids"
	echo "  stopping stale listener..."
	while read -r pid; do
		[[ -z "$pid" ]] && continue
		kill "$pid" 2>/dev/null || true
	done <<< "$pids"

	for _ in $(seq 1 20); do
		if ! port_has_listener; then
			return
		fi
		sleep 0.25
	done

	echo "  stale listener did not stop cleanly; forcing it..."
	pids="$(port_listener_pids)"
	while read -r pid; do
		[[ -z "$pid" ]] && continue
		kill -9 "$pid" 2>/dev/null || true
	done <<< "$pids"
}

force_stop_port_listeners() {
	local pids
	pids="$(port_listener_pids)"
	if [[ -z "$pids" ]]; then
		return
	fi

	echo "  stopping listener(s) on port $PROXY_PORT: $pids"
	while read -r pid; do
		[[ -z "$pid" ]] && continue
		kill "$pid" 2>/dev/null || true
	done <<< "$pids"

	for _ in $(seq 1 20); do
		if ! port_has_listener; then
			return
		fi
		sleep 0.25
	done

	pids="$(port_listener_pids)"
	while read -r pid; do
		[[ -z "$pid" ]] && continue
		kill -9 "$pid" 2>/dev/null || true
	done <<< "$pids"
}

current_model() {
	if [[ -f "$MODELFILE" ]]; then cat "$MODELFILE"; else echo "(unknown)"; fi
}

current_backend() {
	if [[ -f "$BACKENDFILE" ]]; then cat "$BACKENDFILE"; else echo "local"; fi
}

# pick_backend — show local/prod choice on stderr, echo "local" or "prod" on stdout
pick_backend() {
	local prod_label
	if [[ -n "$WORKER_URL" ]]; then
		prod_label="Production  — $WORKER_URL"
	else
		prod_label="Production  — deployed Worker (will prompt for URL)"
	fi

	echo "" >&2
	echo "  Select backend:" >&2
	echo "  1)  Local       — wrangler dev ($PROXY_URL)" >&2
	echo "  2)  $prod_label" >&2
	echo "" >&2

	local choice
	while true; do
		read -rp "  Backend [1-2]: " choice < /dev/tty
		case "$choice" in
			1) echo "local"; return ;;
			2) echo "prod";  return ;;
			*) echo "  Please enter 1 or 2." >&2 ;;
		esac
	done
}

user_settings_conflict_with_gateway() {
	local settings="${HOME}/.claude/settings.json"
	[[ -f "$settings" ]] || return 1
	grep -Eq '"CLAUDE_CODE_USE_(VERTEX|BEDROCK|ANTHROPIC_AWS)"[[:space:]]*:[[:space:]]*"?(1|true)"?' "$settings"
}

has_setting_sources_arg() {
	for arg in "$@"; do
		case "$arg" in
			--setting-sources|--setting-sources=*) return 0 ;;
		esac
	done
	return 1
}

# has_arg <flag> [args…] — return 0 if <flag> appears anywhere in [args…]
has_arg() {
	local needle="$1"; shift
	for arg in "$@"; do
		[[ "$arg" == "$needle" || "$arg" == "$needle="* ]] && return 0
	done
	return 1
}

# pick_from_menu <prompt> <item1> <item2> ...
# Displays menu on stderr, echoes chosen value (right of |) on stdout.
pick_from_menu() {
	local prompt="$1"
	shift
	local labels=()
	local values=()

	for item in "$@"; do
		labels+=("${item%%|*}")
		values+=("${item##*|}")
	done

	echo "" >&2
	for i in "${!labels[@]}"; do
		printf "  %2d)  %s\n" "$((i + 1))" "${labels[$i]}" >&2
	done
	echo "" >&2

	local choice
	while true; do
		read -rp "  $prompt [1-${#labels[@]}]: " choice < /dev/tty
		if [[ "$choice" =~ ^[0-9]+$ ]] && (( choice >= 1 && choice <= ${#labels[@]} )); then
			echo "${values[$((choice - 1))]}"   # stdout only — this is the return value
			return
		fi
		echo "  Please enter a number between 1 and ${#labels[@]}." >&2
	done
}

# pick_provider — displays menu on stderr, echoes provider id on stdout
pick_provider() {
	echo "" >&2
	echo "  Select provider:" >&2
	echo "  1)  NVIDIA NIM        (requires NVIDIA_NIM_API_KEY)" >&2
	echo "  2)  OpenRouter        (requires OPENROUTER_API_KEY)" >&2
	echo "  3)  Cloudflare AI     (requires CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID)" >&2
	echo "  4)  Google AI Studio  (requires GOOGLE_AI_API_KEY)" >&2
	echo "  5)  Workers AI        (uses env.AI binding — no external key needed)" >&2
	echo "" >&2

	local choice
	while true; do
		read -rp "  Provider [1-5]: " choice < /dev/tty
		case "$choice" in
			1) echo "nvidia";      return ;;
			2) echo "openrouter";  return ;;
			3) echo "cloudflare";  return ;;
			4) echo "google_ai";   return ;;
			5) echo "workers_ai";  return ;;
			*) echo "  Please enter 1, 2, 3, 4, or 5." >&2 ;;
		esac
	done
}

# pick_model <provider> — display menu on stderr (for interactive), echo MODEL value on stdout
pick_model() {
	local provider="$1"
	case "$provider" in
		nvidia)
			echo "  NVIDIA NIM models:" >&2
			pick_from_menu "Model" "${NVIDIA_MODELS[@]}"
			;;
		openrouter)
			echo "  OpenRouter models:" >&2
			pick_from_menu "Model" "${OPENROUTER_MODELS[@]}"
			;;
		cloudflare)
			echo "  Cloudflare Workers AI models:" >&2
			pick_from_menu "Model" "${CLOUDFLARE_MODELS[@]}"
			;;
		google_ai)
			echo "  Google AI Studio (Gemini) models:" >&2
			pick_from_menu "Model" "${GOOGLE_AI_MODELS[@]}"
			;;
		workers_ai)
			echo "workers_ai"   # no picker needed — uses built-in model map
			;;
		*)
			echo "  Unknown provider: $provider" >&2
			exit 1
			;;
	esac
}

# explain_model <provider> <model_var> — print what actually runs in the backend
explain_model() {
	local provider="$1"
	local model_var="$2"

	echo ""
	case "$provider" in
		workers_ai)
			echo "  Backend: Workers AI (env.AI binding)"
			for line in "${WORKERS_AI_LABEL[@]}"; do
				echo "    $line"
			done
			;;
		nvidia|openrouter|cloudflare|google_ai)
			echo "  Backend: $model_var"
			;;
	esac
	echo ""
	echo "  ╔═══════════════════════════════════════════════════════════════╗"
	echo "  ║  Claude Code UI will still show 'Opus 4.7' / 'Sonnet 4.6'.  ║"
	echo "  ║  That is the model name it REQUESTS — the proxy intercepts   ║"
	echo "  ║  every request and routes it to the backend shown above.     ║"
	echo "  ║  Check wrangler logs to confirm:  tail -f $LOGFILE  ║"
	echo "  ╚═══════════════════════════════════════════════════════════════╝"
	echo ""
}

start_proxy() {
	local model_var="${1:-}"

	if proxy_running; then
		local running_model
		running_model="$(current_model)"
		if [[ -n "$model_var" && "$model_var" != "$running_model" ]]; then
			echo "  switching model: $running_model → $model_var"
			echo "  restarting proxy..."
			stop_proxy
		elif [[ "$model_var" == "$running_model" ]]; then
			echo "  proxy already running with this model (pid $(cat "$PIDFILE"))"
			return
		else
			echo "  proxy already running (pid $(cat "$PIDFILE"), model: $running_model)"
			return
		fi
	fi

	rm -f "$PIDFILE"
	cleanup_stale_proxy

	if port_has_listener && ! health_ok; then
		echo "  port $PROXY_PORT is still occupied but $PROXY_URL/health does not respond"
		echo "  run: lsof -nP -iTCP:$PROXY_PORT -sTCP:LISTEN"
		exit 1
	fi

	echo "  starting wrangler dev server..."

	# Run wrangler in a subshell so the cd doesn't change the caller's working directory.
	# This is important when cproxy is called from another folder — LAUNCH_DIR stays intact.
	if [[ -n "$model_var" && "$model_var" != "workers_ai" ]]; then
		( cd "$SCRIPT_DIR" && npx wrangler dev --ip "$PROXY_HOST" --port "$PROXY_PORT" \
			--var "MODEL:${model_var}" > "$LOGFILE" 2>&1 ) &
	else
		# workers_ai — don't override MODEL; proxy defaults to workers_ai
		( cd "$SCRIPT_DIR" && npx wrangler dev --ip "$PROXY_HOST" --port "$PROXY_PORT" > "$LOGFILE" 2>&1 ) &
	fi
	echo $! > "$PIDFILE"
	echo "${model_var:-workers_ai}" > "$MODELFILE"

	for _ in $(seq 1 30); do
		if curl -sf "$PROXY_URL/health" > /dev/null 2>&1; then
			echo "  proxy ready at $PROXY_URL (pid $(cat "$PIDFILE"))"
			return
		fi
		if ! kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
			echo "  proxy failed to start — check log: $LOGFILE"
			tail -40 "$LOGFILE" || true
			rm -f "$PIDFILE" "$MODELFILE"
			exit 1
		fi
		sleep 0.5
	done
	echo "  proxy did not respond within 15 s — check log: $LOGFILE"
	tail -40 "$LOGFILE" || true
	rm -f "$PIDFILE" "$MODELFILE"
	exit 1
}

stop_proxy() {
	local stopped=false
	if proxy_running; then
		echo "  stopping proxy (pid $(cat "$PIDFILE"))..."
		kill "$(cat "$PIDFILE")" 2>/dev/null
		for _ in $(seq 1 20); do
			if ! port_has_listener; then
				break
			fi
			sleep 0.25
		done
		if port_has_listener; then
			force_stop_port_listeners
		fi
		stopped=true
	else
		if port_has_listener; then
			echo "  proxy pidfile is missing/stale, but port $PROXY_PORT is occupied"
			force_stop_port_listeners
			stopped=true
		else
			echo "  proxy is not running"
		fi
	fi
	rm -f "$PIDFILE" "$MODELFILE"
	if [[ "$stopped" == "true" ]]; then
		echo "  proxy stopped"
	fi
}

# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

MODE="${1:-on}"

case "$MODE" in

on)
	echo "[proxy ON]"

	# ---------------------------------------------------------------------------
	# Arg parsing — support three calling conventions:
	#
	#   cproxy on                              → fully interactive: pick backend, provider, model
	#   cproxy on prod                         → prod Worker, pick nothing
	#   cproxy on local [provider [model]]     → local wrangler dev
	#   cproxy on <provider> [model]           → backward-compat: implies local backend
	#
	# Any remaining positional arguments after the cproxy-specific keywords are
	# collected into CLAUDE_ARGS and forwarded verbatim to `claude`.  This means
	# every claude CLI flag and subcommand works transparently, e.g.:
	#
	#   cproxy on prod --model sonnet --verbose
	#   cproxy on prod -p "summarise this repo" --output-format json
	#   cproxy on local nvidia --permission-mode plan
	#   cproxy on --dangerously-skip-permissions   (interactive backend pick)
	#
	# Rule: stop consuming positional args the moment we see a token that starts
	# with '-' — that is the boundary between cproxy args and claude args.
	# ---------------------------------------------------------------------------

	ARG2="${2:-}"
	BACKEND=""
	PROVIDER=""
	MODEL_VAR=""
	CLAUDE_ARG_START=2   # default: everything from $2 onward goes to claude

	case "$ARG2" in
		local)
			BACKEND="local"
			CLAUDE_ARG_START=3
			ARG3="${3:-}"
			# Only treat ARG3 as a provider if it is a known keyword, not a flag
			if [[ -n "$ARG3" && "$ARG3" != -* ]]; then
				PROVIDER="$ARG3"
				CLAUDE_ARG_START=4
				ARG4="${4:-}"
				# Only treat ARG4 as a model if it is not a flag
				if [[ -n "$ARG4" && "$ARG4" != -* ]]; then
					MODEL_VAR="$ARG4"
					CLAUDE_ARG_START=5
				fi
			fi
			;;
		prod)
			BACKEND="prod"
			CLAUDE_ARG_START=3
			;;
		nvidia|openrouter|cloudflare|google_ai|workers_ai)
			# Backward-compat: treat as local + provider shortcut
			BACKEND="local"
			PROVIDER="$ARG2"
			CLAUDE_ARG_START=3
			ARG3="${3:-}"
			if [[ -n "$ARG3" && "$ARG3" != -* ]]; then
				MODEL_VAR="$ARG3"
				CLAUDE_ARG_START=4
			fi
			;;
		""|--*|-*)
			# Empty  → fully interactive; no positional arg consumed.
			# Flag   → claude arg starts immediately at $2; interactive backend pick.
			;;
		*)
			echo "  Unknown option: $ARG2"; exit 1
			;;
	esac

	# Capture everything the above did NOT consume as claude passthrough args.
	# This includes all flags (-p, --model, --verbose, subcommands, initial prompts…)
	CLAUDE_ARGS=("${@:$CLAUDE_ARG_START}")

	# ── Discord access.json pre-configuration ─────────────────────────────────
	# Scan CLAUDE_ARGS for --discord-channel, --discord-users, --discord-dms.
	# These are cproxy-specific flags consumed here and NOT forwarded to claude.
	# When any are provided, ~/.claude/channels/discord/access.json is updated
	# before launch. When none are provided the existing file is untouched.
	#
	# Usage examples:
	#   cproxy on prod --channels plugin:discord@claude-plugins-official \
	#       --discord-channel 1234567890 \
	#       --discord-users 111222333,444555666 \
	#       --discord-dms allowlist
	DISCORD_CHANNEL_IDS=""   # comma-separated Discord channel IDs to allow
	DISCORD_USER_IDS=""      # comma-separated Discord user ID snowflakes
	DISCORD_DM_POLICY=""     # open | pairing | allowlist
	CPROXY_MODEL=""          # model specified via --model flag (backend-agnostic)
	# PROVIDER may already be set from the positional-arg shortcuts above;
	# --provider flag below can also set it (overrides positional).

	# Scan CLAUDE_ARGS and consume all cproxy-owned flags in one pass.
	# --model is extracted here for both backends:
	#   local → used as wrangler MODEL var (not forwarded to claude)
	#   prod  → re-injected as --model <id> into CLAUDE_ARGS after this block
	#           so it reaches claude AND the has_arg check skips the picker.
	_CPROXY_FILTERED=()
	_idx=0
	while [[ $_idx -lt ${#CLAUDE_ARGS[@]} ]]; do
		_carg="${CLAUDE_ARGS[$_idx]}"
		case "$_carg" in
			--provider=*)        PROVIDER="${_carg#*=}" ;;
			--provider)          _idx=$((_idx+1)); PROVIDER="${CLAUDE_ARGS[$_idx]}" ;;
			--model=*)           CPROXY_MODEL="${_carg#*=}" ;;
			--model)             _idx=$((_idx+1)); CPROXY_MODEL="${CLAUDE_ARGS[$_idx]}" ;;
			--discord-channel=*) DISCORD_CHANNEL_IDS="${_carg#*=}" ;;
			--discord-channel)   _idx=$((_idx+1)); DISCORD_CHANNEL_IDS="${CLAUDE_ARGS[$_idx]}" ;;
			--discord-users=*)   DISCORD_USER_IDS="${_carg#*=}" ;;
			--discord-users)     _idx=$((_idx+1)); DISCORD_USER_IDS="${CLAUDE_ARGS[$_idx]}" ;;
			--discord-dms=*)     DISCORD_DM_POLICY="${_carg#*=}" ;;
			--discord-dms)       _idx=$((_idx+1)); DISCORD_DM_POLICY="${CLAUDE_ARGS[$_idx]}" ;;
			'\'|'\ ')            : ;;  # drop stray backslash (e.g. "\ --model" on same line)
			*)                   _CPROXY_FILTERED+=("$_carg") ;;
		esac
		_idx=$((_idx+1))
	done
	CLAUDE_ARGS=("${_CPROXY_FILTERED[@]+"${_CPROXY_FILTERED[@]}"}")

	# ── Discord plugin sync ───────────────────────────────────────────────────────
	# docker/discord-plugin/server.ts is the single source of truth.
	# When the Discord plugin is in use, push it to the local Claude plugin cache
	# before launch so the running plugin matches what would be in a Docker image.
	#
	# Trigger detection (either is sufficient):
	#   1. Legacy: --channels plugin:discord@... in CLAUDE_ARGS
	#   2. Modern: DISCORD_STATE_DIR env var set (ops-bot launch path; --channels removed
	#              because Anthropic gates the hosted plugin behind subscriptions)
	#   3. --discord-channel arg present (always implies a Discord session)
	_discord_in_args=false
	[[ -n "${DISCORD_STATE_DIR:-}" ]] && _discord_in_args=true
	[[ -n "${DISCORD_CHANNEL_IDS:-}" ]] && _discord_in_args=true
	if [[ "$_discord_in_args" == false ]]; then
		for _a in "${CLAUDE_ARGS[@]+"${CLAUDE_ARGS[@]}"}"; do
			[[ "$_a" == *"plugin:discord"* ]] && _discord_in_args=true && break
		done
	fi
	if [[ "$_discord_in_args" == true ]]; then
		"$SCRIPT_DIR/scripts/sync-discord-plugin.sh" 2>/dev/null || true

		# ── Ensure the resolved Discord state dir has a .env with DISCORD_BOT_TOKEN ──
		# docker/discord-plugin/server.ts reads <DISCORD_STATE_DIR>/.env (default
		# ~/.claude/channels/discord/.env) for DISCORD_BOT_TOKEN. Per-channel state
		# dirs created by --discord-channel (DISCORD_STATE_DIR=~/.claude/discord-sessions/<id>)
		# start out empty, so the plugin's TOKEN check fails and it calls
		# process.exit(1) before DEBUG_LOG/dbg() are even initialized — i.e. it
		# crashes silently on startup with nothing visible in the Claude Code TUI,
		# and the channel never relays messages.
		_discord_state_dir="${DISCORD_STATE_DIR:-${HOME}/.claude/channels/discord}"
		_discord_state_dir="${_discord_state_dir/#\~/$HOME}"
		_discord_env_file="$_discord_state_dir/.env"
		if [[ ! -s "$_discord_env_file" ]] && [[ -f "$SCRIPT_DIR/.dev.vars" ]]; then
			_bot_token=$(grep -E '^DISCORD_BOT_TOKEN=' "$SCRIPT_DIR/.dev.vars" | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'" || true)
			if [[ -n "$_bot_token" ]]; then
				mkdir -p "$_discord_state_dir"
				echo "DISCORD_BOT_TOKEN=$_bot_token" > "$_discord_env_file"
				chmod 600 "$_discord_env_file"
				echo "  Discord bot token written to $_discord_env_file"
			fi
		fi
	fi

	if [[ -n "$DISCORD_CHANNEL_IDS" || -n "$DISCORD_USER_IDS" || -n "$DISCORD_DM_POLICY" ]]; then
		# Validate: --discord-channel must be a single ID (no commas)
		if [[ "$DISCORD_CHANNEL_IDS" == *,* ]]; then
			echo "  ERROR: --discord-channel takes a single channel ID, not a list." >&2
			echo "         Each Claude Code instance is tied to exactly one channel." >&2
			exit 1
		fi
		# Validate DM policy value if provided
		if [[ -n "$DISCORD_DM_POLICY" ]]; then
			case "$DISCORD_DM_POLICY" in
				open|pairing|allowlist) ;;
				*) echo "  ERROR: --discord-dms must be one of: open, pairing, allowlist" >&2; exit 1 ;;
			esac
		fi

		# Respect DISCORD_STATE_DIR when set (multi-session router mode).
		# Each channel gets its own state dir so sessions don't share access.json.
		# Falls back to the default single-session path when not set.
		DISCORD_ACCESS_FILE="${DISCORD_STATE_DIR:-${HOME}/.claude/channels/discord}/access.json"
		mkdir -p "$(dirname "$DISCORD_ACCESS_FILE")"

		# Use env vars to pass values safely to Python (avoids quoting/escaping issues)
		DISCORD_CHANNEL_IDS="$DISCORD_CHANNEL_IDS" \
		DISCORD_USER_IDS="$DISCORD_USER_IDS" \
		DISCORD_DM_POLICY="$DISCORD_DM_POLICY" \
		DISCORD_ACCESS_FILE="$DISCORD_ACCESS_FILE" \
		python3 - << 'PYEOF'
import json, os, sys

access_file = os.environ["DISCORD_ACCESS_FILE"]
channel_ids_raw = os.environ.get("DISCORD_CHANNEL_IDS", "")
user_ids_raw    = os.environ.get("DISCORD_USER_IDS", "")
dm_policy       = os.environ.get("DISCORD_DM_POLICY", "")

# Parse comma-separated IDs, strip whitespace, drop empties
channel_ids = [c.strip() for c in channel_ids_raw.split(",") if c.strip()] if channel_ids_raw else None
user_ids    = [u.strip() for u in user_ids_raw.split(",")    if u.strip()] if user_ids_raw    else None

# Load existing config or start fresh
if os.path.exists(access_file):
    with open(access_file) as f:
        cfg = json.load(f)
else:
    cfg = {"dmPolicy": "pairing", "allowFrom": [], "groups": {}, "pending": {}}

# Apply overrides — only touch the fields the user asked to change
if dm_policy:
    cfg["dmPolicy"] = dm_policy

if user_ids is not None:
    cfg["allowFrom"] = user_ids  # global allowlist (applies to DMs)

if channel_ids is not None:
    # Replace groups entirely with the specified channel IDs.
    # Users (if provided) are also set per-channel so channel messages are allowed.
    new_groups = {}
    for cid in channel_ids:
        existing = cfg.get("groups", {}).get(cid, {})
        new_groups[cid] = {
            "requireMention": existing.get("requireMention", False),
            "allowFrom": user_ids if user_ids is not None else existing.get("allowFrom", [])
        }
    cfg["groups"] = new_groups
elif user_ids is not None:
    # No new channels specified — update user list in all existing channel groups
    for cid in cfg.get("groups", {}):
        cfg["groups"][cid]["allowFrom"] = user_ids

with open(access_file, "w") as f:
    json.dump(cfg, f, indent=2)
PYEOF

		echo "  Discord access.json updated:"
		[[ -n "$DISCORD_CHANNEL_IDS" ]] && echo "    channels: $DISCORD_CHANNEL_IDS"
		[[ -n "$DISCORD_USER_IDS"    ]] && echo "    users:    $DISCORD_USER_IDS"
		[[ -n "$DISCORD_DM_POLICY"   ]] && echo "    dms:      $DISCORD_DM_POLICY"
		echo ""
	fi

	# Pick backend interactively if not specified
	if [[ -z "$BACKEND" ]]; then
		BACKEND="$(pick_backend)"
	fi

	# ------------------------------------------------------------------
	# PROD mode — point directly at deployed Worker, skip wrangler
	# ------------------------------------------------------------------
	if [[ "$BACKEND" == "prod" ]]; then
		# Resolve prod URL
		ACTIVE_URL="$WORKER_URL"
		if [[ -z "$ACTIVE_URL" ]]; then
			echo "" >&2
			echo "  WORKER_URL is not set in .dev.vars." >&2
			echo "  Add it once: echo 'WORKER_URL=https://claude-proxy.YOUR-ACCOUNT.workers.dev' >> $SCRIPT_DIR/.dev.vars" >&2
			echo "" >&2
			read -rp "  Or enter your Worker URL now: " ACTIVE_URL < /dev/tty
			ACTIVE_URL="${ACTIVE_URL// /}"   # strip spaces
		fi
		if [[ -z "$ACTIVE_URL" ]]; then
			echo "  No Worker URL provided — aborting." >&2
			exit 1
		fi
		ACTIVE_URL="${ACTIVE_URL%/}"   # strip trailing slash

		# Verify the prod worker is reachable
		if ! curl -sf "$ACTIVE_URL/health" > /dev/null 2>&1; then
			echo ""
			echo "  ⚠  Could not reach $ACTIVE_URL/health"
			echo "     Is the worker deployed? Run: npm run deploy"
			echo ""
			read -rp "  Continue anyway? [y/N] " yn < /dev/tty
			[[ "${yn,,}" == "y" ]] || exit 1
		fi

		# Read proxy token — prod workers may use PROXY_TOKEN secret
		TOKEN=""
		if [[ -f "$SCRIPT_DIR/.dev.vars" ]]; then
			TOKEN=$(grep -E '^PROXY_TOKEN=' "$SCRIPT_DIR/.dev.vars" | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'" || true)
		fi
		AUTH="${TOKEN:-dev-token}"

		# ------------------------------------------------------------------
		# Prod provider → model picker.
		# Fetches /v1/models from the Worker (which only returns models whose
		# required API key is actually configured), then shows:
		#   Step 1 — pick a provider
		#   Step 2 — pick a model within that provider
		# Skip both steps if --model was specified (via flag or CLAUDE_ARGS).
		# ------------------------------------------------------------------

		# Re-inject CPROXY_MODEL into CLAUDE_ARGS so it reaches claude and
		# the has_arg check below skips the interactive picker.
		if [[ -n "$CPROXY_MODEL" ]]; then
			CLAUDE_ARGS=("--model" "$CPROXY_MODEL" "${CLAUDE_ARGS[@]+"${CLAUDE_ARGS[@]}"}")
		fi

		PROD_MODEL=""
		PROD_PROVIDER=""
		if has_arg "--model" "${CLAUDE_ARGS[@]+"${CLAUDE_ARGS[@]}"}"; then
			PROD_MODEL="(from --model flag)"
			PROD_PROVIDER="(from --model flag)"
		else
			MODELS_JSON=$(curl -sf -H "Authorization: Bearer $AUTH" "$ACTIVE_URL/v1/models" 2>/dev/null || echo "")

			if [[ -n "$MODELS_JSON" ]]; then
				# ── Step 1: build provider list ──────────────────────────────
				# python3 emits "provider_label|owned_by" once per unique provider,
				# in the order they first appear in the catalog.
				PROVIDER_LINES=$(python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
seen = []
for m in data.get('data', []):
    key = m.get('owned_by', '')
    if key and key not in seen:
        seen.append(key)
        label = m.get('provider_label', key)
        print(f'{label}|{key}')
" <<< "$MODELS_JSON" 2>/dev/null || echo "")

				if [[ -z "$PROVIDER_LINES" ]]; then
					echo "  ⚠  Could not parse provider list — Claude will use its default model." >&2
					PROD_MODEL="(Worker default)"
				else
					PROVIDER_ITEMS=()
					while IFS= read -r line; do
						[[ -n "$line" ]] && PROVIDER_ITEMS+=("$line")
					done <<< "$PROVIDER_LINES"

					echo "  Select provider:" >&2
					PROD_PROVIDER="$(pick_from_menu "Provider" "${PROVIDER_ITEMS[@]}")"

					# ── Step 2: models for the chosen provider ────────────────
					MODEL_LINES=$(python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
for m in data.get('data', []):
    if m.get('owned_by') == '$PROD_PROVIDER':
        label = m.get('display_name', m['id'])
        print(f'{label}|{m[\"id\"]}')
" <<< "$MODELS_JSON" 2>/dev/null || echo "")

					if [[ -z "$MODEL_LINES" ]]; then
						echo "  ⚠  No models found for provider '$PROD_PROVIDER'." >&2
						PROD_MODEL="(Worker default)"
					else
						MODEL_ITEMS=()
						while IFS= read -r line; do
							[[ -n "$line" ]] && MODEL_ITEMS+=("$line")
						done <<< "$MODEL_LINES"

						echo "  Select model:" >&2
						PROD_MODEL="$(pick_from_menu "Model" "${MODEL_ITEMS[@]}")"

						# Prepend --model so Claude Code sends exactly this ID to the Worker,
						# which routes it via the provider prefix (e.g. "google_ai/gemini-2.5-flash")
						CLAUDE_ARGS=("--model" "$PROD_MODEL" "${CLAUDE_ARGS[@]+"${CLAUDE_ARGS[@]}"}")
					fi
				fi
			else
				echo "  ⚠  Could not reach $ACTIVE_URL/v1/models — Claude will use its default model." >&2
				PROD_MODEL="(Worker default)"
				PROD_PROVIDER="(unknown)"
			fi
		fi

		echo ""
		echo "  ╔═════════════════════════════════════════════════════════════════╗"
		echo "  ║  Backend: PRODUCTION                                           ║"
		printf "  ║  URL:     %-51s║\n" "$ACTIVE_URL"
		printf "  ║  Provider:%-51s║\n" "$PROD_PROVIDER"
		printf "  ║  Model:   %-51s║\n" "$PROD_MODEL"
		echo "  ╚═════════════════════════════════════════════════════════════════╝"
		echo ""
		echo "  Opening Claude Code in: $LAUNCH_DIR"
		echo ""

		echo "prod" > "$BACKENDFILE"
		echo "prod:${PROD_PROVIDER}:${PROD_MODEL}" > "$MODELFILE"

		cd "$LAUNCH_DIR"
		if user_settings_conflict_with_gateway && ! has_setting_sources_arg "${CLAUDE_ARGS[@]+"${CLAUDE_ARGS[@]}"}"; then
			echo "  Detected global Claude Code Vertex/Bedrock settings; ignoring for this session."
			echo ""
			CLAUDE_ARGS=(--setting-sources project,local "${CLAUDE_ARGS[@]+"${CLAUDE_ARGS[@]}"}")
		fi

		# -u ANTHROPIC_API_KEY: a key may be set in the environment (e.g. so the
		# bootstrap `claude --print` step can skip the login prompt), but the
		# running session must authenticate to the Worker via ANTHROPIC_AUTH_TOKEN
		# (Authorization: Bearer <PROXY_TOKEN>). Having both set triggers Claude
		# Code's "both ANTHROPIC_AUTH_TOKEN and ANTHROPIC_API_KEY set" warning and
		# can make it ignore the gateway token, so unset the API key for this run.
		env \
			-u CLAUDE_CODE_USE_VERTEX \
			-u ANTHROPIC_VERTEX_PROJECT_ID \
			-u ANTHROPIC_VERTEX_BASE_URL \
			-u CLOUD_ML_REGION \
			-u CLAUDE_CODE_USE_BEDROCK \
			-u ANTHROPIC_BEDROCK_BASE_URL \
			-u CLAUDE_CODE_USE_ANTHROPIC_AWS \
			-u ANTHROPIC_AWS_BASE_URL \
			-u ANTHROPIC_API_KEY \
			ANTHROPIC_BASE_URL="$ACTIVE_URL" \
			ANTHROPIC_AUTH_TOKEN="$AUTH" \
			CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY="1" \
			claude "${CLAUDE_ARGS[@]+"${CLAUDE_ARGS[@]}"}"
		exit $?
	fi

	# ------------------------------------------------------------------
	# LOCAL mode — start wrangler dev, pick provider + model
	# ------------------------------------------------------------------

	# For local mode, CPROXY_MODEL (from --model flag) sets the wrangler MODEL
	# var. It was already consumed from CLAUDE_ARGS in the shared step above,
	# so it is NOT forwarded to claude (correct: local routing is via wrangler var).
	if [[ -n "$CPROXY_MODEL" && -z "$MODEL_VAR" ]]; then
		MODEL_VAR="$CPROXY_MODEL"
	fi

	# Determine provider (arg or interactive)
	if [[ -z "$PROVIDER" ]]; then
		PROVIDER="$(pick_provider)"
	fi

	# Determine model (arg or interactive pick)
	if [[ -z "$MODEL_VAR" ]]; then
		MODEL_VAR="$(pick_model "$PROVIDER")"
	fi

	# Warn if required API key is missing from .dev.vars
	if [[ "$PROVIDER" == "google_ai" ]]; then
		if ! grep -qE '^GOOGLE_AI_API_KEY=' "$SCRIPT_DIR/.dev.vars" 2>/dev/null; then
			echo ""
			echo "  ⚠  GOOGLE_AI_API_KEY not found in .dev.vars"
			echo "     Add it before starting: echo 'GOOGLE_AI_API_KEY=AIza...' >> $SCRIPT_DIR/.dev.vars"
			echo ""
		fi
	fi

	echo ""
	start_proxy "$MODEL_VAR"
	echo "local" > "$BACKENDFILE"

	# Read optional proxy token from .dev.vars
	TOKEN=""
	if [[ -f "$SCRIPT_DIR/.dev.vars" ]]; then
		TOKEN=$(grep -E '^PROXY_TOKEN=' "$SCRIPT_DIR/.dev.vars" | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'" || true)
	fi
	AUTH="${TOKEN:-dev-token}"

	explain_model "$PROVIDER" "$MODEL_VAR"
	echo "  Opening Claude Code in: $LAUNCH_DIR"
	echo "  Tip: open another terminal and run  cproxy log  to watch live requests"
	echo ""

	cd "$LAUNCH_DIR"
	if user_settings_conflict_with_gateway && ! has_setting_sources_arg "${CLAUDE_ARGS[@]+"${CLAUDE_ARGS[@]}"}"; then
		echo "  Detected global Claude Code Vertex/Bedrock settings; ignoring user settings for this proxy session."
		echo "  This prevents Claude Code from bypassing $PROXY_URL and retrying against Vertex/Bedrock."
		echo ""
		CLAUDE_ARGS=(--setting-sources project,local "${CLAUDE_ARGS[@]+"${CLAUDE_ARGS[@]}"}")
	fi

	# -u ANTHROPIC_API_KEY: avoid the "both ANTHROPIC_AUTH_TOKEN and
	# ANTHROPIC_API_KEY set" warning/ambiguity — the local proxy session
	# authenticates via ANTHROPIC_AUTH_TOKEN (Authorization: Bearer <token>).
	env \
		-u CLAUDE_CODE_USE_VERTEX \
		-u ANTHROPIC_VERTEX_PROJECT_ID \
		-u ANTHROPIC_VERTEX_BASE_URL \
		-u CLOUD_ML_REGION \
		-u CLAUDE_CODE_USE_BEDROCK \
		-u ANTHROPIC_BEDROCK_BASE_URL \
		-u CLAUDE_CODE_USE_ANTHROPIC_AWS \
		-u ANTHROPIC_AWS_BASE_URL \
		-u ANTHROPIC_API_KEY \
		ANTHROPIC_BASE_URL="$PROXY_URL" \
		ANTHROPIC_AUTH_TOKEN="$AUTH" \
		CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY="1" \
		claude "${CLAUDE_ARGS[@]+"${CLAUDE_ARGS[@]}"}"
	;;

off)
	echo "[proxy OFF — using real Anthropic API]"
	if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
		echo "  warning: ANTHROPIC_API_KEY is not set"
	fi
	echo "  Opening Claude Code in: $LAUNCH_DIR"
	cd "$LAUNCH_DIR"
	env -u ANTHROPIC_BASE_URL \
	    -u ANTHROPIC_AUTH_TOKEN \
	    -u CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY \
	    claude "${@:2}"
	;;

stop)
	echo "[stopping proxy]"
	stop_proxy
	;;

log)
	if [[ "$(current_backend)" == "prod" ]]; then
		echo "[running against PRODUCTION — local log not available]"
		echo "[check Cloudflare dashboard: https://dash.cloudflare.com → Workers → claude-proxy → Logs]"
		exit 0
	fi
	if ! proxy_running; then
		echo "[proxy is not running — waiting for it to start...]"
		echo "[start it with: $0 on local]"
		echo ""
	else
		echo "[live request log — proxy running on $PROXY_URL, model: $(current_model)]"
		echo "[Ctrl-C to stop watching]"
		echo ""
	fi

	# Columns header
	printf "  %s  %s  %-6s  %-22s  %-40s  %s\n" \
		"st" "~" "method" "path" "backend" "dur"
	printf "  %s\n" "──────────────────────────────────────────────────────────────────────────────────────────────"

	if command -v python3 &>/dev/null && [[ -f "$SCRIPT_DIR/scripts/log-format.py" ]]; then
		# tail -F waits for file to appear and follows across restarts
		tail -F "$LOGFILE" 2>/dev/null | python3 "$SCRIPT_DIR/scripts/log-format.py"
	else
		# Fallback: raw log
		echo "  (python3 or scripts/log-format.py not found — showing raw log)"
		tail -F "$LOGFILE" 2>/dev/null
	fi
	;;

status)
	BACKEND="$(current_backend)"
	if [[ "$BACKEND" == "prod" ]]; then
		STORED_MODEL="$(current_model)"
		ACTIVE_URL="${STORED_MODEL#prod:}"
		echo "[proxy → PRODUCTION]"
		echo "  url:     $ACTIVE_URL"
		echo "  routing: follows deployed MODEL secret"
		if curl -sf "$ACTIVE_URL/health" > /dev/null 2>&1; then
			echo "  health:  ✅ reachable"
		else
			echo "  health:  ❌ not reachable"
		fi
	elif proxy_running; then
		echo "[proxy → LOCAL RUNNING]"
		echo "  pid:    $(cat "$PIDFILE")"
		echo "  url:    $PROXY_URL"
		echo "  model:  $(current_model)"
		echo "  log:    $LOGFILE"
		echo ""
		echo "  Recent requests:"
		if command -v python3 &>/dev/null && [[ -f "$SCRIPT_DIR/scripts/log-format.py" ]]; then
			tail -20 "$LOGFILE" 2>/dev/null | python3 "$SCRIPT_DIR/scripts/log-format.py" | tail -8
		else
			tail -8 "$LOGFILE" 2>/dev/null | sed 's/^/    /' || true
		fi
	elif port_has_listener; then
		echo "[proxy BROKEN]"
		echo "  port:   $PROXY_PORT is occupied"
		echo "  health: $PROXY_URL/health is not responding"
		echo "  pids:   $(port_listener_pids | tr '\n' ' ')"
		echo "  fix:    cproxy stop"
	else
		echo "[proxy STOPPED]"
	fi
	;;

setup-discord-mcp)
	# ── Register the local Discord MCP server in ~/.claude/settings.json ──────
	# Anthropic gates --channels plugin:discord@claude-plugins-official behind
	# subscriptions (Claude Code v2.1.186+). This command configures the local
	# server.ts as an mcpServers entry so it starts automatically instead.
	#
	# Run once on each machine (Mac Studio, GCE, etc.) after cloning the repo.
	SETTINGS_FILE="$HOME/.claude/settings.json"
	PLUGIN_SERVER="$SCRIPT_DIR/docker/discord-plugin/server.ts"

	if [[ ! -f "$PLUGIN_SERVER" ]]; then
		echo "ERROR: discord-plugin server not found at $PLUGIN_SERVER" >&2
		exit 1
	fi

	# Ensure bun is installed (the plugin runs on Bun)
	if ! command -v bun &>/dev/null; then
		echo "ERROR: 'bun' is required to run the discord-plugin server." >&2
		echo "       Install it: curl -fsSL https://bun.sh/install | bash" >&2
		exit 1
	fi

	BUN_PATH="$(command -v bun)"

	echo "Configuring Discord MCP server in $SETTINGS_FILE"
	echo "  server : $PLUGIN_SERVER"
	echo "  runtime: $BUN_PATH"
	echo ""

	python3 - "$SETTINGS_FILE" "$BUN_PATH" "$PLUGIN_SERVER" << 'PYEOF'
import json, os, sys

settings_file, bun_path, server_path = sys.argv[1], sys.argv[2], sys.argv[3]

# Load or create settings
if os.path.exists(settings_file):
    with open(settings_file) as f:
        settings = json.load(f)
else:
    os.makedirs(os.path.dirname(settings_file), exist_ok=True)
    settings = {}

# Add/overwrite the discord MCP server entry
mcp_servers = settings.setdefault("mcpServers", {})
mcp_servers["discord"] = {
    "command": bun_path,
    "args": ["run", server_path],
}

with open(settings_file, "w") as f:
    json.dump(settings, f, indent=2)
    f.write("\n")

print("  ✓ mcpServers.discord added to", settings_file)
print("")
print("  The discord MCP server will now start automatically with every Claude session.")
print("  DISCORD_STATE_DIR (set by the ops-bot launch command) controls which")
print("  channel's state directory is used for each session.")
PYEOF
	;;

*)
	cat >&2 << 'EOF'
Usage: ./claude-proxy.sh [command] [backend] [provider]

Commands:
  on [backend] [provider]   Start proxy + launch claude (shows menus if args omitted)
  off                       Launch claude with real Anthropic API (uses ANTHROPIC_API_KEY)
  stop                      Stop the background local proxy
  log                       Stream live formatted request logs (run in a second terminal)
  status                    Show proxy status, active backend, model, and recent requests
  setup-discord-mcp         Register the local Discord MCP server in ~/.claude/settings.json

Backends (for "on"):
  local           Run wrangler dev locally (http://localhost:8787)
  prod            Connect to deployed Worker URL (set WORKER_URL in .dev.vars)

Providers (for "on local"):
  nvidia          NVIDIA NIM              — requires NVIDIA_NIM_API_KEY
  openrouter      OpenRouter              — requires OPENROUTER_API_KEY
  cloudflare      Cloudflare Workers AI   — requires CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID
  google_ai       Google AI Studio/Gemini — requires GOOGLE_AI_API_KEY
  workers_ai      Workers AI binding      — no external key needed (default)

cproxy flags (consumed here, not forwarded to claude):
  --provider <name>                 Skip provider picker: nvidia | openrouter | cloudflare | google_ai | workers_ai
  --model <model-id>                Skip model picker (local: sets wrangler var; prod: pass --model to claude instead)
  --discord-channel <id1,id2,...>   Replace allowed Discord channel IDs in access.json
  --discord-users <id1,id2,...>     Set allowed Discord user IDs (applies globally + per-channel)
  --discord-dms <policy>            Set DM policy: open | pairing | allowlist
  (omit any discord flag to leave that field in access.json unchanged)

Examples:
  ./claude-proxy.sh on                        # interactive menu: pick backend + provider
  ./claude-proxy.sh on prod                   # use deployed Worker (WORKER_URL from .dev.vars)
  ./claude-proxy.sh on local                  # local wrangler dev, then pick provider
  ./claude-proxy.sh on local nvidia           # local, pick NVIDIA model interactively
  ./claude-proxy.sh on local openrouter       # local, pick OpenRouter model interactively
  ./claude-proxy.sh on local google_ai        # local, pick Google AI (Gemini) model
  ./claude-proxy.sh on local workers_ai       # local, Workers AI binding
  ./claude-proxy.sh on nvidia                 # (compat) same as: on local nvidia
  ./claude-proxy.sh on openrouter             # (compat) same as: on local openrouter
  ./claude-proxy.sh log                       # watch live local requests in second terminal
  ./claude-proxy.sh status                    # show what's running + recent requests

  # Skip provider/model pickers (local):
  ./claude-proxy.sh on local --provider google_ai --model google_ai/gemini-2.5-flash
  ./claude-proxy.sh on local --provider openrouter --model openrouter/deepseek/deepseek-chat-v3-0324

  # Skip model picker (prod — --model passed through to claude):
  ./claude-proxy.sh on prod --model google_ai/gemini-2.5-flash

  # Discord plugin — register local MCP server once per machine, then launch:
  ./claude-proxy.sh setup-discord-mcp         # one-time setup on each machine
  ./claude-proxy.sh on prod \
      --discord-channel 1234567890123456789 \
      --discord-users 111222333444,555666777888 \
      --discord-dms allowlist
  ./claude-proxy.sh stop                      # stop the local proxy

Prod setup (one-time):
  echo 'WORKER_URL=https://claude-proxy.YOUR-ACCOUNT.workers.dev' >> .dev.vars
EOF
	exit 1
	;;
esac
