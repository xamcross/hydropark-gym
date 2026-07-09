<#
.SYNOPSIS
  Run migrations AND seed catalog data (docker compose run --rm -e HP_SEED_ENABLED=true migrate).
#>
[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$deployDir = Split-Path -Parent $PSScriptRoot

Push-Location $deployDir
try {
  Write-Host "==> docker compose run --rm -e HP_SEED_ENABLED=true migrate" -ForegroundColor Cyan
  docker compose run --rm -e HP_SEED_ENABLED=true migrate
  if ($LASTEXITCODE -ne 0) {
    Write-Error "Migrate+seed run failed."
    exit 1
  }
  Write-Host "Migrations applied and catalog seeded." -ForegroundColor Green
  exit 0
} finally {
  Pop-Location
}
