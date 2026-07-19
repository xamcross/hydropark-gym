<#
.SYNOPSIS
  Generate the backend's signing keys in the exact base64 form it expects: a
  P-256 (ES256) keypair for the License Issuer, an RSA-2048 keypair for
  access-token signing, and an Ed25519 keypair for skill PACKAGE signing.

.DESCRIPTION
  The License Issuer signs with ES256 (ECDSA over NIST P-256 = secp256r1 =
  prime256v1) as of P1-16.8 - the switch from Ed25519 that lets a cloud KMS
  (Azure Managed HSM / AWS KMS, which sign P-256 but NOT Ed25519) hold the key.
  The key material is still PKCS#8 private / X.509 SubjectPublicKeyInfo public,
  base64 - the same containers, only the curve differs - which is what
  io.hydropark.config.AppProperties.SigningKey (hydropark.licensing.keys) and
  BACKEND-DESIGN §6.1 expect, with alg=ES256. RSA-2048 (PKCS#8 private, base64)
  is what io.hydropark.security.AccessTokenService expects for
  hydropark.auth.jwt-private-key (the public half is derived at boot).

  Skill PACKAGE signing is a DISTINCT key class (SPEC 13.8/8.8, BACKEND-DESIGN
  §6.2 B8): the license key must never sign a package and vice versa, so this
  emits a separate Ed25519 keypair for hydropark.package-signing.keys - PKCS#8
  private / X.509 SPKI public, base64 (the same containers io.hydropark.packaging
  .PackageTrustedKeySet parses; the manifest's own ed25519:<base64> wire form is
  the signature field, not these env vars). The private half belongs ONLY on the
  registry/signing zone (HP_PACKAGE_SIGNING_ENABLED=true there); every other zone
  ships just HP_PACKAGE_SIGNING_PUBLIC_KEY and verifies offline.

  Prefers `openssl` if it is on PATH. Falls back to a throwaway single-file
  Java program (Java 21+ has native EC support; `java --source 21` runs a .java
  file directly without a separate compile step).

  ******************************************************************************
  ** HP_LICENSE_PRIVATE_KEY must reach ONLY the `issuer` app/service.         **
  ** Never set it on `api` or `worker` (docker-compose.yml and fly.api.toml / **
  ** fly.worker.toml deliberately never reference it). Never commit it.      **
  ** Never log it, echo it in CI output, or paste it anywhere but a secret   **
  ** store / deploy/.env (gitignored) / `fly secrets`.                       **
  ******************************************************************************

.PARAMETER UseJava
  Force the Java fallback even if openssl is on PATH (useful to test it).

.OUTPUTS
  Prints `HP_LICENSE_KID=...`, `HP_LICENSE_ALG=ES256`,
  `HP_LICENSE_PRIVATE_KEY=...`, `HP_LICENSE_PUBLIC_KEY=...`,
  `HP_JWT_PRIVATE_KEY=...`, `HP_PACKAGE_SIGNING_KID=...`,
  `HP_PACKAGE_SIGNING_PRIVATE_KEY=...`, and `HP_PACKAGE_SIGNING_PUBLIC_KEY=...`
  lines to stdout
  (via plain output, not Write-Host) - so the KEY=VALUE lines alone can be
  piped, e.g.:
    .\generate-keys.ps1 | Out-File ..\..\deploy\.env.generated -Encoding ascii
    .\generate-keys.ps1 | flyctl secrets import --app hydropark-issuer
  All banners/warnings go through Write-Host/Write-Warning, which are on
  separate streams and are excluded from a plain `|` pipe of this script's
  output - so redirecting/piping stdout gets ONLY the KEY=VALUE lines.
#>
[CmdletBinding()]
param(
  [switch]$UseJava
)

$ErrorActionPreference = "Stop"

function Test-CommandExists([string]$name) {
  return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

Write-Warning "HP_LICENSE_PRIVATE_KEY must reach ONLY the issuer service. Never set it on api or worker. Never commit it."
Write-Host ""

$haveOpenssl = Test-CommandExists "openssl"
$kid = "hp-lic-" + (Get-Date -Format "yyyy") + "a"
$pkgKid = "hp-pkg-" + (Get-Date -Format "yyyy") + "a"

if ($UseJava -or (-not $haveOpenssl)) {
  # ---------------------------------------------------------------------
  # Java fallback.
  # ---------------------------------------------------------------------
  Write-Host "==> openssl not found (or -UseJava passed) - using the Java fallback." -ForegroundColor Cyan

  if (-not (Test-CommandExists "java")) {
    throw "Neither openssl nor java is on PATH. Install one of them and re-run."
  }

  $tmpDir = Join-Path $env:TEMP ("hp-genkeys-" + [System.Guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Path $tmpDir | Out-Null
  try {
    $javaFile = Join-Path $tmpDir "GenerateHydroparkKeys.java"
    $javaSource = @'
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.spec.ECGenParameterSpec;
import java.util.Base64;

public class GenerateHydroparkKeys {
  public static void main(String[] args) throws Exception {
    // ES256 - License Issuer signing key: ECDSA over NIST P-256 (secp256r1). PKCS#8 private /
    // X.509 SPKI public, base64 - the exact containers hydropark.licensing.keys binds.
    KeyPairGenerator ecGen = KeyPairGenerator.getInstance("EC");
    ecGen.initialize(new ECGenParameterSpec("secp256r1"));
    KeyPair ecKp = ecGen.generateKeyPair();
    String licPriv = Base64.getEncoder().encodeToString(ecKp.getPrivate().getEncoded());
    String licPub = Base64.getEncoder().encodeToString(ecKp.getPublic().getEncoded());

    // RSA-2048 - access-token signing key.
    KeyPairGenerator rsaGen = KeyPairGenerator.getInstance("RSA");
    rsaGen.initialize(2048);
    KeyPair rsaKp = rsaGen.generateKeyPair();
    String rsaPriv = Base64.getEncoder().encodeToString(rsaKp.getPrivate().getEncoded());
    String rsaPub = Base64.getEncoder().encodeToString(rsaKp.getPublic().getEncoded());

    // Ed25519 - skill PACKAGE-signing key (SPEC 13.8/8.8). A SEPARATE key class from the license
    // key above; never reuse one for the other. PKCS#8 private / X.509 SPKI public, base64 - the
    // exact containers hydropark.package-signing.keys binds. Java 21 has native Ed25519 (JEP 339).
    KeyPairGenerator edGen = KeyPairGenerator.getInstance("Ed25519");
    KeyPair pkgKp = edGen.generateKeyPair();
    String pkgPriv = Base64.getEncoder().encodeToString(pkgKp.getPrivate().getEncoded());
    String pkgPub = Base64.getEncoder().encodeToString(pkgKp.getPublic().getEncoded());

    System.out.println("LICENSE_PRIVATE=" + licPriv);
    System.out.println("LICENSE_PUBLIC=" + licPub);
    System.out.println("RSA_PRIVATE=" + rsaPriv);
    System.out.println("RSA_PUBLIC=" + rsaPub);
    System.out.println("PACKAGE_PRIVATE=" + pkgPriv);
    System.out.println("PACKAGE_PUBLIC=" + pkgPub);
  }
}
'@
    # Windows PowerShell 5.1's `-Encoding utf8` writes a BOM, and javac rejects a leading
    # with "illegal character". There is no -Encoding utf8NoBOM on 5.1, so write the bytes directly.
    [System.IO.File]::WriteAllText($javaFile, $javaSource, (New-Object System.Text.UTF8Encoding $false))

    $output = & java --source 21 $javaFile
    if ($LASTEXITCODE -ne 0) {
      throw "java --source 21 GenerateHydroparkKeys.java failed."
    }

    $values = @{}
    foreach ($line in $output) {
      $parts = $line -split "=", 2
      if ($parts.Length -eq 2) {
        $values[$parts[0]] = $parts[1]
      }
    }

    $licPrivB64 = $values["LICENSE_PRIVATE"]
    $licPubB64 = $values["LICENSE_PUBLIC"]
    $rsaPrivB64 = $values["RSA_PRIVATE"]
    $pkgPrivB64 = $values["PACKAGE_PRIVATE"]
    $pkgPubB64 = $values["PACKAGE_PUBLIC"]
  } finally {
    Remove-Item -Path $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
  }
} else {
  # ---------------------------------------------------------------------
  # openssl path. DER is written to temp files and base64-encoded via a
  # SEPARATE `openssl base64` call reading from disk (never piped binary
  # data between two native processes) - Windows PowerShell 5.1's pipeline
  # can mangle raw binary passed between two native executables, so this
  # avoids that failure mode entirely.
  # ---------------------------------------------------------------------
  Write-Host "==> Using openssl." -ForegroundColor Cyan

  $tmpDir = Join-Path $env:TEMP ("hp-genkeys-" + [System.Guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Path $tmpDir | Out-Null
  try {
    $licPrivPem = Join-Path $tmpDir "lic_priv.pem"
    $licPrivDer = Join-Path $tmpDir "lic_priv.der"
    $licPubDer = Join-Path $tmpDir "lic_pub.der"
    $rsaPrivPem = Join-Path $tmpDir "rsa_priv.pem"
    $rsaPrivDer = Join-Path $tmpDir "rsa_priv.der"
    $pkgPrivPem = Join-Path $tmpDir "pkg_priv.pem"
    $pkgPrivDer = Join-Path $tmpDir "pkg_priv.der"
    $pkgPubDer = Join-Path $tmpDir "pkg_pub.der"

    # ES256 = ECDSA over NIST P-256 (secp256r1 / prime256v1). `ecparam -genkey` emits a traditional
    # SEC1 "EC PRIVATE KEY"; Java reads PKCS#8, so convert with `pkcs8 -topk8 -nocrypt` below.
    & openssl ecparam -genkey -name prime256v1 -out $licPrivPem 2>$null
    if ($LASTEXITCODE -ne 0) { throw "openssl: failed to generate the P-256 license key" }

    # Private keys must be PKCS#8 (Java reads them with PKCS8EncodedKeySpec). `openssl pkey/ec
    # -outform DER` writes the traditional SEC1 EC key - no PKCS#8 AlgorithmIdentifier wrapper -
    # which Java rejects with "algid parse error, not a sequence". `pkcs8 -topk8 -nocrypt` is
    # correct for both the EC and RSA keys.
    & openssl pkcs8 -topk8 -nocrypt -in $licPrivPem -outform DER -out $licPrivDer 2>$null
    if ($LASTEXITCODE -ne 0) { throw "openssl: failed to PKCS#8-encode the P-256 private key" }

    & openssl pkey -in $licPrivPem -pubout -outform DER -out $licPubDer 2>$null
    if ($LASTEXITCODE -ne 0) { throw "openssl: failed to derive the P-256 public key" }

    & openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out $rsaPrivPem 2>$null
    if ($LASTEXITCODE -ne 0) { throw "openssl: failed to generate the RSA-2048 key" }

    & openssl pkcs8 -topk8 -nocrypt -in $rsaPrivPem -outform DER -out $rsaPrivDer 2>$null
    if ($LASTEXITCODE -ne 0) { throw "openssl: failed to PKCS#8-encode the RSA private key" }

    # Ed25519 skill PACKAGE-signing key - a SEPARATE key class from the license key (SPEC 13.8/8.8).
    # `genpkey -algorithm ED25519` already writes PKCS#8, but Ed25519 has NO traditional PKCS#1/SEC1
    # form, so `pkcs8 -topk8 -nocrypt` is the correct (and here idempotent) way to produce the exact
    # PKCS#8 DER PackageTrustedKeySet reads; `pkey -pubout` gives the X.509 SPKI public half.
    & openssl genpkey -algorithm ED25519 -out $pkgPrivPem 2>$null
    if ($LASTEXITCODE -ne 0) { throw "openssl: failed to generate the Ed25519 package-signing key" }

    & openssl pkcs8 -topk8 -nocrypt -in $pkgPrivPem -outform DER -out $pkgPrivDer 2>$null
    if ($LASTEXITCODE -ne 0) { throw "openssl: failed to PKCS#8-encode the Ed25519 private key" }

    & openssl pkey -in $pkgPrivPem -pubout -outform DER -out $pkgPubDer 2>$null
    if ($LASTEXITCODE -ne 0) { throw "openssl: failed to derive the Ed25519 public key" }

    $licPrivB64 = ((& openssl base64 -A -in $licPrivDer) -join "").Trim()
    $licPubB64 = ((& openssl base64 -A -in $licPubDer) -join "").Trim()
    $rsaPrivB64 = ((& openssl base64 -A -in $rsaPrivDer) -join "").Trim()
    $pkgPrivB64 = ((& openssl base64 -A -in $pkgPrivDer) -join "").Trim()
    $pkgPubB64 = ((& openssl base64 -A -in $pkgPubDer) -join "").Trim()
  } finally {
    Remove-Item -Path $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}

# --- Human-readable banner (Write-Host - excluded from a plain `|` pipe). ---
Write-Host ""
Write-Host "Generated. Paste the lines below into deploy/.env (issuer key material" -ForegroundColor Green
Write-Host "goes ONLY on the issuer service) or pipe them to 'fly secrets import'." -ForegroundColor Green
Write-Host ""

# --- Machine-readable KEY=VALUE lines (plain output - IS captured by a pipe). ---
"# --- ES256 (P-256) License Issuer keypair - issuer service ONLY, never api/worker ---"
"HP_LICENSE_KID=$kid"
"HP_LICENSE_ALG=ES256"
"HP_LICENSE_PRIVATE_KEY=$licPrivB64"
"HP_LICENSE_PUBLIC_KEY=$licPubB64"
""
"# --- RSA-2048 access-token signing key - api service ---"
"HP_JWT_PRIVATE_KEY=$rsaPrivB64"
""
"# --- Ed25519 skill PACKAGE-signing keypair - registry/signing zone ONLY holds the private half ---"
"# Separate key class from the license key above (SPEC 13.8/8.8). Set HP_PACKAGE_SIGNING_ENABLED=true"
"# only on the zone that actually signs packages; every other zone ships just the PUBLIC key and"
"# verifies offline. Never commit the private key."
"HP_PACKAGE_SIGNING_KID=$pkgKid"
"HP_PACKAGE_SIGNING_PRIVATE_KEY=$pkgPrivB64"
"HP_PACKAGE_SIGNING_PUBLIC_KEY=$pkgPubB64"
