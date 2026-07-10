# Hydropark license token format

> Source of truth for the **offline** license verifier the Angular/Tauri client ships. It mirrors the
> server implementation in `io.hydropark.licensing.LicenseVerifier`. If this document and that class
> disagree, the class wins and this document is the bug.
>
> Backend design: BACKEND-DESIGN §6.1 / §13.3 / §13.12.

## What it is

A license is a **compact, attached JWS** signed with **Ed25519** (`alg: EdDSA`). "Attached" means the
payload travels inline as the middle segment (it is not a detached JWS). The token is:

```
token = base64url(header) "." base64url(payload) "." base64url(signature)
```

- **base64url is unpadded** (no `=`), per the JOSE base64url convention.
- The signature covers the **exact ASCII bytes** `base64url(header) || '.' || base64url(payload)`.

## Header

```json
{ "alg": "EdDSA", "kid": "hp-lic-2026a", "typ": "hp-lic+jws" }
```

- `alg` MUST be exactly `EdDSA`. Reject anything else **before** touching the signature (no `alg`
  agility, no `none`).
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
3. base64url-decode and JSON-parse the **header**. Assert `alg == "EdDSA"`, `typ == "hp-lic+jws"`,
   read `kid`.
4. Look up the Ed25519 public key for `kid` in the shipped trusted set. Unknown/rolled-off `kid` →
   invalid.
5. base64url-decode the **signature** segment and verify it over `signing_input` with that public
   key. Bad signature → invalid.
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
  **PKCS#8** (in-memory JDK path) or held **non-exportable inside a PKCS#11 HSM** (see below). Both
  are Ed25519.
- **Issuer-side key custody is invisible to this format.** Whether the issuer signs with an in-memory
  JDK key (the interim default, P1-16.3) or a hardware HSM over PKCS#11 (the pre-scale target,
  P1-16.8), the token bytes and this verification algorithm are **identical** — the signature is the
  same raw Ed25519 signature over the same `base64url(header) || '.' || base64url(payload)` bytes.
  The client neither knows nor cares which signer produced it. This is exactly why option (a) in
  `HSM-MIGRATION.md` was chosen: moving to hardware custody changes nothing a verifier sees. (A move
  to a cloud KMS would instead require an algorithm change — `alg: ES256` — and a client verifier
  update; that is the wider option (b), not the plan.)
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
