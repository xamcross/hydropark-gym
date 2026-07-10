<#
.SYNOPSIS
  Set Fly secrets per app, enforcing the trust-zone split from BACKEND-DESIGN
  §6.2 / §11.2 #4 (see deploy/README.md's secret-distribution matrix).

.DESCRIPTION
  - HP_LICENSE_PRIVATE_KEY / HP_LICENSE_PUBLIC_KEY / HP_LICENSE_KID -> issuer ONLY.
  - HP_STRIPE_WEBHOOK_SECRET                                        -> worker ONLY.
  - HP_STRIPE_API_KEY                                               -> api + worker.
  - HP_JWT_PRIVATE_KEY / HP_JWT_KEY_ID                               -> api ONLY.
  - HP_INTERNAL_TOKEN                                                -> api + issuer + worker (same value).
  - MONGODB_URI                                                      -> api + issuer + worker, DIFFERENT
    values per zone (different Atlas users - see atlas-roles.js). This
    script reads MONGODB_URI_API / MONGODB_URI_ISSUER / MONGODB_URI_WORKER,
    one connection string per zone, and never reuses one across zones.

  Internal mTLS (ticket P1-16.9), staged ONLY with -Mtls (opt-in; default OFF so the
  existing token-based deploy is unchanged). Certs are files, so they travel as
  base64 Fly secrets that the fly.*.toml [[files]] blocks decode onto each machine:
  - HP_INTERNAL_MTLS_KEYSTORE_PASSWORD / HP_INTERNAL_MTLS_TRUSTSTORE_PASSWORD -> all three.
  - HP_INTERNAL_MTLS_TRUSTSTORE_B64  (= base64 of truststore.p12)             -> all three.
  - HP_INTERNAL_MTLS_KEYSTORE_B64    (= base64 of THIS zone's own .p12)        -> per zone,
    read from HP_INTERNAL_MTLS_API_P12_B64 / _ISSUER_P12_B64 / _WORKER_P12_B64. A zone is
    NEVER given another zone's keystore (each reads only its own), same rule as the
    license key. Produce a base64 with, e.g.:
      $env:HP_INTERNAL_MTLS_ISSUER_P12_B64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes("..\certs\issuer.p12"))

  This script REFUSES to set HP_LICENSE_PRIVATE_KEY or HP_LICENSE_PUBLIC_KEY
  on the api app - that check runs unconditionally, even if you edit the
  variable-assignment code below, because it re-inspects the built
  hashtable rather than trusting that the assignment code was written
  correctly.

  All values are read from environment variables - this script never
  hardcodes or prompts for a secret, and never echoes one back
  (`flyctl secrets set --stage` only prints which NAMES were staged).
  Export the variables first, e.g. from PowerShell:
    $env:HP_INTERNAL_TOKEN = "..."
    $env:HP_JWT_PRIVATE_KEY = "..."
    $env:HP_LICENSE_KID = "..."
    $env:HP_LICENSE_PRIVATE_KEY = "..."      # from deploy/scripts/generate-keys.ps1
    $env:HP_LICENSE_PUBLIC_KEY = "..."       # from deploy/scripts/generate-keys.ps1
    $env:HP_STRIPE_API_KEY = "sk_live_..."
    $env:HP_STRIPE_WEBHOOK_SECRET = "whsec_..."
    $env:MONGODB_URI_API = "mongodb+srv://hp_api_user:...@cluster/hydropark"
    $env:MONGODB_URI_ISSUER = "mongodb+srv://hp_issuer_user:...@cluster/hydropark"
    $env:MONGODB_URI_WORKER = "mongodb+srv://hp_worker_user:...@cluster/hydropark"
  (Get the three Atlas users/passwords from deploy/fly/atlas-roles.js's output.)

  `--stage` applies the secrets on the NEXT deploy rather than forcing an
  immediate machine restart, so secret rollout and code rollout happen
  together via deploy-cloud.ps1.

.PARAMETER App
  Only bootstrap one app's secrets: api, issuer, worker, or all (default).
#>
[CmdletBinding()]
param(
  [ValidateSet("api", "issuer", "worker", "all")]
  [string]$App = "all",

  # Opt-in: also stage the internal mTLS cert secrets (ticket P1-16.9). Default OFF
  # so the token-based deploy path is unchanged unless you ask for mTLS.
  [switch]$Mtls
)

$ErrorActionPreference = "Stop"

$APP_NAMES = @{
  api    = "hydropark-api"
  issuer = "hydropark-issuer"
  worker = "hydropark-worker"
}

function Get-RequiredEnv([string]$name) {
  $v = [System.Environment]::GetEnvironmentVariable($name)
  if ([string]::IsNullOrWhiteSpace($v)) {
    throw "Environment variable '$name' is not set. Export it before running this script (see the header comment for the full list)."
  }
  return $v
}

function Get-OptionalEnv([string]$name) {
  return [System.Environment]::GetEnvironmentVariable($name)
}

function Set-FlySecrets([string]$flyAppName, [hashtable]$secrets) {
  if ($secrets.Count -eq 0) {
    Write-Host "==> $flyAppName - nothing to set, skipping." -ForegroundColor DarkGray
    return
  }
  $pairs = @()
  foreach ($k in $secrets.Keys) {
    $pairs += "$k=$($secrets[$k])"
  }
  Write-Host "==> flyctl secrets set --app $flyAppName --stage <$($secrets.Keys -join ', ')>" -ForegroundColor Cyan
  & flyctl secrets set --app $flyAppName --stage @pairs
  if ($LASTEXITCODE -ne 0) {
    throw "flyctl secrets set failed for $flyAppName"
  }
}

if (-not (Get-Command flyctl -ErrorAction SilentlyContinue)) {
  throw "flyctl is not on PATH. Install it (https://fly.io/docs/flyctl/install/) and run 'fly auth login' first."
}

# --- Build the per-zone secret sets. -----------------------------------
$internalToken = Get-RequiredEnv "HP_INTERNAL_TOKEN"

$apiSecrets = @{
  HP_INTERNAL_TOKEN = $internalToken
  HP_JWT_PRIVATE_KEY = (Get-RequiredEnv "HP_JWT_PRIVATE_KEY")
  MONGODB_URI = (Get-RequiredEnv "MONGODB_URI_API")
}
$stripeApiKey = Get-OptionalEnv "HP_STRIPE_API_KEY"
if ($stripeApiKey) {
  $apiSecrets["HP_STRIPE_API_KEY"] = $stripeApiKey
}

$issuerSecrets = @{
  HP_INTERNAL_TOKEN = $internalToken
  HP_LICENSE_KID = (Get-RequiredEnv "HP_LICENSE_KID")
  HP_LICENSE_PRIVATE_KEY = (Get-RequiredEnv "HP_LICENSE_PRIVATE_KEY")
  HP_LICENSE_PUBLIC_KEY = (Get-RequiredEnv "HP_LICENSE_PUBLIC_KEY")
  MONGODB_URI = (Get-RequiredEnv "MONGODB_URI_ISSUER")
}

$workerSecrets = @{
  HP_INTERNAL_TOKEN = $internalToken
  HP_STRIPE_WEBHOOK_SECRET = (Get-RequiredEnv "HP_STRIPE_WEBHOOK_SECRET")
  MONGODB_URI = (Get-RequiredEnv "MONGODB_URI_WORKER")
}
if ($stripeApiKey) {
  $workerSecrets["HP_STRIPE_API_KEY"] = $stripeApiKey
}

# --- Optional: internal mTLS cert secrets (opt-in via -Mtls, ticket P1-16.9). ---
# Passwords + the CA truststore go to all three zones; each zone gets ONLY its own
# identity keystore, read from a per-zone env var. Certs travel base64-encoded and
# the fly.*.toml [[files]] blocks decode them onto each machine at /certs.
if ($Mtls) {
  $mtlsKsPw = Get-RequiredEnv "HP_INTERNAL_MTLS_KEYSTORE_PASSWORD"
  $mtlsTsPw = Get-RequiredEnv "HP_INTERNAL_MTLS_TRUSTSTORE_PASSWORD"
  $mtlsTrustB64 = Get-RequiredEnv "HP_INTERNAL_MTLS_TRUSTSTORE_B64"

  foreach ($set in @($apiSecrets, $issuerSecrets, $workerSecrets)) {
    $set["HP_INTERNAL_MTLS_KEYSTORE_PASSWORD"] = $mtlsKsPw
    $set["HP_INTERNAL_MTLS_TRUSTSTORE_PASSWORD"] = $mtlsTsPw
    $set["HP_INTERNAL_MTLS_TRUSTSTORE_B64"] = $mtlsTrustB64
  }
  $apiSecrets["HP_INTERNAL_MTLS_KEYSTORE_B64"] = (Get-RequiredEnv "HP_INTERNAL_MTLS_API_P12_B64")
  $issuerSecrets["HP_INTERNAL_MTLS_KEYSTORE_B64"] = (Get-RequiredEnv "HP_INTERNAL_MTLS_ISSUER_P12_B64")
  $workerSecrets["HP_INTERNAL_MTLS_KEYSTORE_B64"] = (Get-RequiredEnv "HP_INTERNAL_MTLS_WORKER_P12_B64")

  # A zone must carry only its OWN identity. Identical base64 across two zones is a
  # paste error - refuse rather than cross-provision one zone's key onto another.
  $ksVals = @(
    $apiSecrets["HP_INTERNAL_MTLS_KEYSTORE_B64"],
    $issuerSecrets["HP_INTERNAL_MTLS_KEYSTORE_B64"],
    $workerSecrets["HP_INTERNAL_MTLS_KEYSTORE_B64"])
  if (($ksVals | Select-Object -Unique).Count -ne 3) {
    throw "REFUSING: two zones were given the same mTLS keystore. Each zone needs its OWN .p12 (api/issuer/worker). Aborting without setting anything."
  }
  Write-Host "==> -Mtls: staging internal mTLS keystore/truststore secrets per zone." -ForegroundColor Cyan
}

# --- Hard refusal: never let the license key anywhere near api or worker. ---
# Re-checks the actual hashtable contents, not the assignment code above, so
# this still catches a future edit that accidentally adds the key to the
# wrong zone.
if ($apiSecrets.ContainsKey("HP_LICENSE_PRIVATE_KEY") -or $apiSecrets.ContainsKey("HP_LICENSE_PUBLIC_KEY")) {
  throw "REFUSING: HP_LICENSE_PRIVATE_KEY/HP_LICENSE_PUBLIC_KEY must never be set on the api app. Aborting without setting anything."
}
if ($workerSecrets.ContainsKey("HP_LICENSE_PRIVATE_KEY") -or $workerSecrets.ContainsKey("HP_LICENSE_PUBLIC_KEY")) {
  throw "REFUSING: HP_LICENSE_PRIVATE_KEY/HP_LICENSE_PUBLIC_KEY must never be set on the worker app. Aborting without setting anything."
}
if ($apiSecrets.ContainsKey("HP_STRIPE_WEBHOOK_SECRET") -or $issuerSecrets.ContainsKey("HP_STRIPE_WEBHOOK_SECRET")) {
  throw "REFUSING: HP_STRIPE_WEBHOOK_SECRET must never be set on api or issuer. Aborting without setting anything."
}

# --- Hard refusal: the migrator identity never reaches a running app. -------
# hp_migrator_user is the only principal that can create or drop an index, and
# several correctness invariants in this system are enforced by exactly one
# unique index and nothing else (webhook dedupe; one active license per device).
# A zone that can drop an index can silently disable an invariant. Inspect the
# hashtable VALUES, not just the keys, because the mistake looks like pasting the
# wrong connection string into MONGODB_URI_API.
foreach ($pair in @(
    @{ Name = "api";    Secrets = $apiSecrets },
    @{ Name = "issuer"; Secrets = $issuerSecrets },
    @{ Name = "worker"; Secrets = $workerSecrets })) {
  if ($pair.Secrets.ContainsKey("MONGODB_URI_MIGRATOR")) {
    throw "REFUSING: MONGODB_URI_MIGRATOR must never be set on any app (found on $($pair.Name)). Aborting without setting anything."
  }
  foreach ($v in $pair.Secrets.Values) {
    if ("$v" -like "*hp_migrator_user*") {
      throw "REFUSING: the $($pair.Name) app was given hp_migrator_user's connection string. That identity can create and drop indexes; no running zone may. Aborting without setting anything."
    }
  }
}

# --- Apply. --------------------------------------------------------------
if ($App -eq "all" -or $App -eq "api") {
  Set-FlySecrets $APP_NAMES["api"] $apiSecrets
}
if ($App -eq "all" -or $App -eq "issuer") {
  Set-FlySecrets $APP_NAMES["issuer"] $issuerSecrets
}
if ($App -eq "all" -or $App -eq "worker") {
  Set-FlySecrets $APP_NAMES["worker"] $workerSecrets
}

Write-Host ""
Write-Host "Secrets staged. Run deploy/fly/deploy-cloud.ps1 (issuer, worker, then api) to roll them out." -ForegroundColor Green
exit 0
