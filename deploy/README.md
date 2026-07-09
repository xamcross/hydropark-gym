# Hydropark deployment tooling

Everything needed to run the Hydropark backend locally (Docker on Windows) or
in the cloud (Fly.io + MongoDB Atlas). Source of truth for *why* it looks
this way: `../BACKEND-DESIGN.md` §2, §6.2, §11.2, `../backend/AGENT-CONTRACT.md`
"Trust zones", and `../sprint/phase-1-backend.md` P1-21.

The one idea that explains most of the layout below: **the same backend
image can boot as three different trust zones** - `api` (public), `issuer`
(signs licenses), `worker` (settles payments) - decided purely by three env
vars (`HP_API_ENABLED` / `HP_ISSUER_ENABLED` / `HP_WORKER_ENABLED`). Nothing
in this directory ever gives `api` a secret that belongs to `issuer` or
`worker`, or vice versa. If you're about to add an env var to a service
block, check the secret-distribution matrix below first.

---

## Trust-zone table

| Zone | Public ingress? | Holds | Never holds |
|---|---|---|---|
| `api` | **Yes** | `HP_JWT_PRIVATE_KEY` (access tokens), `HP_STRIPE_API_KEY` (creates checkouts), `HP_INTERNAL_TOKEN` | `HP_LICENSE_PRIVATE_KEY`, `HP_STRIPE_WEBHOOK_SECRET` |
| `issuer` | No - internal only | `HP_LICENSE_PRIVATE_KEY`, `HP_LICENSE_PUBLIC_KEY`, `HP_INTERNAL_TOKEN` | `HP_STRIPE_*`, `HP_JWT_PRIVATE_KEY` |
| `worker` | No - internal only | `HP_STRIPE_WEBHOOK_SECRET`, `HP_STRIPE_API_KEY`, `HP_INTERNAL_TOKEN` | `HP_LICENSE_*` |

`issuer` and `worker` publish **no port** anywhere in this tooling - not in
`docker-compose.yml` (no `ports:` entry, only `expose:` for documentation),
not in Fly (`fly.issuer.toml` / `fly.worker.toml` have no `[http_service]` /
`[[services]]` block at all). `api` reaches them over an internal-only
hostname (`http://issuer:8080` locally, `http://hydropark-issuer.internal:8080`
on Fly's 6PN network), authenticated by a shared `HP_INTERNAL_TOKEN` bearer
header. That token is a network-boundary credential, **not** authorization -
the Issuer independently re-verifies settlement for the exact `(user, skill)`
on every call regardless of who's asking (BACKEND-DESIGN §6.2 N3). The Atlas
role split below (`atlas-roles.js`) is what makes that true at the database
layer too, not just over the network.

## Secret-distribution matrix

**This is the single most important operational fact in this directory.**
Get this wrong and either a popped `api` container can forge licenses, or a
popped `worker` can be impersonated by `api` in a way the database can't
stop.

| Secret | api | issuer | worker | Where it's set |
|---|:---:|:---:|:---:|---|
| `HP_INTERNAL_TOKEN` | Y | Y | Y | same value, all three |
| `HP_JWT_PRIVATE_KEY` | Y | | | api only - signs access tokens |
| `HP_LICENSE_KID` / `HP_LICENSE_PRIVATE_KEY` / `HP_LICENSE_PUBLIC_KEY` | | **Y (only)** | | issuer only - see `deploy/scripts/generate-keys.ps1` |
| `HP_STRIPE_API_KEY` | Y | | Y | creates checkouts (api) + may look up charges (worker) |
| `HP_STRIPE_WEBHOOK_SECRET` | | | **Y (only)** | worker only - verifies the MoR webhook HMAC |
| `MONGODB_URI` | Y | Y | Y | **different value per zone** in the cloud path - see below |

Locally, `MONGODB_URI` is the same for all three containers (one replica set,
one database, no per-zone Atlas roles - see "Local vs. cloud DB privilege"
below). In the cloud path, each app connects as a **different Atlas
database user** with a custom least-privilege role
(`deploy/fly/atlas-roles.js`):

| Atlas role | Collections | Access |
|---|---|---|
| `hp_api` | everything except `settled_orders`, `grants` | read/write |
| `hp_api` | `settled_orders`, `grants` | **read-only** |
| `hp_worker` | `settled_orders`, `grants` | **the only role that can insert/update these** |
| `hp_worker` | `wallet_accounts`, `wallet_transactions`, `orders`, `webhook_events`, `idempotency_keys` | read/write |
| `hp_issuer` | `grants`, `settled_orders`, `devices` | **read-only** |
| `hp_issuer` | `licenses`, `license_audit` | read/write |

`deploy/fly/bootstrap-secrets.ps1` enforces this split in code: it refuses to
set `HP_LICENSE_PRIVATE_KEY`/`HP_LICENSE_PUBLIC_KEY` on `api` or `worker`,
and refuses to set `HP_STRIPE_WEBHOOK_SECRET` on `api` or `issuer`.

### Local vs. cloud DB privilege

The local stack's single `mongo:7` replica set has no Atlas-style custom
roles (plain community MongoDB doesn't ship Atlas's role UI, and building an
equivalent locally isn't worth the complexity for a throwaway dev database) -
all three containers connect with the same unauthenticated `MONGODB_URI`.
**Isolation ≠ authorization only becomes a real, tested property in the
cloud path**, where `deploy/fly/atlas-roles.js` creates the three roles
above. If you're testing "does a compromised api tier stay unable to write
grants," that has to be tested against Atlas (or a local Mongo you've
manually secured with the same roles), not against the default compose
stack.

---

## Quickstart: local (Docker Desktop on Windows)

```powershell
cd deploy
Copy-Item .env.example .env
# Edit .env: set HP_INTERNAL_TOKEN to any long random string, and
# HP_LICENSE_PRIVATE_KEY/HP_LICENSE_PUBLIC_KEY via generate-keys.ps1:
.\scripts\generate-keys.ps1
# (paste the printed HP_LICENSE_* and HP_JWT_PRIVATE_KEY lines into .env)

.\local\up.ps1        # builds the jar, brings up mongo/migrate/api/issuer/worker
.\local\smoke.ps1      # asserts /actuator/health and GET /v1/catalog both work
.\local\logs.ps1        # tail all logs (Ctrl+C to stop tailing, stack keeps running)
.\local\down.ps1        # stop the stack (add -Volumes to also wipe Mongo data)
```

`up.ps1` runs `mvn package -DskipTests` before `docker compose up -d --build`
- pass `-SkipBuild` to reuse an existing jar. Everything under `local/` has a
POSIX `.sh` twin for macOS/Linux/WSL (`./up.sh`, `./down.sh`, ...).

What `up.ps1` actually brings up, in dependency order:
1. `mongo` - `mongo:7` as a **single-node replica set** (`--replSet rs0`).
   Required, not optional: the wallet-debit + grant + `settled_orders` write
   is one multi-document transaction, and MongoDB only offers transactions
   on a replica set (AGENT-CONTRACT.md security property #6/#8). A
   standalone `mongod` would let every settlement test pass locally and then
   fail the moment it hits production.
2. `mongo-init` - one-shot container that waits for `mongo` to accept
   connections, then runs `rs.initiate({_id:"rs0", members:[{_id:0,
   host:"mongo:27017"}]})` with a retry loop. Safe to re-run (tolerates
   "already initialized").
3. `migrate` - runs schema migrations to completion and exits 0
   (`HP_MIGRATION_EXIT_AFTER=true`). `seed.ps1` additionally sets
   `HP_SEED_ENABLED=true` to load catalog fixtures.
4. `api` / `issuer` / `worker` - only start once `migrate` has exited 0.

## Quickstart: cloud (Fly.io + MongoDB Atlas)

Prerequisites: an Atlas project with a replica set that supports
multi-document transactions (M10+ recommended for production money paths -
BACKEND-DESIGN §11.2 #2), and `flyctl` authenticated (`fly auth login`).

```powershell
# 1. Provision the Atlas least-privilege roles + users (run once per
#    environment - dev/staging/prod each get their own, same as signing keys).
mongosh "<atlas-uri-with-admin-privileges>" --file deploy\fly\atlas-roles.js
#    Copy the three printed passwords/URIs immediately - they aren't re-printable.

# 2. Generate signing keys (per environment - never share a key between
#    staging and prod, P1-21.3).
.\deploy\scripts\generate-keys.ps1

# 3. Export everything bootstrap-secrets.ps1 needs (see its header comment
#    for the full list), then:
.\deploy\fly\bootstrap-secrets.ps1
#    Refuses to set HP_LICENSE_PRIVATE_KEY on api/worker or
#    HP_STRIPE_WEBHOOK_SECRET on api/issuer - by design.

# 4. Deploy all three apps in trust-zone order (issuer, worker, then api):
.\deploy\fly\deploy-cloud.ps1
#    api's [deploy] release_command runs the migration one-shot BEFORE any
#    api instance takes traffic - see fly.api.toml.
```

Three separate Fly apps = three separate trust zones (`hydropark-api`,
`hydropark-issuer`, `hydropark-worker`) - not three processes in one app,
so a `fly.io` account/API-token compromise scoped to one app still can't
reach the other two's machines or secrets directly. `hydropark-issuer` and
`hydropark-worker` never get a public IP allocated; `api` reaches them via
Fly's private `.internal` DNS (6PN).

To run migrations again without a full redeploy (break-glass, or bootstrapping
a brand-new environment after the first deploy): `.\deploy\fly\migrate-cloud.ps1`.

To deploy just one app after a code change (e.g. redeploying `api` alone):
`.\deploy\fly\deploy-cloud.ps1 -App api`.

---

## Switching `fake` → `stripe`

The stack defaults to `HP_PAYMENT_PROVIDER=fake`, which needs **zero**
payment-provider credentials - this is what lets the whole local stack come
up with an empty `.env` beyond `HP_INTERNAL_TOKEN` and the license keys.

To exercise real Stripe test-mode payments locally:

1. In `deploy/.env`: set `HP_PAYMENT_PROVIDER=stripe`, `HP_STRIPE_API_KEY=sk_test_...`,
   and `HP_STRIPE_WEBHOOK_SECRET=whsec_...` (see step 2 to get this value).
2. Point the Stripe CLI at the local stack. Because `worker` publishes no
   port (by design - see the trust-zone table above), you forward to `api`'s
   published port; `api`'s receive-only `POST /v1/webhooks/mor` handler
   captures the raw bytes and enqueues, and `worker` (internal-only) picks
   the event up and verifies it:
   ```powershell
   stripe listen --forward-to localhost:8080/v1/webhooks/mor
   ```
   `stripe listen` prints a `whsec_...` value the first time you run it -
   that's what goes in `HP_STRIPE_WEBHOOK_SECRET` in step 1. Restart the
   `worker` container after changing it: `docker compose up -d worker`.
3. Trigger a test event: `stripe trigger checkout.session.completed` (or
   drive it through a real checkout session your `api` created).

In the cloud path, the equivalent is pointing your Stripe (or Paddle/Lemon
Squeezy - BACKEND-DESIGN §7 names either as the production MoR) webhook
endpoint at `hydropark-api`'s public URL, `/v1/webhooks/mor` - same
receive-only-at-the-edge shape, verification still happens only in
`hydropark-worker`.

---

## Troubleshooting

### "replica set not initiated" / transactions fail / `mongo-init` never completes

Symptom: `api` never becomes healthy, or you see errors like
`Transaction numbers are only allowed on a replica set member or mongos` or
`NotYetInitialized` in logs.

- Check `mongo-init`'s logs first - it's the container responsible for
  `rs.initiate()`: `.\local\logs.ps1 mongo-init -NoFollow`. It retries for
  up to ~60s (30 retries × 2s) before giving up; if it gave up, `mongo`
  itself likely never became healthy - check `.\local\logs.ps1 mongo`.
- A common cause on Windows/Docker Desktop: a stale `mongo_data` volume from
  a previous, differently-configured run (e.g. you changed the replica set
  name, or a previous `mongo-init` half-completed). Fix: `.\local\reset.ps1`
  (destroys the volume and rebuilds clean).
- Confirm the replica set was initiated with the **compose service name**,
  not `localhost`: `docker compose exec mongo mongosh --eval "rs.status()"`
  should show a member with `host: "mongo:27017"`. If it shows `localhost`
  or `127.0.0.1` instead, other containers can't reach it - re-run
  `.\local\reset.ps1`; `mongo-init`'s script always initiates with
  `mongo:27017` explicitly for exactly this reason.
- If you manually ran `docker compose up mongo` without `mongo-init` (e.g.
  during debugging), the replica set is genuinely not initiated yet - that's
  `mongo-init`'s job, not `mongo`'s; bring the full stack up with `up.ps1`
  or at least `docker compose up -d mongo mongo-init`.

### `api`/`issuer`/`worker` won't start: missing required env var

`docker-compose.yml` uses `${VAR:?message}` for `HP_INTERNAL_TOKEN` and (on
`issuer`) `HP_LICENSE_PRIVATE_KEY`/`HP_LICENSE_PUBLIC_KEY` - compose refuses
to start the container and prints the message instead of silently booting
with a blank secret. Run `.\deploy\scripts\generate-keys.ps1` and copy the
output into `deploy/.env`.

### `migrate` runs but `api` still fails to boot

Check `migrate`'s own exit code/logs first: `.\local\logs.ps1 migrate -NoFollow`.
If migrations themselves are failing (as opposed to `api` failing for an
unrelated reason), that's a Java/migration-package problem, not a deploy-tooling
one - this directory intentionally never touches `backend/src/main/java/io/hydropark/migration/`.

### Healthcheck always shows "starting" / never "healthy"

`backend/Dockerfile`'s `HEALTHCHECK` hits `/actuator/health/readiness`, which
only flips to `UP` once the whole Spring context has finished starting -
including a successful Mongo connection. A container stuck "starting"
usually means it can't reach Mongo yet (see the replica-set section above)
or is still waiting on `migrate`.

### Fly: `release_command` fails and blocks the deploy

`fly.api.toml`'s `release_command` runs migrations before any `api` instance
takes traffic - if it fails, `flyctl deploy` stops without rolling out new
`api` code (existing instances keep serving on the old release). Check
`fly logs --app hydropark-api`, and confirm the Atlas user `api` is deployed
with (`hp_api_user` - see `atlas-roles.js`) actually has write access to
whatever the migration touches; `hp_api` is read-only on
`settled_orders`/`grants`, so a migration that needs to touch those two
collections' schema must be run as `hydropark-worker` instead
(`.\deploy\fly\migrate-cloud.ps1 -App hydropark-worker`).

---

## What's here

```
backend/Dockerfile          multi-stage build; layered jar; non-root; HEALTHCHECK
backend/.dockerignore

deploy/docker-compose.yml   mongo (rs0) + mongo-init + migrate + api + issuer + worker (+ tools profile)
deploy/.env.example         every HP_* var, documented, safe defaults, loud placeholders for secrets

deploy/local/                Windows-first local-stack scripts (.ps1 + .sh twins)
  up.ps1 / up.sh              build + docker compose up -d --build + wait for health
  down.ps1 / down.sh          docker compose down (-Volumes / --volumes to also wipe data)
  migrate.ps1 / migrate.sh    docker compose run --rm migrate
  seed.ps1 / seed.sh          same, with HP_SEED_ENABLED=true
  logs.ps1 / logs.sh          tail logs, optionally scoped to one service
  reset.ps1 / reset.sh        down -Volumes then up (clean slate)
  smoke.ps1 / smoke.sh        GET /actuator/health + GET /v1/catalog, exit non-zero on failure

deploy/scripts/
  generate-keys.ps1 / .sh     Ed25519 (issuer) + RSA-2048 (access tokens) keypairs, openssl or Java fallback

deploy/fly/
  fly.api.toml                 public ingress; release_command runs the migration one-shot
  fly.issuer.toml               no public services; sole HP_LICENSE_PRIVATE_KEY holder
  fly.worker.toml               no public services; sole HP_STRIPE_WEBHOOK_SECRET holder
  deploy-cloud.ps1              deploys issuer, worker, api in order (-App to deploy just one)
  bootstrap-secrets.ps1         fly secrets set per app, enforcing the split above
  atlas-roles.js                mongosh script: hp_api / hp_worker / hp_issuer custom Atlas roles + users
  migrate-cloud.ps1             run migrations against Atlas out-of-band (fly ssh console)
```

---

## Stripe: the API-version trap (read before wiring a real webhook endpoint)

Stripe stamps every event with the API version pinned on the **webhook endpoint** (or, failing that,
the account default) — *not* the version `stripe-java` was compiled against. You can read the SDK's
pinned version at runtime from `com.stripe.Stripe.API_VERSION` (currently `2025-03-31.basil`).

When the two differ, `event.getDataObjectDeserializer().getObject()` returns an **empty Optional
rather than throwing**. The signature has already verified, so the event is genuine — but the data
object silently vanishes, and with it the `client_reference_id` that carries our `orders.id`. The
settlement worker then parks the event as *"carried no order correlation"*. If the account's API
version ever drifts from the SDK's, **every webhook dead-letters and settlement stops**, while the
logs blame correlation instead of the version skew that actually caused it.

`StripePaymentProvider` now falls back to `deserializeUnsafe()` and logs a `WARN` naming both
versions. That keeps payments flowing, but it is a safety net, not the fix.

**The fix is operational: pin the webhook endpoint's API version.** When you create the endpoint:

```bash
stripe webhook_endpoints create \
  --url https://<your-api-host>/v1/webhooks/mor \
  --api-version 2025-03-31.basil \
  --enabled-events checkout.session.completed \
  --enabled-events charge.refunded \
  --enabled-events charge.dispute.created
```

Re-pin it whenever you upgrade `stripe-java`, and treat the `WARN` above as a release-blocker.

### Which Stripe secret goes where

| Secret | Container | Why |
|---|---|---|
| `HP_STRIPE_API_KEY` (`sk_test_…`) | `api` | creates Checkout Sessions |
| `HP_STRIPE_WEBHOOK_SECRET` (`whsec_…`) | `worker` **only** | verifies raw-body HMAC; the public edge holds no secret |

`bootstrap-secrets.ps1` refuses to place either on the wrong app. Note that `Stripe.apiKey` is a
**static global** in the SDK, set on first `createCheckout` — so the two zones must never disagree
about it.

### Receiving real Stripe webhooks locally

`localhost` is not reachable from Stripe. Use the Stripe CLI (not installed by default):

```bash
stripe listen --forward-to localhost:8080/v1/webhooks/mor
# prints a whsec_… — put THAT in deploy/.env as HP_STRIPE_WEBHOOK_SECRET
```

Without it, `HP_PAYMENT_PROVIDER=fake` exercises the identical settlement path with no credentials.
