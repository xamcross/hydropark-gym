# Hydropark E2E Harness

Autonomous end-to-end tests that drive the *real* Tauri app (WebView2) through
Playwright, connected over the Chrome DevTools Protocol (CDP) — no bundled
browser, no human in the loop.

## How it works

- The app is launched with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`,
  using the toolchain-free `mock-inference` cargo build (real `backend_client`
  + real IPC + real backend, only the llama engine is scripted/mocked — see
  `client/src-tauri/src/inference.rs` `mod mock`).
- Playwright's `chromium.connectOverCDP('http://127.0.0.1:9222')` attaches to
  the live WebView2 page to click, read the DOM, and screenshot it.
- Each scenario gets a **fresh device**: `resetStore()` deletes
  `%APPDATA%\app.hydropark.phase0\hydropark.db` (+ `-wal`/`-shm`) before
  relaunching the app, so scenarios never see each other's state.

## Prerequisites

- Node.js (with `npx`/`tsx` — installed via `npm install` in this directory).
- The local stack scripts in `deploy/local-native/` (`_env.ps1`, `dev-up.ps1`,
  `mongo.ps1`, `backend.ps1`, `client.ps1`) — Mongo `rs0` on `:27018`, backend
  on `:8080`, the Angular dev server on `:4200`.
- The `mock-inference` cargo build compiled at least once
  (`cargo run --bin hydropark --no-default-features --features mock-inference`
  from `client/src-tauri`) — no libclang/CMake/GGUF/C++ toolchain required.
  The **first run is slow** (cargo compiles the mock build); subsequent runs
  reuse the warm `target/` and relaunch fast.

## Running

One command, from the repo root (PowerShell):

```powershell
deploy/local-native/e2e-up.ps1
```

This ensures Mongo/backend/ng are up, then runs the full scenario suite, then
(unless `-KeepUp` is passed) stops any running `hydropark` process. Exit code
is `0` iff every scenario passed.

If the stack is already up (e.g. mid-development), run the suite directly:

```powershell
cd client/e2e
npx tsx src/run.ts
```

(equivalently `npm run e2e`).

## Scenarios

Run in order, each against a freshly-reset device:

1. `00-smoke.ts` — app launches, the marketplace catalog renders (navigate to
   the MARKETPLACE tab, a known skill card — "Packing List" — is visible).
2. `10-free-install.ts` — Packing List → Get · Free → confirm the "Before you
   install" consent dialog → installed, no error banner.
3. `20-paid-buy.ts` — Cooking Assistant → Buy $5 → confirm consent → continue
   on this device (anonymous identity path) → the fake payment provider
   self-settles → owned/installed, no error banner.
4. `30-chat-tool-render.ts` — enable the free "Kitchen Timer & Units" skill,
   send the scripted mock prompt ("help me cook carbonara for 4"), assert the
   tidy tool-call line renders (e.g. "⏱ Setting a timer") and no raw tool
   JSON (`"duration_sec"`, `"timer_id"`, `start_timer: {...}`) leaks into the
   visible chat transcript (the W08 regression guard).

## Reading the results

Each scenario run writes to `client/e2e/artifacts/<timestamp>-<scenario>/`
(git-ignored):

- `report.md` — a human-readable pass/fail step list.
- `report.json` — the same, machine-readable.
- `*.png` — screenshots taken at each named checkpoint (e.g.
  `detail-before.png`, `detail-after.png`, `chat.png`).
- `FAILURE.png` — captured automatically if the scenario function throws
  (e.g. an unexpected error banner, a selector that never became visible).

**A failing scenario is not necessarily a harness bug.** If a scenario fails
with an error banner (`<p class="own-error" role="alert">`) or a leaked raw
tool-result JSON line, that is the harness catching a real app regression —
read the exact banner/leak text out of `report.md` before assuming the
selectors are wrong.

## Notes

- Selectors are text/role based, matching the live rendered DOM (not the
  route/component tree) — see the comments in each `scenarios/*.ts` file for
  where the live app differs from a first guess (e.g. ASSISTANT, not
  MARKETPLACE, is the default tab; every acquire is gated by a "Before you
  install" consent dialog).
- Tauri enforces single-instance: the lifecycle helpers in `src/app-lifecycle.ts`
  always stop any running `hydropark` process before relaunching.
