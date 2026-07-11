# Hydropark license token format

> Source of truth for the **offline** license verifier the Angular/Tauri client ships. It mirrors the
> server implementation in `io.hydropark.licensing.LicenseVerifier`. If this document and that class
> disagree, the class wins and this document is the bug.
>
> Backend design: BACKEND-DESIGN §6.1 / §13.3 / §13.12.

## What it is

A license is a **compact, attached JWS**. New licenses are signed with **ES256** (`alg: ES256` —
ECDSA over NIST P-256 with SHA-256); already-deployed **Ed25519** licenses (`alg: EdDSA`) keep
verifying through the K = 5 rolling transition (§6.3). The signing algorithm is **pinned per `kid`**,
never taken from the token's own header (see below). "Attached" means the payload travels inline as
the middle segment (it is not a detached JWS). The token is:

```
token = base64url(header) "." base64url(payload) "." base64url(signature)
```

- **base64url is unpadded** (no `=`), per the JOSE base64url convention.
- The signature covers the **exact ASCII bytes** `base64url(header) || '.' || base64url(payload)`.

## Header

```json
{ "alg": "ES256", "kid": "hp-lic-2026b", "typ": "hp-lic+jws" }   // new licenses (P-256 kid)
{ "alg": "EdDSA", "kid": "hp-lic-2026a", "typ": "hp-lic+jws" }   // legacy kid, still in the K=5 window
```

- `alg` is **pinned per `kid` — never read from the header to *choose* the algorithm.** The verifier
  looks up `kid` in the trusted set, reads the algorithm **that entry was provisioned with** (`ES256`
  for a P-256 kid, `EdDSA` for an Ed25519 kid), and verifies with *that* algorithm. It additionally
  asserts the header's `alg` **equals** the pinned algorithm for the kid and rejects any disagreement
  **before** touching the signature (an `ES256` kid presented as `alg: EdDSA`, or vice versa, is
  rejected; so are `none` and any unknown `alg`). The header's `alg` never selects the algorithm; it
  is only cross-checked against the pin. This per-`kid` pinning is the alg-confusion defense the
  dual-algorithm window requires (ADR-001).
- `kid` names the signing key. The client ships the **last K = 5** issuer public keys (§6.3); a token
  whose `kid` is not in that trusted set fails verification.
- `typ` MUST be `hp-lic+jws`.

## Payload

```json
{
  "license_id": "lic_7f3a",
  "sub": "user_123",
  "skill_id": "cooking-assistant",
  "version_constraint": ">=1.0.0",
  "entitlement": "perpetual",
  "device_id": "dev_ab12",
  "device_binding": "<coarse server-side fingerprint>",
  "max_devices": 5,
  "iat": 1760000000,
  "exp": null,
  "iss": "hydropark-licensing"
}
```

| Field | Meaning |
|---|---|
| `license_id` | Unique id of this issued token (also the server's `licenses._id`). |
| `sub` | The owning user id. |
| `skill_id` | The licensed skill (human slug). |
| `version_constraint` | Semver range the license covers. |
| `entitlement` | `perpetual`. |
| `device_id` | The device this token is bound to. |
| `device_binding` | Coarse, server-derived fingerprint. **Server-side only** — never re-derived offline; treat as an opaque equality check against the device record if you have one, not as something to recompute. |
| `max_devices` | **Advisory only.** The real slot cap is enforced server-side at issuance; do not treat a stale value here as authoritative. |
| `iat` | Issued-at (unix seconds). |
| `exp` | Always `null` — **perpetual**. Verification is signature + field checks, **never a clock and never a network callback.** |
| `iss` | `hydropark-licensing`. |

## Verification algorithm (do it in this order)

1. Split the token on `.` into exactly **three** non-empty segments. Anything else → invalid.
2. Let `signing_input` = the raw bytes of `segments[0] + "." + segments[1]` **as received** — do not
   decode-and-re-encode, do not canonicalize, do not re-serialize any JSON.
3. base64url-decode and JSON-parse the **header**. Assert `typ == "hp-lic+jws"` and read `kid`. Do
   **not** read the header's `alg` to *select* an algorithm — the pinned algorithm for the `kid`
   governs (step 4).
4. Look up `kid` in the shipped trusted set to get **both its public key and its pinned algorithm**
   (a P-256 key → `ES256`; an Ed25519 key → `EdDSA`). Unknown/rolled-off `kid` → invalid. Assert the
   header's `alg` **equals** that pinned algorithm and reject any mismatch (and `none`/unknown) here,
   before touching the signature.
5. base64url-decode the **signature** segment and verify it over `signing_input` with that `kid`'s
   pinned algorithm. Bad signature → invalid.
   - **ES256** — ECDSA over P-256 with SHA-256. The signature is the fixed **64-byte raw `R‖S`**
     (RFC 7518 §3.4 / IEEE P1363): R and S each 32 bytes, left-zero-padded big-endian; a non-64-byte
     ES256 signature is rejected outright. (A JDK/WebCrypto ECDSA verifier consumes DER, so the raw
     `R‖S` is converted to DER first — see `EcdsaP1363` in `io.hydropark.signing`.)
   - **EdDSA** — Ed25519 over the raw 64-byte signature.
6. **Only now** base64url-decode and JSON-parse the **payload**. Assert `iss == "hydropark-licensing"`,
   `entitlement == "perpetual"`, `exp` is `null`, and the required fields are present.
7. If every check passes, the parsed payload is trustworthy. There is no expiry and no phone-home.

> The whole point of choosing JWS-over-exact-bytes (rather than a hand-rolled canonical JSON) is step
> 2: the bytes verified are the bytes received, so a valid license can never be bricked by a
> serialization disagreement between issuer and client. If a bespoke JSON encoding is ever
> reintroduced it MUST be RFC 8785 (JCS) with the signature in a detached envelope — but JWS is the
> default precisely to avoid that.

## Keys

- Public keys are base64 **X.509 SubjectPublicKeyInfo**; the private halves (issuer only) are base64
  **PKCS#8** (in-memory JDK path) or held **non-exportable in a cloud KMS / PKCS#11 HSM** (see below).
  New signing keys are **P-256 (ES256)**; already-deployed keys still inside the K=5 window are
  **Ed25519 (EdDSA)**. The container format (SPKI / PKCS#8, base64) is identical for both — only the
  curve, and therefore the JCA `KeyFactory`, differs.
- **For a given algorithm, issuer-side custody is invisible to this format.** On the EdDSA path,
  whether the issuer signs with an in-memory JDK key (P1-16.3) or a hardware HSM over PKCS#11
  (option (a) in `HSM-MIGRATION.md`), the token bytes and this verification algorithm are **identical**
  — the same raw Ed25519 signature over the same `base64url(header) || '.' || base64url(payload)`
  bytes. The client neither knows nor cares which signer produced it.
- **The move to ES256 IS the plan — option (b), ADR-001.** No major cloud KMS/HSM signs Ed25519, so
  obtaining non-exportable cloud-KMS custody (the P1-16.8 goal) required changing the *algorithm*: new
  licenses are **ES256** under a P-256 key a cloud KMS can hold non-exportably. Unlike the
  format-invisible EdDSA custody swap above, this is a **client-visible** change — which is exactly why
  the verifier is dual-algorithm and pins the algorithm **per `kid`** (the alg-confusion mitigation
  that reintroduces). Today the issuer signs ES256 with an in-memory JDK key through the same `Signer`
  seam a cloud-KMS backend slots into (`io.hydropark.signing`); the token bytes are identical either
  way. **Note:** ECDSA is **non-deterministic** — a fresh random nonce per signature — so, unlike
  Ed25519, signing the same input twice yields two different (both valid) signatures; the signature
  bytes are therefore **not** a golden-file or idempotency key. See ADR-001 and `HSM-MIGRATION.md`.
- Rotation is additive: an offline device keeps verifying its cached tokens under the older `kid` it
  already trusts; it only needs an app update to trust **newly** rotated keys, which it encounters
  only when back online. See `KEY-COMPROMISE-RUNBOOK.md` and `HSM-MIGRATION.md`.

## Issuance idempotency (`POST /v1/licenses/issue`)

Re-issuing a license is **naturally idempotent** — the client does **not** send an `Idempotency-Key`,
and the server neither requires nor stores one.

The guarantee comes from a **partial unique index** on `licenses (user_id, skill_id, device_id) WHERE
status='active'`: at most one *live* license can exist per `(user, skill, device)`. On
`POST /v1/licenses/issue` the Issuer first looks up that active row and, if present, returns the
existing token verbatim (no new signature, no rate budget consumed). A concurrent race that slips past
the read is caught by the unique index at insert time — the duplicate-key loser re-reads and returns
the winner's token. Either way a repeated request yields the **same** `license_id`/token, which is
exactly what an idempotency key would otherwise buy — so there is nothing for a key to add.

Because perpetual tokens are additive (a re-issue supersedes, never invalidates), returning the
existing token is always safe. This is a different mechanism from the money-path endpoints
(`checkout`, `pay-wallet`), which **do** take a required/honored `Idempotency-Key` because a duplicate
there would double-charge; issuance has no such hazard.

> A client that sends an `Idempotency-Key` header anyway is unaffected: the endpoint does not read it
> (the header is CORS-allowed only so the shared money-path client code can set it uniformly). It is
> accepted at the HTTP layer and ignored — it changes nothing.
