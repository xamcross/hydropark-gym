<#
.SYNOPSIS
  Deploy the three Hydropark Fly apps (issuer, worker, api) in the right order.

.DESCRIPTION
  Trust-zone order matters on first bootstrap: issuer and worker have no
  public ingress and nothing public depends on them being "first", but api's
  release_command talks to Mongo directly (not to issuer/worker), so strict
  ordering isn't a hard correctness requirement after the first deploy - it
  is still the safer default: bring the two internal-only zones up first so
  api never briefly points HP_ISSUER_URL/HP_WORKER_URL at an app that isn't
  running yet.

  Requires flyctl on PATH and an authenticated `fly auth login` session.
  Never runs `fly deploy` bare - always with --config pointed at this
  directory's fly.<app>.toml AND --dockerfile pointed at backend/Dockerfile,
  so the three fly.*.toml files can stay free of fragile relative [build]
  paths (see each toml's header comment).

.PARAMETER App
  Deploy only one app: api, issuer, or worker. Omit to deploy all three in
  order.
#>
[CmdletBinding()]
param(
  [ValidateSet("api", "issuer", "worker")]
  [string]$App
)

$ErrorActionPreference = "Stop"

$flyDir = $PSScriptRoot
$deployDir = Split-Path -Parent $flyDir
$repoRoot = Split-Path -Parent $deployDir
$backendDir = Join-Path $repoRoot "backend"
$dockerfile = Join-Path $backendDir "Dockerfile"

if (-not (Get-Command flyctl -ErrorAction SilentlyContinue)) {
  throw "flyctl is not on PATH. Install it (https://fly.io/docs/flyctl/install/) and run 'fly auth login' first."
}

function Deploy-HydroparkApp([string]$name) {
  $config = Join-Path $flyDir "fly.$name.toml"
  if (-not (Test-Path $config)) {
    throw "Missing config: $config"
  }
  Write-Host "==> flyctl deploy --config $config --dockerfile $dockerfile $backendDir" -ForegroundColor Cyan
  & flyctl deploy --config $config --dockerfile $dockerfile $backendDir
  if ($LASTEXITCODE -ne 0) {
    Write-Error "flyctl deploy failed for '$name'. Fix the error above before continuing - a partial rollout across trust zones is worse than stopping here."
    exit 1
  }
  Write-Host "==> $name deployed." -ForegroundColor Green
}

if ($App) {
  Deploy-HydroparkApp $App
  exit 0
}

Write-Host "Deploying all three Hydropark apps in trust-zone order: issuer, worker, api." -ForegroundColor Yellow
Write-Host "(api's [deploy] release_command runs the DB migration before api itself takes traffic.)"
Write-Host ""

Deploy-HydroparkApp "issuer"
Deploy-HydroparkApp "worker"
Deploy-HydroparkApp "api"

Write-Host ""
Write-Host "All three apps deployed:" -ForegroundColor Green
Write-Host "  hydropark-api     (public)"
Write-Host "  hydropark-issuer  (internal only - no public ingress)"
Write-Host "  hydropark-worker  (internal only - no public ingress)"
exit 0
