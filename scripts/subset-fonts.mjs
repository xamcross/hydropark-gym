#!/usr/bin/env node
// =============================================================================
// P1-01.8 — Subset the three brand VARIABLE fonts for the offline app.
// -----------------------------------------------------------------------------
// Hydropark ships fonts LOCALLY (offline Tauri app, CSP default-src 'self' — it
// can never fetch Google Fonts). This script shrinks the self-hosted woff2
// binaries in client/web/public/fonts/ to only the glyphs the English UI
// actually renders in the BRAND fonts, while KEEPING the full variable design
// space (weight + width axes — fonts.css uses font-stretch, which needs wdth).
//
// It is repeatable and OFFLINE (no network): it re-subsets whatever woff2 files
// are already in public/fonts/ in place, so re-running is idempotent (a second
// pass keeps the same glyph set and produces the same output). CI can run it
// after dropping fresh upstream binaries into public/fonts/.
//
// LICENSE: all three families are SIL OFL 1.1 (see public/fonts/OFL.txt), which
// explicitly permits subsetting/modifying and redistributing ("Modified
// Versions ... may be bundled, redistributed"). --name-IDs='*' keeps the name
// table so the embedded license/description references survive in each binary.
//
// TOOLING: pyftsubset (fonttools) + brotli, invoked as `python -m
// fontTools.subset`. If missing:  pip install --user fonttools brotli
//
// The DECLARED unicode-range below is deliberately the intersection of what all
// three fonts contain AND what the UI uses, so it is provably tofu-free: any
// codepoint outside it (arrows → ← , math ≥ ≠ , geometric shapes ▸ ● , box
// drawing ─ , emoji 🔒) is NOT in these Latin text families to begin with and
// falls through to the system UI stack declared in tokens.css — unchanged
// behavior. Adding those blocks to the range would render .notdef tofu, not fix
// fallback, so they are intentionally excluded. Keep this list and the
// `unicode-range` in client/web/src/styles/fonts.css in sync.
// =============================================================================

import { spawnSync } from "node:child_process";
import { statSync, renameSync, existsSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const FONTS_DIR = resolve(scriptDir, "..", "client", "web", "public", "fonts");

// ---------------------------------------------------------------------------
// Target repertoire — MUST mirror the `unicode-range` in fonts.css.
// Latin + standard typographic punctuation + the symbols the UI renders in the
// brand fonts. $ (U+0024) and £ ¥ ¢ (U+00A3/A5/A2) live in the Latin blocks;
// € and ₽ are the only Currency-block glyphs all three families share.
// ---------------------------------------------------------------------------
const UNICODE_RANGES = [
  ["U+0020-007E", "Basic Latin (ASCII printable — incl. $ dollar)"],
  ["U+00A0-00FF", "Latin-1 Supplement — § · ° ¶ × ± µ, and £ ¥ ¢ currency"],
  ["U+2011",      "non-breaking hyphen"],
  ["U+2013-2014", "en dash, em dash"],
  ["U+2018-201A", "‘ ’ ‚ single quotes"],
  ["U+201C-201E", "“ ” „ double quotes"],
  ["U+2020-2022", "dagger, double dagger, bullet •"],
  ["U+2026",      "horizontal ellipsis …"],
  ["U+2030",      "per-mille ‰"],
  ["U+2039-203A", "‹ › single angle quotes"],
  ["U+2044",      "fraction slash ⁄"],
  ["U+20AC",      "euro €"],
  ["U+20BD",      "ruble ₽"],
  ["U+2122",      "trademark ™"],
  ["U+2212",      "minus −"],
];
const UNICODES = UNICODE_RANGES.map(([r]) => r).join(",");

const FONTS = [
  "Archivo-Variable.woff2",
  "Chivo-Variable.woff2",
  "MartianMono-Variable.woff2",
];

/** Run python (try `python`, then `python3`); return {status, stdout, stderr}. */
function python(args) {
  for (const bin of ["python", "python3"]) {
    const r = spawnSync(bin, args, { encoding: "utf-8" });
    if (r.error && r.error.code === "ENOENT") continue;
    return r;
  }
  console.error("python not found on PATH. Install Python 3, then:\n  pip install --user fonttools brotli");
  process.exit(1);
}

// Preflight: fonttools + brotli must import.
if (python(["-c", "import fontTools, brotli"]).status !== 0) {
  console.error("fonttools/brotli not importable. Install with:\n  pip install --user fonttools brotli");
  process.exit(1);
}

const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);

console.log("Subsetting brand variable fonts (keeping weight + width axes)\n");
console.log("unicode-range:");
for (const [r, why] of UNICODE_RANGES) console.log(`  ${pad(r, 14)} ${why}`);
console.log("");

let before0 = 0, after0 = 0, failed = false;
for (const f of FONTS) {
  const src = join(FONTS_DIR, f);
  if (!existsSync(src)) { console.error(`skip (missing): ${f}`); continue; }
  const before = statSync(src).size;
  const tmp = `${src}.subset.tmp`;
  if (existsSync(tmp)) unlinkSync(tmp);

  const r = python([
    "-m", "fontTools.subset", src,
    "--flavor=woff2",              // woff2 output (brotli-compressed)
    `--unicodes=${UNICODES}`,      // keep only the target repertoire
    "--layout-features=*",         // keep kerning + typographic features
    "--name-IDs=*",                // keep name table (OFL license references)
    "--recalc-bounds",             // tighten glyph bounds after subsetting
    // NB: no --instance / no axis pinning → full variable fvar/gvar preserved.
    `--output-file=${tmp}`,
  ]);
  if (r.status !== 0) {
    console.error(`FAILED: ${f}\n${r.stderr || r.stdout}`);
    if (existsSync(tmp)) unlinkSync(tmp);
    failed = true;
    continue;
  }
  const after = statSync(tmp).size;
  renameSync(tmp, src);           // overwrite in place (git-tracked; recoverable)
  before0 += before; after0 += after;
  const pct = ((1 - after / before) * 100).toFixed(1);
  console.log(`${pad(f, 28)} ${padL(before, 7)} -> ${padL(after, 7)} bytes  (-${pct}%)`);
}
if (before0 > 0) {
  const pct = ((1 - after0 / before0) * 100).toFixed(1);
  console.log(`${pad("TOTAL", 28)} ${padL(before0, 7)} -> ${padL(after0, 7)} bytes  (-${pct}%)`);
}
console.log(`\nfonts.css unicode-range value:\n  ${UNICODES.replace(/,/g, ",\n    ")}`);
process.exit(failed ? 1 : 0);
