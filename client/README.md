# Hydropark client — Phase 0 prototype

> **This is a throwaway.** `PHASE0-PLAN.md` §1 is explicit: Phase 0 is a validation prototype, *not*
> the seed of the production client. It exists to falsify three hypotheses (H1 desirability,
> H2 model quality, H3 willingness-to-pay). Do not grow the production app out of this tree.

## What builds today

| Part | State | Command |
|---|---|---|
| `web/` — Angular UI | **Builds and runs.** Verified. | `cd web && npm install && npm run build` |
| `src-tauri/` — Rust core | **Authored, never compiled.** | see below |

`npm run build` produces `web/dist/web` (~249 kB initial bundle).

### The Rust core does not compile here

There is **no Rust toolchain on this machine** (`cargo` is not installed), and the Qwen2.5-3B GGUF is
not bundled. Nothing in `src-tauri/` has ever been type-checked. Treat every line of it as a draft.

To build it you need, in order:

```bash
# 1. Rust toolchain
winget install Rustlang.Rustup      # or https://rustup.rs

# 2. Tauri CLI
cargo install tauri-cli

# 3. The base model, placed where tauri.conf.json expects it
#    qwen2.5-3b-instruct-q4_k_m.gguf

# 4. Build
cd src-tauri && cargo build
cargo tauri dev
```

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

- `src-tauri/src/inference.rs` — the llama.cpp binding is a `TODO(P0-02.1)` seam behind a
  `mock-inference` feature. Token streaming, `<tool_call>` parsing, and the malformed-call fallback
  (prefilled widget / one clarifying question, no repair loop) are written but unexercised.
- OS timer notification + sound (`P0-05.4`) is authored, not run.
- No licensing, no marketplace, no backend calls. Phase 0 has no server (`PHASE0-PLAN.md` §3.1:
  state lives in memory plus a JSONL log; no SQLite).

The production backend lives in `../backend` and is unrelated to this prototype.
