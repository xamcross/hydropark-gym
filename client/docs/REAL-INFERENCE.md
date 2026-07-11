# Real inference — build & verify runbook

> **Phase 0, throwaway.** This runbook exists to falsify **H2 (model quality)** and to record the
> **P0-02.3 covariates** (first-token latency, tok/s, GPU offload on/off). It is a one-shot
> "build it once, run it once, write the numbers down" procedure — not a supported install path.

The `real-inference` engine lives in `src-tauri/src/inference.rs` (`mod real`). It embeds llama.cpp
via `llama-cpp-2` 0.1.151, loads the bundled Qwen2.5-3B GGUF on a dedicated worker thread, and emits
the **exact same** `inference://*` events as the default mock engine — so flipping the feature flag is
the only change anywhere in the app.

The default build stays on `mock-inference` and needs none of the below. You only need this to
exercise the real model.

---

## 1. Prerequisites

| Tool | Why | Status on the build box |
|---|---|---|
| Rust (rustup, **MSVC** host) | compiles the crate | present |
| Visual Studio Build Tools — C++ workload + Windows SDK | links llama.cpp's native objects | present |
| **CMake** (on `PATH`) | `llama-cpp-sys-2` builds vendored llama.cpp via cmake | present |
| **LLVM / libclang** | `bindgen` (run by `llama-cpp-sys-2`) parses the C headers | **must be installed** |
| CUDA toolkit (`nvcc`) | *only* for the `cuda` feature | optional |

### libclang (the one that trips people up)

`bindgen` needs `libclang.dll` at build time and finds it via **`LIBCLANG_PATH`**, which must point at
the **directory containing `libclang.dll`** (not the file itself). With a standard LLVM install:

```powershell
# PowerShell — set for the current shell before building:
$env:LIBCLANG_PATH = "C:\Program Files\LLVM\bin"
# sanity check — this should print a path:
Get-ChildItem "$env:LIBCLANG_PATH\libclang.dll"
```

If you installed LLVM elsewhere (e.g. via `winget install LLVM.LLVM` or a VS-bundled clang), set
`LIBCLANG_PATH` to whatever directory holds `libclang.dll`.

---

## 2. The model

The GGUF is already bundled — no download step:

```
client/models/qwen2.5-3b-instruct-q4_k_m.gguf   (~2.1 GB, Q4_K_M)
```

`resolve_model_path()` finds it automatically (it probes `models/` next to the exe, the crate-relative
dev locations, and the cwd). To point elsewhere, set **`HYDROPARK_MODEL_PATH`** to the full `.gguf`
path; that always wins. A missing model surfaces as an `inference://error` event (and an `eprintln`),
not a crash.

---

## 3. Build

Run from `client/src-tauri`. Use **`--release`** — a debug build runs inference many times slower and
would poison the P0-02.3 numbers.

```powershell
# from client/src-tauri, with $env:LIBCLANG_PATH set (see §1)
cargo build --release --features real-inference
```

The first build is slow: `llama-cpp-sys-2` compiles vendored llama.cpp from source via cmake. Later
builds are incremental.

To run the actual app against the real engine:

```powershell
# dev (needs `npm run start` in ../web serving http://localhost:4200):
cargo run --release --features real-inference

# packaged (embeds the built frontend — note custom-protocol is NOT optional, see README):
cargo build --release --features "real-inference custom-protocol"
```

### Fastest way to verify the engine in isolation (no UI)

`mod real` ships one integration test that loads the model, generates a plain-chat turn (prints
tok/s), then a tool-call turn. It **skips (passes)** if the GGUF can't be found, so it is safe in CI.

```powershell
cargo test --release --features real-inference -- --nocapture
```

---

## 4. What success looks like

On load you should see (stderr):

```
[hydropark::inference] loaded <...>/qwen2.5-3b-instruct-q4_k_m.gguf in 1.8s (n_gpu_layers=20, gpu_offload_active=false, n_ctx_train=32768, threads=8)
[hydropark::inference] note: n_gpu_layers=20 requested, but this is a CPU-only build ... — running on CPU.
```

Then, per turn, either the app streams `inference://token` events into the chat (and a
`<tool_call>` block turns into a timer / list / conversion widget), or the test prints the generated
text plus a stats line:

```
=== PLAIN CHAT (23 tokens, 4120.5 ms, 5.58 tok/s) ===
Hello! How can I help you cook today?
=== END PLAIN CHAT ===
...
[hydropark::inference] session <id> — 23 tokens in 4120.5 ms = 5.6 tok/s
```

**Record for P0-02.3 (H2):**

- **Model load time** (the `loaded ... in N.Ns` line).
- **First-token latency** — wall-clock from turn start to the first `inference://token` (dominated by
  prompt decode). The app's `done` event carries totals; time-to-first-token is best eyeballed from
  the token stream or added ad-hoc if you need it precise.
- **tok/s** — from the `done` event (`tok_per_sec`) or the test's stats line.
- **`gpu_offload_active`** — the covariate for the CPU-vs-GPU cut (only ever `true` in a `cuda` build).
- Whether a **well-formed `<tool_call>`** block was produced (the test prints the parsed JSON or
  "no well-formed <tool_call> block this run"). Behaviour varies run-to-run; that is itself an H2
  datapoint. Also sanity-check that generation **stops on its own** (the model emits `<|im_end|>` /
  end-of-generation) rather than running to the `HYDROPARK_MAX_TOKENS` cap.

---

## 5. Feature-flag matrix

| Build | Command | Engine | Native toolchain | GPU |
|---|---|---|---|---|
| **default** | `cargo build --release` (or `... --features custom-protocol`) | mock — scripted, deterministic | none (no CMake/libclang/GGUF) | n/a |
| **real (CPU)** | `cargo build --release --features real-inference` | real llama.cpp, in-process | MSVC + CMake + **libclang** | CPU only; `n_gpu_layers` ignored |
| **real + CUDA** | `cargo build --release --features cuda` | real llama.cpp + GPU offload | above **+ CUDA toolkit (`nvcc`) on PATH** | offloads `HYDROPARK_N_GPU_LAYERS` layers |

Notes:

- `cuda` implies `real-inference` (see `Cargo.toml`); a plain `real-inference` build is CPU-only and
  silently ignores `n_gpu_layers`.
- `real-inference` and the default `mock-inference` can both be enabled at once; when they are, the
  **real engine wins** (`inference::start` dispatches to `real::run`).

### Runtime knobs (env vars, all optional)

| Var | Default | Effect |
|---|---|---|
| `HYDROPARK_MODEL_PATH` | auto-resolved | full path to the `.gguf`; overrides discovery |
| `HYDROPARK_N_CTX` | `4096` | context window (KV cache size) |
| `HYDROPARK_MAX_TOKENS` | `512` | generation cap per turn |
| `HYDROPARK_N_THREADS` | logical cores | CPU threads for decode/batch |
| `HYDROPARK_N_GPU_LAYERS` | `20` | layers to offload (**`cuda` builds only**) |
| `HYDROPARK_TEMPERATURE` | `0.7` | sampling temp; `<= 0` switches to greedy |
| `HYDROPARK_SEED` | `0xA1B2C3D4` | RNG seed for the `dist` sampler (reproducibility) |

Sampling defaults follow Qwen2.5's recommended settings (top_k=20, top_p=0.8, temp≈0.7, repetition
penalty 1.05). Phase 0 does **not** do GBNF-constrained decoding — tool JSON is parsed opportunistically
out of the stream (PHASE0-PLAN §3.3 / P0-04.3a covers the contingent grammar work).
