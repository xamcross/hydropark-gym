#!/usr/bin/env bash
# Nuke the local stack (containers + volumes) and bring it back up from
# scratch. .sh twin of reset.ps1.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "WARNING: this destroys all local Mongo data (volumes) and rebuilds the stack from scratch." >&2

"$SCRIPT_DIR/down.sh" --volumes
"$SCRIPT_DIR/up.sh" "$@"
