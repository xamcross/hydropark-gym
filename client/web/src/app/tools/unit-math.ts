/**
 * Deterministic, exact unit conversion — the arithmetic behind the
 * `convert_units` tool. This table is mirrored byte-for-byte in Rust at
 * `client/src-tauri/src/tools.rs`; if you change a constant here, change it
 * there too (see the comment block at the top of that file).
 *
 * Constants are the internationally-defined exact conversion factors (not
 * approximations), which is what SPEC's H2 gate ("≥98% exact on unit
 * conversions") assumes the deterministic layer provides for free — the
 * model never does this arithmetic itself.
 *
 * Used two ways in the mock build:
 *  1. By `MockIpcService`'s `convert_units` tool handler (the IPC path
 *     bound to `segmented_toggle` and to `list_manage` quantities).
 *  2. Directly by the `chat` widget to re-express inline `{{q:…}}`
 *     quantity tokens when the unit system flips, so chat text and the
 *     ingredient list are provably using the same arithmetic, not two
 *     tables that can drift apart.
 */
import { ConvertUnitsArgs, ConvertUnitsResult, UnitDomain, UnitId, UnitSystem } from '../ipc/contract';

const MASS_TO_GRAMS: Record<string, number> = {
  g: 1,
  kg: 1000,
  oz: 28.349523125, // exact: international avoirdupois ounce
  lb: 453.59237, // exact: international avoirdupois pound
};

const VOLUME_TO_ML: Record<string, number> = {
  ml: 1,
  l: 1000,
  tsp: 4.92892159375, // exact: US legal teaspoon
  tbsp: 14.78676478125, // exact: 3 tsp
  fl_oz: 29.5735295625, // exact: US fluid ounce
  cup: 236.5882365, // exact: US legal cup (8 US fl oz)
};

export const UNIT_DOMAIN: Record<UnitId, UnitDomain> = {
  g: 'mass',
  kg: 'mass',
  oz: 'mass',
  lb: 'mass',
  ml: 'volume',
  l: 'volume',
  tsp: 'volume',
  tbsp: 'volume',
  fl_oz: 'volume',
  cup: 'volume',
  c: 'temperature',
  f: 'temperature',
};

/** Which unit system (US ↔ Metric toggle, SPEC §8.7) each unit belongs to. */
export const UNIT_SYSTEM: Record<UnitId, UnitSystem> = {
  g: 'Metric',
  kg: 'Metric',
  ml: 'Metric',
  l: 'Metric',
  c: 'Metric',
  oz: 'US',
  lb: 'US',
  tsp: 'US',
  tbsp: 'US',
  fl_oz: 'US',
  cup: 'US',
  f: 'US',
};

export class UnitConversionError extends Error {}

/** Round to a sane display precision without hiding the exactness of the arithmetic. */
function roundExact(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function convertLinear(table: Record<string, number>, value: number, from: string, to: string): number {
  const fromFactor = table[from];
  const toFactor = table[to];
  if (fromFactor === undefined || toFactor === undefined) {
    throw new UnitConversionError(`unsupported unit in this domain: ${from} -> ${to}`);
  }
  const base = value * fromFactor;
  return roundExact(base / toFactor);
}

function convertTemperature(value: number, from: UnitId, to: UnitId): number {
  if (from === to) return roundExact(value);
  if (from === 'c' && to === 'f') return roundExact((value * 9) / 5 + 32);
  if (from === 'f' && to === 'c') return roundExact(((value - 32) * 5) / 9);
  throw new UnitConversionError(`unsupported temperature units: ${from} -> ${to}`);
}

/** The exact arithmetic behind the `convert_units` tool. Throws UnitConversionError on bad input. */
export function convertUnitsExact(args: ConvertUnitsArgs): ConvertUnitsResult {
  const { domain, value, from_unit, to_unit } = args;
  if (UNIT_DOMAIN[from_unit] !== domain || UNIT_DOMAIN[to_unit] !== domain) {
    throw new UnitConversionError(`${from_unit}/${to_unit} do not both belong to domain ${domain}`);
  }
  let result: number;
  switch (domain) {
    case 'mass':
      result = convertLinear(MASS_TO_GRAMS, value, from_unit, to_unit);
      break;
    case 'volume':
      result = convertLinear(VOLUME_TO_ML, value, from_unit, to_unit);
      break;
    case 'temperature':
      result = convertTemperature(value, from_unit, to_unit);
      break;
    default:
      throw new UnitConversionError(`unknown domain: ${domain}`);
  }
  return { value: result, unit: to_unit };
}

/** Re-expresses a quantity in whichever unit is idiomatic for `targetSystem`, exact arithmetic, no-op if it's already there. */
export function expressInSystem(value: number, unit: UnitId, targetSystem: UnitSystem): { value: number; unit: UnitId } {
  if (UNIT_SYSTEM[unit] === targetSystem) return { value, unit };
  const to = counterpartUnit(unit);
  const domain = UNIT_DOMAIN[unit];
  const result = convertUnitsExact({ domain, value, from_unit: unit, to_unit: to });
  return { value: result.value, unit: result.unit };
}

/** Best default target unit for a given source unit when flipping US <-> Metric. */
export function counterpartUnit(unit: UnitId): UnitId {
  const map: Partial<Record<UnitId, UnitId>> = {
    oz: 'g',
    lb: 'kg',
    g: 'oz',
    kg: 'lb',
    cup: 'ml',
    tbsp: 'ml',
    tsp: 'ml',
    fl_oz: 'ml',
    ml: 'cup',
    l: 'cup',
    f: 'c',
    c: 'f',
  };
  return map[unit] ?? unit;
}
