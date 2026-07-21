<#
.SYNOPSIS
  One command to bring up the full NO-DOCKER local stack: mongo (rs0) -> backend
  (local profile) -> Angular + Tauri client with real inference.

.DESCRIPTION
  Launches mongo.ps1, backend.ps1, and client.ps1 EACH IN ITS OWN PowerShell
  window (so you can read logs and Ctrl-C each independently), gating between
  them: waits for mongo's writable primary before starting the backend, and for
  the backend's /v1/catalog before starting the client.

  Close the three windows (or run .\dev-down.ps1) to stop everything.

  Requires: the ZIP mongod, a JDK+Maven, the Rust real-inference toolchain
  (LIBCLANG/CMake/MSVC), Node, and the base GGUF model. See README.md; override
  any path with the HP_* env vars in _env.ps1.

.PARAMETER SkipClient
  Bring up mongo + backend only (e.g. to run the client yourself, or capture_preview).
#>
[CmdletBinding()]
param([switch]$SkipClient)

. (Join-Path $PSScriptRoot "_env.ps1")

function Start-Component($title, $script, $argList) {
  $cmd = "`$host.UI.RawUI.WindowTitle='$title'; & '$script' $argList"
  Start-Process powershell -ArgumentList @("-NoExit", "-Command", $cmd) | Out-Null
}

function Wait-For($label, [scriptblock]$test, $timeoutSec) {
  Write-Host "==> waiting for $label (up to ${timeoutSec}s)..." -ForegroundColor Cyan
  $deadline = (Get-Date).AddSeconds($timeoutSec)
  while ((Get-Date) -lt $deadline) {
    if (& $test) { Write-Host "    $label OK" -ForegroundColor Green; return $true }
    Start-Sleep -Seconds 3
  }
  Write-Warning "$label did not come up within ${timeoutSec}s - check its window."
  return $false
}

# 1) Mongo (rs0, on our dedicated port)
Start-Component "hp-mongo" (Join-Path $PSScriptRoot "mongo.ps1") ""
Wait-For "mongo rs0 on :$($Hp.MongoPort)" { (mongosh --quiet --port $Hp.MongoPort --eval "try { rs.status().set } catch (e) { '' }" 2>$null) -eq "rs0" } 90 | Out-Null

# 2) Backend (local profile, publishes packages)
Start-Component "hp-backend" (Join-Path $PSScriptRoot "backend.ps1") ""
Wait-For "backend /v1/catalog" {
  try { (Invoke-WebRequest -Uri "http://localhost:8080/v1/catalog" -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200 } catch { $false }
} 240 | Out-Null

# 3) Client (Angular + Tauri real inference)
if (-not $SkipClient) {
  Start-Component "hp-client" (Join-Path $PSScriptRoot "client.ps1") ""
  Write-Host ""
  Write-Host "Client launching in its own window (first real-inference build can take a couple of minutes)." -ForegroundColor Green
} else {
  Write-Host ""
  Write-Host "mongo + backend up; client skipped (-SkipClient)." -ForegroundColor Green
}

Write-Host ""
$windows = if ($SkipClient) { "hp-mongo, hp-backend" } else { "hp-mongo, hp-backend, hp-client" }
Write-Host "Stack windows: $windows. Close them (or .\dev-down.ps1) to stop." -ForegroundColor DarkGray
Write-Host "Backend: http://localhost:8080/v1/catalog   Angular: http://localhost:4200" -ForegroundColor DarkGray
