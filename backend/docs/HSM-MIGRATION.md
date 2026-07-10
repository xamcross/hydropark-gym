# Pre-scale HSM/KMS migration for the License Issuer

> **Ticket:** BACKLOG **P1-16.8** — replace the interim software-secret key custody (P1-16.3) with a
> real key-protection backend **before paid acquisition / real catalog revenue**.
>
> **Design refs:** BACKEND-DESIGN §6.1 (JWS format), §6.2 (key custody & isolation), §6.3 (K=5
> rolling trusted set), §6.4 (compromise response), §11.2 #1 (the interim decision this closes).
> Companion runbook: `KEY-COMPROMISE-RUNBOOK.md`. Token format: `LICENSE-FORMAT.md`. Decision record:
> **`ADR-001-license-signature-algorithm.md`**.
>
> **Status (2026-07-10): decided.** The owner has chosen **option (b) — ES256 (P-256 ECDSA) on a
> cloud KMS** as the pre-scale key-custody backend. See `ADR-001-license-signature-algorithm.md` for
> the full Context/Decision/Consequences. This document is now the **primary runbook** for that
> migration; the previously-recommended YubiHSM/PKCS#11 path is retained below (§5) as the rejected
> alternative, not the plan.

---

## 0. TL;DR

- **No major cloud KMS/HSM signs Ed25519** (verified 2026-06 against current Azure/AWS/GCP docs — see
  §1). BACKEND-DESIGN §6.2's original target, "Azure Managed HSM (OKP/Ed25519)," does not exist.
  Getting cloud-managed custody therefore requires changing the license signature algorithm, not just
  relocating the existing key.
- **Decision (ADR-001, 2026-07-10): switch to ES256 (ECDSA P-256 + SHA-256).** Azure Managed HSM and
  AWS KMS both support P-256 ECDSA as an HSM-backed, non-exportable key (§2 gives the exact key-spec
  identifiers). New licenses are issued as `alg: ES256`; already-issued Ed25519 licenses keep
  verifying during the K=5 transition window (§4).
- **This is additive, not a cutover.** The existing K=5 rolling trusted-key set (BACKEND-DESIGN §6.3)
  and `RollingKeyReissuer` carry the fleet across the algorithm switch exactly as they carry any other
  key rotation: old Ed25519 `kid`s stay trusted for verification until they roll off the window; no
  offline license holder is stranded. The one added rule (not present in a same-algorithm rotation):
  the verifier must be able to **verify ES256 at all**, which means the not-yet-built Phase-1 offline
  verifier (P1-09) needs ES256 support from its first release, and ES256 issuance should be gated on
  that release having reached devices (§4 step 3).
- **The rejected alternative — YubiHSM 2 / PKCS#11, keeping Ed25519 — remains documented at §5.** It
  was the original recommendation because it leaves the client-visible format untouched; it was not
  chosen because it requires hardware custody on a host outside Fly's ephemeral infra. See ADR-001
  "Alternatives considered" for the full reasoning.
- **The `Signer` seam already built for this ticket (§3) is algorithm-agnostic by design** — a
  `KmsEs256Signer` slots into the same interface the JDK/PKCS#11 Ed25519 signers use.

---

## 1. The finding: cloud KMS/HSM do not sign Ed25519 (verified 2026-06)

BACKEND-DESIGN §6.2 originally named **"Azure Managed HSM (OKP/Ed25519)"** as the target. That option
does not exist.

**Exact statement of the finding (unchanged; this is why the decision in §2 was necessary):**

> As of Microsoft's current Managed HSM documentation (supported-key-types / supported-algorithms
> tables, checked 2026-06), Azure **Managed HSM supports only RSA, EC (P-256, P-256K, P-384, P-521),
> and AES keys**, and sign/verify is limited to **ES256/ES384/ES512, PS256/384/512, RS256/384/512,
> and HS256/384/512**. There is **no OKP key type, no Ed25519 curve, and no EdDSA algorithm** in the
> Managed HSM supported-algorithms table. The Azure SDKs expose `OKP` / `OKP-HSM` enum values, but
> those are client-side surface for a feature the **service does not list as supported** — they do
> not make Managed HSM sign Ed25519. **AWS KMS** (asymmetric sign: RSA + ECDSA over NIST P-256/384/521
> and secp256k1, plus SM2) and **GCP Cloud KMS** (RSA + EC P-256/P-384) likewise do **not** offer
> Ed25519 signing. **Conclusion: no major cloud KMS/HSM signs Ed25519 today.**

Why this mattered: the whole licensing model (§6.1, §13.12) was **Ed25519 JWS verified offline**
against public keys already baked into every shipped app (the K=5 trusted set, §6.3). "Move the key to
a cloud HSM" was impossible **without also changing the algorithm** — a client-visible change, not a
backend-only one. That trade-off is exactly what ADR-001 evaluates and accepts.

---

## 2. The decision: ES256 (P-256 ECDSA) on a cloud KMS

**Chosen key spec — either provider is a valid target; pick based on existing cloud footprint (open
item, §6):**

| | **Azure Managed HSM** | **AWS KMS** |
|---|---|---|
| Key type | `EC-HSM` (Managed HSM issues only HSM-protected keys, hence the `-HSM` suffix — this differs from standard Key Vault's software-protected `EC`) | Customer master key, `KeyUsage = SIGN_VERIFY` |
| Curve / key spec | `P-256` (NIST P-256 / secp256r1) | `KeySpec = ECC_NIST_P256` |
| Sign algorithm identifier | `ES256` (Managed HSM's `sign` REST op / SDK use the JOSE algorithm name directly) | `SigningAlgorithm = ECDSA_SHA_256` |
| Sign input | a **pre-computed digest** — CONFIRMED against Microsoft's current Managed HSM docs (2026-06): *"Strictly, this operation is 'sign hash' or 'verify hash', as the service doesn't hash content as part of signature creation. Applications should hash the data to be signed locally, then request that the service sign the hash."* So `KmsEs256Signer` must `SHA-256(signingInput)` itself and send the 32-byte digest with `alg=ES256`. | `MessageType = RAW` (KMS hashes internally, input ≤ 4096 bytes) **or** `MessageType = DIGEST` (caller supplies the pre-computed SHA-256 digest) — either works |
| Signature shape returned | raw, fixed-width **R‖S** (64 bytes for P-256) — already JOSE-compatible, no decoding needed **[flag: verify — moderate confidence, double-check against current Key Vault docs]** | **DER**-encoded `SEQUENCE{INTEGER r, INTEGER s}` — must be converted to raw R‖S for the JWS (§3) |
| Non-exportability | Key never leaves the HSM boundary; only `sign`/`verify`/`getPublicKey` are exposed | Key never leaves KMS; only `Sign`/`Verify`/`GetPublicKey` are exposed |
| IAM surface | Managed identity + Key Vault/Managed HSM RBAC role scoped to `sign` only on this key | IAM role/policy granting `kms:Sign` (and `kms:GetPublicKey` for the public export) scoped to this key's ARN only |

(GCP Cloud KMS also has an equivalent — algorithm `EC_SIGN_P256_SHA256`, `protectionLevel: HSM` — but
is not one of the two options carried forward here; add it later if the owner's cloud footprint moves
there.)

**Why this is the only algorithm that satisfies both constraints simultaneously:** it is the one
signature scheme that is (i) actually offered by a managed cloud KMS as an HSM-backed key, and
(ii) a standard JOSE `alg` (`ES256`, RFC 7518 §3.4) the offline verifier can implement without
inventing a bespoke scheme. See ADR-001 for the full trade-off writeup (non-determinism, per-`kid`
algorithm pinning, the not-yet-built P1-09 verifier).

---

## 3. The signer integration

BACKEND-DESIGN and this ticket's prior work already shape the Issuer around a signer seam that is
**algorithm-agnostic by design** — this is what makes "the algorithm changed" a backend-swap problem
rather than a full redesign of the Issuer. Package `io.hydropark.signing`:

- **`Signer`** — the interface: `byte[] sign(byte[] signingInput, SigningKeyRef key)` returns the raw
  signature over the exact bytes `base64url(header) || '.' || base64url(payload)`; `SigningKeyRef
  activeKey()` exposes the active key's `kid` + public half. This is the *only* thing that differs
  between an in-memory JDK key, a PKCS#11 hardware key, and a cloud KMS key — the shape returned is
  always "the raw signature bytes for this algorithm," never algorithm-specific plumbing leaking into
  callers.
- **`SigningKeyRef`** — `(kid, PublicKey)`. Deliberately carries **no** private material, so a
  hardware/KMS signer that never exposes the private key still fits without changing this type.
- **`JdkEd25519Signer`** — the interim in-memory JDK-native path (P1-16.3), the default until this
  migration completes. Produces the same Ed25519 signature bytes the Issuer has always minted.
- **`Pkcs11Ed25519Signer`** — the gated skeleton for the rejected hardware-HSM alternative (§5); kept
  in the codebase as a documented escape hatch, not on the migration path.
- **This is where `KmsEs256Signer` slots in.** Same `Signer` interface, new algorithm:
  1. Resolve the KMS key reference for the requested `kid` (Azure: vault URI + key name + version;
     AWS: key ARN).
  2. Call the KMS `sign` API with `signingInput` (or its SHA-256 digest, per the provider's contract
     — §2's flagged row) and the ES256/`ECDSA_SHA_256` algorithm identifier.
  3. **Normalize the returned signature to raw R‖S.** AWS KMS returns **DER**; the signer converts
     DER → fixed-width R‖S **the same conversion routine the local (non-KMS) ES256 signer already
     needs**, because the JDK's own `Signature.getInstance("SHA256withECDSA")` also emits ASN.1 DER —
     JOSE/JWS requires raw R‖S (RFC 7518 §3.4), so *every* ES256 signer in this codebase, KMS-backed
     or not, does this conversion. Azure Key Vault/Managed HSM already returns raw R‖S, so that path
     skips the conversion (flagged above — verify before relying on it).
  4. Return the raw signature bytes. The Issuer's token-assembly code (owned by `LicenseSigner`, not
     this doc) is unaware which provider produced them.
- **`SigningProperties`** (`hydropark.signing.*`) gains a KMS provider entry alongside `jdk`/`pkcs11`
  (e.g. `provider: kms-es256`) with the KMS endpoint/key reference and credential configuration. The
  private key material never appears in this config — only identifiers and IAM/credential references,
  which is the whole point of moving custody off the Issuer host.
- **The KMS holds the private key non-exportably; the app only ever sends the signing input (or its
  digest) and receives the signature back.** This is the property that closes the P1-16.8 residual: a
  compromised Issuer host can no longer exfiltrate a raw private key, because there is no longer a raw
  private key on that host at all — only network credentials scoped to `sign`. (See
  `KEY-COMPROMISE-RUNBOOK.md` for how this changes the compromise-response playbook.)

`LicenseSigner` continues to own the token format and delegates only the raw signature to the injected
`Signer`; per-`kid` algorithm pinning (ADR-001) lives in the trusted-key-set config, not in this seam.
The byte-level header/payload/signature format for `alg: ES256` is specified in `LICENSE-FORMAT.md`
(owned by the code workstream) — this document does not restate it.

---

## 4. Migration runbook — ES256 on cloud KMS, no stranding

The K=5 rolling trusted set + additive re-issue (BACKEND-DESIGN §6.3) carries the fleet across this
switch exactly as it carries any other rotation. The one thing that makes this migration wider than a
routine rotation is step 3: clients must be able to **verify ES256 at all** before they can be handed
an ES256 license.

**Key strategy — this is necessarily a fresh key, not an import.** Unlike the rejected YubiHSM path
(where "import the existing Ed25519 key vs. generate fresh" was a real choice), there is **no import
option here**: an Ed25519 key cannot become a P-256 ECDSA key. The KMS key is generated fresh,
non-exportable from birth — which also means the algorithm switch doubles as leaving behind the
software key that P1-16.3/§11.2 #1 flagged as at-risk, with no carried-forward exposure to weigh.

1. **Provision the KMS key.** Create the P-256 signing key in Azure Managed HSM or AWS KMS per §2's
   spec. Grant the Issuer's identity **only** the `sign` (and `getPublicKey`) permission on this
   specific key — no broader KMS/vault access. Record the key reference (vault+name+version, or ARN).
2. **Export its public half.** Fetch the public key (Azure `GetKey`; AWS `GetPublicKey`) and encode it
   as base64 X.509 SubjectPublicKeyInfo — same shape the existing Ed25519 public keys use in the
   trusted set, just a different key type/curve.
3. **Publish it as a new `kid` in the trusted set, gated on verifier readiness.** Add the new ES256
   `kid` + public key to the app's shipped trusted set in the next client release, appended to the
   K=5 window per the existing additive-rotation rule (§6.3) — **but only once that release also ships
   an ES256-capable offline verifier** (Phase-1 P1-09). Unlike a same-algorithm Ed25519 rotation, an
   ES256 `kid` is useless to a client whose verifier predates ES256 support, so this release is a hard
   prerequisite, not just routine trusted-set churn.
4. **Flip the Issuer's active signing key to the ES256 `kid`.** Point `hydropark.signing.provider` at
   the KMS signer (§3), set the new `kid` as `active: true` (public half only in
   `hydropark.licensing.keys`; no private key — it never leaves the KMS), and deploy the Issuer zone.
   New tokens now sign under ES256 via the KMS.
5. **Old Ed25519 `kid`s keep verifying until they roll off the window.** No action needed for this —
   it is the same additive guarantee every other rotation relies on: a device that never updates keeps
   verifying its cached Ed25519 tokens under the `kid` it already trusts, for as long as that `kid`
   stays in the shipped trusted set.
6. **Proactive re-issue moves active licenses onto the ES256 `kid` before the old one rolls off.** Run
   `RollingKeyReissuer.reissueForRollingKey()` — already built, no code change needed for this — to
   re-sign active licenses whose Ed25519 `kid` is nearing roll-off onto the new ES256 `kid`, marking
   the old rows `superseded`. Online clients on the ES256-capable release re-`POST /v1/licenses/issue`
   for any cached license whose `kid` is at/near roll-off; fresh ES256 tokens supersede.
7. **Gate old-`kid` removal on coverage, exactly as any rotation does.** Before a build that drops the
   old Ed25519 `kid` reaches a material population, confirm
   `RollingKeyReissuer.coverageForKid(oldKid).safeToRemove()` (zero remaining active licenses under
   it), or explicitly accept the residual. Never drop a `kid` a live population still depends on.
8. **Retire the interim software key.** Once the old software `kid` clears the coverage gate, drop it
   from shipped builds on the following release, and decommission the Fly-secret custody path it used
   (rotate/destroy the secret; rebuild, don't just redeploy, the host that held it). Update
   BACKEND-DESIGN §11.2 #1 and close the pre-scale gate in `KEY-COMPROMISE-RUNBOOK.md`.

**No offline license holder is ever stranded** because (i) Ed25519 verification is retained for the
whole transition window, (ii) the new `kid` is additive, and (iii) old-`kid` removal is
coverage-gated — the same three properties every other rotation in this system relies on. The one new
discipline versus a same-algorithm rotation is step 3's verifier-readiness gate.

---

## 5. Rejected alternative — YubiHSM 2 / PKCS#11, keeping Ed25519

This was the original recommendation in this document (pre-2026-07-10) and remains a real option if
cloud-KMS custody ever stops fitting the ops model. **See `ADR-001-license-signature-algorithm.md`,
"Alternatives considered," for why it was not chosen.** Summary, kept for reference:

Move the private key into a hardware token that supports Ed25519 over PKCS#11, and have the Issuer
sign via `C_Sign`. The license stays `alg: EdDSA`; the token format, shipped public keys, and offline
client verifier are **unchanged** — only the Issuer's signer implementation swaps.

| Device | Ed25519 support | Rough cost | Notes |
|---|---|---|---|
| **YubiHSM 2** | Yes — `ed25519` asymmetric key with the `sign-eddsa` capability, exposed via `yubihsm_pkcs11` | ~US$650 per unit | The cheap, realistic choice. USB nano form factor; reached in production via the YubiHSM Connector daemon. |
| **Thales Luna (Network HSM)** | Yes — EdDSA / Ed25519 via its PKCS#11 provider | ~US$10k+ | Network-attached; heavier ops, FIPS 140-2/3 L3. |
| **Entrust nShield** | Yes — EdDSA via nCipher PKCS#11 | ~US$10k+ | Similar tier to Luna. |

Rejected because it requires **hardware custody** on a host outside Fly's ephemeral infra — one
always-on box holding the physical token, firmware/PIN/backup-unit operational overhead — which is a
worse fit for the owner's ops model than a cloud KMS the owner already has account/IAM tooling for,
even though it would have kept the client-visible format untouched. `Pkcs11Ed25519Signer` (§3) remains
in the codebase as a gated skeleton if this path is ever revisited; **when reviving it, re-read
ADR-001 first** — the reasoning it was rejected for needs to still not apply.

---

## 6. Open items for the owner to decide

1. **Azure Managed HSM vs. AWS KMS** — both satisfy the decision in §2; pick based on existing cloud
   account footprint, IAM tooling, and cost. Not yet decided in this document.
2. **Sign input is RESOLVED** for Azure Managed HSM: it is sign-hash (caller pre-hashes) — confirmed
   against Microsoft's current docs. The one remaining KMS detail to confirm before implementing
   `KmsEs256Signer` is **whether Azure returns the ECDSA signature as raw R‖S or DER** (AWS is
   confidently DER → convert). Either way the local ES256 signer's DER→R‖S routine already handles the
   DER case, so this only affects whether the Azure path skips that conversion.
3. **Sequencing with Phase-1 P1-09** (the client offline verifier, not yet built) — §4 step 3 makes
   that release a hard prerequisite for ES256 issuance; confirm it is scheduled ahead of the KMS
   cutover, not after.
4. **Shared vs. separate KMS key for package signing** (P1-19.1, a different signing purpose from
   license issuance) — likely a distinct key object in the same KMS, mirroring the same
   role-separation the HSM path would have used.
