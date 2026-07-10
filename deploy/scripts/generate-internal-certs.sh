#!/usr/bin/env bash
# =============================================================================
# Generate the internal mTLS PKI for the api->issuer / api->worker hop
# (BACKEND-DESIGN §6.2, ticket P1-16.9). Creates:
#
#   ca.crt / ca.key            a private CA (self-signed, CA:TRUE)
#   api.p12 / issuer.p12 / worker.p12
#                              one PKCS12 identity keystore PER ZONE, each holding
#                              that zone's cert+key and the CA in its chain. On the
#                              api zone this is the CLIENT cert; on issuer/worker it
#                              is the SERVER cert. Certs carry serverAuth+clientAuth
#                              EKU and the zone's DNS names as SANs.
#   truststore.p12             the CA as a trustedCertEntry - the SAME file on every
#                              zone; verifies the peer's cert.
#   <zone>.crt / <zone>.key    PEM copies for inspection.
#
# .ps1 twin: generate-internal-certs.ps1 (identical outputs; Windows PowerShell 5.1).
#
# ***************************************************************************
# ** The .key and .p12 files are SECRETS. They are gitignored. Never commit **
# ** them, never log their contents. Regenerate per environment (dev /      **
# ** staging / prod) - never share a CA across environments, same rule as   **
# ** the license signing keys (deploy/scripts/generate-keys.sh).            **
# ***************************************************************************
#
# Prefers openssl; falls back to the JDK's keytool (always present with Java 21).
# Only informational text goes to stderr; the KEY=VALUE env lines go to stdout so
# `./generate-internal-certs.sh > mtls.env` captures just those.
# =============================================================================
set -euo pipefail

# Git Bash on Windows rewrites a "/CN=..." arg into a filesystem path; disable that so
# openssl's -subj survives. Harmless on Linux/macOS. We work in relative filenames
# (see the `cd` below) so file-path args are never mangled either.
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL="*"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_DIR="${1:-$SCRIPT_DIR/../certs}"
PASSWORD="${HP_INTERNAL_MTLS_PASSWORD:-changeit}"
DAYS="${HP_INTERNAL_MTLS_DAYS:-3650}"
ZONES=(api issuer worker)

mkdir -p "$OUT_DIR"
# Run inside the output dir and use bare relative filenames, so native openssl/keytool
# get plain names (no "/c/..." MSYS path that native tools can't resolve).
cd "$OUT_DIR"
OUT_ABS="$(pwd)"

echo "WARNING: the generated .key/.p12 files are secrets - never commit them (they are gitignored)." >&2
if [ "$PASSWORD" = "changeit" ]; then
  echo "WARNING: using the default keystore password 'changeit'. Override with HP_INTERNAL_MTLS_PASSWORD for anything but local dev." >&2
fi
echo "" >&2

# DNS/IP SANs a zone's cert must present so the api client's hostname check passes.
zone_san() {
  local z="$1"
  echo "DNS:localhost,DNS:${z},DNS:hydropark-${z},DNS:hydropark-${z}.internal,DNS:hydropark-${z}.flycast,IP:127.0.0.1"
}

have() { command -v "$1" >/dev/null 2>&1; }

if ! have keytool; then
  echo "ERROR: keytool (from the JDK) is required to build truststore.p12 but is not on PATH." >&2
  exit 1
fi

if have openssl; then
  echo "==> Using openssl (+ keytool for the truststore)." >&2

  # --- Private CA ---
  openssl ecparam -name prime256v1 -genkey -noout -out ca.key
  openssl req -x509 -new -key ca.key -days "$DAYS" -out ca.crt \
    -subj "/CN=Hydropark Internal mTLS CA" \
    -addext "basicConstraints=critical,CA:TRUE" \
    -addext "keyUsage=critical,keyCertSign,cRLSign"

  # --- Per-zone identity ---
  for z in "${ZONES[@]}"; do
    openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$z.key" 2>/dev/null
    openssl req -new -key "$z.key" -out "$z.csr" -subj "/CN=hydropark-$z"
    {
      echo "basicConstraints=CA:FALSE"
      echo "keyUsage=critical,digitalSignature,keyEncipherment"
      echo "extendedKeyUsage=serverAuth,clientAuth"
      echo "subjectAltName=$(zone_san "$z")"
    } > "$z.ext"
    openssl x509 -req -in "$z.csr" -CA ca.crt -CAkey ca.key \
      -CAcreateserial -days "$DAYS" -out "$z.crt" -extfile "$z.ext" 2>/dev/null
    # Bundle cert+key(+CA chain) into a PKCS12 identity keystore for Java/Tomcat.
    openssl pkcs12 -export -inkey "$z.key" -in "$z.crt" \
      -certfile ca.crt -name "$z" -out "$z.p12" -passout pass:"$PASSWORD"
    rm -f "$z.csr" "$z.ext"
  done
else
  echo "==> openssl not found - using keytool only." >&2

  # --- Private CA (in its own keystore so we can sign with it) ---
  rm -f ca.p12
  keytool -genkeypair -alias ca -keyalg EC -groupname secp256r1 \
    -dname "CN=Hydropark Internal mTLS CA" -ext "bc:c=ca:true" \
    -validity "$DAYS" -keystore ca.p12 -storetype PKCS12 \
    -storepass "$PASSWORD" -keypass "$PASSWORD" >/dev/null
  keytool -exportcert -rfc -alias ca -keystore ca.p12 \
    -storepass "$PASSWORD" -file ca.crt >/dev/null

  for z in "${ZONES[@]}"; do
    rm -f "$z.p12"
    keytool -genkeypair -alias "$z" -keyalg EC -groupname secp256r1 \
      -dname "CN=hydropark-$z" -ext "san=$(zone_san "$z")" \
      -validity "$DAYS" -keystore "$z.p12" -storetype PKCS12 \
      -storepass "$PASSWORD" -keypass "$PASSWORD" >/dev/null
    keytool -certreq -alias "$z" -keystore "$z.p12" \
      -storepass "$PASSWORD" -file "$z.csr" >/dev/null
    keytool -gencert -alias ca -keystore ca.p12 -storepass "$PASSWORD" \
      -ext "san=$(zone_san "$z")" -ext "eku=serverAuth,clientAuth" \
      -validity "$DAYS" -rfc -infile "$z.csr" -outfile "$z.crt" >/dev/null
    # Re-import the CA then the signed cert so the alias carries the full chain.
    keytool -importcert -noprompt -alias ca -keystore "$z.p12" \
      -storepass "$PASSWORD" -file ca.crt >/dev/null
    keytool -importcert -noprompt -alias "$z" -keystore "$z.p12" \
      -storepass "$PASSWORD" -file "$z.crt" >/dev/null
    rm -f "$z.csr"
  done
fi

# --- CA truststore (same file for every zone) ---
rm -f truststore.p12
keytool -importcert -noprompt -alias hydropark-internal-ca -file ca.crt \
  -keystore truststore.p12 -storetype PKCS12 -storepass "$PASSWORD" >/dev/null

# Lock down private material where the FS supports it.
chmod 600 ./*.key ./*.p12 2>/dev/null || true

echo "Generated internal mTLS PKI in: $OUT_ABS" >&2
ls -1 . | sed 's/^/  /' >&2
echo "" >&2
echo "Distribution: api.p12 -> api zone, issuer.p12 -> issuer, worker.p12 -> worker;" >&2
echo "truststore.p12 -> ALL zones. Never place a zone's .p12 on a different zone." >&2
echo "" >&2

# KEY=VALUE lines on stdout: the per-zone env each container needs (paths as mounted in compose).
echo "# --- shared by every zone ---"
echo "HP_INTERNAL_MTLS_ENABLED=true"
echo "HP_INTERNAL_MTLS_PORT=8443"
echo "HP_INTERNAL_MTLS_TRUSTSTORE=/certs/truststore.p12"
echo "HP_INTERNAL_MTLS_TRUSTSTORE_PASSWORD=$PASSWORD"
echo "HP_INTERNAL_MTLS_KEYSTORE_PASSWORD=$PASSWORD"
echo "# --- per zone (set HP_INTERNAL_MTLS_KEYSTORE to this zone's own .p12) ---"
echo "# api:    HP_INTERNAL_MTLS_KEYSTORE=/certs/api.p12"
echo "# issuer: HP_INTERNAL_MTLS_KEYSTORE=/certs/issuer.p12"
echo "# worker: HP_INTERNAL_MTLS_KEYSTORE=/certs/worker.p12"
