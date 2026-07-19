# Brand font binaries (P1-01.4 — DONE)

Hydropark ships fonts **locally** because it is an offline Tauri app under a strict
CSP (`default-src 'self'`) — it can never fetch Google Fonts at runtime. The
`@font-face` rules live in `client/web/src/styles/fonts.css` and reference the
files below by their app-origin path (`/fonts/<file>`). Angular copies everything
in `client/web/public/` to the dist root, so a file dropped here is served at
`/fonts/...` in both `ng serve` and the packaged app.

## The three variable-font binaries (present in this folder)

| Family        | File                             | Axes preserved             | License | woff2 size |
|---------------|----------------------------------|----------------------------|---------|------------|
| Archivo       | `Archivo-Variable.woff2`         | `wght 100–900, wdth 62–125`| OFL 1.1 | ~88 KB     |
| Chivo         | `Chivo-Variable.woff2`           | `wght 100–900`             | OFL 1.1 | ~33 KB     |
| Martian Mono  | `MartianMono-Variable.woff2`     | `wght 100–800, wdth 75–112.5`| OFL 1.1 | ~36 KB   |

All three are SIL Open Font License 1.1 — bundling/self-hosting **and subsetting**
are permitted (the OFL expressly allows Modified Versions to be bundled and
redistributed), and the license text is bundled alongside the binaries in
`OFL.txt` (a redistribution requirement of the OFL). The three copyright lines at
the top of `OFL.txt` cover Archivo, Chivo and Martian Mono respectively; the
license body is identical. `--name-IDs='*'` keeps the name table so each binary
retains its embedded license/description references.

## How these were produced (reproduce with fonttools)

Source: the upstream variable TTFs from the `google/fonts` repo
(`ofl/archivo/Archivo[wdth,wght].ttf`, `ofl/chivo/Chivo[wght].ttf`,
`ofl/martianmono/MartianMono[wdth,wght].ttf`), converted to `woff2` **without
pinning any axis** (no `--instance`), so the full variable design space fonts.css
relies on is preserved.

**P1-01.8** then subset each binary down to the shared 212-glyph repertoire the
English UI actually renders in the brand fonts — Latin + standard typographic
punctuation + `€ ₽ ™ −` — cutting the three files from 250 KB to 157 KB total
(-37%). The repeatable pipeline is [`scripts/subset-fonts.mjs`](../../../../scripts/subset-fonts.mjs)
(runs `pyftsubset` in place; offline, idempotent). It applies:

```
pyftsubset <in>.woff2 --flavor=woff2 \
  --unicodes=U+0020-007E,U+00A0-00FF,U+2011,U+2013-2014,U+2018-201A,U+201C-201E,U+2020-2022,U+2026,U+2030,U+2039-203A,U+2044,U+20AC,U+20BD,U+2122,U+2212 \
  --layout-features='*' --name-IDs='*' --recalc-bounds \
  --output-file=<in>.woff2
```

The `unicode-range` in `client/web/src/styles/fonts.css` mirrors this exact set,
so codepoints these Latin families never contained (arrows, math comparators,
geometric shapes, box drawing, emoji) fall through to the system UI stack rather
than rendering `.notdef` tofu. If fonttools/brotli are missing, install with
`pip install --user fonttools brotli` first.

If a binary is ever missing the `@font-face` `src` 404s and the app falls back to
the system UI stack declared in each `--font-*` token — fully legible and
WCAG-AA, only the brand typography is deferred. Do **not** replace these with a
remote `<link>` to fonts.googleapis.com.
