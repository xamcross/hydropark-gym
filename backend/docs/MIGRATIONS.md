# Migrations & seed data

This document covers `io.hydropark.migration.changesets` (index changesets) and `io.hydropark.seed`
(catalog seed data). The framework itself (`io.hydropark.migration.Migration`,
`MigrationRunner`, `MigrationBootstrap`) is owned elsewhere — see `AGENT-CONTRACT.md` — and is
described here only as much as needed to use it correctly.

## Why indexes are versioned changesets, not `@Indexed` annotations

`application.yml` sets `spring.data.mongodb.auto-index-creation: false`, and AGENT-CONTRACT
forbids `@Indexed`/`@CompoundIndex` on domain entities entirely. Two reasons:

1. **MongoDB is schemaless — nothing forces an index into existence.** If index creation were
   inferred from annotations scattered across every domain package, there would be no single
   place to see the full set of indexes a fresh database needs, and no ordered history of how the
   schema got there. A changeset is an explicit, reviewable, ordered artifact instead.
2. **Several correctness properties are enforced by an index and by nothing else** — the unique
   partial index on `skill_versions(skill_id) WHERE is_current`, the one-live-license-per
   `(user_id, skill_id, device_id)` index, and `webhook_events.provider_event_id` uniqueness (the
   entire webhook-dedupe mechanism) are examples. If index creation were implicit
   (`auto-index-creation: true` + `@Indexed`), a developer could delete an annotation — or an
   entity field could silently stop being the one an old annotation pointed at — and the
   *database* would quietly stop enforcing the guarantee while the *code* still assumed it held.
   A missing changeset instead just means the index was never created, which is a loud, detectable
   state (queries are slow, or duplicate documents show up) rather than a silent one.

## How to add a changeset

1. Create a new class under `io.hydropark.migration.changesets`, e.g.
   `V008CreateSomethingIndexes implements Migration`, annotated `@Component`.
2. `id()` returns a **monotonic, zero-padded, unique** string: `V008__create_something_indexes`.
   The three-digit zero-pad matters — `MigrationRunner` sorts all discovered `Migration` beans by
   `Migration::id` using natural **string** order before applying them (see
   `MigrationRunner`'s constructor), not numeric order and not Spring bean-discovery order. `V010`
   would otherwise sort before `V9` as a string. Follow the `V\d{3}__[a-z0-9_]+` shape the way the
   existing seven changesets do.
3. `apply(MongoTemplate mongo)` creates indexes via `mongo.getCollection(name).createIndex(keys,
   IndexOptions)`, using the MongoDB Java driver's `com.mongodb.client.model` types
   (`Indexes`, `IndexOptions`, `Filters`, `Collation`) — not Spring Data's `IndexOperations`. This
   keeps every changeset explicit about the exact index spec being sent to the server.
4. **Always pass an explicit, deterministic `.name(...)`.** `createIndex` is idempotent when
   called again with the *same* name and the *same* spec (this is what makes it safe for
   `MigrationRunner` to re-invoke `apply()` after a crash between the index write and the ledger
   insert — see `Migration`'s Javadoc). If you instead let Mongo auto-generate a name from the
   field list, or reuse a name with a different spec, `createIndex` throws
   `IndexOptionsConflict` instead of being a no-op.
5. Register the changeset in
   `backend/src/test/java/io/hydropark/migration/MigrationChangesetOrderingTest.java`'s
   `ALL_MIGRATIONS` list. Nothing discovers changesets via classpath scanning in that test on
   purpose, so a forgotten registration fails the test rather than silently never being checked.
6. Add the collection/property to the table in `AGENT-CONTRACT.md` if it's a new collection.

### Why ids are never renumbered

`MigrationRunner` records every applied id in the `schema_migrations` ledger collection, and on
boot it asserts every id in that ledger still has a matching `Migration` bean in code
(`assertNoOrphanedLedgerEntries`) — if a released migration's id changes or the class is deleted,
every environment that already ran it refuses to start, because the running schema's history can
no longer be described. Renumbering `V003` to `V004` after it has shipped is exactly that failure:
anyone who already applied the old `V003` now has an "orphaned" ledger entry and a broken boot.
Once a changeset has been applied anywhere (including a teammate's local Mongo), its id is
permanent. If a changeset turns out to be wrong, ship a **new**, later-numbered changeset that
fixes it forward (e.g. drops and recreates an index under the same name with a corrected spec) —
never edit or renumber the old one.

## Changeset inventory (current)

| id | collections | what it enforces |
|---|---|---|
| `V001__create_users_and_oauth_indexes` | `users`, `oauth_identities` | case-insensitive partial-unique email; unique `(provider, provider_sub)` |
| `V002__create_auth_token_indexes` | `refresh_tokens`, `email_verification_tokens`, `password_reset_tokens`, `step_up_challenges` | unique `token_hash`; TTL on every `expires_at` |
| `V003__create_catalog_indexes` | `skills`, `skill_versions`, `bundles`, `bundle_members`, `regional_prices` | unique `(skill_id, version)` + unique-partial current version; composite uniques |
| `V004__create_commerce_indexes` | `orders`, `webhook_events`, `settled_orders`, `idempotency_keys` | unique sparse `mor_order_id`; **unique `provider_event_id`** (webhook dedupe); unique idempotency composite + TTL |
| `V005__create_licensing_indexes` | `grants`, `licenses`, `license_audit` | unique `(order_id, skill_id)`; unique-partial active license per `(user, skill, device)` |
| `V006__create_device_indexes` | `devices`, `device_slot_counters` | unique `(user_id, fingerprint)`; partial active-device index |
| `V007__create_wallet_indexes` | `wallet_accounts`, `wallet_transactions` | unique `user_id`; unique `idempotency_key` |

Two collections in AGENT-CONTRACT's table — `license_audit` and `device_slot_counters` — are not
in the `BACKEND-DESIGN.md` §3 SQL reference model (they're referenced only in prose: §2's "all
signs audited", and §11.1's atomic slot-counter mechanism). Their indexes above are therefore
inferred from the described access pattern, not transcribed from a DDL block; see the Javadoc on
`V005CreateLicensingIndexes` and `V006CreateDeviceIndexes` for the reasoning, including why
`device_slot_counters` deliberately gets **no** secondary index (its only access pattern is a
point `findOneAndUpdate` by `_id`, which the default `_id` index already serves).

## Seed data (`io.hydropark.seed.CatalogSeeder`)

`CatalogSeeder` is an `ApplicationRunner`, `@Order(2)`, gated on
`hydropark.seed.enabled=true`. It seeds the first-party catalog — 2 free skills, 8 paid skills at
$5, one `skill_versions` row each, the `home-starter-pack` bundle, and PPP `regional_prices` for
`US`/`IN`/`BR` — using plain `Document`/`MongoTemplate` writes so it never imports a domain
package. It never writes `system_prompt`: only `compressed_prompt` (the pre-purchase teaser text),
matching BACKEND-DESIGN §3.2's note that the full persona lives only inside the signed `.hpskill`
package.

Every write is `replaceOne(Filters.eq("_id", id), doc, upsert=true)` keyed by a deterministic
`_id` — natural slugs for `skills`/`bundles`, and a deterministic composite string
(`"<skill_id>@<version>"`, `"<bundle_id>::<skill_id>"`, `"<target_type>:<target_id>:<region>"`)
for the collections whose Postgres reference-model key is composite. Re-running the seeder is
therefore safe: same document count, same `_id`s, `created_at` preserved from the prior run.

**Two of the eight paid skills are provisional placeholders**, not final content — see the
top-level agent report and the `PROVISIONAL:` markers in `CatalogSeeder.catalog()`. Picking the
real final two is an open owner/content decision per `SPRINT-BACKLOG.md` §6.

## Running migrate/seed locally and on Fly

- **Local dev (`local` Spring profile):** `hydropark.seed.enabled=true` is already set by the
  profile block in `application.yml`; `hydropark.migration.exit-after` is left at its default
  (`false`), so the app boots as a normal long-running process, `MigrationBootstrap` (`@Order(1)`)
  applies pending migrations, and `CatalogSeeder` (`@Order(2)`) runs immediately after in the same
  JVM, then the app keeps serving. This is the combination to use for `mvn spring-boot:run
  -Dspring-boot.run.profiles=local` or an IDE run configuration.
- **One-shot migration job (docker-compose `migrate` service / Fly `release_command`):** set
  `HP_MIGRATION_ENABLED=true` and `HP_MIGRATION_EXIT_AFTER=true`. `MigrationBootstrap` applies
  pending migrations and then calls `System.exit(...)`.
- **Fly production (`fly` profile):** the profile block hardcodes `hydropark.seed.enabled: false`
  unconditionally (not `${HP_SEED_ENABLED:false}` — it cannot be overridden by env var on this
  profile), so seed data is never written by a production release. Seeding is a local/staging
  convenience only.

### ⚠ Known ordering gap: `exit-after=true` + `seed.enabled=true` does NOT run the seeder

This was called out explicitly as something to confirm, and it does not work as a naive reading
of `@Order` would suggest. `MigrationBootstrap.run()` (`@Order(1)`) does, when
`exit-after=true`:

```java
log.info("migration-only mode: applied {} migration(s), exiting", applied);
System.exit(SpringApplication.exit(context, () -> 0));
```

`System.exit` terminates the JVM **synchronously, immediately, in the calling thread** — it does
not return. Spring Boot invokes `ApplicationRunner`/`CommandLineRunner` beans sequentially, in
`@Order`, on that same thread during `SpringApplication.run(...)`. So if `exit-after=true`,
`MigrationBootstrap` (`@Order(1)`) halts the process *before* Spring's runner loop ever reaches
`CatalogSeeder` (`@Order(2)`) — no later-ordered `ApplicationRunner` can run in the same
invocation once this fires, regardless of what it's ordered relative to. In other words: **with
both flags true, only the migration step actually executes; the seed step is silently skipped**,
not deferred or reordered.

This package (`migration/changesets`, `seed`) is all this agent owns; `MigrationBootstrap.java`
is a framework file under `io.hydropark.migration` proper and is out of scope to edit here (see
AGENT-CONTRACT). Flagging it instead of fixing it, per that contract. Two ways it could be fixed,
for whoever owns the framework package:

1. Have `MigrationBootstrap` invoke seeding itself (e.g. inject an optional seed-runner bean and
   call it before deciding whether to exit) instead of relying on `ApplicationRunner` ordering
   across two independent beans.
2. Don't call `System.exit` synchronously inline; instead set an exit-code holder and let a
   dedicated last-`@Order` runner perform the actual exit once all runners (including the seeder)
   have completed.

Until one of those lands, do not rely on `HP_MIGRATION_EXIT_AFTER=true` +
`HP_SEED_ENABLED=true` together to produce seeded data — run migrations and seeding as two
separate steps (or via the `local` profile's long-running mode) if both are needed in one
environment bootstrap. In practice this gap is currently unreachable in the shipped `fly` profile
(which hardcodes `seed.enabled: false` regardless of this flag combination) — the risk is
scoped to whoever wires a docker-compose or CI job that sets both flags true expecting a combined
one-shot migrate-and-seed step.
