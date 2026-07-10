# Pre-scale HSM/KMS migration for the License Issuer

> **Ticket:** BACKLOG **P1-16.8** — replace the interim software-secret key custody (P1-16.3) with a
> real key-protection backend **before paid acquisition / real catalog revenue**.
>
> **Design refs:** BACKEND-DESIGN §6.1 (JWS/EdDSA format), §6.2 (key custody & isolation), §6.3 (K=5
> rolling trusted set), §6.4 (compromise response), §11.2 #1 (the interim decision this closes).
> Companion runbook: `KEY-COMPROMISE-RUNBOOK.md`. Token format: `LICENSE-FORMAT.md`.
>
> **Status:** decision + staged code seam landed; hardware/driver rollout is the remaining work.

---

## 0. TL;DR

- **The design's stated HSM premise is wrong.** BACKEND-DESIGN §6.2 says to move the Ed25519 key
  into "Azure Managed HSM (OKP/Ed25519)". **No major cloud KMS/HSM signs Ed25519.** So P1-16.8 cannot
  be "lift the existing key into Azure Managed HSM" as written.
- There are exactly **two honest paths**, and both are real work:
  - **(a) PKCS#11 hardware HSM that supports EdDSA** (YubiHSM 2 is the cheap, realistic choice; Thales
    Luna / Entrust nShield also qualify). **Keeps** the offline JWS/EdDSA format, the shipped public
    keys, and the client verifier **unchanged**. Cost: real hardware custody, awkward on Fly's
    ephemeral infra.
  - **(b) Change the license signature algorithm to one a cloud KMS supports** (ES256 / P-256 ECDSA
    via Azure Managed HSM or AWS KMS). Gets cloud-managed custody, but is a **spec change** to §6.1's
    JWS format, forces a **dual-algorithm offline verifier** onto every client, and **re-keys** the
    entire trusted-key set.
- **Recommendation: (a), YubiHSM 2 over PKCS#11.** It preserves the exact offline-verify contract
  §6.1 was designed to protect, makes the migration a **backend-only signer swap** the code is now
  staged for, and lets the existing **additive K=5 rotation** carry the whole fleet across the switch
  **without stranding a single offline license holder**. Keep (b) as a documented escape hatch for
  if/when hardware custody stops fitting the ops model at scale.
- **This ticket delivered the seam, not the hardware.** The default remains JDK in-memory keys from
  Fly secrets (P1-16.3); the signer is now selected by config and an HSM implementation slots in
  behind a stable interface. See §4.

---

## 1. The finding: cloud KMS/HSM do not sign Ed25519 (verified 2026-06)

BACKEND-DESIGN §6.2 names **"Azure Managed HSM (OKP/Ed25519)"** as the target. That option does not
exist.

**Exact statement of the finding (so the owner can decide):**

> As of Microsoft's current Managed HSM documentation (supported-key-types / supported-algorithms
> tables, checked 2026-06), Azure **Managed HSM supports only RSA, EC (P-256, P-256K, P-384, P-521),
> and AES keys**, and sign/verify is limited to **ES256/ES384/ES512, PS256/384/512, RS256/384/512,
> and HS256/384/512**. There is **no OKP key type, no Ed25519 curve, and no EdDSA algorithm** in the
> Managed HSM supported-algorithms table. The Azure SDKs expose `OKP` / `OKP-HSM` enum values, but
> those are client-side surface for a feature the **service does not list as supported** — they do
> not make Managed HSM sign Ed25519. **AWS KMS** (asymmetric sign: RSA + ECDSA over NIST P-256/384/521
> and secp256k1, plus SM2) and **GCP Cloud KMS** (RSA + EC P-256/P-384) likewise do **not** offer
> Ed25519 signing. **Conclusion: no major cloud KMS/HSM signs Ed25519 today.**

Why this matters here: the whole licensing model (§6.1, §13.12) is **Ed25519 JWS verified offline**
against public keys **already baked into every shipped app** (the K=5 trusted set, §6.3). "Move the
key to a cloud HSM" is impossible *without also changing the algorithm* — which is a client-visible
change, not a backend-only one. The ticket is therefore reframed from "integrate Azure Managed HSM"
to "make the migration possible and surface the real decision."

---

## 2. The two real options

### Option (a) — PKCS#11 hardware HSM with EdDSA (recommended)

Move the private key into a hardware token that **does** support Ed25519 over PKCS#11, and have the
Issuer sign via `C_Sign`. Candidates that support Ed25519/EdDSA over PKCS#11:

| Device | Ed25519 support | Rough cost | Notes |
|---|---|---|---|
| **YubiHSM 2** | Yes — `ed25519` asymmetric key with the `sign-eddsa` capability, exposed via `yubihsm_pkcs11` | ~US$650 per unit | The cheap, realistic choice. USB nano form factor; reached in production via the **YubiHSM Connector** daemon. |
| **Thales Luna (Network HSM)** | Yes — EdDSA / Ed25519 via its PKCS#11 provider | ~US$10k+ | Network-attached; heavier ops, FIPS 140-2/3 L3. |
| **Entrust nShield** | Yes — EdDSA via nCipher PKCS#11 | ~US$10k+ | Similar tier to Luna. |

**What stays the same (the decisive property):** the license stays `alg: EdDSA` (Ed25519); the token
format (§6.1) is byte-for-byte unchanged; **the shipped public keys and the offline client verifier
do not change at all.** The private key merely moves from a Fly secret into hardware where it is
non-exportable and only `C_Sign` is exposed.

**Costs / caveats:**
- **Hardware custody on Fly is awkward (BACKEND-DESIGN §11.2 flags this).** Fly offers no HSM and its
  instances are ephemeral. Mitigation: the **Issuer is a separate, low-QPS trust zone** (it signs
  only on purchase / new-device; availability target is *Medium*, §9), so it does **not** have to run
  on Fly. Run the Issuer zone on (or give it private-network reach to) a small always-on host that
  physically holds the YubiHSM + Connector. One always-on box with a USB HSM is acceptable at the
  early stage; revisit if issuance must go multi-region.
- Operational overhead: firmware, PIN/auth-key custody, backup/restore of the HSM (YubiHSM 2 supports
  wrapped key export for backup to a second unit), and a spare unit for DR.

### Option (b) — change the algorithm to one a cloud KMS signs (ES256 / P-256 ECDSA)

Re-issue licenses as **ES256** (ECDSA over NIST P-256), whose private key lives in **Azure Managed
HSM** or **AWS KMS** (both non-exportable, cloud-managed, mature ops/audit/rotation). The Issuer calls
the KMS `Sign` API instead of doing crypto locally.

**What this buys:** fully cloud-managed, non-exportable custody with no hardware to babysit; a clean
fit with Fly's ephemeral infra (the Issuer just makes an authenticated network call to the KMS);
mature key rotation, access policy, and audit out of the box.

**What it costs — this is a spec change, not a config change:**
1. **§6.1 JWS format changes.** Header `alg` becomes `ES256`; the key type becomes P-256, not
   Ed25519. `LICENSE-FORMAT.md` and the "reject anything but `alg: EdDSA`" rule both change.
2. **The offline client verifier changes and must ship to every install.** During the K-window the
   client must verify **both** algorithms: `EdDSA` for still-cached Ed25519 licenses **and** `ES256`
   for new ones. That reintroduces exactly the `alg`-agility the design deliberately removed (§6.1),
   so it must be pinned per-`kid` (a `kid` maps to a known algorithm), never negotiated from the
   header.
3. **The trusted-key set is re-keyed.** A new P-256 `kid` is added; **existing installs trust only the
   old Ed25519 keys until they take an app update.** So a P-256 license cannot verify on any device
   that has not updated — a P-256 issuance to an un-updated device would be unusable.
4. **Every shipped public key is affected** and the offline verifier code itself must reach clients
   *before* any ES256 license is issued to them.

Net: (b) is a wider, client-touching migration with a hard "clients must update before they can use
new licenses" gate on top of the same K-window fleet carry that (a) needs.

---

## 3. Recommendation and reasoning

**Adopt option (a): YubiHSM 2 (PKCS#11, EdDSA) as the pre-scale key-custody backend.** Reasoning,
in priority order:

1. **It preserves the offline-verify contract exactly.** The core design value in §6.1/§13.12 is
   "verify the exact received bytes under a pinned `EdDSA`, no `alg` agility, no re-serialization."
   Option (a) changes **nothing** a client sees — same algorithm, same format, same verifier, same
   public keys. Option (b) throws that away: it forces `alg` agility back into every offline verifier
   and re-keys the fleet. For a $5 local good whose license carries no money, taking on a
   client-visible crypto migration to gain cloud convenience is a poor trade.
2. **It is a backend-only change the code is already staged for.** After this ticket, switching
   custody is: set `hydropark.signing.provider=pkcs11`, point it at the driver + token, and provision
   a key. No token-format work, no client release coupling on the *format*. (Option (b) needs a spec
   change, a new verifier shipped to clients, and a coordinated release.)
3. **The fleet crosses the boundary with zero stranding, using machinery that already exists.** The
   HSM key is a normal §6.3 additive rotation: ship the new key's **public** half in the next release,
   flip the Issuer's active key to it, and let `RollingKeyReissuer` + the coverage gate carry cached
   licenses over (§5 runbook below). Because the algorithm is unchanged, even a long-offline device
   keeps verifying its cached tokens the entire time.
4. **Cost is bounded and appropriate to the stage.** ~US$650 of hardware + one always-on host, for a
   low-QPS signer, is proportionate. It also cleanly **role-separates** from the package-signing key
   (P1-19.1), which can live on the same HSM as a distinct object.

**When to prefer (b) instead (documented escape hatch, not this ticket):** if hardware custody stops
fitting the ops model — e.g., issuance must become multi-region / highly-available, or maintaining a
physical HSM host becomes a liability — then (b)'s cloud-managed ES256 custody becomes the better
call. Treat that as its **own epic**: a §6.1 spec change, a dual-algorithm offline verifier, and a
trusted-set re-key, planned with a client-release gate. **There is no clean cloud-Ed25519 answer; (b)
is the price of cloud-managed custody, and it is a real one.**

> **Honesty note for the owner:** neither path is free. (a) trades cloud convenience for keeping the
> client untouched; (b) trades a client-visible crypto/spec change for cloud-managed custody. The
> recommendation is (a) because the client-offline-verify simplicity is the asset most worth
> protecting, and because the migration then stays inside the backend the team controls.

---

## 4. What this ticket implemented (the seam)

The code is now shaped so that finishing either path is *implementation*, not *redesign*. New package
`io.hydropark.signing`:

- **`Signer`** — the interface. `byte[] sign(byte[] signingInput, SigningKeyRef key)` returns the raw
  detached Ed25519 signature over the exact bytes; `SigningKeyRef activeKey()` exposes the active
  key's `kid` + public half (for the trusted-key set / header). This is the *only* thing that differs
  between in-memory keys and hardware.
- **`SigningKeyRef`** — `(kid, PublicKey)`. Deliberately carries **no** private material, so a
  hardware/KMS signer that never exposes the private key still fits.
- **`JdkEd25519Signer`** — the **default**, the interim in-memory JDK-native path (P1-16.3),
  **extracted verbatim** from the old inline `LicenseSigner.ed25519Sign`. A token minted through it is
  byte-for-byte identical to before; `LicenseCryptoTest` (round-trip + tamper) still asserts this.
- **`Pkcs11Ed25519Signer`** — the **gated skeleton** for option (a). The config surface, the
  `kid → PKCS#11 object-label` resolution, the `SunPKCS11` provider bootstrap, and the
  `open KeyStore → get private-key handle → Signature.sign()` (`C_Sign`) path are all **real and
  complete**. It throws `UnsupportedOperationException("configure a PKCS#11 provider — see docs")`
  until a provider is configured. Finishing it is a **config + driver** task, not new design.
- **`SigningProperties`** (`hydropark.signing.*`) — `provider` (`jdk` default | `pkcs11`) and the
  full `pkcs11.*` block (library, slot/tokenLabel, pin, `signatureAlgorithm`, and the per-`kid`
  object-label map). Added as its own `@ConfigurationProperties` class (not in `AppProperties`) to
  respect package ownership boundaries.

`LicenseSigner` (in `licensing`) now owns the token format and delegates only the raw signature to the
injected `Signer`; `SignerConfig` (in `licensing`, gated on `hydropark.issuer.enabled=true`) selects
the implementation by `hydropark.signing.provider` and bridges `TrustedKeySet` into the signer. The
JDK path stays the default and `LocalLicenseIssuer` / `RollingKeyReissuer` behaviour is unchanged.

**Config to switch to hardware (option a), once the token is provisioned:**

```yaml
hydropark:
  signing:
    provider: pkcs11
    pkcs11:
      library: /usr/lib/pkcs11/yubihsm_pkcs11.so
      slot: "0"                 # or tokenLabel:
      pin: ${HSM_PIN}           # from a secret; never logged
      signatureAlgorithm: Ed25519
      keyLabels:
        hp-lic-2026b: license-signing-key   # kid -> PKCS#11 object label
  licensing:
    keys:
      - kid: hp-lic-2026b       # the HSM key: PUBLIC half only here (private is in hardware)
        publicKey: <base64 X.509 SPKI>
        active: true
      # older keys retained as verify-only (public only) until they roll off the K-window
```

---

## 5. Migration runbook — option (a), YubiHSM 2, no stranding

The K=5 rolling trusted set + additive re-issue (§6.3) is what carries the fleet across the switch.
Because the algorithm is unchanged, this is a *routine rotation* whose only novelty is that the new
key's private half is in hardware.

**Key strategy — generate fresh in the HSM (recommended), do not import the old software key.** The
interim software key (P1-16.3) was, by design, exposable from the Fly host; carrying it forward would
carry forward that exposure. Generating a new key inside the HSM (non-exportable from birth) means the
migration doubles as a §6.4-style rotation away from a key that must now be assumed at-risk. (Importing
the existing Ed25519 key into the YubiHSM via wrapped `put asymmetric` is *possible* — it would keep
the public half and require **no** client release — but only choose it if you accept the prior
exposure; the clean-key path is preferred.)

1. **Provision hardware.** Install the YubiHSM 2 + YubiHSM Connector on the always-on host that runs
   (or is privately reachable by) the Issuer zone. Install `yubihsm_pkcs11`. Create an authentication
   key with only `sign-eddsa` + key-management capabilities for the Issuer's role; custody its
   password like any critical secret.
2. **Generate key `N+1` in the HSM.** Create an `ed25519` asymmetric object with `sign-eddsa`
   capability. Export **only its public half** (base64 X.509 SPKI). Record its object label.
3. **Ship the new public key to clients (additive, §6.3).** Add `N+1`'s public half to the app's
   shipped trusted set in the next client release; the oldest key rolls off only under the coverage
   gate (step 6). This is the one client release involved — and it ships **only a public key**, no
   verifier/format change.
4. **Point the Issuer at the HSM.** Set `hydropark.signing.provider=pkcs11` and the `pkcs11.*` block
   (library, slot/label, pin, `keyLabels{ "hp-lic-N+1" -> "<object label>" }`). In
   `hydropark.licensing.keys`, add `N+1` as `active: true` with its **public** half and **no**
   `privateKey`; keep the old software keys as **verify-only** (public-only) entries so their cached
   licenses still verify. Deploy the Issuer zone. New tokens now sign under `N+1` via `C_Sign`.
5. **Stop signing with the software key.** Ensure the old software key is no longer `active` (it is
   now verify-only). Rotate/destroy the Fly secret that held its private half and treat the old Issuer
   host as compromised-by-default: rebuild it, don't just redeploy.
6. **Carry the fleet with the existing no-stranding machinery.**
   - Run `RollingKeyReissuer.reissueForRollingKey()` — it re-signs every active license whose `kid`
     is nearing roll-off onto `N+1`, marking the old rows `superseded`. Re-issue is **additive**: a
     device offline across the switch keeps verifying its cached token under its old, still-trusted
     `kid`.
   - Online clients that take the new release re-`POST /v1/licenses/issue` for cached licenses whose
     `kid` is at/near roll-off; fresh `N+1` tokens supersede.
   - The old software `kid`'s **removal from shipped builds is gated on
     `RollingKeyReissuer.coverageForKid(oldKid).safeToRemove()`** (zero remaining active licenses
     under it), so it is never dropped while a live population depends on it.
7. **Retire the software key.** Once coverage is zero (or the residual is explicitly accepted), drop
   the old software `kid` from shipped builds on the following release. Long-offline devices are
   unaffected: they keep verifying their own cached licenses under the old `kid` until they next
   update, and they only *need* an update to trust `N+1`, which they encounter only when back online.
8. **Close the interim decision.** Update BACKEND-DESIGN §11.2 #1 from "interim software keys
   (2026-07-09)" to "migrated to YubiHSM 2 (PKCS#11/EdDSA)", and mark the pre-scale gate in
   `KEY-COMPROMISE-RUNBOOK.md` closed. From here, a host compromise no longer yields the private key
   (only online `C_Sign` access while the host is up), shrinking the §11.2 #1 residual from
   "catalog-wide forgery" to "bounded signing-oracle abuse while compromised" — which the per-`sub`
   rate limits + audit (§6.2) already bound.

**No offline license holder is ever stranded** because (i) the algorithm/format/verifier are
unchanged, (ii) rotation is additive, and (iii) key removal is coverage-gated.

## 5b. Migration runbook — option (b), ES256 on cloud KMS (if ever chosen)

Only the deltas vs. §5 (the K-window fleet carry is identical); the added work is what makes (b)
wider:

1. **Spec change first.** Amend §6.1 / `LICENSE-FORMAT.md`: new `alg: ES256`, P-256 key type, and a
   **per-`kid` algorithm pin** (the verifier looks up the algorithm from the trusted-set entry for
   that `kid` — never from the token header, to avoid `alg` confusion).
2. **Ship a dual-algorithm offline verifier to all clients** *before* issuing any ES256 license:
   verify `EdDSA` for old `kid`s and `ES256` for the new one. An ES256 license issued to a device
   that has not taken this release is unusable, so gate ES256 issuance on client version where
   possible.
3. **Stand up the KMS key.** Azure Managed HSM or AWS KMS: create a P-256 signing key, grant only the
   Issuer's role `Sign`, export the public half to the trusted set as a new `kid`. Implement a
   `KmsEs256Signer` behind the same `Signer` seam (the seam is algorithm-agnostic; only `activeKey()`
   + the `sign` call change).
4. **Re-key + carry the fleet** exactly as §5 steps 3–7, but note the extra hard gate from step 2:
   old installs must update to *accept* ES256 before they can use new licenses, whereas in option (a)
   they need no update to keep working.

---

## 6. Open items for the owner to decide

1. **Confirm the recommendation.** (a) YubiHSM 2 vs. (b) cloud ES256 — this doc recommends (a).
2. **Where the Issuer zone + HSM live** (always-on host reachable from Fly over private networking).
3. **Key strategy** in §5: fresh HSM key (recommended) vs. importing the existing Ed25519 key.
4. **Shared vs. separate HSM object for package signing** (P1-19.1) — same device, distinct key
   objects, is the natural fit.
