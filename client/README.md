# Hydropark client — Phase 0 prototype

> **This is a throwaway.** `PHASE0-PLAN.md` §1 is explicit: Phase 0 is a validation prototype, *not*
> the seed of the production client. It exists to falsify three hypotheses (H1 desirability,
> H2 model quality, H3 willingness-to-pay). Do not grow the production app out of this tree.

## What builds today

| Part | State | Command |
|---|---|---|
| `web/` — Angular UI | **Builds.** Verified. | `cd web && npm install && npm run build` |
| `src-tauri/` — Rust core | **Builds, links, and runs.** Verified on Windows. | see below |

`npm run build` produces `web/dist/web/browser/` (~249 kB initial bundle). Note the `browser/`
subdirectory — Angular 17+ nests it, and that is the path `tauri.conf.json`'s `frontendDist` points at.

### Building

```bash
# Prerequisites (Windows): Rust (rustup, MSVC host), Visual Studio Build Tools with the
# C++ workload, the Windows SDK, and the WebView2 runtime (Windows 11 ships it).

cd web && npm install && npm run build      # the Tauri build embeds this output

cd ../src-tauri
cargo run                                   # dev: loads devUrl, needs `npm run start` in ../web
cargo build --release --features custom-protocol    # production: embeds the frontend
```

Release binary: `src-tauri/target/release/hydropark.exe` (~3.3 MB).

### Two traps that compile, link, launch — and are still broken

Both of these were shipped-looking bugs. Neither produces a compiler warning.

**1. `--features custom-protocol` is not optional for a real build.** Without it, `tauri-build` emits
`cfg(dev)` and the binary loads `build.devUrl` (`http://localhost:4200`) *even in `--release`*. The app
opens on WebView2's "Hmmm… can't reach this page / ERR_CONNECTION_REFUSED". The `tauri build` CLI
passes the feature for you; a bare `cargo build --release` does not. The feature is declared in
`Cargo.toml` — do not remove it.

**2. Angular's critical-CSS inliner produces a stylesheet Tauri's CSP will not activate.** The
Angular application builder rewrites the stylesheet link to
`<link rel="stylesheet" media="print" onload="this.media='all'">`, which only becomes active via an
**inline event handler**. Tauri's CSP (`default-src 'self'`, no `script-src`) blocks inline handlers,
so the `onload` never fires, the sheet stays `media="print"`, and the app renders permanently
unstyled — while every asset returns 200. The fix is `optimization.styles.inlineCritical: false` in
`angular.json` (already set), **not** loosening the CSP.

### Inference engine & notifications

- `src-tauri/src/inference.rs` — **both engines are implemented and the real one is verified.**
  `mock-inference` (the default feature) streams a scripted, deterministic turn with no model file
  and no native dependency; `real-inference` embeds llama.cpp via `llama-cpp-2` (a real, optional
  dependency in `Cargo.toml`, gated behind the feature) and runs Qwen2.5-3B in-process on a dedicated
  worker thread. The GGUF **is** bundled at `models/qwen2.5-3b-instruct-q4_k_m.gguf` (~2.1 GB). The
  real path has now been **built and run on this machine** (a `real-inference` build additionally
  needs LLVM/libclang for bindgen — see `docs/REAL-INFERENCE.md`): it loads the GGUF and streams
  tokens at **~17–20 tok/s (CPU-only)**, above the ≥8 tok/s Recommended-tier floor (P0-02.3).
- OS timer notification + sound (`P0-05.4`) is authored; the `notification` plugin is wired in Rust.
  Note `plugins.notification` must be **absent** from `tauri.conf.json` — the v2 plugin's config type
  is a unit, so even `"notification": {}` fails to deserialize and panics at startup.

Until then, the UI runs against a **mock inference stream** (`web/src/app/ipc/mock-ipc.service.ts`),
so the chat, widgets, and skill transform are all exercisable without a model. That is deliberate:
the H1 hypothesis is about the *transform*, and the transform does not need a real model to be felt.

## What is implemented

Phase-0 tickets `P0-01` … `P0-06`:

- **Four widgets** (`web/src/app/widgets/`): `chat`, `timer_stack`, `editable_list`,
  `segmented_toggle`. Flipping the US↔Metric toggle re-expresses quantities in *both* the chat
  transcript and the ingredient list (`P0-03.5`).
- **Skill-enable transform** (`skill-toggle/`): one toggle mounts/unmounts the skill's panels with an
  enter/exit transition that honours `prefers-reduced-motion` (`P0-05.1`, `P0-05.2`). This moment
  *is* the H1 hypothesis.
- **UI-first triggers** (`P0-03.6`): tapping a widget control invokes the tool directly, with **no
  model round-trip**. Built as the primary path, not a fallback — a 3B model will emit malformed tool
  calls, and the product must not depend on it not doing so.
- **Three in-proc tools** (`src-tauri/src/tools.rs`): `start_timer`, `convert_units`, `list_manage`,
  with typed args validated against a registry before execution.
- **Typed IPC contract** — see `IPC-CONTRACT.md`. `web/src/app/ipc/contract.ts` and
  `src-tauri/src/ipc.rs` are mirrors of one schema.
- **JSONL session-event log** (`P0-06.1`) emitted through the IPC bridge.

## What is stubbed

- `src-tauri/src/inference.rs` — the real llama.cpp engine (behind the `real-inference` feature) is
  implemented, not a `TODO` seam: it loads the bundled Qwen2.5-3B GGUF on a dedicated worker thread,
  streams tokens (UTF-8-safe, with a guard tail so a partial `<tool_call>` never leaks), parses
  `<tool_call>` blocks, and runs the same malformed-call fallback (prefilled widget / one clarifying
  question, no repair loop) as the mock — emitting the identical `inference://*` event vocabulary. It
  has **not yet been compiled or run here**; the default build stays on `mock-inference`. See
  `docs/REAL-INFERENCE.md` to build and verify it.
- OS timer notification + sound (`P0-05.4`) is authored, not run.
- No licensing, no marketplace, no backend calls. Phase 0 has no server (`PHASE0-PLAN.md` §3.1:
  state lives in memory plus a JSONL log; no SQLite).

The production backend lives in `../backend` and is unrelated to this prototype.
