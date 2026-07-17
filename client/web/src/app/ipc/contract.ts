/**
 * Hydropark Phase-0 — Rust ↔ Angular IPC contract.
 *
 * This is the SOURCE OF TRUTH for every message that crosses the Tauri
 * webview/core boundary. It is mirrored 1:1 in Rust at
 * `client/src-tauri/src/ipc.rs` (serde structs/enums with matching field
 * names — this file intentionally uses snake_case field names, not the
 * usual TS camelCase, so the two sides stay textually comparable).
 *
 * See `client/IPC-CONTRACT.md` for the responsibility split (what Rust
 * owns vs. what the webview owns) and for how to keep the two files in
 * sync when either side changes.
 *
 * Schema is versioned per-section where it is persisted (telemetry) or
 * replayed across a process boundary that can be upgraded independently
 * (none in Phase 0 — app and core ship together). Bump
 * `TELEMETRY_SCHEMA_VERSION` on any breaking change to `TelemetryEvent`.
 */

// ---------------------------------------------------------------------------
// Tool registry (P0-03.1)
// ---------------------------------------------------------------------------

/**
 * The fixed, first-party, audited tool catalog. The three P0 tools plus the two
 * Phase-1 stateless additions (`calculate`, `date_math`, P1-05.1) — the exact
 * closed set the manifest schema's `toolRef` enum and the Rust
 * `tool_catalog::ToolName` expose (snake_case wire names). No manifest can invent
 * a tool outside this set; adding one is a reviewed catalog change on both sides.
 */
export type ToolName = 'start_timer' | 'convert_units' | 'list_manage' | 'calculate' | 'date_math';

export const TOOL_NAMES: readonly ToolName[] = [
  'start_timer',
  'convert_units',
  'list_manage',
  'calculate',
  'date_math',
] as const;

// --- start_timer -----------------------------------------------------------

export interface StartTimerArgs {
  /** User/agent-facing name, e.g. "Pasta". Multiple named timers may run concurrently. */
  label: string;
  /** Exact integer seconds. */
  duration_sec: number;
}

export interface StartTimerResult {
  timer_id: string;
  label: string;
  duration_sec: number;
  /** Epoch millis, assigned by the Rust core (source of truth for timing). */
  started_at_ms: number;
}

// --- convert_units -----------------------------------------------------------

export type UnitDomain = 'mass' | 'volume' | 'temperature';
export type UnitSystem = 'US' | 'Metric';

/** Deterministic, exact-arithmetic unit identifiers understood by convert_units. */
export type UnitId =
  | 'g' | 'kg' | 'oz' | 'lb' // mass
  | 'ml' | 'l' | 'tsp' | 'tbsp' | 'fl_oz' | 'cup' // volume
  | 'c' | 'f'; // temperature

export interface ConvertUnitsArgs {
  domain: UnitDomain;
  value: number;
  from_unit: UnitId;
  to_unit: UnitId;
}

export interface ConvertUnitsResult {
  value: number;
  unit: UnitId;
}

// --- list_manage -----------------------------------------------------------

export type ListOp = 'add' | 'remove' | 'check' | 'uncheck' | 'set_all';

/** Matches SPEC §8.3.4's `item` record: `{ id, name, qty?, unit?, checked? }`. */
export interface IngredientItem {
  /** Stable, app-assigned id (set on insert) — never chosen by the caller on add. */
  id: string;
  name: string;
  qty?: number;
  unit?: UnitId;
  checked?: boolean;
}

export interface ListManageArgs {
  op: ListOp;
  /** Required for add (name[, qty, unit]); id required for remove/check/uncheck. */
  item?: Partial<IngredientItem>;
  /** Required for set_all (agent populating the list from a recipe). */
  items?: Array<Omit<IngredientItem, 'id'> & { id?: string }>;
}

export interface ListManageResult {
  /** Full resulting list — the shared-state `ingredients` slot, post-op. */
  ingredients: IngredientItem[];
}

// --- calculate (P1-05.1) ---------------------------------------------------
//
// One deterministic arithmetic op over two-or-more operands — NO free-form
// expression evaluation. Mirrors `tool_catalog::CalculateArgs/CalculateResult`.

/** The closed arithmetic-op set (snake_case wire, matches Rust `CalcOp`). */
export type CalcOp = 'add' | 'sub' | 'mul' | 'div';

export interface CalculateArgs {
  op: CalcOp;
  /** Two or more finite operands, folded left-to-right by `op`. */
  operands: number[];
}

export interface CalculateResult {
  value: number;
}

// --- date_math (P1-05.1) ---------------------------------------------------
//
// Add/subtract a whole days/hours/minutes delta to an RFC 3339 instant. Mirrors
// `tool_catalog::DateMathArgs/DateMathResult`.

export type DateOp = 'add' | 'sub';

/** A signed offset in whole days/hours/minutes; each component defaults to 0. */
export interface DateDelta {
  days?: number;
  hours?: number;
  minutes?: number;
}

export interface DateMathArgs {
  /** The base instant as an RFC 3339 date-time (e.g. `2026-07-11T09:00:00Z`). */
  base: string;
  op: DateOp;
  delta: DateDelta;
}

export interface DateMathResult {
  /** The resulting instant, RFC 3339. */
  result: string;
}

// --- generic tool args/result map ------------------------------------------

export interface ToolArgsMap {
  start_timer: StartTimerArgs;
  convert_units: ConvertUnitsArgs;
  list_manage: ListManageArgs;
  calculate: CalculateArgs;
  date_math: DateMathArgs;
}

export interface ToolResultMap {
  start_timer: StartTimerResult;
  convert_units: ConvertUnitsResult;
  list_manage: ListManageResult;
  calculate: CalculateResult;
  date_math: DateMathResult;
}

/** Who triggered the call — the UI-first path (P0-03.6) or the model path (P0-04.1). */
export type ToolCallSource = 'ui' | 'model';

/**
 * `tool` is strictly typed (not a bare string) because this request only
 * ever crosses the IPC boundary from the UI-first path (widgets calling
 * `ToolsService`, always with a compile-time-valid literal) — the
 * model's untrusted tool name is parsed and validated entirely on the
 * Rust side (`inference.rs` / `tools.rs::validate_and_parse`) from the
 * raw `<tool_call>` JSON before anything typed reaches this shape. So
 * `unknown_tool` responses from THIS command are defensive, not the
 * primary path that guards against a bad model output — see
 * `IpcEventMap['inference://tool_call_fallback']` for that.
 */
export interface ToolCallRequest<T extends ToolName = ToolName> {
  request_id: string;
  tool: T;
  args: ToolArgsMap[T];
  source: ToolCallSource;
}

export interface ToolCallError {
  code: 'unknown_tool' | 'invalid_args' | 'execution_error';
  message: string;
}

export type ToolCallResponse<T extends ToolName = ToolName> =
  | { request_id: string; ok: true; tool: T; result: ToolResultMap[T] }
  | { request_id: string; ok: false; tool: T | null; error: ToolCallError };

// ---------------------------------------------------------------------------
// Inference (P0-02.x, P0-04.x)
// ---------------------------------------------------------------------------

export interface InferenceStartArgs {
  session_id: string;
  user_message: string;
  /** Active skill persona id, if any (drives which system prompt leads). */
  skill_id?: SkillId;
}

export interface InferenceCancelArgs {
  session_id: string;
}

/** Streamed one-token-at-a-time; the webview appends to the chat transcript. */
export interface InferenceTokenEvent {
  session_id: string;
  seq: number;
  token: string;
}

/**
 * Emitted whenever the model emits a `<tool_call>` block. Rust has ALREADY
 * decided validity and (if valid) executed it before this event is sent —
 * see IPC-CONTRACT.md "Tool-call turn sequence". The webview never
 * re-validates; it only renders.
 */
export interface InferenceToolCallDetectedEvent {
  session_id: string;
  raw: string;
  tool: ToolName | null;
  parsed_args: Record<string, unknown> | null;
  valid: boolean;
}

/** Valid call: Rust already ran it; this carries the result to render. */
export interface InferenceToolCallResultEvent<T extends ToolName = ToolName> {
  session_id: string;
  tool: T;
  result: ToolResultMap[T];
}

/**
 * Invalid/malformed call: no repair loop (P0-04.2). The webview must
 * degrade to exactly one of: prefill the tool's bound widget, or post one
 * clarifying question to chat.
 */
export interface InferenceToolCallFallbackEvent {
  session_id: string;
  reason: 'malformed_json' | 'unknown_tool' | 'invalid_args';
  /** Best-effort tool guess, if the name parsed even though args didn't validate. */
  tool: ToolName | null;
  /** Whatever args DID parse, to prefill the widget with. */
  parsed_args: Record<string, unknown> | null;
  /** Set when no widget maps to `tool` (or tool is null) — ask this verbatim. */
  clarifying_question: string | null;
}

export interface InferenceDoneEvent {
  session_id: string;
  tokens_generated: number;
  elapsed_ms: number;
  tok_per_sec: number;
}

export interface InferenceErrorEvent {
  session_id: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Skills (P0-05.1)
// ---------------------------------------------------------------------------

/** Phase-0 ships exactly two hardcoded skills (SPEC §26.4). */
export type SkillId = 'kitchen-timer' | 'cooking-assistant';

export interface SkillEnableArgs {
  skill_id: SkillId;
}

export interface SkillEnableResult {
  skill_id: SkillId;
  persona_injected: boolean;
  tools_registered: ToolName[];
  panels: string[];
}

export interface SkillDisableArgs {
  skill_id: SkillId;
}

// ---------------------------------------------------------------------------
// Timers (Rust-owned countdown source of truth)
// ---------------------------------------------------------------------------
//
// `start_timer` is the one model-callable tool (P0-03.1). Pause/resume/reset
// are deliberately NOT tools — they are widget-lifecycle controls the model
// is never offered (there is no product reason for the agent to pause a
// timer on the user's behalf), reached only via the UI-first path. They
// still cross the IPC boundary because Rust remains the single countdown
// source of truth even for these actions.

export interface TimerControlArgs {
  timer_id: string;
}

export interface TimerStateSnapshot {
  timer_id: string;
  label: string;
  duration_sec: number;
  remaining_sec: number;
  running: boolean;
}

export interface TimerTickEvent {
  timer_id: string;
  remaining_sec: number;
}

export interface TimerFinishedEvent {
  timer_id: string;
  label: string;
}

// ---------------------------------------------------------------------------
// Hardware profiling (P0-02.3) — read-only, never gates a feature
// ---------------------------------------------------------------------------

export interface HardwareProfile {
  ram_gb: number;
  cores: number;
  gpu_present: boolean;
}

// ---------------------------------------------------------------------------
// OS notifications (P0-05.4)
// ---------------------------------------------------------------------------

export interface NotifyArgs {
  title: string;
  body: string;
  sound: boolean;
}

// ---------------------------------------------------------------------------
// Telemetry (P0-06.1 / P0-06.2) — one shared, versioned event schema
// ---------------------------------------------------------------------------

export const TELEMETRY_SCHEMA_VERSION = 1 as const;

interface TelemetryEventBase {
  schema_version: typeof TELEMETRY_SCHEMA_VERSION;
  session_id: string;
  ts_ms: number;
}

export interface SkillEnabledEvent extends TelemetryEventBase {
  event: 'skill_enabled';
  skill_id: SkillId;
}

export interface SkillDisabledEvent extends TelemetryEventBase {
  event: 'skill_disabled';
  skill_id: SkillId;
}

export interface TimerStartedEvent extends TelemetryEventBase {
  event: 'timer_started';
  timer_id: string;
  label: string;
  duration_sec: number;
  /** Did the user tap the widget directly, or did the model call the tool? */
  source: ToolCallSource;
}

export interface ListEditedEvent extends TelemetryEventBase {
  event: 'list_edited';
  op: ListOp;
  source: ToolCallSource;
  item_count_after: number;
}

export interface UnitsFlippedEvent extends TelemetryEventBase {
  event: 'units_flipped';
  from: UnitSystem;
  to: UnitSystem;
  source: ToolCallSource;
}

export interface TokPerSecEvent extends TelemetryEventBase {
  event: 'tok_per_sec';
  value: number;
  hardware: HardwareProfile;
}

/** Task-outcome marker — used to compute the H1 behavioral pass from the log alone. */
export interface OutcomeEvent extends TelemetryEventBase {
  event: 'outcome';
  name: 'timer_started_unprompted' | 'list_edited_unprompted' | 'session_end';
  detail?: string;
}

// --- product metrics (P1-25.1) ---------------------------------------------
//
// The four north-star product metrics, emitted through the SAME `telemetry_log`
// sink as everything above. Each carries ONLY enums/booleans/counts/durations —
// never a name, message, or any conversation content (SPEC §15, §25). They are
// suppressed wholesale when the P1-10.3 opt-in toggle is off (see
// telemetry.service.ts's consent guard).

/**
 * ACTIVATION — the user enabled a skill during a session. Emitted once per
 * session, on the FIRST skill enabled that session (telemetry.service.ts owns
 * the once-per-session bookkeeping). `first_session` marks the install's very
 * first session (a best-effort local flag), so "activation in the first
 * session" is computable from the log alone.
 */
export interface ActivationEvent extends TelemetryEventBase {
  event: 'activation';
  skill_id: SkillId;
  /** True when the app has no local record of a prior session. */
  first_session: boolean;
}

/**
 * COMPOSITION RATE — the live agent is composed from more than one skill, or
 * from an adopted template. Emitted once per composition-active transition
 * (CompositionService), never per re-compose. Counts + a boolean only.
 */
export interface CompositionEvent extends TelemetryEventBase {
  event: 'composition';
  /** Skills active in the composed agent (≥ 2 for an ad-hoc composition). */
  skills_active: number;
  /** True when a saved template drove the composition (vs. ad-hoc toggling). */
  via_template: boolean;
}

/**
 * OFFLINE-USAGE SHARE — session-level: did the session run without touching the
 * backend (pure on-device use)? `backend_calls` is the count of network-backed
 * IPC calls made this session; `offline` is `backend_calls === 0`. No URLs, no
 * payloads — just the count and the derived boolean.
 */
export interface OfflineUsageEvent extends TelemetryEventBase {
  event: 'offline_usage';
  /** True when the session made no backend/network call at all. */
  offline: boolean;
  /** Number of backend calls this session (0 ⇒ fully offline). */
  backend_calls: number;
}

/**
 * CRASH-FREE SESSION — session-level: did the session reach a clean end with no
 * unhandled error? `errors` counts observed unhandled errors/rejections;
 * `crash_free` is `errors === 0`. NEVER carries a message or stack (those can
 * leak content) — a count and a boolean only.
 */
export interface CrashFreeSessionEvent extends TelemetryEventBase {
  event: 'crash_free_session';
  /** True when no unhandled error/rejection was observed this session. */
  crash_free: boolean;
  /** Number of unhandled errors observed (0 ⇒ crash-free). */
  errors: number;
}

export type TelemetryEvent =
  | SkillEnabledEvent
  | SkillDisabledEvent
  | TimerStartedEvent
  | ListEditedEvent
  | UnitsFlippedEvent
  | TokPerSecEvent
  | OutcomeEvent
  | ActivationEvent
  | CompositionEvent
  | OfflineUsageEvent
  | CrashFreeSessionEvent;

// ---------------------------------------------------------------------------
// Marketplace + agent-composition commands (P1 live-flow wiring)
// ---------------------------------------------------------------------------
//
// NB: unlike the P0 seed above (which mirrors `ipc.rs` field-for-field in
// snake_case), these Phase-1 commands use camelCase wire field names — that is
// the shape the live-flow task fixes as the cross-agent contract, and the Rust
// half builds its Tauri commands (`#[serde(rename_all = "camelCase")]`) to the
// same names. Base URL for the network-backed ones comes from
// `HYDROPARK_API_BASE` on the Rust side; the webview never talks HTTP directly.
//
// `catalog_list` / `catalog_detail` are PUBLIC (no bearer). Orders,
// entitlements, license and download take an OPTIONAL `bearer` access token —
// the client auth flow that mints it is a later tranche; the plumbing passes it
// through when present and omits it otherwise.

/** One row of `catalog_list` — the card projection (SPEC §11.1). `priceCents === 0` ⇒ free. */
export interface CatalogItem {
  id: string;
  name: string;
  pitch: string;
  category: string;
  /** Minor units (cents). `0` = free. */
  priceCents: number;
  sizeBytes: number;
  /** Human-readable hardware-fit chip, e.g. "Runs on your PC" / "Needs a larger model". */
  hardwareBadge: string;
  /** Effective ownership/lifecycle state string (e.g. "not-owned" | "owned" | "installed" | "active"). */
  ownership: string;
}

export interface CatalogListArgs {
  region?: string;
}

export interface CatalogListResult {
  skills: CatalogItem[];
}

export interface CatalogDetailArgs {
  skillId: string;
}

/**
 * `catalog_detail` result. Carries `compressedPrompt` ONLY — never the full paid
 * `system_prompt` (IP protection SF8); there is deliberately no field for it.
 */
export interface SkillDetail {
  id: string;
  name: string;
  pitch: string;
  category: string;
  priceCents: number;
  sizeBytes: number;
  hardwareBadge: string;
  ownership: string;
  description?: string;
  /** The compressed teaser prompt — the only prompt text ever exposed. */
  compressedPrompt?: string;
  panels?: string[];
  tools?: string[];
  samplePrompts?: string[];
  hasPreview?: boolean;
  currentVersion?: string;
  changelog?: string;
}

export interface OrderCheckoutArgs {
  targetId: string;
  region: string;
  bearer?: string;
}

export interface OrderCheckoutResult {
  orderId: string;
  checkoutUrl: string;
}

export interface OrderGetArgs {
  orderId: string;
  bearer?: string;
}

export interface OrderGetResult {
  orderId: string;
  status: string;
}

export interface EntitlementsGetArgs {
  bearer?: string;
}

/** One owned entitlement row (SPEC §11.3 / §13). */
export interface EntitlementItem {
  skillId: string;
  /** e.g. "owned" | "installed" | "active". */
  state: string;
  version?: string;
}

export interface EntitlementsGetResult {
  skills: EntitlementItem[];
}

export interface LicenseFetchArgs {
  skillId: string;
  bearer?: string;
}

export interface LicenseFetchResult {
  /** The compact-JWS license token (ES256, see HSM migration doc). */
  compactJws: string;
}

export interface DownloadUrlArgs {
  skillId: string;
  version: string;
  bearer?: string;
}

export interface DownloadUrlResult {
  url: string;
  /** ISO-8601 expiry of the signed URL. */
  expiresAt: string;
  /** Per-user watermark token embedded in the package (BE anti-piracy). */
  watermark: string;
}

// ---------------------------------------------------------------------------
// Agent composition (`compose_agent`) — mirrors client/src-tauri/src/composition.rs
// ---------------------------------------------------------------------------
//
// The Rust `compose_agent` command chains manifest validation → merge (order /
// persona / tools / conflicts) → capacity gate → tool routing, and returns the
// flattened `ComposedAgentView` (or throws a structured `ComposeError`). These
// interfaces are the 1:1 TypeScript mirror of the `#[derive(Serialize)]` views
// in composition.rs so the webview consumes it type-safely.

/** One composed tool (mirrors Rust `ToolView`). */
export interface ComposedToolView {
  call_name: string;
  tool_ref: string;
  contributors: string[];
  namespaced: boolean;
}

/** One tool's resolved routing (mirrors Rust `RouteView`). `target` is `"chat"` or `"widget:<name>"`. */
export interface ComposedRouteView {
  tool_ref: string;
  reads: string[];
  writes: string[];
  target: string;
}

/** The context-capacity projection (mirrors Rust `CapacityView`). */
export interface ComposedCapacityView {
  ctx_window: number;
  reserve_tokens: number;
  skill_tokens: number;
  used_tokens: number;
  remaining: number;
  blocked: boolean;
  overflow: number;
}

/** The fully composed agent the `compose_agent` command returns (mirrors Rust `ComposedAgentView`). */
export interface ComposedAgentView {
  order: string[];
  primary: string | null;
  persona: string;
  tools: ComposedToolView[];
  routing: ComposedRouteView[];
  capacity: ComposedCapacityView;
}

/**
 * A structured composition failure (mirrors Rust `ComposeErrorView`). The Tauri
 * command surfaces this as the rejected-promise payload; the client also uses
 * this shape for transport/parse failures it raises itself (`kind: 'ipc'`).
 */
export interface ComposeError {
  /** `invalid_manifest` | `malformed` | `conflict` | `capacity_overflow` | `ipc`. */
  kind: string;
  message: string;
}

export interface ComposeAgentArgs {
  /**
   * Raw `.hpskill` manifest JSON for the currently-enabled skills. Typed
   * `unknown[]` because the Rust side treats each as an opaque `serde_json::Value`
   * and validates it — the webview passes the manifest objects through verbatim.
   */
  manifests: unknown[];
  /** The user's chosen lead skill, if any (otherwise merge order decides). */
  primaryHint?: string;
  /** Model context window in tokens (e.g. 4096). */
  nCtx?: number;
}

// ---------------------------------------------------------------------------
// Account / auth (P1-09.1/.2) + purchase deep-link (P1-08.6/.8)
// ---------------------------------------------------------------------------
//
// Email-OPTIONAL identity (SPEC §12 / §13). The app is fully usable with NO
// account; identity only becomes necessary to BUY. Three escalating states:
//   - `anonymous`     — no identity yet (default; the app still works fully).
//   - `device`        — a device-scoped identity (`device_ensure`) that CAN buy
//                       but is not portable; the no-email "continue on this
//                       device" path.
//   - `authenticated` — an email/password account, so entitlements restore on
//                       another install (`entitlements_refresh`).
//
// camelCase wire names, same cross-agent convention as the marketplace block:
// the Rust half builds `#[serde(rename_all = "camelCase")]` commands to match.
// Network-backed calls take an OPTIONAL device/account `bearer`; the webview
// never talks HTTP directly.

export type AuthStatusKind = 'anonymous' | 'device' | 'authenticated';

/**
 * A pending step-up challenge (SPEC §13.4) — e.g. an emailed code or TOTP the
 * backend demands before a sensitive action completes. While set, the identity
 * is NOT yet `authenticated`; the webview renders `prompt` and answers with
 * `step_up_answer`.
 */
export interface StepUpChallenge {
  challengeId: string;
  /** e.g. "email_code" | "totp". */
  kind: string;
  /** Human-readable instruction to render verbatim. */
  prompt: string;
}

/** The whole client-visible identity state — the result of every auth command. */
export interface AuthState {
  status: AuthStatusKind;
  /** Stable device identity id, present once `device_ensure` has run. */
  deviceId?: string | null;
  /** Account id, present when `status === 'authenticated'`. */
  userId?: string | null;
  /** Linked email, if any (optional even when authenticated in some flows). */
  email?: string | null;
  /** Bearer access token for the authed order/entitlement/license/download calls. */
  accessToken?: string | null;
  /** Set when the last command raised a step-up challenge that must be answered. */
  stepUp?: StepUpChallenge | null;
}

/** Check/hydrate current identity. Optional `bearer` re-validates a stored token. */
export interface AuthStatusArgs {
  bearer?: string;
}

/** Create an email account. Email/password are OPTIONAL here only so the Rust side can 400 with a structured error the UI renders — the UI itself requires them for this path. */
export interface AuthRegisterArgs {
  email?: string;
  password?: string;
  region?: string;
}

export interface AuthLoginArgs {
  email: string;
  password: string;
}

export interface AuthLogoutArgs {
  bearer?: string;
}

/** Mint (or return the existing) device-scoped identity — the no-email buy path. */
export interface DeviceEnsureArgs {
  region?: string;
}

export interface StepUpAnswerArgs {
  challengeId: string;
  answer: string;
}

/** Restore purchases (P1-08.8): re-pull the authed entitlement set. */
export interface EntitlementsRefreshArgs {
  bearer?: string;
}

/** Hand a URL to the OS default browser (Rust owns the actual `open`). */
export interface OpenExternalArgs {
  url: string;
}

/**
 * The purchase deep-link return (P1-08.6). After the buyer completes checkout in
 * the system browser, the backend redirects to the app's `purchase://callback`
 * custom scheme; the OS routes that to the Tauri shell, which re-emits it here.
 * The webview treats it as ONE of two settle signals (the other is polling
 * `order_get`) — whichever arrives first wins.
 */
export interface PurchaseCallbackEvent {
  orderId?: string | null;
  skillId?: string | null;
  /** e.g. "settled" | "cancelled" | "failed". */
  status: string;
  /** The raw deep-link URL, for diagnostics. */
  raw?: string | null;
}

// ---------------------------------------------------------------------------
// On-demand model download (P1-02.7) — resumable, REAL-progress downloader
// ---------------------------------------------------------------------------
//
// The bundled 3B model ships inside the app, so nothing is required to start
// (SPEC §16.1). This block covers PULLING an optional larger model on demand.
// The Rust core owns the actual HTTP range-download, the on-disk temp file, the
// resume offset, and the SHA-256 verify; the webview only starts/cancels it and
// RENDERS the progress it streams back. camelCase wire names, same P1 convention
// as the marketplace block.
//
// Honesty contract (P1-02.7): every byte figure that crosses this seam is a REAL
// count the core measured — there is deliberately no "estimated %" field the UI
// could animate. When the total isn't known yet the UI shows an indeterminate
// bar, never a fabricated fraction.

/** Which downloadable model to fetch. `modelId` keys the core-side model registry. */
export interface ModelDownloadStartArgs {
  modelId: string;
  /**
   * Resume from a retained partial file when one exists (default true). `false`
   * forces a clean restart from byte 0, discarding any partial.
   */
  resume?: boolean;
}

export interface ModelDownloadStatusArgs {
  modelId: string;
}

export interface ModelDownloadCancelArgs {
  modelId: string;
}

/** Lifecycle phase of a model download — drives which UI state renders. */
export type ModelDownloadPhase =
  | 'queued' //      accepted, not yet transferring (no headers yet)
  | 'downloading' // bytes moving
  | 'verifying' //   transfer complete, checking SHA-256
  | 'complete' //    verified + installed on disk
  | 'paused' //      stopped with a resumable partial retained
  | 'cancelled' //   user-cancelled (a resumable partial may be retained)
  | 'error'; //      failed — see `message`; often resumable

/**
 * A download status snapshot — the SHARED shape returned by `model_download_status`
 * / `model_download_start` AND pushed on every `model://progress` event. Carries
 * `bytes` / `totalBytes` / `phase` / `resumed` (plus a `message` on error). Never
 * an estimated percentage — the UI derives the fraction as `bytes / totalBytes`
 * only when `totalBytes` is known.
 */
export interface ModelDownloadStatus {
  modelId: string;
  phase: ModelDownloadPhase;
  /** Bytes transferred so far — a REAL count measured by the core, never estimated. */
  bytes: number;
  /** Total content length in bytes, or null until the core knows it (pre-headers). */
  totalBytes: number | null;
  /** True when this run resumed from a retained partial rather than starting at 0. */
  resumed: boolean;
  /** Human-readable failure reason; set only when `phase === 'error'`. */
  message?: string | null;
}

// ---------------------------------------------------------------------------
// .hpskill install / uninstall (P1-03.2) — mirrors ipc.rs SkillInstall*/SkillUninstall*
// ---------------------------------------------------------------------------
//
// camelCase wire names, same P1 convention as the marketplace block. The Rust core
// (`hpskill.rs`) verifies the downloaded `.hpskill` package's signature against the
// pinned trust set, re-validates the manifest, gates on host compatibility, extracts
// the sanitized assets to the app-data skills dir, and registers + persists the
// install. Fail-closed: on any failure nothing is written and the command REJECTS
// (surfaced as the rejected-promise `CmdError` string). The webview never handles
// package bytes — it passes the local `path` the downloader already fetched.

/** `skill_install` args — the local filesystem path of the fetched `.hpskill` archive. */
export interface SkillInstallArgs {
  path: string;
}

/**
 * `skill_install` result — the installed skill's id + resolved version, the on-disk
 * extraction dir, and its resulting lifecycle `state` (normally `"installed_disabled"`;
 * the composer enables it in a later step). `state` is the snake_case lifecycle label
 * from the Rust `state_label` (e.g. `"owned_not_installed"` | `"installed_disabled"` |
 * `"enabled_active"`).
 */
export interface SkillInstallResult {
  skillId: string;
  version: string;
  dir: string;
  state: string;
}

/**
 * `skill_download_install` args — the signed `.hpskill` blob URL `download_url`
 * returned (the purchase flow's bridge from P1-08.x commerce into this P1-03.2
 * install pipeline). The Rust core fetches the bytes itself (the webview CSP is
 * `connect-src 'self'`, so it cannot reach the blob URL) and installs them through
 * the SAME fail-closed pipeline `skill_install` (path-based) uses, returning the
 * SAME {@link SkillInstallResult} shape.
 */
export interface SkillDownloadInstallArgs {
  url: string;
}

/** `skill_uninstall` args — the skill id to remove (frees disk, keeps ownership; §11.3). */
export interface SkillUninstallArgs {
  skillId: string;
}

/** `skill_uninstall` result — the id and its resulting lifecycle state (normally `"owned_not_installed"`). */
export interface SkillUninstallResult {
  skillId: string;
  state: string;
}

// ---------------------------------------------------------------------------
// App auto-update (P1-11.2) — mirrors ipc.rs UpdatePhase / UpdateCheckResult
// ---------------------------------------------------------------------------
//
// `check_for_update` asks the Rust core (which owns `tauri-plugin-updater`) whether a
// newer SIGNED build is published at the configured endpoint and returns this typed
// status the update surface renders. camelCase wire names, same P1 convention.
//
// OFFLINE-SAFE (§18): the command NEVER rejects — a check that can't complete
// (offline, an unreachable endpoint, or the PLACEHOLDER endpoint/pubkey that ships
// until the update server + signing key are provisioned) resolves to `phase: 'error'`,
// so an update check can never block offline use. `args` is `void` (no input).

/** Which update state to render. `'error'` = the check couldn't complete (non-blocking, §18). */
export type UpdatePhase = 'upToDate' | 'updateAvailable' | 'downloading' | 'error';

export interface UpdateCheckResult {
  phase: UpdatePhase;
  /** The running app version — always present. */
  currentVersion: string;
  /** The newer version, set only when `phase === 'updateAvailable'` (or `'downloading'`). */
  availableVersion?: string;
  /** Optional release notes for the available update. */
  notes?: string;
  /** Diagnostic set only when `phase === 'error'` (rendered quietly, never alarmingly). */
  error?: string;
}

// ---------------------------------------------------------------------------
// Command / event maps — exhaustive typing for the IPC port (see ipc.port.ts)
// ---------------------------------------------------------------------------

/** `invoke(cmd, args) => Promise<result>` — request/response commands. */
export interface IpcCommandMap {
  tool_call: { args: ToolCallRequest; result: ToolCallResponse };
  inference_start: { args: InferenceStartArgs; result: void };
  inference_cancel: { args: InferenceCancelArgs; result: void };
  skill_enable: { args: SkillEnableArgs; result: SkillEnableResult };
  skill_disable: { args: SkillDisableArgs; result: void };
  timer_pause: { args: TimerControlArgs; result: TimerStateSnapshot };
  timer_resume: { args: TimerControlArgs; result: TimerStateSnapshot };
  timer_reset: { args: TimerControlArgs; result: TimerStateSnapshot };
  get_hardware_profile: { args: void; result: HardwareProfile };
  telemetry_log: { args: TelemetryEvent; result: void };
  notify: { args: NotifyArgs; result: void };

  // --- P1 marketplace + composition ---
  catalog_list: { args: CatalogListArgs; result: CatalogListResult };
  catalog_detail: { args: CatalogDetailArgs; result: SkillDetail };
  order_checkout: { args: OrderCheckoutArgs; result: OrderCheckoutResult };
  order_get: { args: OrderGetArgs; result: OrderGetResult };
  entitlements_get: { args: EntitlementsGetArgs; result: EntitlementsGetResult };
  license_fetch: { args: LicenseFetchArgs; result: LicenseFetchResult };
  download_url: { args: DownloadUrlArgs; result: DownloadUrlResult };
  compose_agent: { args: ComposeAgentArgs; result: ComposedAgentView };

  // --- P1 .hpskill install / uninstall (P1-03.2) ---
  skill_install: { args: SkillInstallArgs; result: SkillInstallResult };
  /** Fetch + install the signed `.hpskill` blob at `download_url`'s URL (P1-08.x purchase-flow bridge). */
  skill_download_install: { args: SkillDownloadInstallArgs; result: SkillInstallResult };
  skill_uninstall: { args: SkillUninstallArgs; result: SkillUninstallResult };

  // --- P1 app auto-update (P1-11.2) — offline-safe, never rejects (§18) ---
  check_for_update: { args: void; result: UpdateCheckResult };

  // --- P1 account / auth (P1-09.1/.2) + commerce handoff (P1-08.6/.8) ---
  auth_status: { args: AuthStatusArgs; result: AuthState };
  auth_register: { args: AuthRegisterArgs; result: AuthState };
  auth_login: { args: AuthLoginArgs; result: AuthState };
  auth_logout: { args: AuthLogoutArgs; result: AuthState };
  device_ensure: { args: DeviceEnsureArgs; result: AuthState };
  step_up_answer: { args: StepUpAnswerArgs; result: AuthState };
  entitlements_refresh: { args: EntitlementsRefreshArgs; result: EntitlementsGetResult };
  open_external: { args: OpenExternalArgs; result: void };

  // --- P1 on-demand model download (P1-02.7) ---
  /** Begin (or resume) a model download; the initial snapshot returns synchronously. */
  model_download_start: { args: ModelDownloadStartArgs; result: ModelDownloadStatus };
  /** Poll the current status — `null` when nothing has ever been started for this model. */
  model_download_status: { args: ModelDownloadStatusArgs; result: ModelDownloadStatus | null };
  /** Cancel an in-flight download (the core may retain a resumable partial). */
  model_download_cancel: { args: ModelDownloadCancelArgs; result: void };
}

export type IpcCommand = keyof IpcCommandMap;

/** `listen(event, cb)` — fire-and-forget, Rust-initiated pushes. */
export interface IpcEventMap {
  'inference://token': InferenceTokenEvent;
  'inference://tool_call_detected': InferenceToolCallDetectedEvent;
  'inference://tool_call_result': InferenceToolCallResultEvent;
  'inference://tool_call_fallback': InferenceToolCallFallbackEvent;
  'inference://done': InferenceDoneEvent;
  'inference://error': InferenceErrorEvent;
  'timer://tick': TimerTickEvent;
  'timer://finished': TimerFinishedEvent;
  'timer://updated': TimerStateSnapshot;
  /** Deep-link return from the system-browser checkout (P1-08.6). */
  'purchase://callback': PurchaseCallbackEvent;
  /** Streamed model-download progress (P1-02.7) — REAL byte counts, never estimated. */
  'model://progress': ModelDownloadStatus;
}

export type IpcEvent = keyof IpcEventMap;
