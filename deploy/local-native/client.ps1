<#
.SYNOPSIS
  Run the Hydropark Tauri client locally with REAL inference.

.DESCRIPTION
  Ensures the Angular dev server (http://localhost:4200) is up, sets the
  real-inference build env (LIBCLANG_PATH, CMake, optional vcvars) and the
  package-signing trust set the installer verifies against, then runs the app
  in the FOREGROUND (`cargo run --bin hydropark`; close the window to stop).

  Needs the backend up for catalog/purchase/install to work — run backend.ps1
  (or dev-up.ps1) first. The base model must exist (client/models/*.gguf or
  $env:HYDROPARK_MODEL_PATH).

.PARAMETER SkipNgServe
  Assume an Angular dev server is already running on :4200; don't start one.
#>
[CmdletBinding()]
param([switch]$SkipNgServe)

. (Join-Path $PSScriptRoot "_env.ps1")

Assert-Path $Hp.LibclangPath "libclang native dir (LIBCLANG_PATH)"
Assert-Path $Hp.ModelPath "Qwen GGUF model (client/models or HYDROPARK_MODEL_PATH)"

# --- Angular dev server (Tauri devUrl = http://localhost:4200) --------------
function Test-NgUp {
  try { (Invoke-WebRequest -Uri "http://localhost:4200" -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200 }
  catch { $false }
}

if (-not $SkipNgServe -and -not (Test-NgUp)) {
  Write-Host "==> starting Angular dev server (npm run start) in a new window..." -ForegroundColor Cyan
  Start-Process powershell -ArgumentList @(
    "-NoExit", "-Command",
    "Set-Location '$($Hp.WebDir)'; npm run start"
  ) | Out-Null
  Write-Host "    waiting for http://localhost:4200 ..." -ForegroundColor DarkGray
  $deadline = (Get-Date).AddSeconds(120)
  while ((Get-Date) -lt $deadline -and -not (Test-NgUp)) { Start-Sleep -Seconds 2 }
  if (-not (Test-NgUp)) { Write-Warning "Angular dev server not up yet; the app window may show a connection error until it is." }
}

# --- real-inference build env ----------------------------------------------
$env:LIBCLANG_PATH = $Hp.LibclangPath
if ($Hp.CmakeBin) { $env:PATH = "$env:PATH;$($Hp.CmakeBin)" }
$env:HYDROPARK_MODEL_PATH = $Hp.ModelPath
$env:HYDROPARK_PACKAGE_SIGNING_KEYS = Get-HpPackageKeys

# Best-effort: import MSVC vars so a clean/from-scratch link works from a plain
# shell. Harmless if the crate is already built (cargo just relinks).
if ($Hp.Vcvars) {
  Write-Host "==> importing MSVC env from vcvars64.bat" -ForegroundColor DarkGray
  cmd /c "call `"$($Hp.Vcvars)`" >nul 2>&1 && set" | ForEach-Object {
    if ($_ -match '^([^=]+)=(.*)$') { Set-Item -Path ("env:" + $matches[1]) -Value $matches[2] }
  }
}

Write-Host "==> cargo run --bin hydropark (real inference)" -ForegroundColor Cyan
Push-Location $Hp.TauriDir
try {
  & cargo run --bin hydropark
} finally {
  Pop-Location
}
