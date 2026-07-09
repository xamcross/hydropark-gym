#!/usr/bin/env bash
# Stop the local Hydropark stack. Pass --volumes to also remove the Mongo
# data volume (destroys local data). .sh twin of down.ps1.
set -euo pipefail

VOLUMES=0
if [ "${1:-}" = "--volumes" ]; then
  VOLUMES=1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(dirname "$SCRIPT_DIR")"
cd "$DEPLOY_DIR"

if [ "$VOLUMES" -eq 1 ]; then
  echo "WARNING: removing volumes too (--volumes) - this destroys the local Mongo data." >&2
  docker compose down -v
else
  docker compose down
fi

echo "Stack stopped."
