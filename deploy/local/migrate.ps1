<#
.SYNOPSIS
  Run migrations against the local stack's Mongo (docker compose run --rm migrate).

.DESCRIPTION
  `docker compose run` starts declared dependencies (mongo, mongo-init) first
  if they aren't already up, then runs a fresh `migrate` container to
  completion. Safe to re-run - migrations are idempotent by id.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$deployDir = Split-Path -Parent $PSScriptRoot

Push-Location $deployDir
try {
  Write-Host "==> docker compose run --rm migrate" -ForegroundColor Cyan
  docker compose run --rm migrate
  if ($LASTEXITCODE -ne 0) {
    Write-Error "Migration run failed. Run .\logs.ps1 mongo-init if this is a fresh volume - see deploy/README.md Troubleshooting."
    exit 1
  }
  Write-Host "Migrations applied." -ForegroundColor Green
  exit 0
} finally {
  Pop-Location
}
