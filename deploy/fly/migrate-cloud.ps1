<#
.SYNOPSIS
  Run the migration job against Atlas out-of-band, without a full redeploy.

.DESCRIPTION
  Normally you don't need this: fly.api.toml's [deploy] release_command
  already runs the migration-only mode before every `api` deploy (see
  deploy-cloud.ps1). Use this script for:
    - a break-glass re-run of migrations without redeploying code, or
    - the very first run against a brand-new Atlas cluster BEFORE
      hydropark-api has ever been deployed (release_command needs a machine
      to run in - `fly ssh console` needs one too, so for a truly empty
      environment, deploy once first; after that this script works for
      any subsequent out-of-band run).

  Runs `fly ssh console -C "<java invocation>"` against an existing machine
  of the target app. The same trick as fly.api.toml's release_command:
  -D system properties (which Spring Boot ranks ABOVE OS environment
  variables) force migration-only mode and disable the api/issuer/worker
  beans for this ONE invocation, without touching the app's regular
  [env]/secrets configuration.

.PARAMETER App
  Which Fly app's machine + MONGODB_URI to use. Defaults to hydropark-api.
  Any of the three apps' Atlas users can run migrations as long as that
  user's Atlas role has write access to whatever the migration touches
  (indexes, seed data) - hp_api is read/write on everything except
  settled_orders/grants, so it covers ordinary schema migrations; a
  migration that specifically needs to touch settled_orders/grants schema
  requires running as hydropark-worker instead.

.PARAMETER Seed
  Also seed catalog data (HP_SEED_ENABLED=true). Off by default - seeding
  production is rarely what you want; this exists mainly for a fresh
  staging environment.
#>
[CmdletBinding()]
param(
  [string]$App = "hydropark-api",
  [switch]$Seed
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command flyctl -ErrorAction SilentlyContinue)) {
  throw "flyctl is not on PATH. Install it (https://fly.io/docs/flyctl/install/) and run 'fly auth login' first."
}

$seedFlag = "false"
if ($Seed) {
  $seedFlag = "true"
  Write-Warning "Seeding is enabled for this run (-Seed). Double-check that's what you want against $App's Atlas cluster."
}

$javaCmd = "java " +
  "-Dhydropark.api.enabled=false " +
  "-Dhydropark.issuer.enabled=false " +
  "-Dhydropark.worker.enabled=false " +
  "-Dhydropark.migration.enabled=true " +
  "-Dhydropark.migration.exit-after=true " +
  "-Dhydropark.seed.enabled=$seedFlag " +
  "org.springframework.boot.loader.launch.JarLauncher"

Write-Host "==> fly ssh console --app $App -C `"$javaCmd`"" -ForegroundColor Cyan
Write-Host "    (requires $App to already have at least one running machine - deploy it once first if this is a brand-new environment)" -ForegroundColor DarkGray

& flyctl ssh console --app $App -C $javaCmd
if ($LASTEXITCODE -ne 0) {
  Write-Error "Migration run failed on $App. Check 'fly logs --app $App' and confirm this app's Atlas user (see deploy/fly/atlas-roles.js) has write access to whatever the migration touches."
  exit 1
}

Write-Host "Migration complete on $App." -ForegroundColor Green
exit 0
