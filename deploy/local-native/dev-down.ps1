<#
.SYNOPSIS
  Best-effort stop of the no-Docker local stack started by dev-up.ps1.

.DESCRIPTION
  Cleanly shuts down the rs0 mongod (via mongosh admin shutdown) and stops the
  running Tauri app (hydropark.exe). The backend (mvn/java) and Angular (node)
  run in their own windows — close those windows or Ctrl-C them; this script
  does NOT blanket-kill java/node, to avoid taking down unrelated processes.
#>
[CmdletBinding()]
param()

. (Join-Path $PSScriptRoot "_env.ps1")

Write-Host "==> shutting down mongo rs0..." -ForegroundColor Cyan
try {
  mongosh --quiet --eval "db.getSiblingDB('admin').shutdownServer()" 2>$null | Out-Null
} catch { }
# If it didn't stop (or mongosh absent), fall back to stopping our ZIP mongod.
Get-Process -Name mongod -ErrorAction SilentlyContinue | Where-Object {
  $_.Path -eq $Hp.MongodBin
} | Stop-Process -Force -ErrorAction SilentlyContinue

Write-Host "==> stopping the Tauri app (hydropark.exe)..." -ForegroundColor Cyan
Get-Process -Name hydropark -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "mongo + app stopped. Close the hp-backend and hp-client windows (Ctrl-C) to stop the backend and Angular dev server." -ForegroundColor DarkGray
