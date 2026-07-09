#!/usr/bin/env bash
# Smoke-test the local stack. .sh twin of smoke.ps1.
set -uo pipefail

BASE_URL="${1:-http://localhost:8080}"
FAILED=0

echo "==> GET $BASE_URL/actuator/health"
health_body="$(curl -fsS "$BASE_URL/actuator/health" 2>/dev/null)"
if [ $? -ne 0 ]; then
  echo "    FAIL - request failed"
  FAILED=1
elif ! echo "$health_body" | grep -q '"status":"UP"'; then
  echo "    FAIL - health body did not report status UP: $health_body"
  FAILED=1
else
  echo "    OK - status=UP"
fi

echo "==> GET $BASE_URL/v1/catalog"
catalog_body="$(curl -fsS -w '\n%{http_code}' "$BASE_URL/v1/catalog" 2>/dev/null)"
if [ $? -ne 0 ]; then
  echo "    FAIL - request failed"
  FAILED=1
else
  http_code="$(echo "$catalog_body" | tail -1)"
  body="$(echo "$catalog_body" | sed '$d')"
  if [ "$http_code" != "200" ]; then
    echo "    FAIL - HTTP $http_code, expected 200"
    FAILED=1
  else
    # Non-empty check: reject an empty array `[]`, an empty items envelope
    # `"items":[]`, or an empty body - accept anything else that parses as
    # having at least one element/field.
    trimmed="$(echo "$body" | tr -d '[:space:]')"
    if [ -z "$trimmed" ] || [ "$trimmed" = "[]" ] || [ "$trimmed" = '{"items":[]}' ] || echo "$trimmed" | grep -q '"items":\[\]'; then
      echo "    FAIL - HTTP 200 but no catalog items in the response"
      FAILED=1
    else
      echo "    OK - non-empty catalog response"
    fi
  fi
fi

echo ""
if [ "$FAILED" -ne 0 ]; then
  echo "SMOKE TEST FAILED"
  exit 1
else
  echo "SMOKE TEST PASSED"
  exit 0
fi
