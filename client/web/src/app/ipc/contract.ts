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

/** The fixed, hardcoded Phase-0 tool catalog. No manifest, no discovery. */
export type ToolName = 'start_timer' | 'convert_units' | 'list_manage';

export const TOOL_NAMES: readonly ToolName[] = [
  'start_timer',
  'convert_units',
  'list_manage',
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

// --- generic tool args/result map ------------------------------------------

export interface ToolArgsMap {
  start_timer: StartTimerArgs;
  convert_units: ConvertUnitsArgs;
  list_manage: ListManageArgs;
}

export interface ToolResultMap {
  start_timer: StartTimerResult;
  convert_units: ConvertUnitsResult;
  list_manage: ListManageResult;
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

export type TelemetryEvent =
  | SkillEnabledEvent
  | SkillDisabledEvent
  | TimerStartedEvent
  | ListEditedEvent
  | UnitsFlippedEvent
  | TokPerSecEvent
  | OutcomeEvent;

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
}

export type IpcEvent = keyof IpcEventMap;
