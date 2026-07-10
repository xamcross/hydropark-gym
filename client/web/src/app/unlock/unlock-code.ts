/**
 * Hydropark Phase-0 unlock-code scheme (v1) — app-side verifier.
 *
 *   >> THROWAWAY VALIDATION PROTOTYPE. NOT the production licensing system. <<
 *
 * This is the TypeScript mirror of `fulfillment/unlock_codes.py` (the canonical
 * generator) and `client/src-tauri/src/unlock.rs` (the real-build verifier). The
 * three MUST agree byte-for-byte — the whole point of P0-09.4 is that a code the
 * fulfillment side emails a cold buyer actually validates in the app (PHASE0-PLAN
 * §4c). Constants and algorithm are documented once, in the Python file's header;
 * keep this in lockstep with it (same discipline as unit-math.ts <-> tools.rs).
 *
 * Why it's throwaway, not production: the secret below is symmetric and ships in
 * the client, so anyone who unpacks the app can mint codes. It only stops casual
 * sharing / obvious fakes during the paid smoke test. Production replaces the whole
 * thing with server-issued Ed25519 licences + device binding (SPEC §13) — the app
 * would then hold only a PUBLIC key and be unable to mint anything.
 *
 * Kept free of Angular / DOM imports on purpose: it depends only on Web Crypto
 * (`crypto.subtle`, present in the Tauri webview, browsers, and Node >=20), so the
 * same file both runs in the app and is exercised by the cross-language parity
 * check in `fulfillment/parity_check.mjs`.
 */

/** Shared secret — throwaway, identical to SHARED_SECRET in unlock_codes.py. */
export const SHARED_SECRET = 'hp0-unlock-shared-secret::throwaway::not-a-license-key';

export const PRODUCT = 'cooking-assistant';
export const SKILL_ID = 'cooking-assistant';
const SIGN_PREFIX = 'HP0';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32 (no I L O U)
const NONCE_BYTES = 5; //  -> 8 base32 chars
const TAG_BYTES = 10; //   -> 16 base32 chars (HMAC truncated to 80 bits)
const CANON_LEN = 5 + 8 + 16; // "HP0CA" + nonce8 + tag16

export type VerifyOutcome =
  | { ok: true; nonce: string }
  | { ok: false; reason: 'malformed' | 'bad_signature' };

/** MSB-first Crockford base32, no padding. Matches _b32 in unlock_codes.py. */
function b32(data: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(value >>> bits) & 0x1f];
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 0x1f];
  return out;
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

async function tagFor(nonce8: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    utf8(SHARED_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, utf8(`${SIGN_PREFIX}|${PRODUCT}|${nonce8}`));
  return b32(new Uint8Array(sig).slice(0, TAG_BYTES));
}

/**
 * Normalize whatever a human typed (spaces, hyphens, case, O->0, I/L->1) down to
 * the 29 significant chars. Matches `canonicalize` in unlock_codes.py.
 */
export function canonicalize(userInput: string): string {
  let out = '';
  for (let ch of userInput.toUpperCase()) {
    if (ch === 'O') ch = '0';
    else if (ch === 'I' || ch === 'L') ch = '1';
    if (ALPHABET.includes(ch)) out += ch;
  }
  return out;
}

/** Constant-time equality for two equal-length ASCII strings. */
function ctEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * The app's verification routine. Structurally valid AND correctly signed for this
 * SKU under SHARED_SECRET. Never decodes base32 — recomputes the tag and compares
 * strings, so it can't disagree with the generator over decode edge-cases.
 */
export async function verifyUnlockCode(userInput: string): Promise<VerifyOutcome> {
  const s = canonicalize(userInput);
  if (s.length !== CANON_LEN || !s.startsWith('HP0CA')) return { ok: false, reason: 'malformed' };
  const nonce8 = s.slice(5, 13);
  const presented = s.slice(13, 29);
  const expected = await tagFor(nonce8);
  return ctEqual(presented, expected) ? { ok: true, nonce: nonce8 } : { ok: false, reason: 'bad_signature' };
}

/** Convenience boolean form. */
export async function isValidUnlockCode(userInput: string): Promise<boolean> {
  return (await verifyUnlockCode(userInput)).ok;
}

/**
 * Mint a valid code. NOT used by the app at runtime (the app only ever verifies);
 * present so the scheme is unit-testable from TS and the parity check can prove
 * both directions (TS-generated -> Python-verified and vice-versa).
 */
export async function generateUnlockCode(nonce?: Uint8Array): Promise<string> {
  const n = nonce ?? crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  if (n.length !== NONCE_BYTES) throw new Error(`nonce must be ${NONCE_BYTES} bytes`);
  const nonce8 = b32(n);
  const tag16 = await tagFor(nonce8);
  const tagGroups = [0, 4, 8, 12].map((i) => tag16.slice(i, i + 4)).join('-');
  return `HP0-CA-${nonce8}-${tagGroups}`;
}
