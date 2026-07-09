#!/usr/bin/env bash
# Build the backend jar and bring up the full local Hydropark stack.
# .sh twin of up.ps1 - see that file's header comment for the full flow.
set -euo pipefail

SKIP_BUILD=0
TIMEOUT_SECONDS=180
while [ $# -gt 0 ]; do
  case "$1" in
    --skip-build) SKIP_BUILD=1 ;;
    --timeout-seconds) TIMEOUT_SECONDS="$2"; shift ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
  shift
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(dirname "$SCRIPT_DIR")"
REPO_ROOT="$(dirname "$DEPLOY_DIR")"
BACKEND_DIR="$REPO_ROOT/backend"

if [ "$SKIP_BUILD" -eq 0 ]; then
  echo "==> mvn -f $BACKEND_DIR/pom.xml package -DskipTests"
  mvn -f "$BACKEND_DIR/pom.xml" package -DskipTests
else
  echo "==> --skip-build set; reusing whatever jar is already in backend/target"
fi

cd "$DEPLOY_DIR"

if [ ! -f .env ]; then
  echo "WARNING: .env not found - copying .env.example. Edit it (HP_INTERNAL_TOKEN, HP_LICENSE_* at minimum) before relying on issuer/worker." >&2
  cp .env.example .env
fi

echo "==> docker compose up -d --build"
docker compose up -d --build

echo "==> Waiting for api /actuator/health (up to ${TIMEOUT_SECONDS}s)..."
deadline=$((SECONDS + TIMEOUT_SECONDS))
healthy=0
while [ $SECONDS -lt $deadline ]; do
  status="$(curl -fsS http://localhost:8080/actuator/health 2>/dev/null | grep -o '"status":"[A-Z]*"' | head -1 || true)"
  if [ "$status" = '"status":"UP"' ]; then
    healthy=1
    break
  fi
  sleep 3
done

if [ "$healthy" -ne 1 ]; then
  echo "api did not report healthy within ${TIMEOUT_SECONDS}s. Run ./logs.sh to inspect (check mongo-init and migrate logs first)." >&2
  exit 1
fi

echo ""
echo "Hydropark local stack is up:"
echo "  api        http://localhost:8080"
echo "  catalog    http://localhost:8080/v1/catalog"
echo "  health     http://localhost:8080/actuator/health"
echo "  issuer     (internal only - no published port, by design)"
echo "  worker     (internal only - no published port, by design)"
echo ""
echo "Next: ./smoke.sh to verify, ./logs.sh to tail logs, ./down.sh to stop."
