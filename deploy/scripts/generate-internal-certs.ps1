<#
.SYNOPSIS
  Generate the internal mTLS PKI for the api->issuer / api->worker hop
  (BACKEND-DESIGN §6.2, ticket P1-16.9). .ps1 twin of generate-internal-certs.sh.

.DESCRIPTION
  Creates, in deploy/certs/ (override with -OutDir):

    ca.crt / ca.key            a private CA (self-signed, CA:TRUE)
    api.p12 / issuer.p12 / worker.p12
                               one PKCS12 identity keystore PER ZONE (cert+key+CA
                               chain). On api it is the CLIENT cert; on issuer/worker
                               the SERVER cert. serverAuth+clientAuth EKU, zone DNS
                               names as SANs.
    truststore.p12             the CA as a trustedCertEntry - SAME file on every zone.
    <zone>.crt / <zone>.key    PEM copies for inspection.

  ****************************************************************************
  ** The .key/.p12 files are SECRETS. They are gitignored. Never commit or  **
  ** log them. Regenerate per environment (dev/staging/prod) - never share  **
  ** a CA across environments (same rule as the license keys).              **
  ****************************************************************************

  Prefers openssl (Git Bash / native). Falls back to the JDK's keytool, which is
  always present with Java 21. keytool is required either way (it builds the
  truststore). Only the KEY=VALUE env lines go to the output stream; banners use
  Write-Host/Write-Warning (excluded from a plain `|` pipe), so
  `.\generate-internal-certs.ps1 | Out-File mtls.env -Encoding ascii` captures
  only the env lines.

.PARAMETER OutDir
  Where to write the PKI. Default: deploy/certs (next to deploy/scripts).

.PARAMETER Password
  Keystore/truststore password. Default: env HP_INTERNAL_MTLS_PASSWORD, else "changeit".

.PARAMETER Days
  Validity in days. Default: 3650.
#>
[CmdletBinding()]
param(
  [string]$OutDir,
  [string]$Password,
  [int]$Days = 3650
)

$ErrorActionPreference = "Stop"

function Test-CommandExists([string]$name) {
  return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $OutDir) { $OutDir = Join-Path $scriptDir "..\certs" }
if (-not $Password) {
  $envPw = [System.Environment]::GetEnvironmentVariable("HP_INTERNAL_MTLS_PASSWORD")
  if ([string]::IsNullOrWhiteSpace($envPw)) { $Password = "changeit" } else { $Password = $envPw }
}
$zones = @("api", "issuer", "worker")

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$OutDir = (Resolve-Path $OutDir).Path

Write-Warning "The generated .key/.p12 files are secrets - never commit them (they are gitignored)."
if ($Password -eq "changeit") {
  Write-Warning "Using the default keystore password 'changeit'. Override with -Password (or HP_INTERNAL_MTLS_PASSWORD) for anything but local dev."
}
Write-Host ""

if (-not (Test-CommandExists "keytool")) {
  throw "keytool (from the JDK) is required to build truststore.p12 but is not on PATH."
}

function Get-ZoneSan([string]$z) {
  return "DNS:localhost,DNS:$z,DNS:hydropark-$z,DNS:hydropark-$z.internal,DNS:hydropark-$z.flycast,IP:127.0.0.1"
}

# Work inside the output dir with relative filenames (mirrors the .sh twin).
Push-Location $OutDir
try {
  if (Test-CommandExists "openssl") {
    Write-Host "==> Using openssl (+ keytool for the truststore)." -ForegroundColor Cyan

    # --- Private CA ---
    & openssl ecparam -name prime256v1 -genkey -noout -out ca.key 2>$null
    if ($LASTEXITCODE -ne 0) { throw "openssl: failed to generate the CA key" }
    & openssl req -x509 -new -key ca.key -days $Days -out ca.crt `
      -subj "/CN=Hydropark Internal mTLS CA" `
      -addext "basicConstraints=critical,CA:TRUE" `
      -addext "keyUsage=critical,keyCertSign,cRLSign" 2>$null
    if ($LASTEXITCODE -ne 0) { throw "openssl: failed to self-sign the CA cert" }

    foreach ($z in $zones) {
      & openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$z.key" 2>$null
      if ($LASTEXITCODE -ne 0) { throw "openssl: failed to generate the $z key" }
      & openssl req -new -key "$z.key" -out "$z.csr" -subj "/CN=hydropark-$z" 2>$null
      if ($LASTEXITCODE -ne 0) { throw "openssl: failed to build the $z CSR" }

      # BOM-free ext file (Windows PowerShell 5.1's -Encoding utf8 writes a BOM openssl rejects).
      $ext = "basicConstraints=CA:FALSE`n" +
             "keyUsage=critical,digitalSignature,keyEncipherment`n" +
             "extendedKeyUsage=serverAuth,clientAuth`n" +
             "subjectAltName=$(Get-ZoneSan $z)`n"
      [System.IO.File]::WriteAllText((Join-Path $OutDir "$z.ext"), $ext, (New-Object System.Text.UTF8Encoding $false))

      & openssl x509 -req -in "$z.csr" -CA ca.crt -CAkey ca.key `
        -CAcreateserial -days $Days -out "$z.crt" -extfile "$z.ext" 2>$null
      if ($LASTEXITCODE -ne 0) { throw "openssl: failed to sign the $z cert" }
      & openssl pkcs12 -export -inkey "$z.key" -in "$z.crt" `
        -certfile ca.crt -name "$z" -out "$z.p12" -passout "pass:$Password" 2>$null
      if ($LASTEXITCODE -ne 0) { throw "openssl: failed to package $z.p12" }
      Remove-Item -Force "$z.csr", "$z.ext" -ErrorAction SilentlyContinue
    }
  } else {
    Write-Host "==> openssl not found - using keytool only." -ForegroundColor Cyan

    Remove-Item -Force ca.p12 -ErrorAction SilentlyContinue
    & keytool -genkeypair -alias ca -keyalg EC -groupname secp256r1 `
      -dname "CN=Hydropark Internal mTLS CA" -ext "bc:c=ca:true" `
      -validity $Days -keystore ca.p12 -storetype PKCS12 `
      -storepass $Password -keypass $Password | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "keytool: failed to generate the CA" }
    & keytool -exportcert -rfc -alias ca -keystore ca.p12 -storepass $Password -file ca.crt | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "keytool: failed to export the CA cert" }

    foreach ($z in $zones) {
      Remove-Item -Force "$z.p12" -ErrorAction SilentlyContinue
      $san = Get-ZoneSan $z
      & keytool -genkeypair -alias "$z" -keyalg EC -groupname secp256r1 `
        -dname "CN=hydropark-$z" -ext "san=$san" `
        -validity $Days -keystore "$z.p12" -storetype PKCS12 `
        -storepass $Password -keypass $Password | Out-Null
      if ($LASTEXITCODE -ne 0) { throw "keytool: failed to generate the $z keypair" }
      & keytool -certreq -alias "$z" -keystore "$z.p12" -storepass $Password -file "$z.csr" | Out-Null
      if ($LASTEXITCODE -ne 0) { throw "keytool: failed to build the $z CSR" }
      & keytool -gencert -alias ca -keystore ca.p12 -storepass $Password `
        -ext "san=$san" -ext "eku=serverAuth,clientAuth" `
        -validity $Days -rfc -infile "$z.csr" -outfile "$z.crt" | Out-Null
      if ($LASTEXITCODE -ne 0) { throw "keytool: failed to sign the $z cert" }
      & keytool -importcert -noprompt -alias ca -keystore "$z.p12" -storepass $Password -file ca.crt | Out-Null
      & keytool -importcert -noprompt -alias "$z" -keystore "$z.p12" -storepass $Password -file "$z.crt" | Out-Null
      if ($LASTEXITCODE -ne 0) { throw "keytool: failed to import the $z chain" }
      Remove-Item -Force "$z.csr" -ErrorAction SilentlyContinue
    }
  }

  # --- CA truststore (same file for every zone) ---
  Remove-Item -Force truststore.p12 -ErrorAction SilentlyContinue
  & keytool -importcert -noprompt -alias hydropark-internal-ca -file ca.crt `
    -keystore truststore.p12 -storetype PKCS12 -storepass $Password | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "keytool: failed to build truststore.p12" }
} finally {
  Pop-Location
}

Write-Host ""
Write-Host "Generated internal mTLS PKI in: $OutDir" -ForegroundColor Green
Get-ChildItem -Name $OutDir | ForEach-Object { Write-Host "  $_" }
Write-Host ""
Write-Host "Distribution: api.p12 -> api zone, issuer.p12 -> issuer, worker.p12 -> worker;" -ForegroundColor Green
Write-Host "truststore.p12 -> ALL zones. Never place a zone's .p12 on a different zone." -ForegroundColor Green
Write-Host ""

# --- Machine-readable KEY=VALUE lines (plain output - captured by a pipe). ---
"# --- shared by every zone ---"
"HP_INTERNAL_MTLS_ENABLED=true"
"HP_INTERNAL_MTLS_PORT=8443"
"HP_INTERNAL_MTLS_TRUSTSTORE=/certs/truststore.p12"
"HP_INTERNAL_MTLS_TRUSTSTORE_PASSWORD=$Password"
"HP_INTERNAL_MTLS_KEYSTORE_PASSWORD=$Password"
"# --- per zone (set HP_INTERNAL_MTLS_KEYSTORE to this zone's own .p12) ---"
"# api:    HP_INTERNAL_MTLS_KEYSTORE=/certs/api.p12"
"# issuer: HP_INTERNAL_MTLS_KEYSTORE=/certs/issuer.p12"
"# worker: HP_INTERNAL_MTLS_KEYSTORE=/certs/worker.p12"
