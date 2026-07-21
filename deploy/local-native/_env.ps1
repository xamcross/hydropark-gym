<#
  Shared environment for the NO-DOCKER local dev loop (dot-sourced by the other
  scripts here). This is the recipe proven on this machine during the
  demo-readiness push - see deploy/local-native/README.md. It is deliberately
  separate from deploy/local/*.ps1, which is the Docker-compose path.

  PowerShell 5.1 compatible (no &&/||, no ternary).

  Every machine-specific path can be overridden with an env var before running,
  so this isn't brittle:
    $env:HP_MONGOD_BIN, $env:HP_LIBCLANG_PATH, $env:HP_CMAKE_BIN,
    $env:HP_VCVARS, $env:HYDROPARK_MODEL_PATH
#>

$ErrorActionPreference = "Stop"

# --- repo layout -----------------------------------------------------------
$Hp = @{}
$Hp.LocalNativeDir = $PSScriptRoot
$Hp.DeployDir      = Split-Path -Parent $PSScriptRoot
$Hp.RepoRoot       = Split-Path -Parent $Hp.DeployDir
$Hp.BackendDir     = Join-Path $Hp.RepoRoot "backend"
$Hp.WebDir         = Join-Path $Hp.RepoRoot "client\web"
$Hp.TauriDir       = Join-Path $Hp.RepoRoot "client\src-tauri"
# We run rs0 on 27018 (NOT the default 27017) on purpose: the MSI MongoDB
# service, if installed, squats :27017 as a STANDALONE (not a replica set) and
# can't be stopped without elevation. Using 27018 sidesteps it with zero admin.
$Hp.MongoPort      = 27018
$Hp.MongoDataDir   = Join-Path $Hp.RepoRoot ".mongo-native"
$Hp.EnvGenerated   = Join-Path $Hp.DeployDir ".env.generated"
$Hp.MongoUri       = "mongodb://localhost:27018/hydropark?replicaSet=rs0"

# --- machine-specific tool paths (detected, overridable) -------------------
function Resolve-First($candidates) {
  foreach ($c in $candidates) {
    if ($c -and (Test-Path $c)) { return $c }
  }
  return $null
}

$Hp.MongodBin = if ($env:HP_MONGOD_BIN) { $env:HP_MONGOD_BIN } else {
  $onPath = (Get-Command mongod -ErrorAction SilentlyContinue)
  if ($onPath) { $onPath.Source } else {
    Resolve-First @(
      "C:\Users\xamcr\tools\mongodb-win32-x86_64-windows-8.3.4\bin\mongod.exe",
      "C:\Program Files\MongoDB\Server\8.3\bin\mongod.exe"
    )
  }
}

$Hp.LibclangPath = if ($env:HP_LIBCLANG_PATH) { $env:HP_LIBCLANG_PATH } else {
  Resolve-First @("C:\Users\xamcr\AppData\Roaming\Python\Python314\site-packages\clang\native")
}

$Hp.CmakeBin = if ($env:HP_CMAKE_BIN) { $env:HP_CMAKE_BIN } else {
  $onPath = (Get-Command cmake -ErrorAction SilentlyContinue)
  if ($onPath) { Split-Path -Parent $onPath.Source } else {
    Resolve-First @("C:\Program Files\CMake\bin")
  }
}

$Hp.Vcvars = if ($env:HP_VCVARS) { $env:HP_VCVARS } else {
  Resolve-First @(
    "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat",
    "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat"
  )
}

$Hp.ModelPath = if ($env:HYDROPARK_MODEL_PATH) { $env:HYDROPARK_MODEL_PATH } else {
  Resolve-First @((Join-Path $Hp.RepoRoot "client\models\qwen2.5-7b-instruct-q4_k_m.gguf"))
}

# --- helpers ---------------------------------------------------------------

# Load deploy/.env.generated KEY=VALUE lines into the current process env.
# Generates it first (via deploy/scripts/generate-keys.ps1) if missing.
function Import-HpEnv {
  if (-not (Test-Path $Hp.EnvGenerated)) {
    Write-Host "==> $($Hp.EnvGenerated) missing - generating signing keys..." -ForegroundColor Yellow
    $gen = Join-Path $Hp.DeployDir "scripts\generate-keys.ps1"
    & $gen | Out-File $Hp.EnvGenerated -Encoding ascii
  }
  Get-Content $Hp.EnvGenerated | Where-Object { $_ -match '^[A-Z0-9_]+=' } | ForEach-Object {
    $pair = $_ -split '=', 2
    Set-Item -Path ("env:" + $pair[0]) -Value $pair[1]
  }
}

# The package-signing pubkey the client trusts, in the `kid=spkiB64` form
# HYDROPARK_PACKAGE_SIGNING_KEYS expects (fail-closed if absent).
function Get-HpPackageKeys {
  Import-HpEnv
  return "$($env:HP_PACKAGE_SIGNING_KID)=$($env:HP_PACKAGE_SIGNING_PUBLIC_KEY)"
}

# The Angular dev server both app builds load their frontend from: it is the
# Tauri devUrl, and the mock-inference binary the E2E harness spawns is built
# without `custom-protocol`, so it has no bundled assets to fall back on.
function Test-HpNgUp {
  try { (Invoke-WebRequest -Uri "http://localhost:4200" -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200 }
  catch { $false }
}

# Start ng in its own window if :4200 is cold; $true once it answers. Idempotent,
# so callers can just ask for it rather than tracking whose job it was.
function Start-HpNgServe($timeoutSec = 120) {
  if (Test-HpNgUp) { return $true }
  Write-Host "==> starting Angular dev server (npm run start) in a new window..." -ForegroundColor Cyan
  Start-Process powershell -ArgumentList @(
    "-NoExit", "-Command",
    "`$host.UI.RawUI.WindowTitle='hp-ng'; Set-Location '$($Hp.WebDir)'; npm run start"
  ) | Out-Null
  Write-Host "    waiting for http://localhost:4200 ..." -ForegroundColor DarkGray
  $deadline = (Get-Date).AddSeconds($timeoutSec)
  while ((Get-Date) -lt $deadline -and -not (Test-HpNgUp)) { Start-Sleep -Seconds 2 }
  return (Test-HpNgUp)
}

# Stop the E2E harness's app without touching a developer's client. Only the
# harness passes --remote-debugging-port, so whatever holds :9222 is by
# construction one of its apps -- but the listener is a WebView2 CHILD, so walk
# up to the hydropark parent and kill THAT pid. Never match by image name: that
# also kills a client.ps1 run. Mirrors stopApp() in client/e2e/src/app-lifecycle.ts.
function Stop-HpCdpApp {
  $conn = Get-NetTCPConnection -LocalPort 9222 -State Listen -ErrorAction SilentlyContinue
  if (-not $conn) { return }
  $proc = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $conn[0].OwningProcess)
  if ($proc.Name -ne "hydropark.exe") {
    $proc = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $proc.ParentProcessId)
  }
  if ($proc -and $proc.Name -eq "hydropark.exe") {
    Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
  }
}

function Assert-Path($value, $label) {
  if (-not $value) {
    throw "$label not found. Set its override env var (see deploy/local-native/README.md) and retry."
  }
}
