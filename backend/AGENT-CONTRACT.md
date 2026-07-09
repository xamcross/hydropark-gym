# Hydropark backend — agent contract

**Read this before writing a line.** It is the shared contract between parallel agents. The
foundation already exists and **compiles**. Your job is to fill in exactly one package.

Source of truth for behaviour: `../BACKEND-DESIGN.md` (§ refs below), `../SPECIFICATION.md`.

---

## Hard rules

1. **Do not modify** `pom.xml`, `src/main/resources/application.yml`, or anything under
   `io/hydropark/common/`, `io/hydropark/config/`, `io/hydropark/security/`, `io/hydropark/port/`,
   `io/hydropark/migration/` (the migration agent owns `migration/changesets/` only).
   If you believe the foundation is wrong, **say so in your final report** — do not edit it.
2. **Do not run `mvn`.** Every agent shares one `target/` directory; concurrent builds corrupt it.
   The lead compiles and fixes at integration. Write code that you are confident compiles.
3. **No Lombok.** Use `record` for DTOs, plain classes with explicit getters for `@Document` entities.
4. Java 21, Spring Boot 3.5.6, Spring Data MongoDB.
5. Write unit tests under `src/test/java/io/hydropark/<yourpackage>/`. Do not run them.

---

## Available foundation types

```java
io.hydropark.common.Uuid7            // Uuid7.generate() -> UUIDv7 String; Uuid7.prefixed("lic")
io.hydropark.common.Money            // record Money(long amount, String currency)  — minor units
io.hydropark.common.ErrorCode        // wire codes + HTTP status (see below)
io.hydropark.common.ApiException     // throw this; GlobalExceptionHandler renders it
io.hydropark.common.ApiError         // { "error": { code, message, details } }
io.hydropark.common.CursorPage       // record CursorPage<T>(List<T> items, String nextCursor)
                                     //   + clampLimit(Integer), encode/decode(String),
                                     //     from(List<T> overFetched, int limit, Function<T,String> sortKey)

io.hydropark.security.AuthPrincipal  // record AuthPrincipal(String userId, boolean emailVerified)
io.hydropark.security.CurrentUser    // CurrentUser.require() / .orNull() / .requireUserId()
io.hydropark.security.AccessTokenService  // .issue(userId, emailVerified) -> String; .verify(token) -> AuthPrincipal

io.hydropark.config.AppProperties    // hydropark.* config; getAuth(), getLicensing(), getPayments(), getDevices()
io.hydropark.config.InternalHttpConfig.INTERNAL_TOKEN_HEADER  // "X-Internal-Token"
                                     // @Qualifier("internalRestClient") RestClient for zone crossings

io.hydropark.migration.Migration     // interface: String id(), String description(), void apply(MongoTemplate)
```

`ErrorCode` values: `VALIDATION_ERROR(400) UNAUTHORIZED(401) FORBIDDEN(403) NOT_FOUND(404)
INSUFFICIENT_BALANCE(402) SLOT_LIMIT_REACHED(409) WALLET_CURRENCY_MISMATCH(409)
IDEMPOTENCY_REPLAY(409) CONFLICT(409) STEP_UP_REQUIRED(403) NOT_ENTITLED(403) RATE_LIMITED(429)
REGION_MISMATCH(409) WALLET_FROZEN(403) INTERNAL_ERROR(500)`

---

## Cross-package ports — `io.hydropark.port.Ports`

Read `src/main/java/io/hydropark/port/Ports.java`. It is the **only** legal coupling between
packages. Never import another domain package.

| Port | Implemented by | Consumed by |
|---|---|---|
| `PricingPort` | `catalog` | `commerce` (settlement worker) |
| `GrantPort` | `licensing` | `commerce`, `wallet` |
| `SettlementLogPort` | `commerce` | `licensing` (the Issuer) |
| `WalletPort` | `wallet` | `commerce` |
| `DeviceSlotPort` | `devices` | `licensing` |
| `StepUpPort` | `auth` | `licensing`, `devices` |
| `LicenseIssuerPort` | `licensing` (×2: local + remote) | `api` controllers |
| `SettlementPort` | `commerce` (×2: local + remote) | `api` controllers |

Nested types: `PurchaseKind{SKILL,BUNDLE,WALLET_TOPUP}`, `GrantStatus{ACTIVE,REFUNDED,CHARGED_BACK,
REVOKED}`, `GrantSource{STANDALONE,BUNDLE}`, `IssuedLicense(licenseId, token, kid)`,
`WalletPurchaseResult(orderId, ownedSkillIds)`. Each has `.wire()` for its string form.

---

## Trust zones

Three flags decide which beans load. **The same image is all three.**

```
hydropark.api.enabled      # public ingress. Holds NO signing key, NO MoR webhook secret.
hydropark.worker.enabled   # no public ingress. Sole holder of MoR webhook secret.
                           # ONLY principal that writes settled_orders and grants.
hydropark.issuer.enabled   # no public ingress. Sole holder of the Ed25519 private keys.
```

Gate beans with `@ConditionalOnProperty(name="hydropark.issuer.enabled", havingValue="true")`.

For each of `LicenseIssuerPort` and `SettlementPort`, provide **two** implementations:
- **Local**: `@ConditionalOnProperty(name="hydropark.<zone>.enabled", havingValue="true")` — the real thing.
- **Remote**: `@ConditionalOnProperty(name="hydropark.<zone>.enabled", havingValue="false")` — an HTTP
  client to `hydropark.internal.issuer-url` / `worker-url`, using the `internalRestClient` bean.

The zone that owns the capability exposes it under `/internal/**` (already guarded by
`InternalAuthFilter` + constant-time token compare).

> **Isolation is not authorization (§6.2 N3).** The remote client is a network boundary, not a
> permission. The Issuer re-verifies settlement for the exact `(user, skill)` on every call,
> regardless of which internal caller asked.

---

## MongoDB conventions

- `@Document(collection = "snake_case_name")` — names are fixed, see the table below.
- Every persisted field carries `@Field("snake_case")`. Java stays camelCase.
- `@Id private String id;` — a UUIDv7 string from `Uuid7.generate()`, **except** `skills.id` and
  `bundles.id`, which are human slugs (`cooking-assistant`, `home-starter-pack`).
- Timestamps are `java.time.Instant`, fields `created_at` / `updated_at`.
- **Never declare `@Indexed` or `@CompoundIndex`.** `auto-index-creation` is off. Every index is
  created by a versioned migration. Several correctness properties are enforced by an index and
  nothing else.
- **No cross-collection foreign keys exist** (§11.2 #3). Validate referenced ids in the service layer
  at write time. Mongo will not do it for you.
- Multi-document writes that must be atomic go through `@Transactional` (a `MongoTransactionManager`
  is already configured, majority read+write concern). Ports called inside a transaction join the
  ambient session automatically — never open your own.

### Collections (fixed names)

| Package | Collections |
|---|---|
| `auth` | `users`, `oauth_identities`, `refresh_tokens`, `email_verification_tokens`, `password_reset_tokens`, `step_up_challenges` |
| `catalog` | `skills`, `skill_versions`, `bundles`, `bundle_members`, `regional_prices` |
| `commerce` | `orders`, `webhook_events`, `settled_orders`, `idempotency_keys` |
| `licensing` | `grants`, `licenses`, `license_audit` |
| `devices` | `devices` |
| `wallet` | `wallet_accounts`, `wallet_transactions` |

---

## Non-negotiable security properties

These are the reasons the design looks the way it does. If your code makes any of them false, the
ticket is not done.

1. **Server-derived pricing (SF1).** The client's `amount` is ignored for `skill`/`bundle`. Only
   `wallet_topup` honours a client amount. The **settlement worker** — not the request handler —
   is the sole price authority for wallet spends.
2. **Order status is monotonic (B6).** `pending → paid → {refunded|charged_back}`; `failed` is
   terminal. A refund arriving *before* `paid` goes `pending → refunded` directly and sticks, so a
   late duplicate `succeeded` can never re-grant. **Terminal states never transition again.**
3. **Webhook dedupe is insert-first (B6).** Unique index on `webhook_events.provider_event_id`;
   insert, and let the duplicate-key error short-circuit *before* any grant is created.
4. **Webhook verification happens in the worker, never at the edge (§3.5).** `POST /v1/webhooks/mor`
   is public, holds no secret, verifies nothing: it captures raw bytes + headers, enqueues, returns
   200 fast. The worker holds the HMAC secret and verifies over the **raw body, constant-time,
   before parsing**.
5. **Ownership is grants, never a mutable row (§13.11).** Effective entitlement = ≥1 grant with
   `status=active`. Unique on `(order_id, skill_id)`; **never** unique on `(user_id, skill_id)` — a
   user may hold both a standalone and a bundle grant, and refunding one must not strip the other.
6. **The Issuer re-verifies settlement (§6.2).** Before signing it confirms an `active` grant for
   *exactly* this `(user_id, skill_id)` whose `order_id` has a row in `settled_orders`. Not "some
   settled order exists for this user" — that would let a compromised internal caller mint a license
   for any skill in the catalog.
7. **The license JWS is signed over exact bytes.** `b64u(header) + "." + b64u(payload)`, Ed25519,
   attached compact JWS. The client verifies over the bytes it received and only then parses. No
   canonical-JSON re-serialization, ever.
8. **Wallet debit is self-guarding.** One atomic `findOneAndUpdate` matching
   `{_id, status:'active', balance:{$gte:p}}` with `$inc:{balance:-p}`. A null result means
   insufficient/frozen. Never read-then-write. Balance may go **negative** via clawback and is never
   clamped — a `balance >= 0` constraint would abort the clawback that the design requires.
9. **Only settled credit is spendable.** Top-up credit is unusable until `settled=true`.
10. **Access-token `alg` is pinned** before signature verification (already done in
    `AccessTokenService`). Never widen it.

---

## Report back

Finish with: files created, ports implemented, any place you deviated from `BACKEND-DESIGN.md` and
why, and anything you could not implement. **Do not claim a test passed — you did not run it.**
