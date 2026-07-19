# Hydropark

An offline-first desktop AI assistant. A free local agent (Qwen2.5-7B via llama.cpp, swapped from
3B on 2026-07-19 for tool-chaining/arg consistency) is specialised by
installable **skills** — a prompt, a set of tools, and a dynamic-UI pack. Two skills are free; the rest
are a one-time purchase. You buy online and use offline, forever: ownership is an Ed25519-signed,
per-device license that the app verifies locally, with no clock, no callback, and no keep-alive.

> **Note on the design docs.** The code references design decisions by section number
> (`BACKEND-DESIGN §6.2`, `SPEC §13.11`). Those documents are intentionally not published in this
> repository. The section references are kept because they are the real provenance of the decisions,
> and because the docs travel with the project.

## Layout

| Path | What it is |
|---|---|
| `backend/` | Java 21 / Spring Boot 3.5. Catalog, commerce, entitlements, offline license issuer. |
| `deploy/` | docker-compose for local dev; Fly.io + MongoDB Atlas for cloud. |
| `client/` | Angular webview (builds today) + a Tauri/Rust core (authored, not yet compiled). |
| `landing/`, `landing-gym/` | Static landing-page prototypes. |

## Quick start

```bash
cd deploy
cp .env.example .env
pwsh ./scripts/generate-keys.ps1     # writes the Ed25519 + RSA keys you must paste into .env
pwsh ./local/up.ps1                  # builds the jar, brings up the stack, waits for health
curl localhost:8080/v1/catalog
```

`HP_PAYMENT_PROVIDER=fake` is the default, so the entire purchase → settlement → license flow runs
with **no payment credentials**. Set `provider=stripe` plus `HP_STRIPE_API_KEY` /
`HP_STRIPE_WEBHOOK_SECRET` to exercise the real adapter.

## One image, three trust zones

The backend is a single artifact that boots as any of three roles, selected by config. This is not
decoration — the boundary is enforced by which secret each container is given, and by the
least-privilege MongoDB roles in `deploy/fly/atlas-roles.js`.

| Zone | Ingress | Holds |
|---|---|---|
| `api` | public | neither the signing key nor the webhook secret |
| `worker` | none | the payment webhook secret; the only principal that may write `settled_orders` and `grants` |
| `issuer` | none | the Ed25519 private keys |

`docker-compose` runs all three as separate containers, so the isolation is exercised in development
rather than discovered in production.

**Isolation is not authorization.** The internal network boundary is not a permission: before signing,
the Issuer independently re-confirms that an *active grant exists for exactly this `(user, skill)`* and
that its order appears in the append-only `settled_orders` log. A fully compromised `api` tier can
enqueue bytes; it cannot forge a settlement, and it cannot make the Issuer mint a license for a skill
the user does not own.

## Things worth knowing before you change something

- **Several correctness properties are enforced by a database index and by nothing else.** The unique
  partial index on `skill_versions(skill_id) WHERE is_current`; the one-active-license-per
  `(user, skill, device)` index; the unique `webhook_events.provider_event_id` that makes webhook
  dedupe work. MongoDB is schemaless — nothing else will stop a second row. Indexes are created by
  versioned changesets in `backend/src/main/java/io/hydropark/migration/changesets/`, never by
  `@Indexed` annotations. See `backend/docs/MIGRATIONS.md`.
- **`grants` is deliberately *not* unique on `(user_id, skill_id)`.** A user may hold both a standalone
  and a bundle grant for one skill; refunding one must not strip the other. The missing index looks
  like an oversight and is not.
- **Money is minor units + an ISO-4217 code.** Never a float. The wallet balance may go negative via a
  chargeback clawback and is never clamped.
- **The settlement worker is the sole price authority.** A wallet purchase forwards
  `(user, kind, target, region)` and never a price, so a compromised web tier cannot decide what a
  skill costs.
- **The license JWS is signed over exact bytes** — `b64u(header) + "." + b64u(payload)`. Verify over
  the bytes you received, then parse. Never re-serialize.
- **Stripe stamps events with the *webhook endpoint's* API version.** If it drifts from the SDK's, the
  data object silently fails to deserialize and settlement halts. See "Stripe: the API-version trap" in
  `deploy/README.md`.

## Tests

```bash
cd backend && mvn verify      # 99 tests; Testcontainers needs a running Docker daemon
```

The pom pins `docker.api.version=1.44`: `docker-java` negotiates v1.32, modern Docker Engines answer
`/info` with a bare HTTP 400, and Testcontainers reports that as the thoroughly misleading
"Could not find a valid Docker environment".

## Status

The Phase-1 backend slice is implemented and verified end-to-end against a running stack, including
real Stripe in test mode. The Tauri client is a Phase-0 prototype and is explicitly throwaway. Cloud
deployment scripts exist but have not been run against a live Fly.io or Atlas account.
