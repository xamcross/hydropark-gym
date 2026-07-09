#!/usr/bin/env bash
# Tail logs from the local stack. .sh twin of logs.ps1.
#   ./logs.sh                 all services, follow
#   ./logs.sh api              just api, follow
#   ./logs.sh --no-follow api  just api, print and exit
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(dirname "$SCRIPT_DIR")"
cd "$DEPLOY_DIR"

FOLLOW="-f"
TAIL=200
SERVICE=""
for arg in "$@"; do
  case "$arg" in
    --no-follow) FOLLOW="" ;;
    --tail=*) TAIL="${arg#--tail=}" ;;
    *) SERVICE="$arg" ;;
  esac
done

docker compose logs --tail="$TAIL" $FOLLOW $SERVICE
