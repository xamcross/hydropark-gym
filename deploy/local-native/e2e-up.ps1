[CmdletBinding()] param([switch]$KeepUp)
. (Join-Path $PSScriptRoot '_env.ps1')
Write-Host '==> ensuring stack (mongo/backend/ng) is up' -ForegroundColor Cyan
# -SkipClient is LOAD-BEARING, not a speed-up: client.ps1 runs `cargo run` with
# REAL inference, which rebuilds client/src-tauri/target/debug/hydropark.exe --
# the very binary the harness launches -- and holds the target/ lock while it
# does. Let it run alongside and the suite relaunches a real-inference binary
# mid-suite and stalls (2026-07-21: a run died on paid-buy, leaving an orphaned
# app and a stray `inference backend = real` line in artifacts/app-stderr.log).
# The harness builds and spawns its OWN mock binary; it needs mongo, the
# backend, and ng -- never the real client.
& (Join-Path $PSScriptRoot 'dev-up.ps1') -SkipClient
# ...but it DOES need :4200: the mock binary is built without `custom-protocol`,
# so it loads the frontend from the dev server, not from bundled assets.
if (-not (Start-HpNgServe)) {
  throw 'Angular dev server (:4200) did not come up - the app would have no frontend to load.'
}
$env:HYDROPARK_APP_VERSION = '1.0.0'
# The mock-inference app still runs the REAL fail-closed installer, so it needs the
# package-signing trust set (same value client.ps1 exports) or EVERY skill install
# rejects with "We couldn't install this skill." (empty trust set -> UnknownKid).
# Inherited by the app the Node lifecycle spawns (it spreads process.env).
$env:HYDROPARK_PACKAGE_SIGNING_KEYS = Get-HpPackageKeys
Write-Host '==> running Playwright E2E runner' -ForegroundColor Cyan
Push-Location (Join-Path $Hp.RepoRoot 'client\e2e')
try { & npm run e2e; $code = $LASTEXITCODE } finally { Pop-Location }
# Belt for a harness that died before its own stopApp(); scoped by CDP port so it
# never takes down a developer's client.ps1 run.
if (-not $KeepUp) { Stop-HpCdpApp }
exit $code
