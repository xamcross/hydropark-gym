"""
Hydropark Phase-0 unlock-code scheme (v1) — CANONICAL reference implementation.

  >> THROWAWAY VALIDATION PROTOTYPE. This is NOT the production licensing system. <<

PHASE0-PLAN.md §2 / §4c: the H3 willingness-to-pay test needs a cold buyer to pay,
receive an unlock code by email, and redeem it in the app to actually enable the
paid "Cooking Assistant" skill. This module is the fulfillment side of that code.

What this scheme IS
-------------------
A short, human-typeable code carrying an HMAC-SHA256 tag over a random nonce, keyed
by a SHARED SECRET that is baked into BOTH this fulfillment script and the app. The
app recomputes the tag and rejects anything that doesn't match, so a random string
("aaaa", "hunter2", a length>0 check) does NOT unlock the skill. That is the whole
job: stop *casual* sharing / obvious fakes during a paid smoke test.

What this scheme is NOT (and why it's throwaway, not production)
----------------------------------------------------------------
The secret is SYMMETRIC and shipped inside the client. Anyone who unpacks the app
binary can extract it and mint unlimited valid codes. There is:
  * no asymmetric signature (production uses Ed25519 — the client holds only a
    PUBLIC key and provably cannot mint licenses; SPEC §13, BACKEND-DESIGN §6),
  * no device binding, no per-identity issuance limits, no server confirmation of
    a settled order, no revocation, no offline-license format.
It is deliberately the weakest thing that clears the "not a plain length check"
bar in the ticket (P0-05.5 / P0-09.4), and it is expected to be thrown away when
Phase 1 starts fresh (PHASE0-PLAN §0). Do not grow a licensing system from it.

The scheme, exactly (must match unlock-code.ts and unlock.rs byte-for-byte)
--------------------------------------------------------------------------
  alphabet      Crockford Base32, uppercase: 0-9 A-Z minus I L O U
  secret        SHARED_SECRET, UTF-8 bytes
  product       the literal "cooking-assistant" (binds the code to the one SKU)
  nonce         5 random bytes -> 8 base32 chars (uniqueness / one-time-ness)
  sign input    the ASCII string  "HP0|cooking-assistant|" + <nonce8>
  tag           HMAC_SHA256(secret, sign_input); first 10 bytes -> 16 base32 chars
  display code  "HP0-CA-" + nonce8 + "-" + tag[0:4] + "-" + ... + "-" + tag[12:16]

Verification never DECODES base32 — it re-encodes and compares strings, so the
three language ports only need an ENCODER plus HMAC-SHA256, which removes a whole
class of cross-implementation drift.
"""

import hashlib
import hmac
import os

# --- Shared secret (throwaway; baked into the client too) --------------------
# Rotating this means re-issuing every outstanding code. That is fine: Phase 0
# is a short smoke test. In production this would never exist — see module docs.
SHARED_SECRET = b"hp0-unlock-shared-secret::throwaway::not-a-license-key"

PRODUCT = "cooking-assistant"     # what the code unlocks; bound into the HMAC input
SKILL_ID = "cooking-assistant"    # the app-side SkillId this maps to
SIGN_PREFIX = "HP0"               # scheme/version marker, also bound into the input

_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"   # Crockford base32 (no I L O U)
_NONCE_BYTES = 5                  # -> 8 base32 chars
_TAG_BYTES = 10                   # -> 16 base32 chars (HMAC truncated to 80 bits)


def _b32(data: bytes) -> str:
    """MSB-first Crockford base32, no padding. Only called with 5- and 10-byte
    inputs, both exact multiples of 5 bits, so the tail branch never fires — but
    it is written the standard way so a port can be checked against it directly."""
    bits = 0
    value = 0
    out = []
    for byte in data:
        value = (value << 8) | byte
        bits += 8
        while bits >= 5:
            bits -= 5
            out.append(_ALPHABET[(value >> bits) & 0x1F])
    if bits > 0:
        out.append(_ALPHABET[(value << (5 - bits)) & 0x1F])
    return "".join(out)


def _sign_input(nonce8: str) -> bytes:
    return f"{SIGN_PREFIX}|{PRODUCT}|{nonce8}".encode("ascii")


def _tag_for(nonce8: str) -> str:
    digest = hmac.new(SHARED_SECRET, _sign_input(nonce8), hashlib.sha256).digest()
    return _b32(digest[:_TAG_BYTES])


def _group(code29: str) -> str:
    """Turn the 29 significant chars into the hyphenated display form."""
    nonce8, tag16 = code29[5:13], code29[13:29]
    tag_groups = "-".join(tag16[i:i + 4] for i in range(0, 16, 4))
    return f"HP0-CA-{nonce8}-{tag_groups}"


def canonicalize(user_input: str) -> str:
    """Normalize whatever a human typed (spaces, hyphens, case, O/o->0, I/l->1)
    down to the 29 significant chars. Returns '' if nothing usable is left."""
    out = []
    for ch in user_input.upper():
        if ch in ("O",):
            ch = "0"
        elif ch in ("I", "L"):
            ch = "1"
        if ch in _ALPHABET:
            out.append(ch)
    return "".join(out)


def generate(nonce: bytes | None = None) -> str:
    """Mint a fresh, valid unlock code (display form). `nonce` is injectable for
    deterministic tests; production fulfillment always uses a random one."""
    if nonce is None:
        nonce = os.urandom(_NONCE_BYTES)
    if len(nonce) != _NONCE_BYTES:
        raise ValueError(f"nonce must be {_NONCE_BYTES} bytes")
    nonce8 = _b32(nonce)
    return _group(f"HP0CA{nonce8}{_tag_for(nonce8)}")


def verify(user_input: str) -> bool:
    """True iff `user_input` is a structurally valid, correctly-signed code for
    this SKU under SHARED_SECRET. Constant-time tag comparison. This is the exact
    routine the app runs (mirrored in unlock-code.ts / unlock.rs)."""
    s = canonicalize(user_input)
    if len(s) != 29 or not s.startswith("HP0CA"):
        return False
    nonce8, presented_tag = s[5:13], s[13:29]
    return hmac.compare_digest(presented_tag, _tag_for(nonce8))


def nonce_of(user_input: str) -> str | None:
    """The 8-char nonce (the code's stable id), or None if it doesn't verify.
    The app uses this to record which codes have been redeemed on this machine."""
    if not verify(user_input):
        return None
    return canonicalize(user_input)[5:13]
