#!/usr/bin/env bash
# Generate an Ed25519 keypair for the License Issuer and an RSA-2048 keypair
# for access-token signing, in the exact base64 form the backend expects.
# .sh twin of generate-keys.ps1 - see that file's header comment for details
# on the exact key formats (PKCS#8 private / X.509 public, base64) and why.
#
# ******************************************************************************
# ** HP_LICENSE_PRIVATE_KEY must reach ONLY the `issuer` app/service.         **
# ** Never set it on `api` or `worker`. Never commit it. Never log it.        **
# ******************************************************************************
#
# Prefers openssl. Falls back to a throwaway single-file Java program
# (Java 21+ has native Ed25519 - JEP 339; `java --source 21` runs a .java
# file directly).
#
# Only the KEY=VALUE lines go to stdout (fd 1) - all banners/warnings go to
# stderr (fd 2) - so `./generate-keys.sh > .env.generated` or
# `./generate-keys.sh | flyctl secrets import --app hydropark-issuer` capture
# ONLY the key material.
set -euo pipefail

USE_JAVA=0
if [ "${1:-}" = "--use-java" ]; then
  USE_JAVA=1
fi

echo "WARNING: HP_LICENSE_PRIVATE_KEY must reach ONLY the issuer service. Never set it on api or worker. Never commit it." >&2
echo "" >&2

KID="hp-lic-$(date +%Y)a"

if [ "$USE_JAVA" -eq 1 ] || ! command -v openssl >/dev/null 2>&1; then
  echo "==> openssl not found (or --use-java passed) - using the Java fallback." >&2
  if ! command -v java >/dev/null 2>&1; then
    echo "Neither openssl nor java is on PATH. Install one of them and re-run." >&2
    exit 1
  fi

  TMP_DIR="$(mktemp -d)"
  trap 'rm -rf "$TMP_DIR"' EXIT
  JAVA_FILE="$TMP_DIR/GenerateHydroparkKeys.java"
  cat > "$JAVA_FILE" <<'EOF'
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.util.Base64;

public class GenerateHydroparkKeys {
  public static void main(String[] args) throws Exception {
    KeyPairGenerator edGen = KeyPairGenerator.getInstance("Ed25519");
    KeyPair edKp = edGen.generateKeyPair();
    String edPriv = Base64.getEncoder().encodeToString(edKp.getPrivate().getEncoded());
    String edPub = Base64.getEncoder().encodeToString(edKp.getPublic().getEncoded());

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
EOF

  OUTPUT="$(java --source 21 "$JAVA_FILE")"
  ED_PRIV="$(echo "$OUTPUT" | grep '^ED25519_PRIVATE=' | cut -d= -f2-)"
  ED_PUB="$(echo "$OUTPUT" | grep '^ED25519_PUBLIC=' | cut -d= -f2-)"
  RSA_PRIV="$(echo "$OUTPUT" | grep '^RSA_PRIVATE=' | cut -d= -f2-)"
else
  echo "==> Using openssl." >&2

  TMP_DIR="$(mktemp -d)"
  trap 'rm -rf "$TMP_DIR"' EXIT

  # Private keys MUST be emitted as PKCS#8, because Java parses them with PKCS8EncodedKeySpec.
  #
  # `openssl pkey -outform DER` is NOT that. For RSA it writes the *traditional* PKCS#1
  # `RSAPrivateKey` encoding - a SEQUENCE of raw INTEGERs with no AlgorithmIdentifier - even though
  # the PEM it was read from says `BEGIN PRIVATE KEY`. Java then fails with the memorable
  # "algid parse error, not a sequence", because it looked for an AlgorithmIdentifier SEQUENCE and
  # found an INTEGER. Ed25519 has no traditional encoding, so it silently comes out as PKCS#8 and
  # works - which is exactly why this bug hides: the issuer boots and only the api dies.
  #
  # `openssl pkcs8 -topk8 -nocrypt` is unambiguous for both algorithms. Use it.
  openssl genpkey -algorithm ed25519 -out "$TMP_DIR/ed_priv.pem" 2>/dev/null
  openssl pkcs8 -topk8 -nocrypt -in "$TMP_DIR/ed_priv.pem" -outform DER -out "$TMP_DIR/ed_priv.der" 2>/dev/null
  openssl pkey -in "$TMP_DIR/ed_priv.pem" -pubout -outform DER -out "$TMP_DIR/ed_pub.der" 2>/dev/null

  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$TMP_DIR/rsa_priv.pem" 2>/dev/null
  openssl pkcs8 -topk8 -nocrypt -in "$TMP_DIR/rsa_priv.pem" -outform DER -out "$TMP_DIR/rsa_priv.der" 2>/dev/null

  # -A: single-line output, no 64-char wrapping - reads DER from a FILE
  # (never piped raw binary between two processes).
  ED_PRIV="$(openssl base64 -A -in "$TMP_DIR/ed_priv.der")"
  ED_PUB="$(openssl base64 -A -in "$TMP_DIR/ed_pub.der")"
  RSA_PRIV="$(openssl base64 -A -in "$TMP_DIR/rsa_priv.der")"
fi

echo "" >&2
echo "Generated. Paste the lines below into deploy/.env (issuer key material" >&2
echo "goes ONLY on the issuer service) or pipe them to 'fly secrets import'." >&2
echo "" >&2

echo "# --- Ed25519 License Issuer keypair - issuer service ONLY, never api/worker ---"
echo "HP_LICENSE_KID=$KID"
echo "HP_LICENSE_PRIVATE_KEY=$ED_PRIV"
echo "HP_LICENSE_PUBLIC_KEY=$ED_PUB"
echo ""
echo "# --- RSA-2048 access-token signing key - api service ---"
echo "HP_JWT_PRIVATE_KEY=$RSA_PRIV"
