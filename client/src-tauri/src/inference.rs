//! Inference engine seam. Exactly one of the two `#[cfg]`-gated modules
//! below is compiled in, selected by Cargo feature (`Cargo.toml`):
//!
//!  - `mock` (default feature `mock-inference`) — a scripted, deterministic
//!    token stream. No model file, no native inference dependency. This is
//!    what makes `cargo check`/`cargo build` on this crate meaningful even
//!    without a GGUF or a C/C++ toolchain (see client/README.md).
//!  - `real` (feature `real-inference`) — embeds llama.cpp via the
//!    `llama-cpp-2` binding and runs qwen2.5-3b-instruct-q4_k_m in-process on
//!    a dedicated worker thread (see `mod real` below). CPU-only unless built
//!    with the `cuda` feature. Built AND run against llama-cpp-2 0.1.151 + the
//!    bundled GGUF; the build/run steps and the measured throughput (P0-02.3)
//!    are in `client/docs/REAL-INFERENCE.md`.
//!
//! Both speak the *exact* same event vocabulary (`inference://token`,
//! `inference://tool_call_detected`, `inference://tool_call_result`,
//! `inference://tool_call_fallback`, `inference://done`, `inference://error`
//! — see `ipc.rs`) and honour the same `CancelRegistry`, so flipping the
//! feature flag is the only change needed anywhere in the app.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use tauri::AppHandle;

use crate::ipc::{FallbackReason, InferenceStartArgs, ToolName};

/// Tracks which sessions have an in-flight `inference_cancel` request.
/// Checked by the engine between token emissions (mirrors
/// `MockIpcService`'s `cancelledSessions` set on the Angular side).
#[derive(Clone, Default)]
pub struct CancelRegistry(Arc<Mutex<HashSet<String>>>);

impl CancelRegistry {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn cancel(&self, session_id: &str) {
        self.0.lock().expect("cancel registry poisoned").insert(session_id.to_string());
    }
    pub fn clear(&self, session_id: &str) {
        self.0.lock().expect("cancel registry poisoned").remove(session_id);
    }
    pub fn is_cancelled(&self, session_id: &str) -> bool {
        self.0.lock().expect("cancel registry poisoned").contains(session_id)
    }
}

/// Extracts and parses a Qwen-native `<tool_call>{"name":…,"arguments":…}</tool_call>`
/// block with a **plain JSON parse** (P0-04.1 — explicitly NOT the
/// production GBNF-constrained decoding of SPEC §8.4; see PHASE0-PLAN §3.3
/// for why that's out of scope for the throwaway prototype). Returns
/// `None` on anything that isn't well-formed JSON, which the caller treats
/// as `FallbackReason::MalformedJson`.
pub fn extract_tool_call(text: &str) -> Option<serde_json::Value> {
    const START: &str = "<tool_call>";
    const END: &str = "</tool_call>";
    let start = text.find(START)? + START.len();
    let end = text[start..].find(END)? + start;
    let json_text = text[start..end].trim();
    serde_json::from_str(json_text).ok()
}

/// Classifies a parsed (or failed-to-parse) `<tool_call>` payload into the
/// `(tool, arguments, fallback reason)` triple both engines emit on the
/// malformed/invalid path (P0-04.1). Lives at module scope — rather than
/// inside `mod mock` — so the `real` engine can reuse it without either
/// duplicating it or depending on the mock feature being compiled.
pub(crate) fn classify_malformed(
    parsed: Option<serde_json::Value>,
) -> (Option<ToolName>, Option<serde_json::Value>, FallbackReason) {
    let Some(value) = parsed else {
        return (None, None, FallbackReason::MalformedJson);
    };
    let name = value.get("name").and_then(|n| n.as_str());
    let arguments = value.get("arguments").cloned();
    match name {
        Some("start_timer") => (Some(ToolName::StartTimer), arguments, FallbackReason::InvalidArgs),
        Some("convert_units") => (Some(ToolName::ConvertUnits), arguments, FallbackReason::InvalidArgs),
        Some("list_manage") => (Some(ToolName::ListManage), arguments, FallbackReason::InvalidArgs),
        _ => (None, arguments, FallbackReason::UnknownTool),
    }
}

/// Entry point used by `main.rs`'s `inference_start` command. Dispatches
/// to whichever engine is compiled in. When both features are enabled (a
/// plain `--features real-inference` keeps the default `mock-inference` on),
/// the real engine wins.
pub fn start(app: AppHandle, state: crate::tools::AppState, cancel: CancelRegistry, args: InferenceStartArgs) {
    #[cfg(all(feature = "mock-inference", not(feature = "real-inference")))]
    mock::run(app, state, cancel, args);

    #[cfg(feature = "real-inference")]
    real::run(app, state, cancel, args);

    #[cfg(not(any(feature = "mock-inference", feature = "real-inference")))]
    compile_error!("enable either the `mock-inference` or `real-inference` feature");
}

// ---------------------------------------------------------------------------
// Mock engine — scripted, deterministic. MIRRORS
// client/web/src/app/ipc/mock-ipc.service.ts's `scriptTurn()` so the
// Angular-only mock and this Rust mock demonstrate identically, even
// though they never run in the same process.
// ---------------------------------------------------------------------------

#[cfg(all(feature = "mock-inference", not(feature = "real-inference")))]
pub mod mock {
    use super::*;
    use crate::ipc::{
        InferenceDoneEvent, InferenceErrorEvent, InferenceToolCallDetectedEvent,
        InferenceToolCallFallbackEvent, InferenceToolCallResultEvent, InferenceTokenEvent,
        SkillId, ToolName,
    };
    use crate::tools::{self, AppState};
    use std::time::Duration;
    use tauri::Emitter;
    use tokio::time::sleep;

    enum Step {
        Text(&'static str),
        ToolCallValid { tool: ToolName, args: serde_json::Value },
        ToolCallMalformed(&'static str),
    }

    fn script_turn(user_message: &str, skill_enabled: bool) -> Vec<Step> {
        let msg = user_message.to_lowercase();

        if !skill_enabled {
            return vec![Step::Text(
                "I'm the base Hydropark agent — I can chat, but I don't have cooking tools yet. \
                 Enable \"Kitchen Timer & Units\" and ask me again.",
            )];
        }
        if msg.contains("confuse") || msg.contains("gibberish") {
            return vec![
                Step::Text("Hmm, let me think about how to help with that."),
                Step::ToolCallMalformed("<tool_call>{not valid json at all"),
            ];
        }
        if msg.contains("unknown tool") || msg.contains("random tool") {
            return vec![
                Step::Text("One moment —"),
                Step::ToolCallMalformed(
                    r#"<tool_call>{"name":"delete_everything","arguments":{}}</tool_call>"#,
                ),
            ];
        }
        if msg.contains("surprise") {
            return vec![
                Step::Text("Sure, let me set that up for you —"),
                Step::ToolCallMalformed(
                    r#"<tool_call>{"name":"start_timer","arguments":{"label":"Mystery"}}</tool_call>"#,
                ),
                Step::Text("I've prefilled a timer below — just tell me how long to set it for."),
            ];
        }
        if msg.contains("carbonara") {
            return vec![
                Step::Text("Great choice! Let's cook carbonara for 4. Here's what you'll need —"),
                Step::ToolCallValid {
                    tool: ToolName::ListManage,
                    args: serde_json::json!({
                        "op": "set_all",
                        "items": [
                            {"name": "Spaghetti", "qty": 400.0, "unit": "g"},
                            {"name": "Guanciale (or pancetta)", "qty": 150.0, "unit": "g"},
                            {"name": "Egg yolks", "qty": 4.0},
                            {"name": "Whole egg", "qty": 1.0},
                            {"name": "Pecorino Romano, grated", "qty": 50.0, "unit": "g"},
                            {"name": "Black pepper"}
                        ]
                    }),
                },
                Step::Text(
                    "I've filled in the ingredient list — flip US/Metric anytime, it re-converts \
                     exactly. Starting the pasta timer now —",
                ),
                Step::ToolCallValid {
                    tool: ToolName::StartTimer,
                    args: serde_json::json!({"label": "Pasta", "duration_sec": 540}),
                },
                Step::Text(
                    "Pasta timer is running (9:00). I'll ping you when it's done — want a sauce timer too?",
                ),
            ];
        }
        vec![Step::Text(
            "Kitchen Timer & Units is on — try \"Help me cook carbonara for 4\", or use the panels directly.",
        )]
    }

    /// Splits on whitespace runs while keeping them as their own tokens,
    /// so streamed output reproduces natural spacing — equivalent to the
    /// TS mock's `text.split(/(\s+)/).filter(w => w.length > 0)`.
    fn split_keep_whitespace(text: &str) -> Vec<&str> {
        let mut out = Vec::new();
        let mut start = 0;
        let mut chars = text.char_indices().peekable();
        let mut in_space = text.starts_with(char::is_whitespace);
        while let Some((i, c)) = chars.next() {
            let is_space = c.is_whitespace();
            if is_space != in_space {
                if i > start {
                    out.push(&text[start..i]);
                }
                start = i;
                in_space = is_space;
            }
        }
        if start < text.len() {
            out.push(&text[start..]);
        }
        out
    }

    pub fn run(app: AppHandle, state: AppState, cancel: CancelRegistry, args: InferenceStartArgs) {
        tauri::async_runtime::spawn(async move {
            let session_id = args.session_id.clone();
            cancel.clear(&session_id);
            let skill_enabled = matches!(
                args.skill_id,
                Some(SkillId::KitchenTimer) | Some(SkillId::CookingAssistant)
            );
            let steps = script_turn(&args.user_message, skill_enabled);
            let start_time = std::time::Instant::now();
            let mut seq: u64 = 0;
            let mut token_count: u64 = 0;

            'steps: for step in steps {
                if cancel.is_cancelled(&session_id) {
                    break;
                }
                match step {
                    Step::Text(text) => {
                        for word in split_keep_whitespace(text) {
                            if cancel.is_cancelled(&session_id) {
                                break 'steps;
                            }
                            sleep(Duration::from_millis(18 + (seq % 24) * 2)).await;
                            token_count += 1;
                            let _ = app.emit(
                                "inference://token",
                                InferenceTokenEvent { session_id: session_id.clone(), seq, token: word.to_string() },
                            );
                            seq += 1;
                        }
                    }
                    Step::ToolCallValid { tool, args: tool_args } => {
                        sleep(Duration::from_millis(120)).await;
                        let raw = format!(
                            "<tool_call>{{\"name\":\"{tool}\",\"arguments\":{tool_args}}}</tool_call>"
                        );
                        let _ = app.emit(
                            "inference://tool_call_detected",
                            InferenceToolCallDetectedEvent {
                                session_id: session_id.clone(),
                                raw,
                                tool: Some(tool),
                                parsed_args: Some(tool_args.clone()),
                                valid: true,
                            },
                        );
                        match tools::validate_and_parse(tool, &tool_args) {
                            Ok(typed) => match tools::execute(&state, &app, typed) {
                                Ok((executed_tool, result)) => {
                                    let _ = app.emit(
                                        "inference://tool_call_result",
                                        InferenceToolCallResultEvent {
                                            session_id: session_id.clone(),
                                            tool: executed_tool,
                                            result,
                                        },
                                    );
                                }
                                Err(e) => {
                                    let _ = app.emit(
                                        "inference://error",
                                        InferenceErrorEvent { session_id: session_id.clone(), message: e.to_string() },
                                    );
                                }
                            },
                            Err(e) => {
                                let _ = app.emit(
                                    "inference://error",
                                    InferenceErrorEvent { session_id: session_id.clone(), message: e.to_string() },
                                );
                            }
                        }
                    }
                    Step::ToolCallMalformed(raw) => {
                        sleep(Duration::from_millis(120)).await;
                        let parsed = extract_tool_call(raw);
                        let (tool, parsed_args, reason) = classify_malformed(parsed);
                        let _ = app.emit(
                            "inference://tool_call_detected",
                            InferenceToolCallDetectedEvent {
                                session_id: session_id.clone(),
                                raw: raw.to_string(),
                                tool,
                                parsed_args: parsed_args.clone(),
                                valid: false,
                            },
                        );
                        let clarifying_question = if tool.is_none() {
                            Some(
                                "Could you tell me what you would like me to do — start a timer, \
                                 update the ingredient list, or convert a unit?"
                                    .to_string(),
                            )
                        } else {
                            None
                        };
                        let _ = app.emit(
                            "inference://tool_call_fallback",
                            InferenceToolCallFallbackEvent {
                                session_id: session_id.clone(),
                                reason,
                                tool,
                                parsed_args,
                                clarifying_question,
                            },
                        );
                    }
                }
            }

            let elapsed_ms = start_time.elapsed().as_secs_f64() * 1000.0;
            let tok_per_sec = if token_count > 0 {
                (token_count as f64) / (elapsed_ms / 1000.0)
            } else {
                0.0
            };
            let _ = app.emit(
                "inference://done",
                InferenceDoneEvent {
                    session_id: session_id.clone(),
                    tokens_generated: token_count,
                    elapsed_ms,
                    tok_per_sec: (tok_per_sec * 10.0).round() / 10.0,
                },
            );
        });
    }
}

// ---------------------------------------------------------------------------
// Real engine (P0-02.1/.2, P0-04.1) — embeds llama.cpp via `llama-cpp-2` and
// runs qwen2.5-3b-instruct-q4_k_m in-process. It emits the *exact* same event
// vocabulary as the mock module above (`inference://token`, the three
// `tool_call_*` events, `done`, `error`) and honours the same `CancelRegistry`
// — so flipping the `real-inference` feature is the only change anywhere.
//
// The model + backend are loaded ONCE and owned by a single dedicated worker
// thread: llama.cpp's `LlamaModel`/`LlamaContext` handles are not `Send`, so
// rather than move them across threads we send jobs to the worker over a
// channel. A fresh `LlamaContext` (KV cache) is built per turn; Phase 0 keeps
// no cross-turn KV state (the transcript is re-assembled each turn).
//
// Phase 0 deliberately does NOT do GBNF-constrained decoding — tool JSON is
// parsed opportunistically out of the stream with `extract_tool_call`
// (PHASE0-PLAN §3.3 / ticket P0-04.3a covers the contingent grammar work).
#[cfg(feature = "real-inference")]
pub mod real {
    use super::{classify_malformed, extract_tool_call, CancelRegistry};
    use crate::ipc::{
        InferenceDoneEvent, InferenceErrorEvent, InferenceStartArgs,
        InferenceToolCallDetectedEvent, InferenceToolCallFallbackEvent,
        InferenceToolCallResultEvent, InferenceTokenEvent, SkillId, ToolName,
    };
    use crate::tools::{self, AppState};

    use std::num::NonZeroU32;
    use std::path::PathBuf;
    use std::sync::mpsc::{self, Receiver, Sender};
    use std::sync::OnceLock;
    use std::time::Instant;

    use tauri::{AppHandle, Emitter};

    use llama_cpp_2::context::params::LlamaContextParams;
    use llama_cpp_2::llama_backend::LlamaBackend;
    use llama_cpp_2::llama_batch::LlamaBatch;
    use llama_cpp_2::model::params::LlamaModelParams;
    use llama_cpp_2::model::{AddBos, LlamaModel};
    use llama_cpp_2::sampling::LlamaSampler;

    const MODEL_FILE: &str = "qwen2.5-3b-instruct-q4_k_m.gguf";
    const TOOL_CALL_OPEN: &str = "<tool_call>";
    const TOOL_CALL_CLOSE: &str = "</tool_call>";

    // ---- configuration (env-overridable) --------------------------------

    fn env_u32(key: &str, default: u32) -> u32 {
        std::env::var(key).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
    }

    /// GPU layers to offload. Conservative default because a 3B Q4 only
    /// partially fits a 4 GB card; override with `HYDROPARK_N_GPU_LAYERS`.
    /// Only takes effect in a `cuda`-feature build — a CPU-only build has no
    /// GPU backend and ignores it.
    fn n_gpu_layers() -> u32 { env_u32("HYDROPARK_N_GPU_LAYERS", 20) }
    fn n_ctx() -> u32 { env_u32("HYDROPARK_N_CTX", 4096) }
    fn max_new_tokens() -> usize { env_u32("HYDROPARK_MAX_TOKENS", 512) as usize }
    fn n_threads() -> i32 {
        std::env::var("HYDROPARK_N_THREADS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or_else(|| {
                std::thread::available_parallelism().map(|n| n.get() as i32).unwrap_or(4)
            })
    }
    fn temperature() -> f32 {
        std::env::var("HYDROPARK_TEMPERATURE").ok().and_then(|v| v.parse().ok()).unwrap_or(0.7)
    }

    /// Resolves the GGUF path. `HYDROPARK_MODEL_PATH` wins; otherwise the
    /// first existing of a set of conventional locations (next to / relative
    /// to the exe for a packaged build, relative to the crate for
    /// `cargo run`/`cargo test`). Returns a clear error listing where it
    /// looked if nothing is found (fail gracefully — the file may be absent).
    fn resolve_model_path() -> Result<PathBuf, String> {
        if let Ok(p) = std::env::var("HYDROPARK_MODEL_PATH") {
            let p = PathBuf::from(p);
            return if p.is_file() {
                Ok(p)
            } else {
                Err(format!("HYDROPARK_MODEL_PATH points at a missing file: {}", p.display()))
            };
        }
        let mut candidates: Vec<PathBuf> = Vec::new();
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                candidates.push(dir.join("models").join(MODEL_FILE)); // packaged: models/ next to exe
                candidates.push(dir.join("..").join("models").join(MODEL_FILE)); // ticket default: ../models
                // dev: target/<profile>/hydropark.exe -> ../../../models == client/models
                candidates.push(dir.join("..").join("..").join("..").join("models").join(MODEL_FILE));
            }
        }
        if let Ok(cwd) = std::env::current_dir() {
            candidates.push(cwd.join("models").join(MODEL_FILE));
            candidates.push(cwd.join("..").join("models").join(MODEL_FILE)); // `cargo test` cwd == src-tauri
        }
        for c in &candidates {
            if c.is_file() {
                return Ok(c.clone());
            }
        }
        Err(format!(
            "model file `{MODEL_FILE}` not found. Set HYDROPARK_MODEL_PATH, or place it in one of: {}",
            candidates.iter().map(|p| p.display().to_string()).collect::<Vec<_>>().join(" ; ")
        ))
    }

    // ---- loaded engine (lives only on the worker thread) ----------------

    pub struct Engine {
        backend: LlamaBackend,
        model: LlamaModel,
    }

    impl Engine {
        pub fn load() -> Result<Self, String> {
            let path = resolve_model_path()?;
            let backend =
                LlamaBackend::init().map_err(|e| format!("llama.cpp backend init failed: {e}"))?;
            let gpu_layers = n_gpu_layers();
            let model_params = LlamaModelParams::default().with_n_gpu_layers(gpu_layers);
            let load_start = Instant::now();
            let model = LlamaModel::load_from_file(&backend, &path, &model_params)
                .map_err(|e| format!("failed to load GGUF `{}`: {e}", path.display()))?;
            // P0-02.3 covariate: record whether GPU offload is actually in
            // effect. It is only ever active in a `cuda`-feature build.
            let gpu_offload_active = cfg!(feature = "cuda") && gpu_layers > 0;
            eprintln!(
                "[hydropark::inference] loaded {} in {:.1}s (n_gpu_layers={}, gpu_offload_active={}, n_ctx_train={}, threads={})",
                path.display(),
                load_start.elapsed().as_secs_f64(),
                gpu_layers,
                gpu_offload_active,
                model.n_ctx_train(),
                n_threads(),
            );
            if gpu_layers > 0 && !cfg!(feature = "cuda") {
                eprintln!(
                    "[hydropark::inference] note: n_gpu_layers={gpu_layers} requested, but this is a CPU-only build (no `cuda` feature) — running on CPU."
                );
            }
            Ok(Engine { backend, model })
        }
    }

    // ---- worker thread + job queue --------------------------------------

    struct Job {
        app: AppHandle,
        state: AppState,
        cancel: CancelRegistry,
        args: InferenceStartArgs,
    }

    static WORKER: OnceLock<Sender<Job>> = OnceLock::new();

    /// Same signature/role as `mock::run`: enqueue a turn. The first call
    /// lazily spawns the worker thread (which loads the model on its first
    /// job, so a missing model surfaces as an `inference://error`, not a
    /// startup crash).
    pub fn run(app: AppHandle, state: AppState, cancel: CancelRegistry, args: InferenceStartArgs) {
        let session_id = args.session_id.clone();
        let err_app = app.clone();
        let tx = WORKER.get_or_init(spawn_worker);
        if tx.send(Job { app, state, cancel, args }).is_err() {
            let _ = err_app.emit(
                "inference://error",
                InferenceErrorEvent {
                    session_id,
                    message: "inference worker thread is unavailable".to_string(),
                },
            );
        }
    }

    fn spawn_worker() -> Sender<Job> {
        let (tx, rx) = mpsc::channel::<Job>();
        std::thread::Builder::new()
            .name("hydropark-inference".to_string())
            .stack_size(16 * 1024 * 1024)
            .spawn(move || worker_loop(rx))
            .expect("failed to spawn inference worker thread");
        tx
    }

    fn worker_loop(rx: Receiver<Job>) {
        let mut engine: Option<Engine> = None;
        while let Ok(job) = rx.recv() {
            if engine.is_none() {
                match Engine::load() {
                    Ok(e) => engine = Some(e),
                    Err(msg) => {
                        eprintln!("[hydropark::inference] model load failed: {msg}");
                        let _ = job.app.emit(
                            "inference://error",
                            InferenceErrorEvent { session_id: job.args.session_id.clone(), message: msg },
                        );
                        continue; // leave engine None so a later job can retry (e.g. model appears)
                    }
                }
            }
            let engine = engine.as_ref().expect("engine loaded above");
            run_turn(engine, job);
        }
    }

    // ---- per-turn generation --------------------------------------------

    pub struct GenStats {
        pub n_decoded: u64,
        pub elapsed_ms: f64,
        pub cancelled: bool,
    }

    /// Builds the Qwen2.5 ChatML prompt. `str_to_token(.., special=true)`
    /// maps the `<|im_start|>` / `<|im_end|>` literals to their real
    /// control-token ids, so this hand-assembled string tokenizes correctly.
    pub fn build_chatml_prompt(user_message: &str, skill_enabled: bool) -> String {
        let system = if skill_enabled {
            concat!(
                "You are Hydropark, a friendly offline cooking assistant. The \"Kitchen Timer & Units\" ",
                "skill is enabled, so you can call tools. To call a tool, emit exactly one block of the form:\n",
                "<tool_call>\n{\"name\": \"<tool>\", \"arguments\": { ... }}\n</tool_call>\n\n",
                "Available tools:\n",
                "- start_timer(label: string, duration_sec: integer) — start a kitchen countdown.\n",
                "- convert_units(domain: \"mass\"|\"volume\"|\"temperature\", value: number, from_unit: string, to_unit: string) — convert a quantity.\n",
                "- list_manage(op: \"add\"|\"remove\"|\"check\"|\"uncheck\"|\"set_all\", item?, items?) — edit the ingredient list.\n\n",
                "When the user asks for something a tool can do, reply briefly and then emit one <tool_call> block. Otherwise, just chat."
            )
            .to_string()
        } else {
            concat!(
                "You are Hydropark, an offline AI assistant. The \"Kitchen Timer & Units\" skill is NOT ",
                "enabled, so you have no cooking tools. Chat helpfully; if the user wants cooking help, ",
                "suggest they enable the \"Kitchen Timer & Units\" skill."
            )
            .to_string()
        };
        format!(
            "<|im_start|>system\n{system}<|im_end|>\n<|im_start|>user\n{user}<|im_end|>\n<|im_start|>assistant\n",
            system = system,
            user = user_message,
        )
    }

    fn build_sampler() -> LlamaSampler {
        let temp = temperature();
        let seed = std::env::var("HYDROPARK_SEED")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(0xA1B2_C3D4);
        if temp <= 0.0 {
            LlamaSampler::chain_simple([
                LlamaSampler::penalties(64, 1.05, 0.0, 0.0),
                LlamaSampler::greedy(),
            ])
        } else {
            // Qwen2.5 recommended sampling: top_k=20, top_p=0.8, temp≈0.7,
            // repetition penalty 1.05.
            LlamaSampler::chain_simple([
                LlamaSampler::penalties(64, 1.05, 0.0, 0.0),
                LlamaSampler::top_k(20),
                LlamaSampler::top_p(0.8, 1),
                LlamaSampler::temp(temp),
                LlamaSampler::dist(seed),
            ])
        }
    }

    /// The core decode loop. Streams decoded UTF-8 pieces to `on_piece` as
    /// they are produced, checks `is_cancelled` between tokens, and returns
    /// timing stats. Intentionally free of any Tauri/event coupling so it is
    /// unit-testable without a running app (see `mod tests`).
    pub fn generate_stream(
        engine: &Engine,
        prompt: &str,
        max_new: usize,
        is_cancelled: &dyn Fn() -> bool,
        on_piece: &mut dyn FnMut(&str),
    ) -> Result<GenStats, String> {
        let ctx_params = LlamaContextParams::default()
            .with_n_ctx(NonZeroU32::new(n_ctx()))
            .with_n_threads(n_threads())
            .with_n_threads_batch(n_threads());
        let mut ctx = engine
            .model
            .new_context(&engine.backend, ctx_params)
            .map_err(|e| format!("failed to create llama context: {e}"))?;

        let tokens = engine
            .model
            .str_to_token(prompt, AddBos::Never)
            .map_err(|e| format!("tokenization failed: {e}"))?;
        if tokens.is_empty() {
            return Err("prompt tokenized to zero tokens".to_string());
        }

        let mut batch = LlamaBatch::new(tokens.len().max(512), 1);
        let last = tokens.len() as i32 - 1;
        for (i, tok) in tokens.iter().enumerate() {
            batch
                .add(*tok, i as i32, &[0], i as i32 == last)
                .map_err(|e| format!("batch add failed: {e}"))?;
        }
        ctx.decode(&mut batch).map_err(|e| format!("prompt decode failed: {e}"))?;

        let mut sampler = build_sampler();
        let start = Instant::now();
        let mut n_cur = batch.n_tokens();
        let mut n_decoded: u64 = 0;
        let mut utf8_buf: Vec<u8> = Vec::new();
        let mut cancelled = false;

        while n_decoded < max_new as u64 {
            if is_cancelled() {
                cancelled = true;
                break;
            }

            let token = sampler.sample(&ctx, batch.n_tokens() - 1);
            sampler.accept(token);
            if engine.model.is_eog_token(token) {
                break;
            }

            // `token_to_piece_bytes` (non-deprecated): special=false so no
            // control-token text leaks into the stream; 64 bytes is ample for
            // one token's piece; no left-strip.
            if let Ok(bytes) = engine.model.token_to_piece_bytes(token, 64, false, None) {
                utf8_buf.extend_from_slice(&bytes);
            }
            let piece = take_valid_utf8(&mut utf8_buf);
            if !piece.is_empty() {
                on_piece(&piece);
            }

            n_decoded += 1;

            batch.clear();
            batch
                .add(token, n_cur, &[0], true)
                .map_err(|e| format!("batch add failed: {e}"))?;
            n_cur += 1;
            ctx.decode(&mut batch).map_err(|e| format!("decode failed: {e}"))?;
        }

        Ok(GenStats { n_decoded, elapsed_ms: start.elapsed().as_secs_f64() * 1000.0, cancelled })
    }

    fn run_turn(engine: &Engine, job: Job) {
        let Job { app, state, cancel, args } = job;
        let session_id = args.session_id.clone();
        cancel.clear(&session_id);

        let skill_enabled = matches!(
            args.skill_id,
            Some(SkillId::KitchenTimer) | Some(SkillId::CookingAssistant)
        );
        let prompt = build_chatml_prompt(&args.user_message, skill_enabled);

        // Streaming state: emit chat tokens as they arrive, but hold back a
        // small guard tail so a partial "<tool_call>" is never streamed, and
        // suppress all chat text once a tool-call block begins (its raw JSON
        // is surfaced via the tool_call_* events instead, exactly like mock).
        let mut full = String::new();
        let mut emitted: usize = 0;
        let mut suppress = false;
        let mut seq: u64 = 0;

        let stats = {
            let stream = generate_stream(
                engine,
                &prompt,
                max_new_tokens(),
                &|| cancel.is_cancelled(&session_id),
                &mut |piece: &str| {
                    full.push_str(piece);
                    stream_progress(&app, &session_id, &full, &mut emitted, &mut suppress, &mut seq);
                },
            );
            match stream {
                Ok(s) => s,
                Err(msg) => {
                    let _ = app.emit(
                        "inference://error",
                        InferenceErrorEvent { session_id: session_id.clone(), message: msg },
                    );
                    return;
                }
            }
        };

        // Flush any trailing chat text held back by the guard (only if no
        // tool-call block suppressed the stream).
        if !suppress && emitted < full.len() {
            emit_token(&app, &session_id, &full[emitted..], &mut seq);
        }

        // Tool-call turn (P0-04.1): parse + validate + execute/fallback,
        // exactly like the mock engine. Skipped if cancelled mid-stream.
        if !stats.cancelled && full.contains(TOOL_CALL_OPEN) {
            process_tool_call(&app, &state, &session_id, &full);
        }

        // Real tok/s (P0-02.3 covariate) — same `inference://done` schema the
        // mock emits, so the Angular telemetry path is unchanged.
        let tok_per_sec = if stats.n_decoded > 0 && stats.elapsed_ms > 0.0 {
            (stats.n_decoded as f64) / (stats.elapsed_ms / 1000.0)
        } else {
            0.0
        };
        eprintln!(
            "[hydropark::inference] session {} — {} tokens in {:.1} ms = {:.1} tok/s{}",
            session_id,
            stats.n_decoded,
            stats.elapsed_ms,
            tok_per_sec,
            if stats.cancelled { " (cancelled)" } else { "" },
        );
        let _ = app.emit(
            "inference://done",
            InferenceDoneEvent {
                session_id: session_id.clone(),
                tokens_generated: stats.n_decoded,
                elapsed_ms: stats.elapsed_ms,
                tok_per_sec: (tok_per_sec * 10.0).round() / 10.0,
            },
        );
    }

    // ---- streaming helpers ----------------------------------------------

    fn emit_token(app: &AppHandle, session_id: &str, text: &str, seq: &mut u64) {
        if text.is_empty() {
            return;
        }
        let _ = app.emit(
            "inference://token",
            InferenceTokenEvent {
                session_id: session_id.to_string(),
                seq: *seq,
                token: text.to_string(),
            },
        );
        *seq += 1;
    }

    /// Emits everything newly safe to stream. Holds back the last
    /// `len("<tool_call>") - 1` bytes so a partial opening tag is never
    /// streamed as chat text, and latches `suppress` once a full opening tag
    /// appears.
    fn stream_progress(
        app: &AppHandle,
        session_id: &str,
        full: &str,
        emitted: &mut usize,
        suppress: &mut bool,
        seq: &mut u64,
    ) {
        if *suppress {
            return;
        }
        if let Some(tc) = full.find(TOOL_CALL_OPEN) {
            if tc > *emitted {
                emit_token(app, session_id, &full[*emitted..tc], seq);
            }
            *emitted = full.len();
            *suppress = true;
            return;
        }
        let guard = TOOL_CALL_OPEN.len() - 1;
        let mut safe = full.len().saturating_sub(guard);
        while safe > *emitted && !full.is_char_boundary(safe) {
            safe -= 1;
        }
        if safe > *emitted {
            emit_token(app, session_id, &full[*emitted..safe], seq);
            *emitted = safe;
        }
    }

    /// Drains the largest valid-UTF-8 prefix of `buf`, leaving any incomplete
    /// trailing multi-byte sequence for the next token (llama tokens can split
    /// a multi-byte character across two decode steps).
    fn take_valid_utf8(buf: &mut Vec<u8>) -> String {
        match std::str::from_utf8(buf) {
            Ok(s) => {
                let out = s.to_string();
                buf.clear();
                out
            }
            Err(e) => {
                let valid = e.valid_up_to();
                let out = String::from_utf8_lossy(&buf[..valid]).into_owned();
                match e.error_len() {
                    Some(bad) => {
                        buf.drain(..valid + bad); // genuinely invalid bytes: drop them
                    }
                    None => {
                        buf.drain(..valid); // incomplete tail: keep it for the next token
                    }
                }
                out
            }
        }
    }

    // ---- tool-call handling (mirrors the mock engine) -------------------

    fn tool_from_name(name: &str) -> Option<ToolName> {
        match name {
            "start_timer" => Some(ToolName::StartTimer),
            "convert_units" => Some(ToolName::ConvertUnits),
            "list_manage" => Some(ToolName::ListManage),
            _ => None,
        }
    }

    fn raw_tool_call_block(text: &str) -> String {
        if let Some(s) = text.find(TOOL_CALL_OPEN) {
            if let Some(rel) = text[s..].find(TOOL_CALL_CLOSE) {
                return text[s..s + rel + TOOL_CALL_CLOSE.len()].to_string();
            }
            return text[s..].to_string(); // unterminated block
        }
        String::new()
    }

    fn process_tool_call(app: &AppHandle, state: &AppState, session_id: &str, full: &str) {
        let raw = raw_tool_call_block(full);
        let parsed = extract_tool_call(full);

        // Valid path: JSON parses, names a known tool, and args pass the same
        // registry validation the UI-first path uses.
        if let Some(value) = &parsed {
            if let Some(name) = value.get("name").and_then(|n| n.as_str()) {
                if let Some(tool) = tool_from_name(name) {
                    let tool_args =
                        value.get("arguments").cloned().unwrap_or_else(|| serde_json::json!({}));
                    if let Ok(typed) = tools::validate_and_parse(tool, &tool_args) {
                        let _ = app.emit(
                            "inference://tool_call_detected",
                            InferenceToolCallDetectedEvent {
                                session_id: session_id.to_string(),
                                raw: raw.clone(),
                                tool: Some(tool),
                                parsed_args: Some(tool_args.clone()),
                                valid: true,
                            },
                        );
                        match tools::execute(state, app, typed) {
                            Ok((executed_tool, result)) => {
                                let _ = app.emit(
                                    "inference://tool_call_result",
                                    InferenceToolCallResultEvent {
                                        session_id: session_id.to_string(),
                                        tool: executed_tool,
                                        result,
                                    },
                                );
                            }
                            Err(e) => {
                                let _ = app.emit(
                                    "inference://error",
                                    InferenceErrorEvent {
                                        session_id: session_id.to_string(),
                                        message: e.to_string(),
                                    },
                                );
                            }
                        }
                        return;
                    }
                }
            }
        }

        // Malformed / invalid path — reuse the shared classifier + the same
        // one-shot fallback (no repair loop) the mock engine uses.
        let (tool, parsed_args, reason) = classify_malformed(parsed);
        let _ = app.emit(
            "inference://tool_call_detected",
            InferenceToolCallDetectedEvent {
                session_id: session_id.to_string(),
                raw,
                tool,
                parsed_args: parsed_args.clone(),
                valid: false,
            },
        );
        let clarifying_question = if tool.is_none() {
            Some(
                "Could you tell me what you would like me to do — start a timer, update the ingredient list, or convert a unit?"
                    .to_string(),
            )
        } else {
            None
        };
        let _ = app.emit(
            "inference://tool_call_fallback",
            InferenceToolCallFallbackEvent {
                session_id: session_id.to_string(),
                reason,
                tool,
                parsed_args,
                clarifying_question,
            },
        );
    }

    // ---- unit tests (require the GGUF + a native llama.cpp build) --------
    // Run explicitly, e.g.:
    //   cargo test --release --features real-inference -- --nocapture
    // They SKIP (rather than fail) if the model file can't be found, so the
    // suite still passes on machines without the GGUF.
    #[cfg(test)]
    mod tests {
        use super::*;

        fn run_prompt(engine: &Engine, label: &str, user: &str, skill: bool, max_new: usize) -> String {
            let prompt = build_chatml_prompt(user, skill);
            let mut text = String::new();
            let stats = generate_stream(engine, &prompt, max_new, &|| false, &mut |p| text.push_str(p))
                .expect("generation failed");
            let tps = if stats.elapsed_ms > 0.0 {
                stats.n_decoded as f64 / (stats.elapsed_ms / 1000.0)
            } else {
                0.0
            };
            eprintln!(
                "=== {label} ({} tokens, {:.1} ms, {:.2} tok/s) ===\n{}\n=== END {label} ===",
                stats.n_decoded,
                stats.elapsed_ms,
                tps,
                text.trim()
            );
            assert!(stats.n_decoded > 0, "{label}: expected at least one token");
            text
        }

        // Single test: `LlamaBackend::init()` is global (once per process), so
        // one Engine is loaded and reused for both a plain turn (tok/s) and the
        // tool-call turn (P0-04.1). SKIPs (passes) if the GGUF isn't found.
        #[test]
        fn loads_model_generates_and_tool_calls() {
            let engine = match Engine::load() {
                Ok(e) => e,
                Err(msg) => {
                    eprintln!("SKIP loads_model_generates_and_tool_calls: {msg}");
                    return;
                }
            };

            let hello = run_prompt(
                &engine,
                "PLAIN CHAT",
                "Say hello in exactly one short sentence.",
                false,
                64,
            );
            assert!(!hello.trim().is_empty(), "expected non-empty chat output");

            let tool = run_prompt(
                &engine,
                "TOOL CALL",
                "Start a 9 minute timer labelled Pasta.",
                true,
                256,
            );
            // Model behaviour varies run-to-run; surface whether a well-formed
            // tool_call block was produced without hard-failing on it.
            match extract_tool_call(&tool) {
                Some(v) => eprintln!("parsed <tool_call> JSON: {v}"),
                None => eprintln!("no well-formed <tool_call> block this run"),
            }
        }
    }
}
