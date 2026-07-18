[CmdletBinding()] param([switch]$KeepUp)
. (Join-Path $PSScriptRoot '_env.ps1')
Write-Host '==> ensuring stack (mongo/backend/ng) is up' -ForegroundColor Cyan
& (Join-Path $PSScriptRoot 'dev-up.ps1')
$env:HYDROPARK_APP_VERSION = '1.0.0'
# The mock-inference app still runs the REAL fail-closed installer, so it needs the
# package-signing trust set (same value client.ps1 exports) or EVERY skill install
# rejects with "We couldn't install this skill." (empty trust set -> UnknownKid).
# Inherited by the app the Node lifecycle spawns (it spreads process.env).
$env:HYDROPARK_PACKAGE_SIGNING_KEYS = Get-HpPackageKeys
Write-Host '==> running Playwright E2E runner' -ForegroundColor Cyan
Push-Location (Join-Path $Hp.RepoRoot 'client\e2e')
try { & npm run e2e; $code = $LASTEXITCODE } finally { Pop-Location }
if (-not $KeepUp) { Get-Process hydropark -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue }
exit $code
