#!/usr/bin/env bash
# Run migrations against the local stack's Mongo. .sh twin of migrate.ps1.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(dirname "$SCRIPT_DIR")"
cd "$DEPLOY_DIR"

echo "==> docker compose run --rm migrate"
docker compose run --rm migrate
echo "Migrations applied."
