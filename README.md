# claude-code-cf-proxy

A minimal Anthropic Messages API–compatible proxy hosted on Cloudflare Workers that routes requests to [Cloudflare Workers AI](https://developers.cloudflare.com/workers-ai/) models. Point Claude Code at this Worker to use Workers AI models as a drop-in replacement for the Anthropic API.

## Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) (installed via `npm install`)
- A Cloudflare account with Workers AI access

## Setup

```bash
npm install
npx wrangler login
```

The proxy uses a Workers AI binding, so local `wrangler dev` still needs Cloudflare authentication. If Wrangler is not logged in, the launcher exits before starting Claude Code instead of leaving Claude pointed at an unavailable local endpoint.

## Local development

```bash
# Copy the example env file and edit as needed
cp .dev.vars.example .dev.vars

# Start the dev server (calls real Workers AI via Cloudflare)
npm run dev
```

The dev server listens on `http://localhost:8787`.

## Deploy to Cloudflare

```bash
npm run deploy
```

To set a proxy auth token (optional, recommended for production):

```bash
npx wrangler secret put PROXY_TOKEN
```

## Run from any terminal — `cproxy`

By default the proxy scripts only work from inside the project directory. Run `install.sh` once to register a global `cproxy` command so you can start the proxy (and Claude Code) from **any** terminal session:

```bash
# Install to ~/.local/bin  (no sudo required — recommended)
./install.sh

# Or install system-wide
./install.sh --global

# Uninstall
./install.sh --remove
```

If `~/.local/bin` is not on your PATH yet, the installer will print the one line to add to your shell rc file (`~/.zshrc` or `~/.bashrc`):

```bash
export PATH="$HOME/.local/bin:$PATH"
```

Once installed, `cproxy` works from any directory — Claude Code always opens in the folder you ran the command from:

```bash
cproxy on              # interactive provider + model picker
cproxy on openrouter   # skip picker, use OpenRouter
cproxy on nvidia       # skip picker, use NVIDIA NIM
cproxy on workers_ai   # skip picker, use Workers AI binding
cproxy off             # stop proxy, switch Claude Code to real Anthropic API
cproxy log             # live coloured request log
cproxy status          # show whether proxy is running
cproxy stop            # stop the proxy without opening Claude Code
```

## Configure Claude Code

```bash
export ANTHROPIC_BASE_URL=http://localhost:8787     # or your deployed Worker URL
export ANTHROPIC_AUTH_TOKEN=dev-token               # any value when PROXY_TOKEN is unset
export CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1

claude
```

When prompted to select a gateway model, choose one of the `claude-*` aliases exposed by the proxy, such as `claude-sonnet-4-6`. Claude Code only adds gateway-discovered models whose IDs begin with `claude` or `anthropic`.

## Model mapping

### Default fallback (Workers AI binding)

The proxy exposes Claude-compatible aliases for Claude Code discovery. When no `MODEL` env var is set, requests fall back to the Workers AI binding (`env.AI`):

| Alias | Workers AI model |
|---|---|
| `claude-sonnet-4-6` | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` |
| `claude-opus-4-7` | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` |
| `claude-haiku-4-5` | `@cf/qwen/qwen2.5-coder-32b-instruct` |
| `cf-qwen-coder` | `@cf/qwen/qwen2.5-coder-32b-instruct` |
| `cf-llama` | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` |

### External providers

Set the `MODEL` env var (and optionally `MODEL_OPUS`, `MODEL_SONNET`, `MODEL_HAIKU`) to route to an external provider. Format: `provider_id/model-name`.

| Provider ID | Format example | Credentials needed |
|---|---|---|
| `workers_ai` | *(default)* | `env.AI` binding |
| `nvidia_nim` | `nvidia_nim/meta/llama-3.3-70b-instruct` | `NVIDIA_NIM_API_KEY` |
| `openrouter` | `openrouter/meta-llama/llama-3.3-70b-instruct` | `OPENROUTER_API_KEY` |
| `deepseek` | `deepseek/deepseek-chat` | `DEEPSEEK_API_KEY` |
| `cloudflare_workers_ai` | `cloudflare_workers_ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast` | `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` |

<details>
<summary><b>Cloudflare Workers AI REST API</b> (edge inference via external API)</summary>

Uses the OpenAI-compatible endpoint at `https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1`. Different from the `workers_ai` binding — works from any environment, including deployed workers that need a specific account.

```dotenv
CLOUDFLARE_API_TOKEN="your-api-token"      # from dash.cloudflare.com/profile/api-tokens
CLOUDFLARE_ACCOUNT_ID="your-account-id"    # from dash.cloudflare.com — right sidebar

MODEL="cloudflare_workers_ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast"
MODEL_SONNET="cloudflare_workers_ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast"
MODEL_HAIKU="cloudflare_workers_ai/@cf/meta/llama-3.1-8b-instruct"
```

Available models: [developers.cloudflare.com/workers-ai/models](https://developers.cloudflare.com/workers-ai/models/)

</details>

To change or add Workers AI fallback models, edit `WORKERS_AI_MODEL_MAP` in [`src/model-router.ts`](src/model-router.ts).

## Auth

If the `PROXY_TOKEN` environment variable (or secret) is set, every request must include one of:

- `Authorization: Bearer <PROXY_TOKEN>`
- `x-proxy-token: <PROXY_TOKEN>`

If `PROXY_TOKEN` is unset, all requests are allowed (fine for local dev).

## Curl tests

```bash
BASE=http://localhost:8787
TOKEN=dev-token   # match PROXY_TOKEN in .dev.vars, or any value when unset

# Health check
curl $BASE/health -H "Authorization: Bearer $TOKEN"

# Model discovery (shows only cf-* aliases)
curl $BASE/v1/models -H "Authorization: Bearer $TOKEN"

# Token count estimate (never calls Workers AI — pure math)
curl -X POST $BASE/v1/messages/count_tokens \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"model":"cf-llama","messages":[{"role":"user","content":"Hello world"}]}'

# Non-streaming message
curl -X POST $BASE/v1/messages \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "model": "cf-llama",
    "max_tokens": 256,
    "messages": [{"role": "user", "content": "Say hello in one sentence."}]
  }'

# Streaming message (SSE) — use -N to disable curl buffering so events print as they arrive
curl -N -X POST $BASE/v1/messages \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "model": "cf-llama",
    "max_tokens": 256,
    "stream": true,
    "messages": [{"role": "user", "content": "Count to five."}]
  }'

# Alternatively, run the full smoke-test script:
./scripts/test-local.sh $TOKEN
```

> Streaming responses use `Content-Type: text/event-stream; charset=utf-8` and `Connection: keep-alive`.
> Use `curl -N` (no-buffer) to see SSE events as they arrive.

## Type-checking

```bash
npm run typecheck
```

## Analytics (Cloudflare D1)

The proxy logs metadata-only analytics (no prompts, no responses) to a Cloudflare D1 database.

### Setup

**1. Create the D1 database** (one-time):
```bash
npm run db:create
```
Copy the `database_id` from the output and paste it into `wrangler.jsonc`:
```jsonc
"d1_databases": [{ "binding": "DB", "database_name": "claude_proxy_analytics", "database_id": "YOUR-ID-HERE" }]
```

**2. Run the migration** to create the `request_logs` table:
```bash
npm run db:migrate:local   # local dev
npm run db:migrate:remote  # deployed worker
```

If you already created analytics before token accounting was split out, also run:
```bash
npm run db:migrate5:local   # local dev
npm run db:migrate5:remote  # deployed worker
```

**3. Set the IP hash secret** (recommended for production):
```bash
npx wrangler secret put IP_HASH_SECRET
# Enter any random string — used to HMAC-hash client IPs before storage
```

### Viewing analytics

```bash
# Dashboard (browser)
open http://localhost:8787/dashboard

# JSON summary
curl http://localhost:8787/analytics/summary | jq .

# Recent requests (newest first, max 200)
curl "http://localhost:8787/analytics/recent?limit=20" | jq .

# Run smoke tests
./scripts/test-analytics.sh

# Query D1 directly
npx wrangler d1 execute claude_proxy_analytics --local \
  --command "SELECT provider, COUNT(*) n, SUM(estimated_cost_usd) cost FROM request_logs GROUP BY provider;"
```

### What is stored

| Field | Example | Notes |
|---|---|---|
| `id` | `abc123` | Request UUID |
| `timestamp` | `2026-05-18T…` | ISO8601 UTC |
| `method` / `path` | `POST /v1/messages` | Endpoint only |
| `model` | `claude-sonnet-4-6` | Requested model name |
| `provider` | `openrouter` | Resolved provider |
| `stream` | `1` | Boolean |
| `status_code` | `200` | HTTP status |
| `duration_ms` | `1547` | Response time |
| `estimated_context_tokens` | `55000` | Full context estimate seen by the proxy |
| `estimated_prompt_tokens` | `87` | User-visible prompt estimate |
| `estimated_tool_result_tokens` | `1200` | Tool-result content estimate |
| `billable_input_tokens` / `billable_output_tokens` | `87 / 42` | Provider-reported usage when available |
| `cached_input_tokens` | `4000` | Provider-reported cache usage when available |
| `failed_request_tokens` | `55000` | Failed/rate-limited context estimate, not billable |
| `request_kind` | `normal` | `normal`, `tool_result`, `skill_result`, `rate_limited`, or `failed` |
| `estimated_cost_usd` | `0.000045` | Estimate from billable tokens only |
| `user_agent` | `Claude-Code/…` | Client UA |
| `client_ip_hash` | `a3f8b2…` | HMAC-SHA256, 16 chars |

**What is NEVER stored:** raw prompts, messages, model responses, tool inputs/outputs, API keys, or auth headers.

### Token accounting notes

Claude Code's task UI and the proxy dashboard can differ. Claude Code may show summarized per-agent token usage, while the proxy sees the full request context sent over HTTP, tool-result continuation requests such as `[Result: ...]`, skill launch messages, and retry/rate-limit attempts. The dashboard separates **billable tokens** from **estimated context processed** so repeated context estimates do not inflate spend.

### Disable analytics

Set `ANALYTICS_ENABLED=false` in `.dev.vars` or as a wrangler secret.

## Known limitations

- **Tool-use depends on the backend model.** The proxy forwards Anthropic tools to Workers AI and converts Workers AI `tool_calls` into Anthropic `tool_use` blocks, but non-Claude model tool-calling quality can vary.
- **Fake streaming.** The proxy calls Workers AI in non-streaming mode and then re-emits the full response as chunked SSE events. There is no token-by-token streaming.
- **Approximate token counts.** All token estimates use `Math.ceil(chars / 4)` — not a real tokenizer.
- **No image support.** Image content blocks are replaced with a placeholder string.
- **Model quality differs from Claude.** Workers AI models are not Claude — expect differences in instruction-following, code quality, and reasoning ability, especially on complex agentic tasks.
- **Model availability may change.** The Workers AI model catalog is updated by Cloudflare. If a model stops working, update `MODEL_MAP` in `src/index.ts`.
