#!/usr/bin/env bash
# Smoke-test all proxy endpoints against http://localhost:8787
# Usage: ./scripts/test-local.sh [TOKEN]
# TOKEN defaults to "dev-token" — match PROXY_TOKEN in .dev.vars, or any value when unset.
set -euo pipefail

BASE='http://localhost:8787'
TOKEN="${1:-dev-token}"
AUTH="Authorization: Bearer ${TOKEN}"

echo '=== GET /health ==='
curl -sf -H "${AUTH}" "${BASE}/health" | jq .
echo

echo '=== GET /v1/models ==='
curl -sf -H "${AUTH}" "${BASE}/v1/models" | jq .
echo

echo '=== POST /v1/messages/count_tokens ==='
curl -sf -X POST "${BASE}/v1/messages/count_tokens" \
	-H 'Content-Type: application/json' \
	-H "${AUTH}" \
	-d '{"model":"cf-llama","messages":[{"role":"user","content":"Hello world"}]}' | jq .
echo

echo '=== POST /v1/messages (stream=false) ==='
curl -sf -X POST "${BASE}/v1/messages" \
	-H 'Content-Type: application/json' \
	-H "${AUTH}" \
	-d '{
		"model": "cf-llama",
		"max_tokens": 64,
		"messages": [{"role": "user", "content": "Say hi in one sentence."}]
	}' | jq .
echo

echo '=== POST /v1/messages (stream=true) — use curl -N for unbuffered SSE ==='
curl -sN -X POST "${BASE}/v1/messages" \
	-H 'Content-Type: application/json' \
	-H "${AUTH}" \
	-d '{
		"model": "cf-llama",
		"max_tokens": 64,
		"stream": true,
		"messages": [{"role": "user", "content": "Say hi in one sentence."}]
	}'
echo
echo

echo '=== done ==='
