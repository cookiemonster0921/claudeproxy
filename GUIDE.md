# Claude Code Proxy — User Guide

This proxy lets you run Claude Code against free or cheaper AI models instead of paying Anthropic directly. It sits between Claude Code and the real API — Claude Code thinks it's talking to Anthropic, but requests actually go to whichever model you choose.

---

## What you need before starting

- A **Cloudflare account** (free tier works) — [cloudflare.com](https://cloudflare.com)
- **Node.js 18+** installed — [nodejs.org](https://nodejs.org)
- **Claude Code** installed — run `npm install -g @anthropic-ai/claude-code`
- At least one API key from a supported provider (or use Cloudflare's free Workers AI)

---

## First-time setup

Open a terminal in this folder and run:

```bash
npm install          # install dependencies
npx wrangler login   # log in to Cloudflare (opens a browser)
cp .dev.vars.example .dev.vars  # create your local config file
```

Then open `.dev.vars` and add your API keys. You only need keys for the providers you want to use:

```bash
# Cloudflare Workers AI (free tier available — no key needed beyond login)
# Leave blank if you only use the env.AI binding (workers_ai provider)

# NVIDIA NIM — get key at build.nvidia.com
NVIDIA_NIM_API_KEY=

# OpenRouter — get key at openrouter.ai/keys
OPENROUTER_API_KEY=

# DeepSeek — get key at platform.deepseek.com
DEEPSEEK_API_KEY=

# Cloudflare Workers AI REST API (separate from the binding)
CLOUDFLARE_API_TOKEN=
CLOUDFLARE_ACCOUNT_ID=
```

---

## Starting Claude Code with the proxy

The launcher script handles everything — starting the proxy server, picking a model, and launching Claude Code with the right settings.

### Interactive mode (recommended for beginners)

```bash
./claude-proxy.sh on
```

You'll see two menus: pick a provider, then pick a model. The proxy starts and Claude Code launches automatically.

### Direct shortcuts

```bash
./claude-proxy.sh on nvidia      # pick from NVIDIA NIM models
./claude-proxy.sh on openrouter  # pick from OpenRouter models
./claude-proxy.sh on cloudflare  # pick from Cloudflare Workers AI models
./claude-proxy.sh on workers_ai  # use Cloudflare Workers AI binding (no key needed)
```

### Running without the proxy

To use Claude Code with your real Anthropic API key instead:

```bash
./claude-proxy.sh off
```

---

## Available providers and models

### Workers AI (Cloudflare binding) — free tier available
No external API key required. Uses your Cloudflare account's Workers AI binding.

| When Claude Code requests… | The proxy routes to… |
|---|---|
| `claude-sonnet-4-6`, `claude-opus-4-7` | Llama 3.3 70B (fp8-fast) |
| `claude-haiku-4-5` | Qwen 2.5 Coder 32B |

### NVIDIA NIM — `NVIDIA_NIM_API_KEY` required
High-quality models via NVIDIA's inference platform.

| Option | Model |
|---|---|
| Llama 3.3 70B Instruct | Fast, general-purpose |
| Llama 3.1 405B Instruct | Largest, highest quality |
| DeepSeek R1 | Strong reasoning and coding |
| Qwen 2.5 Coder 32B | Specialized for code |

### OpenRouter — `OPENROUTER_API_KEY` required
Routes to many models from one API. Some are free.

| Option | Notes |
|---|---|
| Llama 3.3 70B | Often free |
| DeepSeek Chat V3 | Strong coding, cheap |
| DeepSeek R1 | Reasoning model |
| Qwen3 235B | Very large, high quality |
| Gemini 2.0 Flash | Google's fast model |

### Cloudflare Workers AI REST API — `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` required
Same models as Workers AI binding, but accessed via the REST API. Works outside of Cloudflare Workers too.

---

## Why does Claude Code still show "Opus 4.7"?

That's normal. Claude Code's UI shows the model name it *requests* — it always thinks it's talking to Anthropic. The proxy intercepts every request and routes it to your chosen model instead.

When you see this:
```
▛ Claude Code v2.x
  Opus 4.7 (1M context)
```

The proxy is actually sending your messages to **Llama 3.3 70B** (or whichever model you picked). To confirm, watch the proxy logs in a second terminal:

```bash
./claude-proxy.sh log
```

You'll see lines like:
```
200 ~ POST /v1/messages  OpenRouter → deepseek/deepseek-r1  1234ms  87tok
```

---

## Watching live request logs

Open a second terminal while Claude Code is running:

```bash
./claude-proxy.sh log
```

Each line shows one request:
- `200` / `400` — response status (green = ok, red = error)
- `~` — streaming request
- `POST /v1/messages` — which endpoint was called
- `OpenRouter → deepseek/deepseek-r1` — which provider and model handled it
- `1234ms` — how long it took
- `87tok` — approximate token count

Press `Ctrl-C` to stop watching.

---

## Checking proxy status

```bash
./claude-proxy.sh status
```

Shows whether the proxy is running, which model is active, and the last few requests.

---

## Stopping the proxy

```bash
./claude-proxy.sh stop
```

Or just close the terminal. The proxy runs in the background — `stop` cleans it up properly.

---

## Switching models mid-session

Stop Claude Code (Ctrl-C or `/exit`), then run `on` again with a different provider:

```bash
./claude-proxy.sh on openrouter   # pick a different model
```

The proxy restarts automatically with the new model.

---

## Analytics dashboard

The proxy tracks metadata about every request (no prompts or responses — just timing, model, tokens, cost estimates).

### View the dashboard

Make sure the proxy is running, then open in your browser:

```
http://localhost:8787/dashboard
```

You'll see:
- Total requests and success rate
- Estimated cost breakdown
- Token usage totals
- Average response time
- Recent requests table
- Model and provider breakdown charts

### First-time analytics setup

Analytics requires a Cloudflare D1 database. Run these once:

```bash
# 1. Create the database
npm run db:create
# Copy the "database_id" it prints, and paste it into wrangler.jsonc

# 2. Create the table
npm run db:migrate:local
```

After that, every request is automatically logged. The dashboard auto-refreshes every 30 seconds.

### Query the data directly

```bash
# Recent requests
npx wrangler d1 execute claude_proxy_analytics --local \
  --command "SELECT timestamp, provider, model, duration_ms, status_code FROM request_logs ORDER BY timestamp DESC LIMIT 10;"

# Cost by provider
npx wrangler d1 execute claude_proxy_analytics --local \
  --command "SELECT provider, COUNT(*) as requests, ROUND(SUM(estimated_cost_usd),6) as total_cost FROM request_logs GROUP BY provider;"

# Error rate
npx wrangler d1 execute claude_proxy_analytics --local \
  --command "SELECT success, COUNT(*) FROM request_logs GROUP BY success;"
```

### Privacy note

The analytics database stores **only metadata**: timestamps, model names, response times, and approximate token counts. It **never stores** your prompts, Claude's responses, tool outputs, code, or any content from your conversations.

---

## Deploying to Cloudflare (optional)

If you want the proxy running permanently in the cloud instead of locally:

```bash
npm run deploy
```

Then set a token so only you can use it:

```bash
npx wrangler secret put PROXY_TOKEN
# Enter a long random string and save it
```

Set your secrets (API keys) in the deployed worker:

```bash
npx wrangler secret put OPENROUTER_API_KEY
npx wrangler secret put NVIDIA_NIM_API_KEY
# etc.
```

And run the analytics migration on the remote database:

```bash
npm run db:migrate:remote
```

To use Claude Code with the deployed proxy, set these environment variables in your shell (replace the URL with your deployed worker URL):

```bash
export ANTHROPIC_BASE_URL=https://claude-proxy.your-name.workers.dev
export ANTHROPIC_AUTH_TOKEN=your-proxy-token
export CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1
claude
```

Or just run `./claude-proxy.sh on` — it automatically uses the local proxy at `http://localhost:8787`.

---

## Troubleshooting

### "proxy failed to start" or nothing happens

Check the wrangler log:

```bash
cat /tmp/claude-cf-proxy-8787.log
```

Common causes:
- **Not logged in to Cloudflare**: run `npx wrangler login`
- **Port 8787 already in use**: run `./claude-proxy.sh stop` first, or set `PROXY_PORT=8788 ./claude-proxy.sh on`

### "Unknown model" error (400)

The model name you're using isn't in the proxy's routing table. This usually means the `MODEL` env var in `.dev.vars` is set to something unsupported. Check `.dev.vars` and make sure `MODEL` matches one of the supported formats (e.g. `openrouter/meta-llama/llama-3.3-70b-instruct`).

### Claude Code hangs or keeps retrying

The provider is taking too long (>30 seconds). The proxy has a 30-second timeout. Try a smaller/faster model:
- Switch to `openrouter` → `Llama 3.3 70B Instruct (free)` — usually fast
- Switch to `workers_ai` — runs on Cloudflare's edge, low latency

### Analytics shows 503 "D1 database not configured"

You need to set up the D1 database. Follow the [First-time analytics setup](#first-time-analytics-setup) steps above.

### Tool calls don't work as expected

Non-Claude models have varying support for tool use. DeepSeek, Llama 3.3, and Qwen 2.5 Coder all support function calling, but they may produce different formats than Claude. If Claude Code fails on agentic tasks, try a different model.

---

## File reference

| File | Purpose |
|---|---|
| `claude-proxy.sh` | The main launcher script — start here |
| `.dev.vars` | Your API keys and config (never committed to git) |
| `.dev.vars.example` | Template showing all available settings |
| `src/index.ts` | Main Worker entry point and route handler |
| `src/model-router.ts` | Edit `WORKERS_AI_MODEL_MAP` to change model aliases |
| `claude-proxy.sh` model arrays | Edit `NVIDIA_MODELS`, `OPENROUTER_MODELS`, etc. to add models to the picker |
| `scripts/log-format.py` | Log formatter used by `./claude-proxy.sh log` |
| `scripts/test-local.sh` | Quick smoke test for all API endpoints |
| `scripts/test-analytics.sh` | Smoke test for analytics endpoints |
| `migrations/0001_create_analytics.sql` | D1 database schema |

---

## Quick reference card

```
./claude-proxy.sh on              Start proxy + Claude Code (interactive picker)
./claude-proxy.sh on nvidia       Start with NVIDIA NIM model picker
./claude-proxy.sh on openrouter   Start with OpenRouter model picker
./claude-proxy.sh on cloudflare   Start with Cloudflare AI model picker
./claude-proxy.sh on workers_ai   Start with Cloudflare Workers AI binding
./claude-proxy.sh off             Run Claude Code with real Anthropic API
./claude-proxy.sh log             Watch live request logs in real time
./claude-proxy.sh status          Show what's running and recent requests
./claude-proxy.sh stop            Stop the background proxy server

open http://localhost:8787/dashboard    Analytics dashboard
curl http://localhost:8787/health       Health check
curl http://localhost:8787/v1/models    List available models
```
