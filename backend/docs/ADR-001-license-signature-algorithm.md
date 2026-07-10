# ADR-001: License signature algorithm — Ed25519 → ES256 for cloud-KMS custody

> **Status:** Accepted — 2026-07-10
> **Design refs:** BACKEND-DESIGN §6.1 (JWS format), §6.2 (key custody & isolation), §6.3 (K=5 rolling
> trusted set), §6.4 (compromise response), §11.2 #1 (the interim custody decision this succeeds).
> **Companion docs:** `HSM-MIGRATION.md` (the runbook this decision drives), `KEY-COMPROMISE-RUNBOOK.md`
> (updated for dual-algorithm custody), `LICENSE-FORMAT.md` (owned by the code workstream — the
> byte-level JWS format is defined there, not restated here).
> **Ticket:** BACKLOG P1-16.8 (pre-scale key-custody migration).

## Context

BACKEND-DESIGN §6.1 chose a compact, attached **JWS with `alg: EdDSA` (Ed25519)** for the offline
license token: the client verifies the exact received bytes against a shipped public key, with no
`alg` agility and no re-serialization risk (B3). §6.2 named the target key-custody backend as an
"EdDSA-capable HSM" — originally written as "Azure Managed HSM (OKP/Ed25519)".

As an interim step (§11.2 #1, decided 2026-07-09, ticket P1-16.3), the Issuer's Ed25519 private keys
were placed in **Fly.io encrypted secrets** — an explicit, documented downgrade of the §13.8 trust
root, accepted only as a conscious early-stage risk: a compromised Issuer host yields the raw private
key, enabling catalog-wide license forgery (a "keygen", SPEC §28.2). BACKLOG **P1-16.8** exists
specifically to close that exposure — migrate to real key-protection custody — **before paid
acquisition / real catalog revenue**.

**The blocking discovery (`HSM-MIGRATION.md` §1, verified 2026-06 against current provider docs):**
no major cloud KMS/HSM signs Ed25519. Azure Managed HSM supports only RSA, EC (P-256/P-384/P-521), and
AES keys, with sign/verify limited to ES256/384/512, PS256/384/512, RS256/384/512, HS256/384/512 — no
OKP key type, no EdDSA algorithm. AWS KMS's asymmetric signing likewise offers only RSA and ECDSA
(NIST P-256/P-384/P-521, secp256k1) plus SM2 — no Ed25519. GCP Cloud KMS is the same shape (RSA + EC
P-256/P-384, no EdDSA). §6.2's named target therefore does not exist: "lift the Ed25519 key into a
cloud HSM" is not an available migration, full stop — the algorithm itself must change to get
cloud-managed custody.

`HSM-MIGRATION.md` originally framed this as a choice between two real options and recommended
**(a) YubiHSM 2 over PKCS#11**, which keeps Ed25519 and the offline-verify contract byte-for-byte
unchanged but requires hardware custody on a host outside Fly's ephemeral infra. Option **(b)** —
change the signature algorithm to one a cloud KMS supports — was documented as the escape hatch, not
the plan. This ADR records that the owner has now chosen **(b)**.

## Decision

**Adopt ES256 (ECDSA over NIST P-256, SHA-256) for new license signing.** New licenses are issued as a
JWS with `alg: ES256`, signed by a P-256 key held non-exportably in a cloud KMS (Azure Managed HSM or
AWS KMS — see `HSM-MIGRATION.md` §2 for the concrete key-spec identifiers).

**Ed25519 verification is kept during the transition window.** The client's offline verifier trusts
both algorithms for the duration of the K=5 rolling trusted-key set (§6.3): already-issued Ed25519
licenses keep verifying under their existing `kid`s until those keys roll off the window in the
ordinary course of rotation; only *new* issuance moves to ES256. This is the existing additive
rotation machinery (`RollingKeyReissuer`, the coverage gate) — no offline license holder is stranded
by this switch, exactly as it protects against stranding on any other key rotation.

The verifier pins **algorithm to `kid`**, never to the token's `alg` header: each trusted-set entry
records which algorithm its key uses, and verification uses that pinned algorithm regardless of what
the header claims. This is the load-bearing mitigation for the alg-confusion risk this decision
reintroduces (see Consequences).

## Consequences

**(a) Cloud-managed HSM custody becomes possible — the reason for this change.** Azure Managed HSM or
AWS KMS can hold a non-exportable P-256 signing key; the Issuer calls the KMS's `Sign` API with the
signing input (or its digest) and receives back a signature, and the private key never enters Issuer
host memory. This closes the exact residual P1-16.8 exists to close, without hardware custody on
Fly's ephemeral infra. See `HSM-MIGRATION.md` for the concrete KMS options and the `Signer`-seam
integration (`KmsEs256Signer`).

**(b) The JWS now carries `alg: ES256` and a raw R‖S signature; the offline verifier must handle
ECDSA, and the trusted set becomes dual-algorithm during the transition.** This is a client-visible
change: the not-yet-built Phase-1 offline verifier (P1-09) must be written to verify **both** `EdDSA`
and `ES256` from the start, keyed off which algorithm each trusted `kid` is pinned to. This
reintroduces exactly the per-`kid` algorithm agility that §6.1 deliberately removed to avoid
`alg`-confusion attacks. The mitigation is pinning: the verifier must **never** trust the algorithm
named in the token's own header — it looks up the `kid` in the trusted set, reads the algorithm
*that entry* was provisioned with, and rejects a token whose header disagrees with the pinned
algorithm for that `kid`. A `kid` is never re-purposed across algorithms. (The byte-level format
changes — header shape, DER→R‖S signature encoding, verification-order updates — are specified in
`LICENSE-FORMAT.md`, owned by the code workstream; this ADR does not restate them.)

**(c) ECDSA signing is non-deterministic; Ed25519 signing was deterministic.** P-256 ECDSA draws a
fresh random nonce `k` per signature (or a deterministic-`k` scheme per RFC 6979, if the chosen KMS
supports it — cloud KMS sign APIs typically do not expose this as a caller-controlled toggle, so
assume ordinary randomized ECDSA). This does not weaken the signature — a valid ECDSA signature is a
valid ECDSA signature regardless of how `k` was chosen — but it does mean **signing over the same
input twice produces two different, both-valid signatures**, unlike Ed25519 which is deterministic
and reproducible byte-for-byte. Nothing in the license flow depends on signature reproducibility
today (§6.1's byte-exactness guarantee is about the *verifier* checking received bytes, not about
re-signing producing identical bytes), but it is a real behavioral difference worth naming: signature
values are no longer suitable as a dedupe/idempotency key or a golden-file byte-for-byte test fixture
the way the current `LicenseCryptoTest` treats Ed25519 output. Tests and audit tooling that assumed
"same input → same signature" need updating.

**(d) The client offline verifier (Phase-1 P1-09), not yet built, must be written for ES256 from the
start.** Because that verifier does not exist yet, this decision has no legacy-client migration cost
for the *verifier code itself* — it simply needs to ship supporting both algorithms (per-`kid` pinned)
in its first release, rather than being built Ed25519-only and retrofitted later. It does still need
to ship *before* any ES256 license is issued to a device running it, per the ordinary K=5
no-stranding discipline (§6.3).

## Alternatives considered

1. **YubiHSM 2 (or another PKCS#11 HSM) keeping Ed25519 — rejected.** `HSM-MIGRATION.md` originally
   recommended this: it preserves the offline-verify contract exactly (same algorithm, same format,
   same verifier, same public keys — a pure backend signer swap), and several PKCS#11 HSMs support
   Ed25519 (YubiHSM 2 ~US$650, Thales Luna, Entrust nShield). It was rejected as the path forward
   because it requires **hardware custody** — a physical token on an always-on host reachable from
   Fly's ephemeral infra — which is awkward operationally (firmware, PIN/auth-key custody, backup
   unit, DR) compared to a managed cloud KMS the owner already has account/IAM tooling for. This
   remains the other real option and is kept documented in `HSM-MIGRATION.md` as the rejected
   alternative, in case cloud-KMS custody stops fitting the ops model later (e.g., a future
   compliance requirement for FIPS 140-3 Level 3 hardware the owner's cloud KMS tier doesn't meet).
2. **Stay on in-memory Ed25519 in Fly secrets permanently — rejected.** This is the interim P1-16.3
   state, never intended as the permanent answer: a popped Issuer host yields the raw private key and
   thus catalog-wide license forgery, which is the exact risk P1-16.8 exists to close. Staying here
   was not a real alternative so much as the default this ADR is explicitly closing out.

## Status

**Accepted, 2026-07-10.** New license signing moves to ES256 on a cloud KMS; Ed25519 verification is
retained during the K=5 transition window per the no-stranding runbook in `HSM-MIGRATION.md` §5.
