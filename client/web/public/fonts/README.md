# Brand font binaries (TODO — P1-01.4)

Hydropark ships fonts **locally** because it is an offline Tauri app under a strict
CSP (`default-src 'self'`) — it can never fetch Google Fonts at runtime. The
`@font-face` rules live in `client/web/src/styles/fonts.css` and reference the
files below by their app-origin path (`/fonts/<file>`). Angular copies everything
in `client/web/public/` to the dist root, so a file dropped here is served at
`/fonts/...` in both `ng serve` and the packaged app.

## Drop these three variable-font binaries here

| Family        | Expected file                    | Axes                       | License |
|---------------|----------------------------------|----------------------------|---------|
| Archivo       | `Archivo-Variable.woff2`         | `wght 100–900, wdth 62–125`| OFL 1.1 |
| Chivo         | `Chivo-Variable.woff2`           | `wght 100–900`             | OFL 1.1 |
| Martian Mono  | `MartianMono-Variable.woff2`     | `wght 100–800, wdth 75–112`| OFL 1.1 |

All three are SIL Open Font License 1.1 (bundling/self-hosting is permitted).
Subset to the Latin range and convert to `woff2` to keep the payload small, e.g.:

```
pyftsubset Archivo[wdth,wght].ttf --flavor=woff2 \
  --unicodes=U+0000-00FF,U+2010-2027,U+2030-205E \
  --output-file=Archivo-Variable.woff2
```

**Until the binaries are added** the `@font-face` `src` 404s and the app falls
back to the system UI stack declared in each `--font-*` token — fully legible and
WCAG-AA, only the brand typography is deferred. Do **not** replace this with a
remote `<link>` to fonts.googleapis.com.
