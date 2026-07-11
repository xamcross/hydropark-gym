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
| Archivo       | `Archivo-Variable.woff2`         | `wght 100–900, wdth 62–125`| OFL 1.1 | ~153 KB    |
| Chivo         | `Chivo-Variable.woff2`           | `wght 100–900`             | OFL 1.1 | ~49 KB     |
| Martian Mono  | `MartianMono-Variable.woff2`     | `wght 100–800, wdth 75–112.5`| OFL 1.1 | ~48 KB   |

All three are SIL Open Font License 1.1 — bundling/self-hosting is permitted, and
the license text is bundled alongside the binaries in `OFL.txt` (a redistribution
requirement of the OFL). The three copyright lines at the top of `OFL.txt` cover
Archivo, Chivo and Martian Mono respectively; the license body is identical.

## How these were produced (reproduce with fonttools)

Source: the upstream variable TTFs from the `google/fonts` repo
(`ofl/archivo/Archivo[wdth,wght].ttf`, `ofl/chivo/Chivo[wght].ttf`,
`ofl/martianmono/MartianMono[wdth,wght].ttf`). Each was subset to Latin +
Latin-ext and converted to `woff2` **without pinning any axis** (no `--instance`),
so the full variable design space fonts.css relies on is preserved:

```
pyftsubset "Archivo[wdth,wght].ttf" --flavor=woff2 \
  --unicodes=U+0000-00FF,U+0100-024F,U+02B0-02FF,U+0300-036F,U+2000-206F,U+20A0-20CF,U+2122,U+2212,U+FEFF,U+FFFD \
  --layout-features='*' --name-IDs='*' \
  --output-file=Archivo-Variable.woff2
```

(Same command for Chivo and Martian Mono, changing input/output names.)

If a binary is ever missing the `@font-face` `src` 404s and the app falls back to
the system UI stack declared in each `--font-*` token — fully legible and
WCAG-AA, only the brand typography is deferred. Do **not** replace these with a
remote `<link>` to fonts.googleapis.com.
