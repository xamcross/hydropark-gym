/**
 * Typed argument validation for the 3 fixed tools (P0-03.1, P0-04.1).
 * Mirrored in Rust at `client/src-tauri/src/tools.rs::validate_args`.
 *
 * Used on both the UI-first path (defensive — a widget bug should never
 * reach the tool with bad args) and the model path, where it's the thing
 * that decides "valid → execute" vs. "invalid → fallback, no repair loop"
 * (SPEC §8.4 pt 3, scoped down for Phase 0 per PHASE0-PLAN §3.3).
 */
import { ListManageArgs, StartTimerArgs, ConvertUnitsArgs, ToolArgsMap, ToolName, TOOL_NAMES } from '../ipc/contract';
import { UNIT_DOMAIN } from './unit-math';

export type ValidationResult<T> = { ok: true; args: T } | { ok: false; message: string };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function validateStartTimer(raw: unknown): ValidationResult<StartTimerArgs> {
  if (!isPlainObject(raw)) return { ok: false, message: 'arguments must be an object' };
  const { label, duration_sec } = raw as Record<string, unknown>;
  if (typeof label !== 'string' || label.trim().length === 0) {
    return { ok: false, message: '"label" must be a non-empty string' };
  }
  if (typeof duration_sec !== 'number' || !Number.isFinite(duration_sec) || duration_sec <= 0) {
    return { ok: false, message: '"duration_sec" must be a positive number' };
  }
  return { ok: true, args: { label, duration_sec: Math.round(duration_sec) } };
}

function validateConvertUnits(raw: unknown): ValidationResult<ConvertUnitsArgs> {
  if (!isPlainObject(raw)) return { ok: false, message: 'arguments must be an object' };
  const { domain, value, from_unit, to_unit } = raw as Record<string, unknown>;
  if (domain !== 'mass' && domain !== 'volume' && domain !== 'temperature') {
    return { ok: false, message: '"domain" must be mass | volume | temperature' };
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { ok: false, message: '"value" must be a number' };
  }
  if (typeof from_unit !== 'string' || typeof to_unit !== 'string') {
    return { ok: false, message: '"from_unit"/"to_unit" must be strings' };
  }
  if (UNIT_DOMAIN[from_unit as never] !== domain || UNIT_DOMAIN[to_unit as never] !== domain) {
    return { ok: false, message: `"from_unit"/"to_unit" must both belong to domain "${domain}"` };
  }
  return {
    ok: true,
    args: { domain, value, from_unit: from_unit as ConvertUnitsArgs['from_unit'], to_unit: to_unit as ConvertUnitsArgs['to_unit'] },
  };
}

function validateListManage(raw: unknown): ValidationResult<ListManageArgs> {
  if (!isPlainObject(raw)) return { ok: false, message: 'arguments must be an object' };
  const { op, item, items } = raw as Record<string, unknown>;
  const validOps = ['add', 'remove', 'check', 'uncheck', 'set_all'];
  if (typeof op !== 'string' || !validOps.includes(op)) {
    return { ok: false, message: `"op" must be one of ${validOps.join(', ')}` };
  }
  if (op === 'set_all') {
    if (!Array.isArray(items)) return { ok: false, message: '"items" must be an array for op=set_all' };
  } else if (op === 'add') {
    if (!isPlainObject(item) || typeof (item as Record<string, unknown>)['name'] !== 'string') {
      return { ok: false, message: '"item.name" is required for op=add' };
    }
  } else {
    if (!isPlainObject(item) || typeof (item as Record<string, unknown>)['id'] !== 'string') {
      return { ok: false, message: '"item.id" is required for op=' + op };
    }
  }
  return { ok: true, args: raw as unknown as ListManageArgs };
}

/** Restricts `name` to the 3-tool catalog and validates `arguments` against that tool's schema (P0-04.1). */
export function validateToolCall(
  name: unknown,
  args: unknown
): { ok: true; tool: ToolName; args: ToolArgsMap[ToolName] } | { ok: false; reason: 'unknown_tool' | 'invalid_args'; message: string; tool: ToolName | null } {
  if (typeof name !== 'string' || !TOOL_NAMES.includes(name as ToolName)) {
    return { ok: false, reason: 'unknown_tool', message: `"${String(name)}" is not a registered tool`, tool: null };
  }
  const tool = name as ToolName;
  let result: ValidationResult<ToolArgsMap[ToolName]>;
  switch (tool) {
    case 'start_timer':
      result = validateStartTimer(args) as ValidationResult<ToolArgsMap[ToolName]>;
      break;
    case 'convert_units':
      result = validateConvertUnits(args) as ValidationResult<ToolArgsMap[ToolName]>;
      break;
    case 'list_manage':
      result = validateListManage(args) as ValidationResult<ToolArgsMap[ToolName]>;
      break;
  }
  if (!result.ok) {
    return { ok: false, reason: 'invalid_args', message: result.message, tool };
  }
  return { ok: true, tool, args: result.args };
}
