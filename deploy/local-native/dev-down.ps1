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

Write-Host "==> shutting down our rs0 on :$($Hp.MongoPort)..." -ForegroundColor Cyan
try {
  mongosh --quiet --port $Hp.MongoPort --eval "db.getSiblingDB('admin').shutdownServer()" 2>$null | Out-Null
} catch { }
# If it didn't stop (or mongosh absent), fall back to stopping our ZIP mongod on
# our port (leaves any MSI-service mongod on :27017 alone).
Get-CimInstance Win32_Process -Filter "Name='mongod.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match "--port $($Hp.MongoPort)" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

Write-Host "==> stopping the Tauri app (hydropark.exe)..." -ForegroundColor Cyan
Get-Process -Name hydropark -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

# Free :8080 by stopping whatever listens there (the backend) - targeted by port,
# so we never blanket-kill unrelated java. A leftover backend here is exactly
# what blocks a subsequent dev-up ("Port 8080 was already in use").
Write-Host "==> freeing :8080 (backend listener, if any)..." -ForegroundColor Cyan
$pid8080 = (Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess
if ($pid8080) {
  $proc = Get-Process -Id $pid8080 -ErrorAction SilentlyContinue
  Write-Host "    stopping PID $pid8080 ($($proc.ProcessName)) on :8080" -ForegroundColor DarkGray
  Stop-Process -Id $pid8080 -Force -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "mongo + app + backend(:8080) stopped. Close the hp-client window (Ctrl-C) to stop the Angular dev server." -ForegroundColor DarkGray
