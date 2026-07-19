#!/usr/bin/env node
// =============================================================================
// X-A11Y.2 — WCAG contrast audit of the Hydropark design tokens.
// -----------------------------------------------------------------------------
// Dependency-free (pure Node, no npm install). Parses
// client/web/src/styles/tokens.css, resolves the documented foreground /
// background token PAIRS for BOTH shipped themes (the dark landing-gym seed and
// the derived WCAG-AA light theme), computes the WCAG 2.1 relative-luminance
// contrast ratio for each, and prints a table.
//
// EXIT CODE is the merge gate:
//   0  every GATED pair meets its threshold (AA text 4.5:1, large/UI 3.0:1).
//   1  at least one GATED pair is below threshold — the offending pairs are
//      listed. Thresholds are the WCAG minima and are NEVER weakened here; a
//      failure means a token pair must change, not the gate.
//
// The audit also prints NON-GATING witnesses, chiefly the known-tricky
// "sulphur-on-light" case: raw --sulphur as text on --paper is unreadable
// (~1.4:1), which is *why* the token system routes careful text to
// --sulphur-ink on the light theme. Keeping that witness in the table documents
// the guard the tokens encode and proves the contrast math discriminates.
//
// WCAG references: relative luminance + contrast ratio per WCAG 2.1
// (https://www.w3.org/TR/WCAG21/#dfn-relative-luminance,
//  https://www.w3.org/TR/WCAG21/#dfn-contrast-ratio); non-text UI 3:1 per SC
// 1.4.11. Purely decorative boundaries (hairline dividers) are exempt from
// 1.4.11 and are reported as non-gating.
// =============================================================================

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const TOKENS_PATH = join(scriptDir, "..", "client", "web", "src", "styles", "tokens.css");

// ---------------------------------------------------------------------------
// 1. Parse tokens.css into per-selector custom-property maps.
//    We only care about three rule kinds, and deliberately ignore @media:
//      :root                     → brand primitives + the LIGHT semantic set
//      :root[data-theme="dark"]  → the DARK semantic overrides
//    The @media (prefers-color-scheme: dark) block merely duplicates the dark
//    set as the OS-default signal, so skipping it avoids double-counting.
// ---------------------------------------------------------------------------

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Walk top-level `selector { body }` rules (brace-depth aware); skip at-rules. */
function topLevelRules(css) {
  const rules = [];
  let i = 0;
  const n = css.length;
  while (i < n) {
    // Accumulate a selector up to the next '{'.
    let selStart = i;
    while (i < n && css[i] !== "{") i++;
    if (i >= n) break;
    const selector = css.slice(selStart, i).trim();
    // Capture the balanced body.
    let depth = 1;
    i++; // past '{'
    const bodyStart = i;
    while (i < n && depth > 0) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") depth--;
      if (depth === 0) break;
      i++;
    }
    const body = css.slice(bodyStart, i);
    i++; // past matching '}'
    if (!selector.startsWith("@")) rules.push({ selector, body });
    // at-rules (e.g. @media) are skipped whole — their inner rules are the
    // OS-default duplicate of the explicit dark block we already parse.
  }
  return rules;
}

/** Parse `--name: value;` declarations from a flat rule body, in order. */
function parseDecls(body) {
  const decls = {};
  const re = /(--[A-Za-z0-9-]+)\s*:\s*([^;]+);/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    decls[m[1].trim()] = m[2].trim();
  }
  return decls;
}

function buildEnvironments(css) {
  const rules = topLevelRules(stripComments(css));
  // Merge every plain `:root {}` block → brand primitives + light semantics.
  const light = {};
  for (const r of rules) {
    if (r.selector === ":root") Object.assign(light, parseDecls(r.body));
  }
  // Dark = the same primitives, overlaid with the explicit dark overrides.
  const darkOverlay = {};
  for (const r of rules) {
    if (r.selector === ':root[data-theme="dark"]') {
      Object.assign(darkOverlay, parseDecls(r.body));
    }
  }
  const dark = { ...light, ...darkOverlay };
  return { light, dark };
}

// ---------------------------------------------------------------------------
// 2. Resolve a token/value to an sRGB {r,g,b} triple (0-255).
//    Handles var(--x[, fallback]) chains, #rgb / #rrggbb, and rgb()/rgba().
// ---------------------------------------------------------------------------

function resolve(value, env, seen = new Set()) {
  let v = value.trim();
  // Chase token references — either `var(--x[, fallback])` or a bare `--x`
  // (the pair table names tokens directly) — until we hit a literal color.
  let guard = 0;
  while (v.startsWith("var(") || v.startsWith("--")) {
    if (guard++ > 50) throw new Error(`token resolution loop at '${value}'`);
    let name;
    let fallback = null;
    if (v.startsWith("var(")) {
      const inner = v.slice(4, v.lastIndexOf(")")); // "--name" or "--name, fallback"
      const comma = inner.indexOf(",");
      name = (comma === -1 ? inner : inner.slice(0, comma)).trim();
      fallback = comma === -1 ? null : inner.slice(comma + 1).trim();
    } else {
      name = v; // bare `--token` reference
    }
    if (seen.has(name)) throw new Error(`cyclic token reference at '${name}'`);
    seen.add(name);
    if (env[name] !== undefined) v = env[name].trim();
    else if (fallback !== null) v = fallback;
    else throw new Error(`unresolved token '${name}' (in '${value}')`);
  }
  return toRgb(v);
}

function toRgb(v) {
  v = v.trim();
  if (v.startsWith("#")) return hexToRgb(v);
  const rgbm = v.match(/^rgba?\(([^)]+)\)$/i);
  if (rgbm) {
    const parts = rgbm[1].split(/[,/]/).map((s) => s.trim());
    return {
      r: parseChannel(parts[0]),
      g: parseChannel(parts[1]),
      b: parseChannel(parts[2]),
    };
  }
  throw new Error(`not a resolvable color: '${v}'`);
}

function parseChannel(s) {
  if (s.endsWith("%")) return Math.round((parseFloat(s) / 100) * 255);
  return parseInt(s, 10);
}

function hexToRgb(hex) {
  let h = hex.replace("#", "").trim();
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (h.length !== 6) throw new Error(`bad hex '${hex}'`);
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

// ---------------------------------------------------------------------------
// 3. WCAG 2.1 relative luminance + contrast ratio.
// ---------------------------------------------------------------------------

function channelLuminance(c8) {
  const c = c8 / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function relativeLuminance({ r, g, b }) {
  return (
    0.2126 * channelLuminance(r) +
    0.7152 * channelLuminance(g) +
    0.0722 * channelLuminance(b)
  );
}

function contrastRatio(fg, bg) {
  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

// ---------------------------------------------------------------------------
// 4. The documented foreground/background token pairs to audit, per theme.
//    kind "text" → AA 4.5:1 ; kind "ui" (focus ring, semantic fill, on-fill
//    label meeting a large/component role) → 3.0:1.
// ---------------------------------------------------------------------------

const AA_TEXT = 4.5;
const AA_LARGE_UI = 3.0;

/** Gated pairs shared by both themes (resolved against each theme's env). */
const PAIRS = [
  // ---- body / muted text on the three surfaces --------------------------
  { role: "Body text", fg: "--color-text", bg: "--color-bg", kind: "text" },
  { role: "Body text on surface", fg: "--color-text", bg: "--color-surface", kind: "text" },
  { role: "Body text on surface-alt", fg: "--color-text", bg: "--color-surface-alt", kind: "text" },
  { role: "Muted text", fg: "--color-text-muted", bg: "--color-bg", kind: "text" },
  { role: "Muted text on surface", fg: "--color-text-muted", bg: "--color-surface", kind: "text" },

  // ---- primary action: label on the fill (rest + hover/pressed) ---------
  { role: "Primary label on fill", fg: "--color-primary-contrast", bg: "--color-primary", kind: "text" },
  { role: "Primary label on hover fill", fg: "--color-primary-contrast", bg: "--color-primary-strong", kind: "text" },

  // ---- semantic triad AS TEXT (chalk/steel = fine, sulphur = careful,
  //      rust = no). THE sulphur-on-light case rides on --tone-careful-text,
  //      which the tokens route to --sulphur-ink on light (see witness below).
  { role: "Fine text (triad)", fg: "--tone-fine-text", bg: "--color-bg", kind: "text" },
  { role: "Careful text (triad, sulphur)", fg: "--tone-careful-text", bg: "--color-bg", kind: "text" },
  { role: "Danger text (triad)", fg: "--tone-danger-text", bg: "--color-bg", kind: "text" },
  { role: "Danger text (alias)", fg: "--color-danger", bg: "--color-bg", kind: "text" },
  { role: "Accent as text", fg: "--color-accent", bg: "--color-bg", kind: "text" },

  // ---- labels ON semantic fills -----------------------------------------
  { role: "Label on danger fill", fg: "--color-on-danger", bg: "--color-danger-fill", kind: "text" },
  { role: "Label on accent fill", fg: "--color-on-accent", bg: "--color-accent", kind: "text" },

  // ---- non-text UI: focus ring (SC 2.4.7/1.4.11) + semantic fills (≥3:1) -
  { role: "Focus ring on bg", fg: "--focus-ring", bg: "--color-bg", kind: "ui" },
  { role: "Focus ring on surface", fg: "--focus-ring", bg: "--color-surface", kind: "ui" },
  { role: "Fine fill (non-text)", fg: "--tone-fine-fill", bg: "--color-bg", kind: "ui" },
  { role: "Careful fill (non-text)", fg: "--tone-careful-fill", bg: "--color-bg", kind: "ui" },
  { role: "Danger fill (non-text)", fg: "--tone-danger-fill", bg: "--color-bg", kind: "ui" },
];

/** Non-gating witnesses: they document guards / exemptions, not merge blockers. */
const WITNESSES = [
  {
    role: "RAW --sulphur as text",
    fg: "--sulphur",
    bg: "--paper",
    themes: ["light"],
    note: "known-tricky case: fails AA (~1.4:1) → careful text uses --sulphur-ink on light",
    expect: "fail-aa",
  },
  {
    role: "Divider / border on bg",
    fg: "--color-border",
    bg: "--color-bg",
    themes: ["light", "dark"],
    note: "decorative hairline — exempt from SC 1.4.11 (not the sole identifier of a component)",
    expect: "info",
  },
];

// ---------------------------------------------------------------------------
// 5. Run + report.
// ---------------------------------------------------------------------------

function hex({ r, g, b }) {
  const h = (n) => n.toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`.toUpperCase();
}

function pad(s, w) {
  s = String(s);
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}

function auditTheme(themeName, env) {
  console.log(`\n  ${themeName.toUpperCase()} theme`);
  console.log(
    "  " +
      pad("Role", 31) +
      pad("fg", 26) +
      pad("bg", 24) +
      pad("ratio", 9) +
      pad("req", 6) +
      "result",
  );
  console.log("  " + "-".repeat(100));

  const failures = [];
  for (const p of PAIRS) {
    const fg = resolve(p.fg, env);
    const bg = resolve(p.bg, env);
    const ratio = contrastRatio(fg, bg);
    const req = p.kind === "text" ? AA_TEXT : AA_LARGE_UI;
    const ok = ratio >= req - 1e-9;
    if (!ok) failures.push({ theme: themeName, ...p, ratio, req });
    console.log(
      "  " +
        pad(p.role, 31) +
        pad(`${p.fg}`, 26) +
        pad(`${p.bg}`, 24) +
        pad(ratio.toFixed(2) + ":1", 9) +
        pad(req.toFixed(1), 6) +
        (ok ? "PASS" : "*** FAIL ***"),
    );
  }
  return failures;
}

function reportWitnesses(envs) {
  console.log("\n  NON-GATING witnesses (guards + exemptions — do not affect exit code)");
  console.log(
    "  " +
      pad("Role", 31) +
      pad("theme", 8) +
      pad("ratio", 9) +
      "note",
  );
  console.log("  " + "-".repeat(100));
  for (const w of WITNESSES) {
    for (const t of w.themes) {
      const env = envs[t];
      const ratio = contrastRatio(resolve(w.fg, env), resolve(w.bg, env));
      console.log(
        "  " + pad(w.role, 31) + pad(t, 8) + pad(ratio.toFixed(2) + ":1", 9) + w.note,
      );
    }
  }
}

function main() {
  const css = readFileSync(TOKENS_PATH, "utf8");
  const { light, dark } = buildEnvironments(css);

  console.log("X-A11Y.2 — WCAG contrast audit of client/web/src/styles/tokens.css");
  console.log(`  thresholds: AA normal text ${AA_TEXT}:1 · large text / non-text UI ${AA_LARGE_UI}:1`);

  const failures = [
    ...auditTheme("dark", dark), // dark is the default (OS) signal
    ...auditTheme("light", light),
  ];
  reportWitnesses({ light, dark });

  console.log("");
  if (failures.length > 0) {
    console.log(`FAIL — ${failures.length} gated pair(s) below WCAG AA:`);
    for (const f of failures) {
      console.log(
        `  [${f.theme}] ${f.role}: ${f.fg} on ${f.bg} = ${f.ratio.toFixed(2)}:1 (needs ${f.req.toFixed(1)}:1)`,
      );
    }
    console.log("Thresholds are the WCAG minima and are not weakened here — fix the token(s).");
    process.exit(1);
  }
  console.log("PASS — every gated foreground/background pair meets WCAG AA in both themes.");
  process.exit(0);
}

main();
