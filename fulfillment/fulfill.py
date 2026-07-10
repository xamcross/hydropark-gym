#!/usr/bin/env python3
"""
Hydropark Phase-0 FULFILLMENT STUB  (ticket P0-09.4)

  ############################################################################
  #  STUB - NOT A REAL EMAIL SENDER, NOT PRODUCTION LICENSING.               #
  #  It composes the post-purchase email and drops it in ./outbox/ (and      #
  #  prints it). No SMTP, no ESP, no credentials, no network. See below for  #
  #  exactly which parts are stubbed vs. real.                               #
  ############################################################################

What this simulates
-------------------
The moment AFTER a cold buyer's Stripe payment is captured in the H3 willingness-
to-pay test (PHASE0-PLAN §4c). Given a buyer email (and optionally the Stripe
session / event id for the record), it:

  (a) mints a VALID one-time unlock code with the shared-secret scheme in
      unlock_codes.py - the SAME scheme the app verifies (unlock-code.ts /
      unlock.rs), and
  (b) composes the fulfillment email: a download link (placeholder, clearly
      marked) + the unlock code + redemption instructions,
  (c) verifies the code it just minted with the app's own verify() routine
      BEFORE "sending" - if that ever failed, the two sides would have drifted
      and the cold test would become a fake door, so this is a hard gate.

Where it slots into the real P0-09 flow
---------------------------------------
    Stripe hosted-checkout success
      -> webhook / thank-you redirect fires with the buyer email + session id   [STUBBED: run this script by hand instead]
      -> THIS SCRIPT mints the code + composes the email                         [REAL: the code is genuinely valid]
      -> email is actually delivered to the buyer                                [STUBBED: written to ./outbox/, not sent]
      -> buyer downloads the app from the download link                          [STUBBED: placeholder URL]
      -> buyer pastes the code into the app's "Enter unlock code" field          [REAL: unlock/ UI + unlock.rs verify it]
      -> Cooking Assistant unlocks and persists across restarts                  [REAL]

Production (SPEC §13, BACKEND-DESIGN §6) replaces the mint+email step with a
server that confirms a *settled* order and issues a real Ed25519 licence; none of
this shared-secret code survives. That is the point - it's throwaway (PHASE0 §0).

Usage
-----
    python fulfill.py --email buyer@example.com
    python fulfill.py --email buyer@example.com --stripe-session cs_test_123 --event-id evt_456
    python fulfill.py --selftest      # generate -> verify(pass) + tamper -> verify(fail)
"""

import argparse
import datetime as _dt
import pathlib
import re
import sys

import unlock_codes as codes

OUTBOX = pathlib.Path(__file__).resolve().parent / "outbox"

# Clearly-marked placeholder, matching the landing pages' REPLACE_ME convention
# (landing-gym/app.js DOWNLOAD_URL). Growth swaps in the real signed-installer URL
# for the live cold cohort (P0-09.1).
DOWNLOAD_URL = "https://hydropark.app/download/REPLACE_ME"
SUPPORT_EMAIL = "hello@hydropark.app"

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

STUB_BANNER = (
    "============================================================\n"
    " HYDROPARK FULFILLMENT STUB - this email was NOT sent.\n"
    " It was written to ./outbox/ and printed. No SMTP/ESP wired.\n"
    " (Phase-0 validation prototype - throwaway. PHASE0-PLAN sec 0.)\n"
    "============================================================"
)


def compose_email(email: str, code: str, stripe_session: str | None, event_id: str | None) -> str:
    """The buyer-facing fulfillment email body. Real content, stub delivery."""
    ref_bits = []
    if stripe_session:
        ref_bits.append(f"checkout {stripe_session}")
    if event_id:
        ref_bits.append(f"event {event_id}")
    ref = f"  (ref: {', '.join(ref_bits)})" if ref_bits else ""

    return f"""\
From: Hydropark <{SUPPORT_EMAIL}>
To: {email}
Subject: Your Cooking Assistant unlock code

Thanks for buying the Cooking Assistant skill for Hydropark.{ref}

Two steps and you're cooking:

  1. Download Hydropark (about 2 GB - it includes the offline AI model, so it
     runs entirely on your computer with no internet):

        {DOWNLOAD_URL}

  2. Open the app, click "Enter unlock code", and paste this in:

        {code}

     The Cooking Assistant turns on immediately and stays unlocked on this
     computer - you won't need the code again.

Your code is tied to the Cooking Assistant skill. Keep this email; if you
reinstall, paste the same code to unlock again.

Questions or a refund? Just reply, or write {SUPPORT_EMAIL}.

- Hydropark

--
This is a Phase-0 test purchase. Your unlock code is a lightweight,
temporary mechanism for this trial, not a permanent licence; a proper
account-backed licence replaces it if Hydropark ships. See our terms for the
business-continuity commitment.
"""


def fulfill(email: str, stripe_session: str | None, event_id: str | None) -> int:
    if not _EMAIL_RE.match(email):
        print(f"error: '{email}' does not look like an email address", file=sys.stderr)
        return 2

    code = codes.generate()

    # Correctness gate: the code we are about to email MUST validate under the
    # app's own routine. If this ever trips, fulfillment and app have drifted.
    if not codes.verify(code):
        print("FATAL: generated code failed self-verification - scheme drift, refusing "
              "to send. Fix unlock_codes.py / unlock-code.ts / unlock.rs parity.", file=sys.stderr)
        return 1

    body = compose_email(email, code, stripe_session, event_id)

    OUTBOX.mkdir(exist_ok=True)
    stamp = _dt.datetime.now(_dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    safe = re.sub(r"[^A-Za-z0-9._-]", "_", email)
    path = OUTBOX / f"{stamp}-{safe}.eml"
    path.write_text(body, encoding="utf-8")

    print(STUB_BANNER)
    print()
    print(body)
    print("------------------------------------------------------------")
    print(f"unlock code   : {code}")
    print(f"self-verify   : PASS  (app-side verify() accepts this code)")
    print(f"nonce (code id): {codes.nonce_of(code)}")
    print(f"written to    : {path}")
    print(f"delivery      : STUB (no email actually sent)")
    return 0


def selftest() -> int:
    """The tiny verification the ticket asks for: generate -> verify(pass);
    tamper -> verify(fail). Proves the mint and the app-verify agree in-process."""
    code = codes.generate(nonce=bytes([0, 1, 2, 3, 4]))  # deterministic
    ok = codes.verify(code)
    tampered = code[:-1] + ("Y" if code[-1] == "Z" else "Z")
    bad = codes.verify(tampered)
    junk = codes.verify("not-a-real-code")

    print("Hydropark unlock-code selftest (fulfillment side)")
    print(f"  generated code      : {code}")
    print(f"  verify(valid)       : {ok}      (expect True)")
    print(f"  tampered code       : {tampered}")
    print(f"  verify(tampered)    : {bad}     (expect False)")
    print(f"  verify(junk string) : {junk}    (expect False)")
    passed = ok and not bad and not junk
    print(f"  RESULT              : {'PASS' if passed else 'FAIL'}")
    return 0 if passed else 1


def main() -> int:
    p = argparse.ArgumentParser(description="Hydropark Phase-0 fulfillment stub (P0-09.4)")
    p.add_argument("--email", help="buyer email address (from the Stripe checkout)")
    p.add_argument("--stripe-session", help="Stripe checkout session id, for the record (optional)")
    p.add_argument("--event-id", help="Stripe webhook event id, for the record (optional)")
    p.add_argument("--selftest", action="store_true", help="run the generate/verify/tamper self-check and exit")
    args = p.parse_args()

    if args.selftest:
        return selftest()
    if not args.email:
        p.error("--email is required (or pass --selftest)")
    return fulfill(args.email, args.stripe_session, args.event_id)


if __name__ == "__main__":
    raise SystemExit(main())
