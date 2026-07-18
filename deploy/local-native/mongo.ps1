<#
.SYNOPSIS
  Start local MongoDB as a single-node replica set (rs0) on port 27018 - the
  NO-DOCKER path.

.DESCRIPTION
  The backend uses multi-document transactions, which require a replica set;
  a standalone mongod is rejected ("Expecting replica set member, but found a
  STANDALONE"). We run on **27018** (not the default 27017) so we never fight
  the MSI-installed MongoDB service, which squats :27017 as a standalone and
  can't be stopped without elevation. Runs mongod in the FOREGROUND (Ctrl-C to
  stop) against a repo-local data dir, and initiates rs0 (member localhost:27018)
  on first start.
#>
[CmdletBinding()]
param()

. (Join-Path $PSScriptRoot "_env.ps1")

$port = $Hp.MongoPort

# Reuse an already-running rs0 on our port rather than spawning a second mongod
# that would fail to bind (the exact conflict a re-run otherwise hits). Check the
# actual replica-set name, not just isWritablePrimary (a standalone reports that too).
try {
  $setName = mongosh --quiet --port $port --eval "try { rs.status().set } catch (e) { '' }" 2>$null
  if ($setName -eq "rs0") {
    Write-Host "==> rs0 already up on :$port - reusing it, not starting a second mongod." -ForegroundColor Green
    Write-Host "    (Ctrl-C here does nothing; stop the owning mongod to take it down.)" -ForegroundColor DarkGray
    return
  }
} catch { }

Assert-Path $Hp.MongodBin "mongod.exe (ZIP MongoDB)"
New-Item -ItemType Directory -Force $Hp.MongoDataDir | Out-Null

Write-Host "==> mongod --replSet rs0 --dbpath $($Hp.MongoDataDir) --port $port" -ForegroundColor Cyan

# Background initiator: wait for the port, then initiate rs0 with an explicit
# member host on our port (so the node finds itself). Idempotent. $Hp isn't
# visible inside a job runspace, so the port is passed as an argument.
Start-Job -ArgumentList $port -ScriptBlock {
  param($p)
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 1
    try {
      $set = mongosh --quiet --port $p --eval "try { rs.status().set } catch (e) { '' }" 2>$null
      if ($set -eq "rs0") { return }
      $init = "rs.initiate({_id:'rs0',members:[{_id:0,host:'localhost:$p'}]})"
      $r = mongosh --quiet --port $p --eval "try { $init; 'ok' } catch (e) { e.codeName }" 2>$null
      if ($r -match "ok|AlreadyInitialized") { return }
    } catch { }
  }
} | Out-Null

# Foreground mongod. This blocks; Ctrl-C stops it.
& $Hp.MongodBin --replSet rs0 --dbpath $Hp.MongoDataDir --port $port --bind_ip 127.0.0.1
