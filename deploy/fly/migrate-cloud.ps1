<#
.SYNOPSIS
  Apply schema migrations (and optionally seed the catalog) against a cloud
  MongoDB, as hp_migrator_user.

.DESCRIPTION
  Migrations do NOT run as part of a Fly deploy. There is no
  [deploy] release_command, on purpose:

    * A release_command on hydropark-api would run with that app's MONGODB_URI,
      i.e. as hp_api_user - which is read-only on `grants` and holds no
      createIndex privilege anywhere (deploy/fly/atlas-roles.js, asserted by
      deploy/fly/privcheck.js). Migrations create indexes on `grants`, `users`
      and `licenses`.
    * Making that work would mean granting the public tier the right to create,
      and therefore drop, the unique indexes that enforce webhook dedupe and
      one-active-license-per-device. That is the privilege the whole role split
      exists to withhold.

  So migrations are an operator action, run with an identity no app ever holds.
  Run this BEFORE the first deploy, and before any deploy whose image contains a
  new changeset.

  The job runs the backend image locally against the remote database. It applies
  only pending changesets (the `schema_migrations` ledger is authoritative), takes
  a lock so two operators cannot race, and exits 0.

.PARAMETER MigratorUri
  Full mongodb+srv:// URI for hp_migrator_user. Defaults to $env:MONGODB_URI_MIGRATOR.
  NEVER store this as a Fly secret.

.PARAMETER Seed
  Also run the catalog seeder. Off by default: seeding a production catalog is
  rarely what you want, and CatalogSeeder upserts by _id, so re-seeding silently
  overwrites live pricing.

.PARAMETER Image
  Backend image to run. Defaults to hydropark-backend:local; build it with
  `docker compose -f ../docker-compose.yml build api`.

.EXAMPLE
  $env:MONGODB_URI_MIGRATOR = "mongodb+srv://hp_migrator_user:...@cluster0.abcde.mongodb.net/hydropark?retryWrites=true&w=majority"
  ./migrate-cloud.ps1

.EXAMPLE
  ./migrate-cloud.ps1 -Seed        # first run against an empty cluster
#>
[CmdletBinding()]
param(
  [string] $MigratorUri = $env:MONGODB_URI_MIGRATOR,
  [switch] $Seed,
  [string] $Image = "hydropark-backend:local"
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($MigratorUri)) {
  throw "No migrator URI. Set MONGODB_URI_MIGRATOR or pass -MigratorUri. This is hp_migrator_user's URI, printed by atlas-roles.js - not any app's."
}

# Guard against the single most damaging mistake this script could enable.
foreach ($wrong in @("hp_api_user", "hp_worker_user", "hp_issuer_user")) {
  if ($MigratorUri -like "*$wrong*") {
    throw "That URI belongs to $wrong, not hp_migrator_user. A zone identity cannot create indexes, and must never be able to."
  }
}

docker image inspect $Image *> $null
if ($LASTEXITCODE -ne 0) {
  Write-Host "Image '$Image' not found. Build it first:" -ForegroundColor Yellow
  Write-Host "  docker compose -f $PSScriptRoot/../docker-compose.yml build api"
  throw "missing image"
}

$seedEnabled = "false"
if ($Seed) { $seedEnabled = "true" }

# Report the identity we are ACTUALLY using, parsed from the URI - not the one we
# wish we were using. Bootstrapping a brand-new Atlas cluster legitimately runs as
# a temporary atlasAdmin, before hp_migrator_user exists.
$actualUser = "(unknown)"
if ($MigratorUri -match "://([^:]+):") { $actualUser = $Matches[1] }

Write-Host ""
Write-Host "Applying migrations as '$actualUser' (seed=$seedEnabled)" -ForegroundColor Cyan
if ($actualUser -ne "hp_migrator_user") {
  Write-Host "NOTE: not hp_migrator_user. Acceptable only for the first run against an empty cluster, before atlas-provision.ps1 has created the scoped identities." -ForegroundColor Yellow
}
Write-Host "Only pending changesets run; schema_migrations is authoritative."
Write-Host ""

# All three zones disabled, no web server: this is a one-shot job that exits 0.
docker run --rm `
  -e MONGODB_URI="$MigratorUri" `
  -e SPRING_PROFILES_ACTIVE="docker" `
  -e HP_API_ENABLED="false" `
  -e HP_ISSUER_ENABLED="false" `
  -e HP_WORKER_ENABLED="false" `
  -e HP_MIGRATION_ENABLED="true" `
  -e HP_MIGRATION_EXIT_AFTER="true" `
  -e HP_SEED_ENABLED="$seedEnabled" `
  -e SPRING_MAIN_WEB_APPLICATION_TYPE="none" `
  -e HP_INTERNAL_TOKEN="unused-by-migration" `
  $Image

if ($LASTEXITCODE -ne 0) {
  throw "Migration job exited $LASTEXITCODE. The schema was NOT advanced; deploy nothing until this is green."
}

Write-Host ""
Write-Host "Migrations applied." -ForegroundColor Green
Write-Host "Next: verify the role split still holds against this cluster -"
Write-Host "  mongosh '<hp_api_user uri>'    --eval `"var ROLE='hp_api'`"    --file privcheck.js"
Write-Host "  mongosh '<hp_worker_user uri>' --eval `"var ROLE='hp_worker'`" --file privcheck.js"
Write-Host "  mongosh '<hp_issuer_user uri>' --eval `"var ROLE='hp_issuer'`" --file privcheck.js"
