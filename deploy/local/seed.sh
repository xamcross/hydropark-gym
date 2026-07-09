#!/usr/bin/env bash
# Run migrations AND seed catalog data. .sh twin of seed.ps1.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(dirname "$SCRIPT_DIR")"
cd "$DEPLOY_DIR"

echo "==> docker compose run --rm -e HP_SEED_ENABLED=true migrate"
docker compose run --rm -e HP_SEED_ENABLED=true migrate
echo "Migrations applied and catalog seeded."
