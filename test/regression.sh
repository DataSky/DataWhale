#!/bin/bash
# DataWhale API Regression Test Suite
# Usage: bash test/regression.sh [base_url]

BASE="${1:-http://localhost:3000}"
PASS=0
FAIL=0

check() {
  local desc="$1" method="$2" url="$3" expected="$4"
  local status
  local body
  
  if [ "$method" = "POST" ]; then
    body=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE$url" -H "Content-Type: application/json" -d "${5:-{}}")
  elif [ "$method" = "DELETE" ]; then
    body=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE "$BASE$url")
  else
    body=$(curl -s -o /dev/null -w "%{http_code}" "$BASE$url")
  fi
  
  if [ "$body" = "$expected" ]; then
    echo "  ✓ $desc"
    PASS=$((PASS + 1))
  else
    echo "  ✗ $desc (expected $expected, got $body)"
    FAIL=$((FAIL + 1))
  fi
}

echo "🦈 DataWhale Regression Tests"
echo "   Server: $BASE"
echo ""

echo "--- Static Pages ---"
check "Homepage"         GET  "/"                 "200"
check "Settings"         GET  "/settings/"         "200"
check "Dashboard"        GET  "/dashboard/"        "200"
check "404"              GET  "/nonexistent"       "200"  # SPA fallback

echo ""
echo "--- REST API ---"
check "Sessions list"    GET  "/api/sessions"      "200"
check "Config read"      GET  "/api/config"        "200"
check "Knowledge search" GET  "/api/knowledge/search?q=test" "200"
check "Monitoring data"  GET  "/api/monitoring"    "200"
check "Session not found" GET "/api/sessions/nonexistent" "404"
check "File not found"   GET  "/api/files/x/y.png" "404"

echo ""
echo "--- Write APIs ---"
check "Delete session"   DELETE "/api/sessions/test123" "200"
check "Chat (SSE)"       POST "/api/chat"    "200" '{"prompt":"hello"}'
check "Config write"     PUT  "/api/config"  "200" '{"TEST_KEY":"test"}'

echo ""
echo "--- Export ---"
EXPORT_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/sessions/session_test/export")
if [ "$EXPORT_STATUS" = "200" ] || [ "$EXPORT_STATUS" = "404" ]; then
  echo "  ✓ Export endpoint ($EXPORT_STATUS)"
  PASS=$((PASS + 1))
else
  echo "  ✗ Export endpoint ($EXPORT_STATUS)"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "---"
echo "Results: $PASS passed, $FAIL failed"
[ $FAIL -eq 0 ] && echo "✅ All tests passed!" || echo "❌ Some tests failed"

exit $FAIL
