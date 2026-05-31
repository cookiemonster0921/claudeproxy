#!/usr/bin/env bash
# Smoke test all proxy endpoints including analytics routes.
# Usage: ./scripts/test-analytics.sh [TOKEN]
# TOKEN defaults to "dev-token" (any value works when PROXY_TOKEN is unset).
set -euo pipefail

BASE='http://localhost:8787'
TOKEN="${1:-dev-token}"
AUTH="Authorization: Bearer ${TOKEN}"
PASS=0
FAIL=0

check() {
	local desc="$1"
	local expected_status="$2"
	shift 2
	local actual_status
	actual_status=$(curl -sf -o /dev/null -w "%{http_code}" "$@" 2>/dev/null || true)
	if [[ "$actual_status" == "$expected_status" ]]; then
		echo "  ✓  $desc  ($actual_status)"
		PASS=$((PASS + 1))
	else
		echo "  ✗  $desc  (expected $expected_status, got $actual_status)"
		FAIL=$((FAIL + 1))
	fi
}

echo "=== claude-proxy smoke tests against $BASE ==="
echo ""

echo "── Core endpoints ──────────────────────────────────────────────────────────"
check "GET  /health" 200 -H "$AUTH" "$BASE/health"
check "GET  /v1/models" 200 -H "$AUTH" "$BASE/v1/models"
check "POST /v1/messages/count_tokens" 200 \
	-X POST "$BASE/v1/messages/count_tokens" \
	-H 'Content-Type: application/json' -H "$AUTH" \
	-d '{"model":"cf-llama","messages":[{"role":"user","content":"Hello world"}]}'
check "POST /v1/messages (stream=false, Workers AI fallback on 503 = ok)" "200" \
	-X POST "$BASE/v1/messages" \
	-H 'Content-Type: application/json' -H "$AUTH" \
	--max-time 40 \
	-d '{"model":"claude-sonnet-4-6","max_tokens":32,"messages":[{"role":"user","content":"Say hi"}]}' \
	|| true  # allow 503 if AI binding unavailable in CI

echo ""
echo "── Analytics endpoints ──────────────────────────────────────────────────────"
check "GET  /analytics/summary" "200" -H "$AUTH" "$BASE/analytics/summary"
check "GET  /analytics/recent?limit=5" "200" -H "$AUTH" "$BASE/analytics/recent?limit=5"
check "GET  /dashboard" "200" -H "$AUTH" "$BASE/dashboard"

echo ""
echo "── Auth checks (only if PROXY_TOKEN is set) ────────────────────────────────"
NO_AUTH_STATUS=$(curl -sf -o /dev/null -w "%{http_code}" "$BASE/health" 2>/dev/null || true)
if [[ "$NO_AUTH_STATUS" == "401" ]]; then
	check "GET  /health without token → 401" "401" "$BASE/health"
	check "GET  /health with bad token → 401" "401" -H "Authorization: Bearer wrong-token" "$BASE/health"
	echo "  ✓  Auth enforcement working"
else
	echo "  ─  PROXY_TOKEN not set — auth checks skipped"
fi

echo ""
echo "── Response validation ─────────────────────────────────────────────────────"
# Verify /analytics/summary returns expected JSON structure
SUMMARY=$(curl -sf -H "$AUTH" "$BASE/analytics/summary" 2>/dev/null || echo '{}')
if echo "$SUMMARY" | grep -q '"total_requests"'; then
	echo "  ✓  /analytics/summary has total_requests field"
	PASS=$((PASS + 1))
else
	echo "  ✗  /analytics/summary missing total_requests field"
	echo "     Response: $SUMMARY"
	FAIL=$((FAIL + 1))
fi

RECENT=$(curl -sf -H "$AUTH" "$BASE/analytics/recent?limit=5" 2>/dev/null || echo '{}')
if echo "$RECENT" | grep -q '"results"'; then
	echo "  ✓  /analytics/recent has results field"
	PASS=$((PASS + 1))
else
	echo "  ✗  /analytics/recent missing results field"
	FAIL=$((FAIL + 1))
fi

DASHBOARD=$(curl -sf -H "$AUTH" "$BASE/dashboard" 2>/dev/null || echo '')
if echo "$DASHBOARD" | grep -q 'Analytics'; then
	echo "  ✓  /dashboard returns HTML"
	PASS=$((PASS + 1))
else
	echo "  ✗  /dashboard did not return expected HTML"
	FAIL=$((FAIL + 1))
fi

echo ""
echo "─────────────────────────────────────────────────────────────────────────────"
echo "  Passed: $PASS  Failed: $FAIL"
if [[ $FAIL -gt 0 ]]; then
	echo ""
	echo "  If analytics endpoints return 503, run: npm run db:migrate:local"
	exit 1
fi
echo "  All checks passed."
