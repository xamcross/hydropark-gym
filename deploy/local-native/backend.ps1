<#
.SYNOPSIS
  Run the Hydropark backend locally (Java, no Docker) against the rs0 mongo.

.DESCRIPTION
  Loads signing keys from deploy/.env.generated (generating them on first run),
  points at the local replica set, enables package publishing, and runs the
  `local` Spring profile in the FOREGROUND (Ctrl-C to stop). The `local` profile
  runs all three trust zones in one JVM and seeds the catalog.

  Requires mongo (rs0) already up — run mongo.ps1 first, or use dev-up.ps1 which
  gates on it.
#>
[CmdletBinding()]
param()

. (Join-Path $PSScriptRoot "_env.ps1")

Import-HpEnv
$env:MONGODB_URI = $Hp.MongoUri
$env:HP_PACKAGE_SIGNING_ENABLED = "true"

# Sanity: is our rs0 reachable on its port? (Standalones report isWritablePrimary
# too, so check the replica-set name.)
try {
  $set = mongosh --quiet --port $Hp.MongoPort --eval "try { rs.status().set } catch (e) { '' }" 2>$null
  if ($set -ne "rs0") {
    Write-Warning "rs0 not reachable on :$($Hp.MongoPort) yet. Start mongo.ps1 first (or run dev-up.ps1)."
  }
} catch {
  Write-Warning "Could not reach mongo via mongosh on :$($Hp.MongoPort). Ensure mongo.ps1 is running."
}

Write-Host "==> mvn spring-boot:run (profile=local, publish-packages=true)" -ForegroundColor Cyan
Push-Location $Hp.BackendDir
try {
  & mvn spring-boot:run "-Dspring-boot.run.profiles=local" "-Dspring-boot.run.arguments=--hydropark.seed.publish-packages=true"
} finally {
  Pop-Location
}
