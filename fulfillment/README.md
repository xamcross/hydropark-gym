# Hydropark — Phase-0 fulfillment stub (P0-09.4)

> **This is a throwaway.** PHASE0-PLAN §0/§4c: Phase 0 is a validation prototype.
> This directory is **not** the production licensing/fulfillment system (SPEC §13,
> BACKEND-DESIGN §6 — server-issued Ed25519 licences, device binding, settled-order
> confirmation). It is the weakest mechanism that closes the H3 cold-buyer loop
> honestly, and it is meant to be thrown away.

The H3 willingness-to-pay test (PHASE0-PLAN §4c) sells one real SKU — **Cooking
Assistant, $5** — to cold buyers who pay *before* they have the app. So the loop
can't be a fake door: on payment, the buyer must receive a **download link + a
one-time unlock code** that actually enables the paid skill. This stub is the
"after the charge captures" half of that.

```
unlock_codes.py    canonical unlock-code scheme (Crockford-base32 HMAC-SHA256)
fulfill.py         the stub: email in -> unlock code + composed email out
parity_check.mjs   runs the APP's real TS verifier against Python-minted codes
outbox/            where "sent" emails land (nothing is actually emailed)
```

## Run it

```bash
# Mint a code + compose the fulfillment email for a buyer (writes to ./outbox/):
python fulfill.py --email buyer@example.com --stripe-session cs_test_123 --event-id evt_456

# The tiny correctness check the ticket asks for (generate -> verify pass;
# tamper -> verify fail):
python fulfill.py --selftest
```

Requires only Python 3 stdlib (`hashlib`, `hmac`). No packages, no network.

## The unlock-code scheme (v1)

A short, human-typeable code carrying an HMAC-SHA256 tag over a random nonce,
keyed by a **shared secret baked into both this script and the app**. The app
recomputes the tag and rejects anything that doesn't match — so a random string
does **not** unlock the skill (that's the bar P0-05.5 sets: a real check, not
`len(code) > 0`).

```
alphabet     Crockford base32, uppercase, 0-9 A-Z minus I L O U (typo-resistant)
secret       SHARED_SECRET (UTF-8) — throwaway, identical in all three ports
product      the literal "cooking-assistant" — binds the code to the one SKU
nonce        5 random bytes  -> 8 base32 chars   (uniqueness / one-time-ness)
sign input   ASCII "HP0|cooking-assistant|" + <nonce8>
tag          HMAC_SHA256(secret, sign_input); first 10 bytes -> 16 base32 chars
code         HP0-CA-<nonce8>-<tag[0:4]>-<tag[4:8]>-<tag[8:12]>-<tag[12:16]>
```

Verification never *decodes* base32 — it re-encodes and compares strings, which
removes a whole class of cross-language drift. Input is canonicalized first
(uppercased, `O->0`, `I/L->1`, non-alphabet chars stripped) so hyphens, spaces,
and common typos are tolerated.

**Three ports, one scheme — they must agree byte-for-byte:**

| Side | File | Role |
|---|---|---|
| Fulfillment | `fulfillment/unlock_codes.py` | **canonical** — generates + verifies |
| App (web/mock) | `client/web/src/app/unlock/unlock-code.ts` | verifies (Web Crypto) |
| App (Rust core) | `client/src-tauri/src/unlock.rs` | verifies + persists (vendored SHA-256/HMAC) |

`parity_check.mjs` runs the **actual** TS verifier the Angular app imports against
a Python-minted code (Node ≥23 strips the TS types), proving the two live sides
agree. The Rust port pins the same known-answer vector in `#[cfg(test)]`.

### Why this is throwaway-grade, not production

The secret is **symmetric and ships inside the client**. Anyone who unpacks the
app binary can extract it and mint unlimited valid codes; a redeemed code isn't
bound to a device or an account and can be pasted on any machine. That is
**acceptable and intended** here — the job is only to deter casual sharing / obvious
fakes across a few-hundred-buyer smoke test. Production replaces the whole thing:
the client would hold only a **public** key and be unable to mint anything; the
server confirms a *settled* order before signing an **Ed25519** licence, with
device binding, per-identity issuance limits, and revocation (SPEC §13,
BACKEND-DESIGN §6). None of this code survives into Phase 1.

## How it slots into the real P0-09 flow — stubbed vs. real

```
  Stripe hosted-checkout success (real charge, no pre-auth)              REAL   (P0-09.3)
    -> webhook / thank-you redirect delivers buyer email + session id    STUBBED: run fulfill.py by hand
    -> fulfill.py mints a valid unlock code + composes the email         REAL:   the code genuinely validates in-app
    -> email delivered to the buyer                                       STUBBED: written to ./outbox/, no SMTP/ESP
    -> buyer opens the download link, installs (~2 GB w/ model)           STUBBED: placeholder DOWNLOAD_URL
    -> buyer pastes the code into the app's "Enter unlock code" field     REAL:   client/web/src/app/unlock/**
    -> Cooking Assistant unlocks and persists across restarts            REAL:   unlock.rs / UnlockService
```

**Real:** the code, its verification on all three sides, the in-app redemption UI
and persistence. **Stubbed (deliberately, no credentials, clearly marked):** the
webhook trigger (invoke the script manually), the email delivery (file in
`outbox/`), and the download URL (`REPLACE_ME` placeholder, matching the landing
pages' convention in `landing-gym/app.js`).

To make it live for the cold cohort (P0-09), the only wiring is: a webhook handler
that calls `fulfill.py` (or its `compose_email`/`generate` functions) with the
buyer's email on `checkout.session.completed`, and an SMTP/ESP send in place of the
`outbox/` write. The unlock code itself needs no change.

## Analytics note (P0-09.5)

The deciding H3 metric is **completed real captures ÷ unique visitors**, counted at
the payment provider — not `checkout_click`. Report the **install-friction drop-off**
(paid → downloaded → redeemed) and the **refund-request rate** beside it. This stub
is where "redeemed" becomes observable end-to-end.
