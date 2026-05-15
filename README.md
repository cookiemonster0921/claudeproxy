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

## Configure Claude Code

```bash
export ANTHROPIC_BASE_URL=http://localhost:8787     # or your deployed Worker URL
export ANTHROPIC_AUTH_TOKEN=dev-token               # any value when PROXY_TOKEN is unset
export CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1

claude
```

When prompted to select a gateway model, choose one of the `claude-*` aliases exposed by the proxy, such as `claude-sonnet-4-6`. Claude Code only adds gateway-discovered models whose IDs begin with `claude` or `anthropic`.

## Model mapping

The proxy exposes Claude-compatible aliases for Claude Code discovery and keeps `cf-*` aliases for direct curl/testing. Each alias maps to a Workers AI model ID in `src/index.ts`:

| Alias | Workers AI model |
|---|---|
| `claude-sonnet-4-6` | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` |
| `claude-opus-4-7` | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` |
| `claude-haiku-4-5` | `@cf/qwen/qwen2.5-coder-32b-instruct` |
| `cf-qwen-coder` | `@cf/qwen/qwen2.5-coder-32b-instruct` |
| `cf-llama` | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` |

To change or add models, edit `MODEL_MAP` in [`src/index.ts`](src/index.ts) and check the current catalog at [developers.cloudflare.com/workers-ai/models](https://developers.cloudflare.com/workers-ai/models/). Model availability changes over time.

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

## Known limitations

- **Tool-use depends on the backend model.** The proxy forwards Anthropic tools to Workers AI and converts Workers AI `tool_calls` into Anthropic `tool_use` blocks, but non-Claude model tool-calling quality can vary.
- **Fake streaming.** The proxy calls Workers AI in non-streaming mode and then re-emits the full response as chunked SSE events. There is no token-by-token streaming.
- **Approximate token counts.** All token estimates use `Math.ceil(chars / 4)` — not a real tokenizer.
- **No image support.** Image content blocks are replaced with a placeholder string.
- **Model quality differs from Claude.** Workers AI models are not Claude — expect differences in instruction-following, code quality, and reasoning ability, especially on complex agentic tasks.
- **Model availability may change.** The Workers AI model catalog is updated by Cloudflare. If a model stops working, update `MODEL_MAP` in `src/index.ts`.
