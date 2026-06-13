#!/usr/bin/env bash
# upload-secrets.sh — Upload sensitive values from .dev.vars to Cloudflare Workers secrets.
#
# Reads .dev.vars, skips keys that are already plain vars in wrangler.jsonc
# (non-sensitive: public keys, IDs, feature flags), and uploads everything
# else via `wrangler secret bulk`.
#
# Usage:
#   ./scripts/upload-secrets.sh            # dry-run: show what would be uploaded
#   ./scripts/upload-secrets.sh --apply    # actually upload to Cloudflare

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEV_VARS="$REPO_ROOT/.dev.vars"

[[ -f "$DEV_VARS" ]] || { echo "ERROR: .dev.vars not found at $REPO_ROOT/.dev.vars" >&2; exit 1; }

# ── Keys to SKIP ──────────────────────────────────────────────────────────────
# These are already in wrangler.jsonc vars (plain, non-sensitive),
# or are runtime-only flags used by claude-proxy.sh locally (not Worker vars).
SKIP_KEYS=(
  # Already in wrangler.jsonc vars
  DEFAULT_MODEL
  DISCORD_PUBLIC_KEY
  DISCORD_APPLICATION_ID
  DISCORD_ALLOWED_GUILD_IDS
  DISCORD_ADMIN_ROLE_IDS
  DISCORD_STORE_MESSAGES
  DISCORD_ENABLE_ADMIN_COMMANDS
  OPS_BOT_PUBLIC_KEY         # public key — just added to wrangler.jsonc vars

  # Runtime flags used only by claude-proxy.sh on the local machine
  DISCORD_CHANNEL_IDS
  DISCORD_USER_IDS
  DISCORD_DM_POLICY
  DISCORD_REQUIRE_MENTION
  MODEL
  CLAUDE_MODEL
)

# Build a Python set literal for the skip list
SKIP_SET=$(printf '"%s",' "${SKIP_KEYS[@]}")
SKIP_SET="{${SKIP_SET%,}}"

# ── Convert .dev.vars → JSON secrets object ───────────────────────────────────
SECRETS_JSON=$(python3 - "$DEV_VARS" "$SKIP_SET" <<'PYEOF'
import json, sys

dev_vars_path = sys.argv[1]
skip_keys = set(eval(sys.argv[2]))  # safe: we control the string above

secrets = {}
with open(dev_vars_path) as f:
    for line in f:
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, _, value = line.partition('=')
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and value and key not in skip_keys:
            secrets[key] = value

print(json.dumps(secrets, indent=2))
PYEOF
)

# ── Dry-run output ────────────────────────────────────────────────────────────
echo ""
echo "Keys that will be uploaded as Cloudflare secrets:"
echo "$SECRETS_JSON" | python3 -c "
import json, sys
d = json.load(sys.stdin)
for k, v in sorted(d.items()):
    masked = v[:4] + '*' * min(8, len(v)-4) if len(v) > 4 else '****'
    print(f'  {k:<35} {masked}')
print(f'\n  Total: {len(d)} secret(s)')
"
echo ""

# ── Apply ─────────────────────────────────────────────────────────────────────
if [[ "${1:-}" != "--apply" ]]; then
  echo "  → Dry run. Pass --apply to upload."
  echo "  → Example: ./scripts/upload-secrets.sh --apply"
  echo ""
  exit 0
fi

# Write to a temp file (wrangler secret bulk requires a file path)
TMPFILE=$(mktemp /tmp/cloudflare-secrets-XXXXXX.json)
trap 'rm -f "$TMPFILE"' EXIT

echo "$SECRETS_JSON" > "$TMPFILE"

echo "Uploading secrets to Cloudflare..."
cd "$REPO_ROOT"
npx wrangler secret bulk "$TMPFILE"
echo ""
echo "✅  Done. Verify in: https://dash.cloudflare.com → Workers → claude-proxy → Settings → Variables"
echo ""
