import { Injectable } from '@angular/core';
import {
  AuthState,
  CalculateArgs,
  CalculateResult,
  ComposedAgentView,
  ComposedRouteView,
  ComposedToolView,
  DateMathArgs,
  DateMathResult,
  DownloadUrlResult,
  EntitlementsGetResult,
  HardwareProfile,
  IngredientItem,
  IpcCommand,
  IpcCommandMap,
  IpcEvent,
  IpcEventMap,
  LicenseFetchResult,
  ListManageArgs,
  ListManageResult,
  ModelDownloadPhase,
  ModelDownloadStartArgs,
  ModelDownloadStatus,
  OrderCheckoutResult,
  OrderGetResult,
  SkillInstallResult,
  StartTimerArgs,
  TelemetryEvent,
  TemplateLoadResult,
  TemplateView,
  TimerStateSnapshot,
  ToolCallRequest,
  ToolCallResponse,
  ToolName,
  UpdateCheckResult,
} from './contract';
import { IpcPort, Unlisten } from './ipc.port';
import { convertUnitsExact, UnitConversionError } from '../tools/unit-math';
import { validateToolCall } from '../tools/tool-validation';

interface MockTimer {
  timer_id: string;
  label: string;
  duration_sec: number;
  remaining_sec: number;
  running: boolean;
  interval: ReturnType<typeof setInterval> | null;
}

/** One scripted "turn" of the mock inference brain — see `scriptTurn()` below. */
type ScriptStep =
  | { kind: 'text'; text: string }
  | { kind: 'tool_call_valid'; tool: ToolName; args: Record<string, unknown> }
  | { kind: 'tool_call_malformed'; raw: string };

/**
 * In-browser stand-in for the Rust core. Implements the exact same
 * `IpcPort` contract `TauriIpcService` does, so every Angular component
 * is written once and works against either. This is what makes
 * `ng serve` / `ng build` succeed with no llama.cpp, no GGUF, and no
 * compiled Rust anywhere (see client/README.md).
 *
 * Responsibilities simulated here (normally Rust's, per IPC-CONTRACT.md):
 *  - tool execution (start_timer / convert_units / list_manage)
 *  - timer countdown ticking (setInterval instead of a Tokio task)
 *  - a scripted token-stream "model" that occasionally emits a
 *    `<tool_call>` — including a deliberately malformed one, to exercise
 *    the P0-04.2 fallback path end-to-end without a real model
 *  - a JSONL telemetry sink (kept in memory + downloadable; a real file
 *    write is a Rust/filesystem responsibility)
 */
@Injectable()
export class MockIpcService extends IpcPort {
  private readonly listeners = new Map<IpcEvent, Set<(payload: unknown) => void>>();
  private readonly timers = new Map<string, MockTimer>();
  private ingredients: IngredientItem[] = [];
  private readonly cancelledSessions = new Set<string>();
  private readonly telemetryLog: TelemetryEvent[] = [];
  private itemSeq = 0;

  // --- simulated account + commerce state (P1-08/09) ---------------------
  private mockAuth: AuthState = { status: 'anonymous' };
  /** Seeded owned skills so "Restore purchases" has material to restore in the demo. */
  private readonly ownedSkills = new Set<string>(['packing-list', 'budget-planner']);
  /** In-flight orders → when they settle (so order_get flips pending→settled). */
  private readonly orders = new Map<string, { skillId: string; settleAt: number }>();

  // --- simulated on-demand model download (P1-02.7) ----------------------
  /** Active downloads → the live transfer state (stands in for the Rust range-download). */
  private readonly modelDownloads = new Map<
    string,
    { bytes: number; total: number; phase: ModelDownloadPhase; resumed: boolean; interval: ReturnType<typeof setInterval> | null }
  >();
  /** Retained partial byte offsets, so a cancelled/failed download can RESUME (real range behavior). */
  private readonly modelPartials = new Map<string, number>();

  // --- templates (Task 11a, SPEC §10) -------------------------------------
  /** In-memory "My Templates" gallery — save/list/load round-trip within a session. */
  private readonly templates = new Map<string, { view: TemplateView; uiOverrides: unknown; updatedAt: number }>();

  // ---- IpcPort ------------------------------------------------------------

  async invoke<K extends IpcCommand>(cmd: K, args: IpcCommandMap[K]['args']): Promise<IpcCommandMap[K]['result']> {
    switch (cmd) {
      case 'tool_call':
        return this.handleToolCall(args as ToolCallRequest) as IpcCommandMap[K]['result'];
      case 'inference_start':
        this.runInference(args as IpcCommandMap['inference_start']['args']);
        return undefined as IpcCommandMap[K]['result'];
      case 'inference_cancel':
        this.cancelledSessions.add((args as IpcCommandMap['inference_cancel']['args']).session_id);
        return undefined as IpcCommandMap[K]['result'];
      case 'skill_enable':
        return this.handleSkillEnable(args as IpcCommandMap['skill_enable']['args']) as IpcCommandMap[K]['result'];
      case 'skill_disable':
        return undefined as IpcCommandMap[K]['result'];
      case 'timer_pause':
        return this.setTimerRunning((args as { timer_id: string }).timer_id, false) as IpcCommandMap[K]['result'];
      case 'timer_resume':
        return this.setTimerRunning((args as { timer_id: string }).timer_id, true) as IpcCommandMap[K]['result'];
      case 'timer_reset':
        return this.resetTimer((args as { timer_id: string }).timer_id) as IpcCommandMap[K]['result'];
      case 'get_hardware_profile':
        return this.readHardwareProfile() as IpcCommandMap[K]['result'];
      case 'telemetry_log':
        this.telemetryLog.push(args as TelemetryEvent);
        // eslint-disable-next-line no-console
        console.debug('[telemetry]', JSON.stringify(args));
        return undefined as IpcCommandMap[K]['result'];
      case 'notify':
        this.showNotification(args as IpcCommandMap['notify']['args']);
        return undefined as IpcCommandMap[K]['result'];
      case 'compose_agent':
        return this.mockCompose(args as IpcCommandMap['compose_agent']['args']) as IpcCommandMap[K]['result'];

      // --- account / auth (P1-09.1/.2) ---
      case 'auth_status':
        return this.mockAuth as IpcCommandMap[K]['result'];
      case 'device_ensure':
        return this.ensureDevice() as IpcCommandMap[K]['result'];
      case 'auth_register': {
        const a = args as IpcCommandMap['auth_register']['args'];
        return this.authenticate(a.email, a.password) as IpcCommandMap[K]['result'];
      }
      case 'auth_login': {
        const a = args as IpcCommandMap['auth_login']['args'];
        return this.authenticate(a.email, a.password) as IpcCommandMap[K]['result'];
      }
      case 'step_up_answer':
        return this.answerStepUp() as IpcCommandMap[K]['result'];
      case 'auth_logout':
        return this.logoutAuth() as IpcCommandMap[K]['result'];

      // --- commerce (P1-08.5/.6/.8) ---
      case 'entitlements_get':
      case 'entitlements_refresh':
        return this.entitlements() as IpcCommandMap[K]['result'];
      case 'order_checkout':
        return this.orderCheckout(args as IpcCommandMap['order_checkout']['args']) as IpcCommandMap[K]['result'];
      case 'order_get':
        return this.orderGet(args as IpcCommandMap['order_get']['args']) as IpcCommandMap[K]['result'];
      case 'license_fetch':
        return this.licenseFetch(args as IpcCommandMap['license_fetch']['args']) as IpcCommandMap[K]['result'];
      case 'download_url':
        return this.downloadUrl(args as IpcCommandMap['download_url']['args']) as IpcCommandMap[K]['result'];
      case 'skill_download_install':
        return this.skillDownloadInstall(
          args as IpcCommandMap['skill_download_install']['args']
        ) as IpcCommandMap[K]['result'];
      case 'open_external':
        // No system browser to hand off to in the mock — the SystemBrowserService
        // uses window.open in the web build and never reaches this.
        return undefined as IpcCommandMap[K]['result'];

      // --- Task 10: install-time capability disclosure (SPEC §8.5 / §11) ---
      case 'capability_disclose':
        return this.capabilityDisclose(
          args as IpcCommandMap['capability_disclose']['args']
        ) as IpcCommandMap[K]['result'];

      // --- on-demand model download (P1-02.7) ---
      case 'model_download_start':
        return this.modelDownloadStart(args as ModelDownloadStartArgs) as IpcCommandMap[K]['result'];
      case 'model_download_status':
        return this.modelDownloadStatus((args as { modelId: string }).modelId) as IpcCommandMap[K]['result'];
      case 'model_download_cancel':
        this.modelDownloadCancel((args as { modelId: string }).modelId);
        return undefined as IpcCommandMap[K]['result'];

      // --- app auto-update (P1-11.2) ---
      case 'check_for_update': {
        // No update server in the browser mock; report a stable "up to date" so the
        // surface renders its resting state. The Rust core runs the real signed check.
        const status: UpdateCheckResult = { phase: 'upToDate', currentVersion: '0.1.0' };
        return status as IpcCommandMap[K]['result'];
      }

      // --- Task 11a: templates (save / list / load a named skill combination, SPEC §10) ---
      case 'template_save':
        return this.templateSave(args as IpcCommandMap['template_save']['args']) as IpcCommandMap[K]['result'];
      case 'template_list':
        return this.templateList() as IpcCommandMap[K]['result'];
      case 'template_load':
        return this.templateLoad(args as IpcCommandMap['template_load']['args']) as IpcCommandMap[K]['result'];

      default:
        throw new Error(`MockIpcService: unhandled command "${String(cmd)}"`);
    }
  }

  on<K extends IpcEvent>(event: K, handler: (payload: IpcEventMap[K]) => void): Unlisten {
    const set = this.listeners.get(event) ?? new Set();
    set.add(handler as (payload: unknown) => void);
    this.listeners.set(event, set);
    return () => set.delete(handler as (payload: unknown) => void);
  }

  private emit<K extends IpcEvent>(event: K, payload: IpcEventMap[K]): void {
    this.listeners.get(event)?.forEach((h) => h(payload));
  }

  /** Dev convenience: the JSONL a real build would have written to disk (P0-06.1). Not part of IpcPort — wired to a debug button in app.component. */
  downloadTelemetryLog(): void {
    const jsonl = this.telemetryLog.map((e) => JSON.stringify(e)).join('\n') + '\n';
    const blob = new Blob([jsonl], { type: 'application/x-ndjson' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `hydropark-session-${Date.now()}.jsonl`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ---- tool execution -------------------------------------------------------

  private handleToolCall(req: ToolCallRequest): ToolCallResponse {
    const validated = validateToolCall(req.tool, req.args);
    if (!validated.ok) {
      return {
        request_id: req.request_id,
        ok: false,
        tool: validated.tool,
        error: { code: validated.reason, message: validated.message },
      };
    }
    try {
      switch (validated.tool) {
        case 'start_timer':
          return {
            request_id: req.request_id,
            ok: true,
            tool: 'start_timer',
            result: this.startTimer(validated.args as StartTimerArgs),
          };
        case 'convert_units':
          return {
            request_id: req.request_id,
            ok: true,
            tool: 'convert_units',
            result: convertUnitsExact(validated.args as never),
          };
        case 'list_manage':
          return {
            request_id: req.request_id,
            ok: true,
            tool: 'list_manage',
            result: this.listManage(validated.args as ListManageArgs),
          };
        case 'calculate':
          return {
            request_id: req.request_id,
            ok: true,
            tool: 'calculate',
            result: this.calculate(validated.args as CalculateArgs),
          };
        case 'date_math':
          return {
            request_id: req.request_id,
            ok: true,
            tool: 'date_math',
            result: this.dateMath(validated.args as DateMathArgs),
          };
      }
    } catch (e) {
      const message = e instanceof UnitConversionError ? e.message : String(e);
      return { request_id: req.request_id, ok: false, tool: req.tool, error: { code: 'execution_error', message } };
    }
  }

  private startTimer(args: StartTimerArgs): { timer_id: string; label: string; duration_sec: number; started_at_ms: number } {
    const timer_id = crypto.randomUUID();
    const t: MockTimer = {
      timer_id,
      label: args.label,
      duration_sec: args.duration_sec,
      remaining_sec: args.duration_sec,
      running: true,
      interval: null,
    };
    this.timers.set(timer_id, t);
    this.armInterval(t);
    return { timer_id, label: t.label, duration_sec: t.duration_sec, started_at_ms: Date.now() };
  }

  private armInterval(t: MockTimer): void {
    if (t.interval) clearInterval(t.interval);
    t.interval = setInterval(() => {
      if (!t.running) return;
      t.remaining_sec = Math.max(0, t.remaining_sec - 1);
      this.emit('timer://tick', { timer_id: t.timer_id, remaining_sec: t.remaining_sec });
      if (t.remaining_sec === 0) {
        t.running = false;
        clearInterval(t.interval!);
        t.interval = null;
        this.emit('timer://finished', { timer_id: t.timer_id, label: t.label });
      }
    }, 1000);
  }

  private setTimerRunning(timer_id: string, running: boolean): TimerStateSnapshot {
    const t = this.timers.get(timer_id);
    if (!t) throw new Error(`unknown timer ${timer_id}`);
    t.running = running && t.remaining_sec > 0;
    if (t.running) this.armInterval(t);
    else if (t.interval) {
      clearInterval(t.interval);
      t.interval = null;
    }
    const snap = this.snapshotTimer(t);
    this.emit('timer://updated', snap);
    return snap;
  }

  private resetTimer(timer_id: string): TimerStateSnapshot {
    const t = this.timers.get(timer_id);
    if (!t) throw new Error(`unknown timer ${timer_id}`);
    t.remaining_sec = t.duration_sec;
    t.running = false;
    if (t.interval) {
      clearInterval(t.interval);
      t.interval = null;
    }
    const snap = this.snapshotTimer(t);
    this.emit('timer://updated', snap);
    return snap;
  }

  private snapshotTimer(t: MockTimer): TimerStateSnapshot {
    return { timer_id: t.timer_id, label: t.label, duration_sec: t.duration_sec, remaining_sec: t.remaining_sec, running: t.running };
  }

  private nextItemId(): string {
    this.itemSeq += 1;
    return `item_${this.itemSeq}`;
  }

  private listManage(args: ListManageArgs): ListManageResult {
    switch (args.op) {
      case 'add': {
        const item: IngredientItem = {
          id: this.nextItemId(),
          name: args.item!.name!,
          qty: args.item?.qty,
          unit: args.item?.unit,
          checked: false,
        };
        this.ingredients = [...this.ingredients, item];
        break;
      }
      case 'remove':
        this.ingredients = this.ingredients.filter((i) => i.id !== args.item!.id);
        break;
      case 'check':
        this.ingredients = this.ingredients.map((i) => (i.id === args.item!.id ? { ...i, checked: true } : i));
        break;
      case 'uncheck':
        this.ingredients = this.ingredients.map((i) => (i.id === args.item!.id ? { ...i, checked: false } : i));
        break;
      case 'set_all':
        this.ingredients = (args.items ?? []).map((i) => ({ ...i, id: i.id ?? this.nextItemId() }));
        break;
    }
    return { ingredients: this.ingredients };
  }

  // ---- stateless catalog tools (P1-05.1) --------------------------------
  //
  // Pure execution mirroring `tool_catalog::run_calculate` / `run_date_math`
  // (same closed ops, same divide-by-zero / out-of-range failures). Thrown
  // errors are surfaced as a structured `execution_error` by the caller's catch.

  private calculate(args: CalculateArgs): CalculateResult {
    let acc = args.operands[0];
    for (let i = 1; i < args.operands.length; i++) {
      const x = args.operands[i];
      switch (args.op) {
        case 'add':
          acc += x;
          break;
        case 'sub':
          acc -= x;
          break;
        case 'mul':
          acc *= x;
          break;
        case 'div':
          if (x === 0) throw new Error('division by zero');
          acc /= x;
          break;
      }
    }
    if (!Number.isFinite(acc)) throw new Error(`result is not a finite number (${acc})`);
    return { value: acc };
  }

  private dateMath(args: DateMathArgs): DateMathResult {
    const base = new Date(args.base);
    if (Number.isNaN(base.getTime())) throw new Error('base is not a valid date-time');
    const days = args.delta.days ?? 0;
    const hours = args.delta.hours ?? 0;
    const minutes = args.delta.minutes ?? 0;
    const totalMinutes = days * 24 * 60 + hours * 60 + minutes;
    const signed = args.op === 'sub' ? -totalMinutes : totalMinutes;
    const out = new Date(base.getTime() + signed * 60_000);
    if (Number.isNaN(out.getTime())) throw new Error('resulting date is out of range');
    return { result: out.toISOString() };
  }

  // ---- skill lifecycle --------------------------------------------------

  private handleSkillEnable(args: IpcCommandMap['skill_enable']['args']): IpcCommandMap['skill_enable']['result'] {
    return {
      skill_id: args.skill_id,
      persona_injected: true,
      tools_registered: ['start_timer', 'convert_units', 'list_manage'],
      panels: ['timer_stack', 'editable_list', 'segmented_toggle'],
    };
  }

  // ---- capability disclosure (Task 10, SPEC §8.5 / §11) -----------------
  //
  // Mirrors `tool_routing::disclose` / `Capability::disclosure_phrase` on the
  // Rust side EXACTLY (same v1 closed set, same phrases, same error text) so
  // the install-time trust surface behaves identically under `ng serve` and a
  // real Tauri build. The Rust core is the source of truth; this is a copy.

  private capabilityDisclose(args: IpcCommandMap['capability_disclose']['args']): string {
    const caps = args.capabilities;
    for (const c of caps) {
      if (!(c in CAPABILITY_PHRASES)) {
        const allowed = Object.keys(CAPABILITY_PHRASES).join(', ');
        throw new Error(
          `invalid arguments: capability '${c}' is not in the v1 allowed set (${allowed}); ` +
            'skills have no network/file/system capabilities in v1'
        );
      }
    }
    if (caps.length === 0) return 'This skill uses no special capabilities.';
    return `This skill can: ${caps.map((c) => CAPABILITY_PHRASES[c]).join(', ')}`;
  }

  // ---- templates (Task 11a, SPEC §10) ------------------------------------
  //
  // Save/list/load a named skill combination — the "Weeknight Chef" B2 demo
  // beat. Unlike the real Rust core, this mock has no separate "installed
  // skills" registry with per-skill versions to resolve a load against, so a
  // template saved through this mock session is always resolvable when
  // reloaded (the browser demo never truly uninstalls a skill) — only an
  // unknown template id rejects, mirroring the real command's caller-error
  // case. The missing-skill/reinstall UI path (Task 11b) is exercised
  // against a hand-rolled `IpcPort` test double in that task's own specs.

  /** Mirrors Rust `templates::template_id`'s slug rule: lowercase alnum runs
   * joined by a single `_`, trimmed, falling back to `untitled` when empty. */
  private templateSlug(name: string): string {
    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
    return `tmpl_${slug || 'untitled'}`;
  }

  private templateSave(args: IpcCommandMap['template_save']['args']): TemplateView {
    const view: TemplateView = {
      id: this.templateSlug(args.name),
      name: args.name,
      skill_refs: args.skill_refs.map(([skillId]) => skillId),
      base_model: args.base_model,
    };
    this.templates.set(view.id, { view, uiOverrides: args.ui_overrides, updatedAt: Date.now() });
    return view;
  }

  private templateList(): TemplateView[] {
    return [...this.templates.values()].sort((a, b) => b.updatedAt - a.updatedAt).map((t) => t.view);
  }

  /**
   * Resolve a saved template's `skill_refs` against a real "is it actually
   * available" check, so the missing-skill/reinstall gallery UI (Task 11b) is
   * demoable live under `ng serve`, not only in that task's own hand-rolled
   * IpcPort test doubles (see the file-header note above and Task 11a's
   * report, concern #2).
   *
   * `ownedSkills` is the mock's MARKETPLACE entitlement registry (P1-08/09 —
   * what "Restore purchases" reconciles against), so it is the right thing to
   * check a marketplace skill id against. It deliberately does NOT gate
   * `kitchen-timer` / `cooking-assistant`: those are the two P0 skills that
   * ship WITH the app and are gated by their own, separate seams
   * (`SessionService.kitchenSkillEnabled` / `UnlockService`) — folding them
   * into the marketplace entitlement set would misrepresent them elsewhere
   * (e.g. `entitlements()` / restore-purchases would start reporting them as
   * purchased marketplace SKUs, which they are not). Today's real save flow
   * (Task 11b's `TemplatesService`) only ever names those two ids, so they
   * always resolve — exactly like the real Rust store, where they are always
   * "installed". Any OTHER skill id a template names is checked for real
   * against `ownedSkills`, so a template referencing one that was never
   * bought/installed (or has since been "uninstalled" in this session) shows
   * the missing-skill path.
   */
  private templateLoad(args: IpcCommandMap['template_load']['args']): TemplateLoadResult {
    const saved = this.templates.get(args.id);
    if (!saved) {
      // Mirrors the Rust core: an unknown template id rejects (not a
      // structured `ok: false` — that shape is reserved for a resolvable
      // template with an unresolvable skill, SPEC §10).
      throw new Error(`no such template: ${args.id}`);
    }
    const missing = saved.view.skill_refs.filter(
      (id) => !ALWAYS_RESOLVABLE_P0_SKILLS.has(id) && !this.ownedSkills.has(id)
    );
    if (missing.length > 0) {
      return { ok: false, skill_ids: [], ui_overrides: null, missing_skills: missing };
    }
    return { ok: true, skill_ids: saved.view.skill_refs, ui_overrides: saved.uiOverrides, missing_skills: [] };
  }

  // ---- simulated account + commerce (P1-08/09) --------------------------
  //
  // A minimal in-memory stand-in for the Rust auth/commerce commands so the full
  // purchase + restore loop runs under `ng serve` with no backend. The Rust core
  // replaces every method here.

  private token(prefix: string): string {
    return `${prefix}_${crypto.randomUUID().slice(0, 12)}`;
  }

  /** No-email identity: mint/return a device-scoped account that can buy. */
  private ensureDevice(): AuthState {
    const deviceId = this.mockAuth.deviceId ?? this.token('dev');
    if (this.mockAuth.status === 'anonymous') {
      this.mockAuth = { status: 'device', deviceId, accessToken: this.token('tok'), email: null, stepUp: null };
    } else {
      this.mockAuth = { ...this.mockAuth, deviceId };
    }
    return this.mockAuth;
  }

  /** Email account: authenticate — or raise a step-up challenge for `+2fa` emails. */
  private authenticate(email: string | undefined, _password: string | undefined): AuthState {
    const deviceId = this.mockAuth.deviceId ?? this.token('dev');
    if (email && /\+2fa@/i.test(email)) {
      this.mockAuth = {
        status: this.mockAuth.status === 'anonymous' ? 'device' : this.mockAuth.status,
        deviceId,
        email,
        accessToken: this.mockAuth.accessToken ?? this.token('tok'),
        stepUp: {
          challengeId: this.token('ch'),
          kind: 'email_code',
          prompt: 'Enter the 6-digit code we emailed you (any digits work in this demo).',
        },
      };
      return this.mockAuth;
    }
    this.mockAuth = {
      status: 'authenticated',
      deviceId,
      userId: this.token('usr'),
      email: email ?? null,
      accessToken: this.token('tok'),
      stepUp: null,
    };
    return this.mockAuth;
  }

  private answerStepUp(): AuthState {
    this.mockAuth = {
      status: 'authenticated',
      deviceId: this.mockAuth.deviceId ?? this.token('dev'),
      userId: this.mockAuth.userId ?? this.token('usr'),
      email: this.mockAuth.email ?? null,
      accessToken: this.mockAuth.accessToken ?? this.token('tok'),
      stepUp: null,
    };
    return this.mockAuth;
  }

  /** Logout drops the account but keeps the device identity (purchases stay reachable). */
  private logoutAuth(): AuthState {
    this.mockAuth = this.mockAuth.deviceId
      ? { status: 'device', deviceId: this.mockAuth.deviceId, accessToken: this.token('tok'), email: null, stepUp: null }
      : { status: 'anonymous' };
    return this.mockAuth;
  }

  private entitlements(): EntitlementsGetResult {
    return { skills: [...this.ownedSkills].map((skillId) => ({ skillId, state: 'owned', version: '1.0.0' })) };
  }

  private orderCheckout(args: IpcCommandMap['order_checkout']['args']): OrderCheckoutResult {
    const orderId = this.token('ord');
    this.orders.set(orderId, { skillId: args.targetId, settleAt: Date.now() + 1400 });
    // Simulate the buyer finishing in the system browser: the deep-link callback
    // returns ~1.5s later, racing the client's order_get poll — either settles it.
    setTimeout(() => {
      this.ownedSkills.add(args.targetId);
      this.emit('purchase://callback', {
        orderId,
        skillId: args.targetId,
        status: 'settled',
        raw: `purchase://callback?orderId=${orderId}&status=settled`,
      });
    }, 1500);
    return { orderId, checkoutUrl: `https://checkout.hydropark.app/session/${orderId}` };
  }

  private orderGet(args: IpcCommandMap['order_get']['args']): OrderGetResult {
    const order = this.orders.get(args.orderId);
    if (!order) return { orderId: args.orderId, status: 'unknown' };
    if (Date.now() >= order.settleAt) {
      this.ownedSkills.add(order.skillId);
      return { orderId: args.orderId, status: 'settled' };
    }
    return { orderId: args.orderId, status: 'pending' };
  }

  private licenseFetch(args: IpcCommandMap['license_fetch']['args']): LicenseFetchResult {
    // A structurally-plausible compact-JWS placeholder — never a real signature.
    return { compactJws: `eyJhbGciOiJFUzI1NiJ9.${this.token('lic')}.${this.token('sig')}` };
  }

  private downloadUrl(args: IpcCommandMap['download_url']['args']): DownloadUrlResult {
    return {
      url: `https://cdn.hydropark.app/skills/${args.skillId}/${args.version}.hpskill`,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      watermark: this.token('wm'),
    };
  }

  /**
   * No real Rust core / package bytes in the browser mock — simulate the same
   * success shape the REAL `skill_download_install` command returns (fetch +
   * `SkillInstaller::install_bytes` in `hpskill.rs`) so the demo purchase flow
   * completes end-to-end. Recovers `skillId`/`version` from the URL `downloadUrl()`
   * above minted (`.../skills/{id}/{version}.hpskill`) rather than trusting an
   * opaque blob URL, mirroring how the real command only trusts the manifest
   * INSIDE the fetched bytes, never the URL.
   */
  private skillDownloadInstall(args: IpcCommandMap['skill_download_install']['args']): SkillInstallResult {
    const match = /\/skills\/([^/]+)\/([^/]+)\.hpskill(?:$|\?)/.exec(args.url);
    const skillId = match?.[1] ?? 'mock-skill';
    const version = match?.[2] ?? '1.0.0';
    return { skillId, version, dir: `mock://skills/${skillId}`, state: 'installed_disabled' };
  }

  // ---- agent composition (mirrors client/src-tauri/src/composition.rs) ----
  //
  // A lightweight stand-in for the Rust `compose_agent` pipeline so the compose
  // experience runs under `ng serve` with no core: order by combine_priority,
  // assemble a persona, union tools, project routing, and run the capacity gate.
  // It intentionally MIRRORS the Rust view shape (composition.rs `to_view`).

  private mockCompose(args: IpcCommandMap['compose_agent']['args']): ComposedAgentView {
    const manifests = (args.manifests ?? []) as MockManifest[];
    const nCtx = args.nCtx ?? 4096;

    // Order: combine_priority desc, then id asc. Primary = hint (if enabled) else the lead.
    const ordered = [...manifests].sort((a, b) => {
      const pa = a.compatibility?.combine_priority ?? 0;
      const pb = b.compatibility?.combine_priority ?? 0;
      if (pa !== pb) return pb - pa;
      return (a.id ?? '').localeCompare(b.id ?? '');
    });
    const order = ordered.map((m) => m.id ?? '<unknown>');
    const hint = args.primaryHint && order.includes(args.primaryHint) ? args.primaryHint : null;
    const primary = hint ?? order[0] ?? null;

    // Persona: base + primary's full prompt + secondaries' compressed form.
    const primaryManifest = ordered.find((m) => (m.id ?? '') === primary);
    const parts = [MOCK_BASE_PREAMBLE];
    if (primaryManifest) parts.push(primaryManifest.persona?.system_prompt ?? primaryManifest.summary ?? '');
    for (const m of ordered) {
      if ((m.id ?? '') === primary) continue;
      const c = m.persona?.compressed_prompt ?? m.summary;
      if (c) parts.push(c);
    }
    const persona = parts.filter((p) => p).join('\n\n');

    // Tools: union by ref (equal first-party config ⇒ shared, not namespaced here).
    const toolMap = new Map<string, ComposedToolView>();
    const routing: ComposedRouteView[] = [];
    for (const m of ordered) {
      const boundWidget = new Map<string, string>();
      for (const p of m.ui?.panels ?? []) {
        if (p.binds_tool && p.id) boundWidget.set(p.binds_tool, p.id);
      }
      for (const t of m.tools ?? []) {
        const ref = t.ref ?? '';
        if (!ref) continue;
        const existing = toolMap.get(ref);
        if (existing) existing.contributors.push(m.id ?? '');
        else toolMap.set(ref, { call_name: ref, tool_ref: ref, contributors: [m.id ?? ''], namespaced: false });
        const writes = t.writes_state ?? [];
        const widget = boundWidget.get(ref);
        routing.push({
          tool_ref: ref,
          reads: t.reads_state ?? [],
          writes,
          target: writes.length === 0 && widget ? `widget:${widget}` : 'chat',
        });
      }
    }

    // Capacity gate (rough token estimate; blocks on overflow like the Rust gate).
    const reserve = 512;
    const skillTokens = ordered.reduce(
      (sum, m) => sum + (m.cost_estimate?.prompt_tokens ?? Math.ceil((m.persona?.system_prompt ?? m.summary ?? '').length / 4)),
      0
    );
    const used = reserve + skillTokens;
    const blocked = used > nCtx;

    return {
      order,
      primary,
      persona,
      tools: [...toolMap.values()],
      routing,
      capacity: {
        ctx_window: nCtx,
        reserve_tokens: reserve,
        skill_tokens: skillTokens,
        used_tokens: used,
        remaining: Math.max(0, nCtx - used),
        blocked,
        overflow: blocked ? used - nCtx : 0,
      },
    };
  }

  // ---- on-demand model download (P1-02.7) --------------------------------
  //
  // A believable stand-in for the Rust range-downloader: streams REAL (simulated)
  // byte counts on `model://progress`, retains a resumable partial on cancel, runs
  // a short verify phase, then completes. The whole resumable download + cancel
  // loop is demonstrable under `ng serve` with no core. The Rust core replaces
  // every method here (it measures actual transferred bytes + SHA-256 verifies).

  /** The content-length the real core would read from the response headers. */
  private modelTotalBytes(modelId: string): number {
    const KNOWN: Record<string, number> = { 'qwen2.5-7b-instruct-q4km': 4_680_000_000 };
    return KNOWN[modelId] ?? 4_680_000_000;
  }

  private modelDownloadStart(args: ModelDownloadStartArgs): ModelDownloadStatus {
    const { modelId } = args;
    const total = this.modelTotalBytes(modelId);
    const existing = this.modelDownloads.get(modelId);
    if (existing && existing.phase === 'downloading') {
      return { modelId, phase: 'downloading', bytes: existing.bytes, totalBytes: existing.total, resumed: existing.resumed };
    }

    const resumeFrom = args.resume === false ? 0 : this.modelPartials.get(modelId) ?? 0;
    const resumed = resumeFrom > 0;
    const d = { bytes: resumeFrom, total, phase: 'downloading' as ModelDownloadPhase, resumed, interval: null as ReturnType<typeof setInterval> | null };
    this.modelDownloads.set(modelId, d);
    this.modelPartials.delete(modelId);

    // ~40 ticks of real byte deltas → a demonstrable multi-second transfer.
    const chunk = Math.max(1, Math.ceil(total / 40));
    d.interval = setInterval(() => {
      d.bytes = Math.min(d.total, d.bytes + chunk);
      if (d.bytes >= d.total) {
        if (d.interval) clearInterval(d.interval);
        d.interval = null;
        d.phase = 'verifying';
        this.emit('model://progress', { modelId, phase: 'verifying', bytes: d.total, totalBytes: d.total, resumed });
        setTimeout(() => {
          this.modelDownloads.delete(modelId);
          this.modelPartials.delete(modelId);
          this.emit('model://progress', { modelId, phase: 'complete', bytes: total, totalBytes: total, resumed });
        }, 700);
      } else {
        this.emit('model://progress', { modelId, phase: 'downloading', bytes: d.bytes, totalBytes: d.total, resumed });
      }
    }, 220);

    return { modelId, phase: 'downloading', bytes: d.bytes, totalBytes: d.total, resumed };
  }

  private modelDownloadStatus(modelId: string): ModelDownloadStatus | null {
    const d = this.modelDownloads.get(modelId);
    if (d) return { modelId, phase: d.phase, bytes: d.bytes, totalBytes: d.total, resumed: d.resumed };
    const partial = this.modelPartials.get(modelId);
    if (partial && partial > 0) return { modelId, phase: 'paused', bytes: partial, totalBytes: this.modelTotalBytes(modelId), resumed: false };
    return null;
  }

  private modelDownloadCancel(modelId: string): void {
    const d = this.modelDownloads.get(modelId);
    if (!d) return;
    if (d.interval) clearInterval(d.interval);
    this.modelDownloads.delete(modelId);
    // Retain the partial so a later resume picks up where this left off.
    this.modelPartials.set(modelId, d.bytes);
    this.emit('model://progress', { modelId, phase: 'cancelled', bytes: d.bytes, totalBytes: d.total, resumed: d.resumed });
  }

  // ---- hardware profiling (P0-02.3, read-only) ---------------------------

  private readHardwareProfile(): HardwareProfile {
    const nav = navigator as Navigator & { deviceMemory?: number };
    let gpu_present = false;
    try {
      const canvas = document.createElement('canvas');
      gpu_present = !!(canvas.getContext('webgl2') || canvas.getContext('webgl'));
    } catch {
      gpu_present = false;
    }
    return {
      ram_gb: nav.deviceMemory ?? 8,
      cores: navigator.hardwareConcurrency ?? 4,
      gpu_present,
    };
  }

  // ---- notifications (P0-05.4) -------------------------------------------

  private showNotification(args: IpcCommandMap['notify']['args']): void {
    if (typeof Notification === 'undefined') return;
    if (Notification.permission === 'granted') {
      new Notification(args.title, { body: args.body });
      return;
    }
    if (Notification.permission !== 'denied') {
      Notification.requestPermission().then((perm) => {
        if (perm === 'granted') new Notification(args.title, { body: args.body });
      });
    }
    // If denied: silently no-op here. The in-app fallback (a system chat
    // line + toast) is rendered unconditionally by timer-stack.component on
    // `timer://finished`, independent of OS notification permission — see
    // SPEC §9.7 "degrades to an in-app alert if denied".
  }

  // ---- mock inference (interface behind which a real llama.cpp stream
  //      would sit — see client/src-tauri/src/inference.rs) -----------------

  private async runInference(args: IpcCommandMap['inference_start']['args']): Promise<void> {
    const { session_id, user_message, skill_id } = args;
    this.cancelledSessions.delete(session_id);
    const steps = this.scriptTurn(user_message, skill_id === 'kitchen-timer');
    const start = performance.now();
    let seq = 0;
    let tokenCount = 0;

    for (const step of steps) {
      if (this.cancelledSessions.has(session_id)) break;

      if (step.kind === 'text') {
        const words = step.text.split(/(\s+)/).filter((w) => w.length > 0);
        for (const w of words) {
          if (this.cancelledSessions.has(session_id)) break;
          await sleep(18 + Math.random() * 24);
          tokenCount += 1;
          this.emit('inference://token', { session_id, seq: seq++, token: w });
        }
      } else if (step.kind === 'tool_call_valid') {
        await sleep(120);
        this.emit('inference://tool_call_detected', {
          session_id,
          raw: `<tool_call>${JSON.stringify({ name: step.tool, arguments: step.args })}</tool_call>`,
          tool: step.tool,
          parsed_args: step.args,
          valid: true,
        });
        const resp = this.handleToolCall({ request_id: crypto.randomUUID(), tool: step.tool, args: step.args as never, source: 'model' });
        if (resp.ok) {
          this.emit('inference://tool_call_result', { session_id, tool: resp.tool, result: resp.result });
        }
      } else if (step.kind === 'tool_call_malformed') {
        await sleep(120);
        const parsed = tryParseToolCall(step.raw);
        const validated = parsed ? validateToolCall(parsed.name, parsed.arguments) : null;
        this.emit('inference://tool_call_detected', {
          session_id,
          raw: step.raw,
          tool: validated?.tool ?? (parsed?.name as ToolName) ?? null,
          parsed_args: (parsed?.arguments as Record<string, unknown>) ?? null,
          valid: false,
        });
        this.emit('inference://tool_call_fallback', {
          session_id,
          reason: !parsed ? 'malformed_json' : validated && !validated.ok ? validated.reason : 'invalid_args',
          tool: (validated?.tool ?? null) as ToolName | null,
          parsed_args: (parsed?.arguments as Record<string, unknown>) ?? null,
          clarifying_question:
            parsed?.name && ['start_timer', 'convert_units', 'list_manage'].includes(parsed.name)
              ? null
              : 'Could you tell me what you would like me to do — start a timer, update the ingredient list, or convert a unit?',
        });
      }
    }

    const elapsed_ms = performance.now() - start;
    const tok_per_sec = tokenCount > 0 ? Math.round((tokenCount / (elapsed_ms / 1000)) * 10) / 10 : 0;
    this.emit('inference://done', { session_id, tokens_generated: tokenCount, elapsed_ms, tok_per_sec });
  }

  /** The scripted "brain" — see file header. Real inference.rs replaces this whole method. */
  private scriptTurn(userMessage: string, skillEnabled: boolean): ScriptStep[] {
    const msg = userMessage.toLowerCase();

    if (!skillEnabled) {
      return [
        {
          kind: 'text',
          text:
            "I'm the base Hydropark agent — I can chat, but I don't have cooking tools yet. " +
            'Enable "Kitchen Timer & Units" above and ask me again — I\'ll be able to start timers, ' +
            'build an ingredient list, and convert units for you.',
        },
      ];
    }

    if (msg.includes('confuse') || msg.includes('gibberish')) {
      return [
        { kind: 'text', text: "Hmm, let me think about how to help with that." },
        { kind: 'tool_call_malformed', raw: '<tool_call>{not valid json at all' },
      ];
    }

    if (msg.includes('unknown tool') || msg.includes('random tool')) {
      return [
        { kind: 'text', text: 'One moment —' },
        {
          kind: 'tool_call_malformed',
          raw: '<tool_call>{"name":"delete_everything","arguments":{}}</tool_call>',
        },
      ];
    }

    if (msg.includes('surprise')) {
      return [
        { kind: 'text', text: 'Sure, let me set that up for you —' },
        { kind: 'tool_call_malformed', raw: '<tool_call>{"name":"start_timer","arguments":{"label":"Mystery"}}</tool_call>' },
        { kind: 'text', text: "I've prefilled a timer below — just tell me how long to set it for." },
      ];
    }

    if (msg.includes('carbonara')) {
      return [
        { kind: 'text', text: "Great choice! Let's cook carbonara for 4. Here's what you'll need —" },
        {
          kind: 'tool_call_valid',
          tool: 'list_manage',
          args: {
            op: 'set_all',
            items: [
              { name: 'Spaghetti', qty: 400, unit: 'g', checked: false },
              { name: 'Guanciale (or pancetta)', qty: 150, unit: 'g', checked: false },
              { name: 'Egg yolks', qty: 4, checked: false },
              { name: 'Whole egg', qty: 1, checked: false },
              { name: 'Pecorino Romano, grated', qty: 50, unit: 'g', checked: false },
              { name: 'Black pepper', checked: false },
            ],
          },
        },
        {
          kind: 'text',
          text:
            "I've filled in the ingredient list — flip to Metric or US anytime, it re-converts everything " +
            'exactly (e.g. {{q:150:g}} of guanciale, {{q:50:g}} of pecorino). Starting the pasta timer now —',
        },
        { kind: 'tool_call_valid', tool: 'start_timer', args: { label: 'Pasta', duration_sec: 9 * 60 } },
        {
          kind: 'text',
          text: "Pasta timer is running (9:00). I'll ping you when it's done — want a sauce timer too?",
        },
      ];
    }

    return [
      {
        kind: 'text',
        text:
          'Kitchen Timer & Units is on — try "Help me cook carbonara for 4" to see the full flow, or ' +
          'tap "+ timer", edit the list, or flip US/Metric yourself any time.',
      },
    ];
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The loose shape `mockCompose` reads out of the opaque manifest JSON. */
interface MockManifest {
  id?: string;
  summary?: string;
  persona?: { system_prompt?: string; compressed_prompt?: string };
  tools?: Array<{ ref?: string; reads_state?: string[]; writes_state?: string[] }>;
  ui?: { panels?: Array<{ type?: string; id?: string; binds_tool?: string }> };
  compatibility?: { combine_priority?: number };
  cost_estimate?: { prompt_tokens?: number };
}

/** The v1 closed capability set's plain-language phrase, mirroring Rust
 * `Capability::disclosure_phrase` (`tool_routing.rs`) verbatim. */
const CAPABILITY_PHRASES: Record<string, string> = {
  timers: 'set timers',
  unit_conversion: 'convert units',
  list_management: 'manage a list',
  calculation: 'do calculations',
  date_math: 'do date math',
};

/** The two P0 skills ship with the app itself — see `templateLoad`'s doc comment above. */
const ALWAYS_RESOLVABLE_P0_SKILLS = new Set<string>(['kitchen-timer', 'cooking-assistant']);

/** Mirrors `composition.rs` BASE_PREAMBLE (the base agent's voice). */
const MOCK_BASE_PREAMBLE =
  'You are Hydropark, a private assistant that runs fully on-device. You are offline and never ' +
  'send the conversation anywhere. Be helpful, concise, and honest.';

function tryParseToolCall(raw: string): { name: string; arguments: unknown } | null {
  const match = raw.match(/<tool_call>([\s\S]*?)<\/tool_call>/);
  const jsonText = match ? match[1] : raw;
  try {
    const parsed = JSON.parse(jsonText);
    if (typeof parsed === 'object' && parsed && 'name' in parsed) {
      return parsed as { name: string; arguments: unknown };
    }
    return null;
  } catch {
    return null;
  }
}
