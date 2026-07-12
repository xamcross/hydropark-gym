#![allow(dead_code)] // Test-only harness: no runtime items, only the #[cfg(test)] matrix below.

//! P1-26.4 — the offline-behaviour matrix (SPEC §14), split into the slice that
//! is *automatable in `cargo test`* and the slice that needs a **running app**.
//!
//! SPEC §14 promises the desktop app keeps working with the network fully down:
//! owned skills stay entitled, agents keep chatting on the local model, templates
//! save/load, and buying a *new* skill is the only thing that (correctly) needs a
//! connection. This module makes the **offline-provable** part of that promise a
//! regression test, and documents — so the split is explicit — the part that
//! still has to be exercised by hand against a real build.
//!
//! ## Automated here (pure, network-free, runs under `cargo test`)
//! These four flows depend only on an in-memory SQLite database, compile-time
//! `include_str!` golden vectors, and locally-built key sets. None of them
//! constructs or accepts a [`crate::backend_client::BackendClient`], opens a
//! socket, or names a URL — reaching the network on these paths is not merely
//! disabled, it is *unreachable by construction* (SPEC §6). Each test therefore
//! provides no network client, no server, and no connectivity, and asserts the
//! flow still runs to success:
//!
//!  - **A1 — owned-skill licence verifies from a CACHED token, no network.** A
//!    compact-JWS licence is cached in the on-device store (as it would be after a
//!    prior online fetch) and then re-verified purely offline against the golden
//!    ES256 key — the returning-buyer entitlement path (`store` + `license_verify`).
//!  - **A2 — templates save / load / restore offline.** A named skill combo is
//!    saved, persisted to and reloaded from the local store, and resolved back
//!    into an ordered agent against the installed skill set (`templates` + `store`).
//!  - **A3 — the local store round-trips offline.** Agent docs, chat transcript
//!    rows, and per-agent panel state persist and read back from an in-memory
//!    database (`store`), the app-data layer §6 depends on.
//!  - **A4 — skill-package signature verifies offline.** A skill manifest's
//!    detached Ed25519 signature is checked against a pinned trusted key before
//!    install, with no trust in any download channel (`package_verify`).
//!
//! ## Manual — still needs a running app (NOT covered by `cargo test`)
//! These require a live Tauri process, a real GGUF model on disk, and OS-level
//! network toggling, so they live in the manual QA pass, not here. Listed so the
//! automated-vs-manual boundary is unambiguous:
//!
//!  - **M1 — cold start offline.** Launch with the NIC down: the window opens,
//!    no telemetry/backend call blocks the UI, and owned skills are present.
//!  - **M2 — chat / inference offline.** Send a prompt to an enabled agent; the
//!    local llama.cpp (`real-inference`) model streams tokens to completion and
//!    tool calls (timers, unit conversion) run — all with no connectivity.
//!  - **M3 — model swap offline.** Switch the base model (GGUF) mid-session; the
//!    agent recomposes and the next turn runs on the new model with no download.
//!  - **M4 — paid skill runs offline end-to-end.** After a prior online unlock,
//!    Cooking Assistant stays enabled and functional across a full offline
//!    relaunch. (A1 automates the licence-verify half; the persona + tool runtime
//!    is the manual half.)
//!  - **M5 — template gallery UI offline.** Save/reload templates through the real
//!    gallery UI. (A2 automates the pure save/load/restore core; the UI is manual.)
//!  - **M6 — timers + OS notification offline.** A timer completes and fires an OS
//!    notification (with sound) with no network, degrading to an in-app alert if
//!    permission is denied.
//!  - **M7 — marketplace gracefully unavailable offline.** Catalog / detail /
//!    checkout fail *soft*; owned skills are unaffected and the UI shows an offline
//!    state rather than an error wall.
//!  - **M8 — buying a locked skill is correctly BLOCKED offline.** Unlock/checkout
//!    needs the network; attempting it offline surfaces a clear "needs connection"
//!    path and never a false unlock.
//!  - **M9 — reconnect flush.** Queued telemetry / entitlement refresh flushes once
//!    the network returns.

// ===========================================================================
// Automated offline slice (A1–A4). Everything below is #[cfg(test)] — this
// module ships no runtime items.
// ===========================================================================

#[cfg(test)]
mod tests {
    use crate::license_verify::{verify_license, SigAlg, TrustedKeySet};
    use crate::package_verify::{verify as verify_package, PackageTrustedKeys, PackageVerifyError};
    use crate::store::Store;
    use crate::templates::{load_template, save_as_template, SemVer};

    use serde_json::json;

    // --- compile-time-embedded golden vectors -----------------------------
    // `include_str!` bakes these into the test binary AT COMPILE TIME, so
    // reading them at run time is neither a file fetch nor a network call —
    // the offline inputs travel inside the binary itself.
    const LICENSE_GOLDEN: &str = include_str!("../../../contracts/testdata/license-es256-golden.json");
    const PACKAGE_GOLDEN: &str = include_str!("../../../contracts/testdata/package-signing-golden.json");

    #[derive(serde::Deserialize)]
    struct LicenseGolden {
        token: String,
        public_key_spki_b64: String,
        kid: String,
    }

    #[derive(serde::Deserialize)]
    struct PackageGolden {
        manifest: serde_json::Value,
        package_public_key_b64: String,
        kid: String,
    }

    fn license_golden() -> LicenseGolden {
        serde_json::from_str(LICENSE_GOLDEN).expect("embedded license golden parses")
    }

    fn package_golden() -> PackageGolden {
        serde_json::from_str(PACKAGE_GOLDEN).expect("embedded package golden parses")
    }

    // ======================================================================
    // A1 — owned-skill licence verifies from a CACHED token, with NO network.
    // ======================================================================
    //
    // Models the returning-buyer path (SPEC §13.3/§13.12, §14): the licence was
    // fetched online once, cached on-device, and every later launch re-verifies it
    // offline. The token is cached in an in-memory store and re-read; the trusted
    // key is built from the embedded golden SPKI. No `BackendClient`, no URL, no
    // socket is involved — verification is a pure signature check.
    #[test]
    fn a1_owned_skill_license_verifies_from_cached_token_offline() {
        let g = license_golden();
        let skill_id = "cooking-assistant"; // the skill the golden licence entitles

        // The ONLY input path is the local cache — seeded here, as a prior online
        // fetch would have, then read back with zero connectivity.
        let store = Store::open_in_memory().expect(":memory: store opens offline");
        store
            .cache_license(skill_id, &g.kid, &g.token, /* cached_at = */ 1_770_000_000_000)
            .expect("caching a compact-JWS licence touches only the local db");
        let cached = store
            .newest_license(skill_id)
            .expect("reading the cache is a local query")
            .expect("a licence is cached for the owned skill");
        assert_eq!(cached.compact_jws, g.token, "the cached token is returned verbatim");

        // Trust set built purely from the embedded golden key — no key fetch.
        let mut trust = TrustedKeySet::new();
        trust
            .insert_spki_b64(g.kid.clone(), SigAlg::Es256, &g.public_key_spki_b64)
            .expect("golden ES256 SPKI is valid");

        // Offline verification of the cached token succeeds and yields the claims.
        let verified = verify_license(&cached.compact_jws, &trust)
            .expect("cached owned-skill licence must verify entirely offline");
        assert_eq!(verified.skill_id, skill_id);
        assert_eq!(verified.entitlement, "perpetual");
        assert_eq!(verified.exp, None, "a perpetual licence carries no expiry");
        assert_eq!(verified.kid, g.kid);
        assert_eq!(verified.alg, SigAlg::Es256);

        // No network: the whole flow used only an in-memory db + embedded key
        // material. Nothing on this path can open a socket (structural, SPEC §6).
    }

    // ======================================================================
    // A2 — templates save / load / restore offline.
    // ======================================================================
    //
    // "Save current agent as template" then "reload the exact combination + layout"
    // (SPEC §10), with the template persisted through the local store in between —
    // all offline. No network is consulted to resolve pins; loading checks the pin
    // against the *installed* set already on this host.
    #[test]
    fn a2_templates_save_load_and_restore_offline() {
        let ui = json!({ "panel_order": ["timers", "ingredients", "nutrition"] });
        let saved = save_as_template(
            "Weeknight Chef",
            "qwen2.5-3b-instruct-q4_k_m",
            &[("cooking-assistant", SemVer::new(1, 2, 0)), ("nutrition-coach", SemVer::new(1, 0, 0))],
            ui.clone(),
        );

        // Persist to and reload from the on-device store (no network).
        let store = Store::open_in_memory().expect(":memory: store opens offline");
        store.save_template(&saved).expect("template persists locally");
        let reloaded = store
            .load_template(&saved.id)
            .expect("reading the template is a local query")
            .expect("the saved template is present offline");
        assert_eq!(reloaded, saved, "template round-trips through the local store");

        // Restore the exact ordered combo + layout against the installed skills
        // (a different install order + a newer patch must still resolve, offline).
        let restored = load_template(
            &reloaded,
            &[("nutrition-coach", SemVer::new(1, 0, 3)), ("cooking-assistant", SemVer::new(1, 4, 0))],
        )
        .expect("template loads offline against the installed set");
        assert_eq!(restored.base_model, "qwen2.5-3b-instruct-q4_k_m");
        assert_eq!(restored.ui_overrides, ui, "layout restored verbatim");
        let combo: Vec<(&str, SemVer)> =
            restored.skills.iter().map(|s| (s.skill_id.as_str(), s.version)).collect();
        assert_eq!(
            combo,
            vec![("cooking-assistant", SemVer::new(1, 4, 0)), ("nutrition-coach", SemVer::new(1, 0, 3))],
            "combo restored in template order, at the installed versions — no network needed"
        );
    }

    // ======================================================================
    // A3 — the local store round-trips offline.
    // ======================================================================
    //
    // The app-data layer (SPEC §6): agent docs, chat transcript rows, and per-agent
    // panel state must persist and read back with no network — this is the state
    // that lets the app resume fully offline. Exercised against `:memory:`.
    #[test]
    fn a3_local_store_round_trips_offline() {
        let store = Store::open_in_memory().expect(":memory: store opens + migrates offline");

        // agent document
        let agent = json!({ "base_model": "qwen2.5-3b-instruct-q4_k_m", "skills": ["cooking-assistant"] });
        store.save_agent("agent-1", &agent).expect("agent persists locally");
        assert_eq!(store.load_agent("agent-1").unwrap(), Some(agent));

        // chat transcript (append-only, ordered)
        let a = store.append_chat_message("chat-1", "user", "how long for pasta?", 10).unwrap();
        let b = store.append_chat_message("chat-1", "assistant", "about 9 minutes", 20).unwrap();
        assert!(b > a, "row ids are monotonic in append order");
        let msgs = store.list_chat_messages("chat-1").unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!((msgs[0].role.as_str(), msgs[0].content.as_str()), ("user", "how long for pasta?"));

        // per-agent panel state
        let panel = json!({ "order": ["timers", "ingredients"], "collapsed": [] });
        store.save_panel_state("agent-1", &panel).expect("panel state persists locally");
        assert_eq!(store.load_panel_state("agent-1").unwrap(), Some(panel));

        // No network: an in-memory database, opened and driven entirely on-device.
    }

    // ======================================================================
    // A4 — skill-package signature verifies offline (before install).
    // ======================================================================
    //
    // SPEC §8.8/§13.8: a skill package's manifest carries a detached Ed25519
    // signature; the client re-derives the RFC 8785 JCS canonical bytes and checks
    // the signature against a pinned trusted key BEFORE anything is installed —
    // offline, trusting the signature and not the download channel. A one-field
    // tamper must be rejected.
    #[test]
    fn a4_package_signature_verifies_offline() {
        let g = package_golden();

        // Trusted key built purely from the embedded golden SPKI — no key fetch.
        let trusted = PackageTrustedKeys::from_spki_b64([(g.kid.clone(), g.package_public_key_b64.clone())])
            .expect("golden package key is a valid Ed25519 SPKI");

        // The genuine manifest verifies with no network.
        assert_eq!(verify_package(&g.manifest, &trusted), Ok(()));

        // A tampered manifest is rejected offline (the guard the install path relies on).
        let mut tampered = g.manifest.clone();
        tampered["name"] = serde_json::Value::String("Golden Vector — TAMPERED".to_string());
        assert_eq!(
            verify_package(&tampered, &trusted),
            Err(PackageVerifyError::SignatureMismatch),
            "a byte tamper must fail the offline signature check"
        );
    }
}
