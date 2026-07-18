<#
.SYNOPSIS
  Start local MongoDB as a single-node replica set (rs0) — the NO-DOCKER path.

.DESCRIPTION
  The backend uses multi-document transactions, which require a replica set;
  a standalone mongod is rejected. This runs mongod in the FOREGROUND (Ctrl-C
  to stop) against a repo-local data dir, and initiates rs0 on first start.

  The MSI-installed MongoDB is avoided on purpose (its installer hangs on the
  bundled Compass, and it registers an auto-start service that grabs :27017 as
  a NON-replica-set standalone). Use the ZIP mongod instead (see README).
#>
[CmdletBinding()]
param()

. (Join-Path $PSScriptRoot "_env.ps1")

Assert-Path $Hp.MongodBin "mongod.exe (ZIP MongoDB)"
New-Item -ItemType Directory -Force $Hp.MongoDataDir | Out-Null

Write-Host "==> mongod --replSet rs0 --dbpath $($Hp.MongoDataDir) --port 27017" -ForegroundColor Cyan

# Kick off a one-shot initiator that waits for the port, then initiates rs0 if
# it isn't configured yet. Runs in the background so mongod can stay foreground.
Start-Job -ScriptBlock {
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 1
    try {
      $primary = mongosh --quiet --eval "db.hello().isWritablePrimary" 2>$null
      if ($primary -eq "true") { return }
      $r = mongosh --quiet --eval "try { rs.initiate(); 'initiated' } catch (e) { e.codeName }" 2>$null
      if ($r -match "initiated|AlreadyInitialized") { return }
    } catch { }
  }
} | Out-Null

# Foreground mongod. This blocks; Ctrl-C stops it.
& $Hp.MongodBin --replSet rs0 --dbpath $Hp.MongoDataDir --port 27017 --bind_ip 127.0.0.1
