<#
.SYNOPSIS
  Generate an Ed25519 keypair for the License Issuer and an RSA-2048 keypair
  for access-token signing, in the exact base64 form the backend expects.

.DESCRIPTION
  Ed25519 (PKCS#8 private / X.509 SubjectPublicKeyInfo public, base64) is
  what io.hydropark.config.AppProperties.SigningKey (hydropark.licensing.keys)
  and BACKEND-DESIGN §6.1 expect. RSA-2048 (PKCS#8 private, base64) is what
  io.hydropark.security.AccessTokenService expects for hydropark.auth.jwt-private-key
  (the public half is derived from the private key at boot - not a separate var).

  Prefers `openssl` if it is on PATH. Falls back to a throwaway single-file
  Java program (Java 21+ has native Ed25519 support - JEP 339 - so no
  BouncyCastle is needed; `java --source 21` runs a .java file directly
  without a separate compile step).

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
  Prints `HP_LICENSE_KID=...`, `HP_LICENSE_PRIVATE_KEY=...`,
  `HP_LICENSE_PUBLIC_KEY=...`, and `HP_JWT_PRIVATE_KEY=...` lines to stdout
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
import java.util.Base64;

public class GenerateHydroparkKeys {
  public static void main(String[] args) throws Exception {
    // Ed25519 - License Issuer signing key (native since JDK 15, JEP 339).
    KeyPairGenerator edGen = KeyPairGenerator.getInstance("Ed25519");
    KeyPair edKp = edGen.generateKeyPair();
    String edPriv = Base64.getEncoder().encodeToString(edKp.getPrivate().getEncoded());
    String edPub = Base64.getEncoder().encodeToString(edKp.getPublic().getEncoded());

    // RSA-2048 - access-token signing key.
    KeyPairGenerator rsaGen = KeyPairGenerator.getInstance("RSA");
    rsaGen.initialize(2048);
    KeyPair rsaKp = rsaGen.generateKeyPair();
    String rsaPriv = Base64.getEncoder().encodeToString(rsaKp.getPrivate().getEncoded());
    String rsaPub = Base64.getEncoder().encodeToString(rsaKp.getPublic().getEncoded());

    System.out.println("ED25519_PRIVATE=" + edPriv);
    System.out.println("ED25519_PUBLIC=" + edPub);
    System.out.println("RSA_PRIVATE=" + rsaPriv);
    System.out.println("RSA_PUBLIC=" + rsaPub);
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

    $edPrivB64 = $values["ED25519_PRIVATE"]
    $edPubB64 = $values["ED25519_PUBLIC"]
    $rsaPrivB64 = $values["RSA_PRIVATE"]
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
    $edPrivPem = Join-Path $tmpDir "ed_priv.pem"
    $edPrivDer = Join-Path $tmpDir "ed_priv.der"
    $edPubDer = Join-Path $tmpDir "ed_pub.der"
    $rsaPrivPem = Join-Path $tmpDir "rsa_priv.pem"
    $rsaPrivDer = Join-Path $tmpDir "rsa_priv.der"

    & openssl genpkey -algorithm ed25519 -out $edPrivPem 2>$null
    if ($LASTEXITCODE -ne 0) { throw "openssl: failed to generate the Ed25519 key" }

    # Private keys must be PKCS#8 (Java reads them with PKCS8EncodedKeySpec). `openssl pkey
    # -outform DER` writes traditional PKCS#1 for RSA - no AlgorithmIdentifier - which Java rejects
    # with "algid parse error, not a sequence". Ed25519 has no traditional form and so survives,
    # which is precisely why the bug hides. `pkcs8 -topk8 -nocrypt` is correct for both.
    & openssl pkcs8 -topk8 -nocrypt -in $edPrivPem -outform DER -out $edPrivDer 2>$null
    if ($LASTEXITCODE -ne 0) { throw "openssl: failed to PKCS#8-encode the Ed25519 private key" }

    & openssl pkey -in $edPrivPem -pubout -outform DER -out $edPubDer 2>$null
    if ($LASTEXITCODE -ne 0) { throw "openssl: failed to derive the Ed25519 public key" }

    & openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out $rsaPrivPem 2>$null
    if ($LASTEXITCODE -ne 0) { throw "openssl: failed to generate the RSA-2048 key" }

    & openssl pkcs8 -topk8 -nocrypt -in $rsaPrivPem -outform DER -out $rsaPrivDer 2>$null
    if ($LASTEXITCODE -ne 0) { throw "openssl: failed to PKCS#8-encode the RSA private key" }

    $edPrivB64 = ((& openssl base64 -A -in $edPrivDer) -join "").Trim()
    $edPubB64 = ((& openssl base64 -A -in $edPubDer) -join "").Trim()
    $rsaPrivB64 = ((& openssl base64 -A -in $rsaPrivDer) -join "").Trim()
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
"# --- Ed25519 License Issuer keypair - issuer service ONLY, never api/worker ---"
"HP_LICENSE_KID=$kid"
"HP_LICENSE_PRIVATE_KEY=$edPrivB64"
"HP_LICENSE_PUBLIC_KEY=$edPubB64"
""
"# --- RSA-2048 access-token signing key - api service ---"
"HP_JWT_PRIVATE_KEY=$rsaPrivB64"
