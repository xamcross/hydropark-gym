<#
.SYNOPSIS
  Build the backend jar and bring up the full local Hydropark stack.

.DESCRIPTION
  1. `mvn package -DskipTests` in backend/ (unless -SkipBuild).
  2. `docker compose up -d --build` (mongo -> mongo-init -> migrate -> api/issuer/worker).
  3. Polls api's /actuator/health until it reports UP (or times out).
  4. Prints the URLs.

  Requires Windows PowerShell 5.1 (no &&/||, no ternary - see deploy/README.md).

.PARAMETER SkipBuild
  Skip the `mvn package` step and reuse whatever jar is already in backend/target.

.PARAMETER TimeoutSeconds
  How long to wait for api to become healthy before giving up. Default 180s.
#>
[CmdletBinding()]
param(
  [switch]$SkipBuild,
  [int]$TimeoutSeconds = 180
)

$ErrorActionPreference = "Stop"

$deployDir = Split-Path -Parent $PSScriptRoot
$repoRoot = Split-Path -Parent $deployDir
$backendDir = Join-Path $repoRoot "backend"
$pomPath = Join-Path $backendDir "pom.xml"

if (-not $SkipBuild) {
  Write-Host "==> mvn -f $pomPath package -DskipTests" -ForegroundColor Cyan
  & mvn -f $pomPath package -DskipTests
  if ($LASTEXITCODE -ne 0) {
    Write-Error "Maven build failed. Fix the build, or pass -SkipBuild to reuse an existing jar."
    exit 1
  }
} else {
  Write-Host "==> -SkipBuild set; reusing whatever jar is already in backend/target" -ForegroundColor Yellow
}

Push-Location $deployDir
try {
  $envFile = Join-Path $deployDir ".env"
  $envExample = Join-Path $deployDir ".env.example"
  if (-not (Test-Path $envFile)) {
    Write-Warning "$envFile not found - copying .env.example. Edit it (HP_INTERNAL_TOKEN, HP_LICENSE_* at minimum) before relying on issuer/worker."
    Copy-Item $envExample $envFile
  }

  Write-Host "==> docker compose up -d --build" -ForegroundColor Cyan
  docker compose up -d --build
  if ($LASTEXITCODE -ne 0) {
    Write-Error "docker compose up failed. Run .\logs.ps1 to inspect, or .\reset.ps1 to start clean."
    exit 1
  }

  Write-Host "==> Waiting for api /actuator/health (up to ${TimeoutSeconds}s)..." -ForegroundColor Cyan
  $healthy = $false
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    try {
      $resp = Invoke-RestMethod -Uri "http://localhost:8080/actuator/health" -Method Get -TimeoutSec 3
      if ($resp.status -eq "UP") {
        $healthy = $true
        break
      }
    } catch {
      # api not up yet - keep polling
    }
    Start-Sleep -Seconds 3
  }

  if (-not $healthy) {
    Write-Error "api did not report healthy within ${TimeoutSeconds}s. Run .\logs.ps1 to inspect (check mongo-init and migrate logs first - the replica-set-not-initiated failure mode is the most common cause, see deploy/README.md Troubleshooting)."
    exit 1
  }

  Write-Host ""
  Write-Host "Hydropark local stack is up:" -ForegroundColor Green
  Write-Host "  api        http://localhost:8080"
  Write-Host "  catalog    http://localhost:8080/v1/catalog"
  Write-Host "  health     http://localhost:8080/actuator/health"
  Write-Host "  issuer     (internal only - no published port, by design)"
  Write-Host "  worker     (internal only - no published port, by design)"
  Write-Host ""
  Write-Host "Next: .\smoke.ps1 to verify, .\logs.ps1 to tail logs, .\down.ps1 to stop." -ForegroundColor DarkGray
  exit 0
} finally {
  Pop-Location
}
