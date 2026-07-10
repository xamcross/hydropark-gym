// deploy/fly/atlas-roles.js
//
// Least-privilege Atlas custom DB roles (BACKEND-DESIGN.md §6.2, §11.2 #4;
// AGENT-CONTRACT.md "Non-negotiable security properties" #6; sprint/
// phase-1-backend.md P1-21.7).
//
// This is what makes "isolation ≠ authorization" (§6.2 N3) a fact about the
// database, not just about the network: even a FULLY COMPROMISED api tier -
// arbitrary code execution, attacker has the api container's MONGODB_URI -
// cannot forge a settlement, because the hp_api Atlas user is physically
// incapable of writing settled_orders or grants. The Issuer's independent
// re-verification (§6.2) and this role split are two separate, both-required
// layers - do not treat either as sufficient alone.
//
// -----------------------------------------------------------------------
// USAGE
//
//   mongosh "<atlas-connection-string-with-a-project-owner-or-dbAdmin-user>" \
//     --file atlas-roles.js
//
// Run it once against your Atlas cluster (any environment: dev/staging/prod -
// re-run per environment, since staging and prod must not share DB users any
// more than they share signing keys - P1-21.3). It is idempotent: existing
// hp_api/hp_worker/hp_issuer roles and hp_api_user/hp_worker_user/
// hp_issuer_user users are dropped and recreated, so it is safe to re-run
// after editing privileges below.
//
// Atlas-specific notes:
//   - Atlas also lets you define custom roles and database users through the
//     Atlas UI / Admin API (Project Access Manager) instead of this script -
//     either path produces the same role definitions in the cluster. This
//     script is the reviewable, versioned source of truth for what those
//     roles SHOULD be; if you provision through the UI, make it match this
//     file exactly (and keep this file in sync afterwards).
//   - Users are created on the `hydropark` database (see DB_NAME below), so
//     each zone's MONGODB_URI needs `authSource=hydropark` (or connect with
//     the database name in the path, which mongodb+srv:// URIs already do -
//     `mongodb+srv://user:pass@cluster/hydropark?...` - the path segment
//     doubles as authSource unless overridden).
//   - Passwords are generated here and printed ONCE, to the mongosh console
//     output - copy them immediately into MONGODB_URI_API /
//     MONGODB_URI_ISSUER / MONGODB_URI_WORKER before closing the terminal.
//     They are not stored anywhere by this script and cannot be re-printed;
//     re-run the script to rotate (this changes the password, which is safe -
//     nothing else depends on the old one once you update the Fly secret).
// -----------------------------------------------------------------------

const DB_NAME = "hydropark";
const db = db.getSiblingDB(DB_NAME);

// All collection names, from AGENT-CONTRACT.md's fixed collection table.
const AUTH_COLLECTIONS = [
  "users",
  "oauth_identities",
  "refresh_tokens",
  "email_verification_tokens",
  "password_reset_tokens",
  "step_up_challenges",
];
const CATALOG_COLLECTIONS = [
  "skills",
  "skill_versions",
  "bundles",
  "bundle_members",
  "regional_prices",
];
const COMMERCE_ORDERS_COLLECTIONS = ["orders", "webhook_events", "idempotency_keys"];
// The privileged pair. Only hp_worker may insert/update these.
const SETTLEMENT_COLLECTIONS = ["settled_orders", "grants"];
const LICENSING_COLLECTIONS = ["licenses", "license_audit"];
// `device_slot_counters` is the per-user atomic slot counter that replaces the
// advisory lock Postgres would have used (§11.1). It is a real collection the
// devices package reads and writes on every registration - omitting it here
// denies device registration outright.
const DEVICES_COLLECTIONS = ["devices", "device_slot_counters"];
const WALLET_COLLECTIONS = ["wallet_accounts", "wallet_transactions"];

// The migration ledger and its distributed lock. No running zone ever touches
// these - `hydropark.migration.enabled` is false in the `fly` profile - so they
// belong to hp_migrator alone and are deliberately kept out of ALL_COLLECTIONS.
const SYSTEM_COLLECTIONS = ["schema_migrations", "schema_migrations_lock"];

const ALL_COLLECTIONS = [
  ...AUTH_COLLECTIONS,
  ...CATALOG_COLLECTIONS,
  ...COMMERCE_ORDERS_COLLECTIONS,
  ...SETTLEMENT_COLLECTIONS,
  ...LICENSING_COLLECTIONS,
  ...DEVICES_COLLECTIONS,
  ...WALLET_COLLECTIONS,
];

/**
 * The normal write path for a running zone. Note what is NOT here:
 *
 *  - no `remove`: nothing in this system hard-deletes as its normal write path.
 *    The two places that do delete are granted it explicitly below.
 *  - no `createIndex`: indexes are created by versioned changesets running as
 *    hp_migrator, and `spring.data.mongodb.auto-index-creation` is false. A
 *    running app that can mint an index can also mint a *unique* index, and
 *    several correctness properties in this system are enforced by exactly one
 *    unique index. Don't hand that to the public tier.
 */
function readWriteActions() {
  return ["find", "insert", "update"];
}

/**
 * hp_migrator. Everything the changesets and the seeder actually do:
 *
 *  - `remove`      - MigrationRunner reaps an expired lock and releases its own
 *  - `dropIndex`   - V008 replaces the webhook dedupe index; V009 drops V005's
 *                    phantom license_audit index
 *  - `listIndexes` - both of those check before they drop
 *  - `createCollection` - the first createIndex on an absent collection creates it
 *
 * This identity exists so that migrations do not force the privilege split open.
 * It must NEVER be stored as a Fly app secret: no running zone should be able to
 * drop an index that a correctness invariant depends on.
 */
function migratorActions() {
  return [
    "find",
    "insert",
    "update",
    "remove",
    "createIndex",
    "dropIndex",
    "listIndexes",
    "listCollections",
    "createCollection",
    "collStats",
  ];
}

function dropRoleIfExists(roleName) {
  try {
    db.dropRole(roleName);
    print(`  (dropped pre-existing role ${roleName})`);
  } catch (e) {
    // didn't exist - fine
  }
}

function dropUserIfExists(userName) {
  try {
    db.dropUser(userName);
    print(`  (dropped pre-existing user ${userName})`);
  } catch (e) {
    // didn't exist - fine
  }
}

function randomPassword() {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 40; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

// ---------------------------------------------------------------------------
// hp_api - read/write on everything EXCEPT settled_orders/grants, which it
// may only READ. Effective ownership reads (GET /entitlements, catalog
// "owned" flag, etc.) need find on grants; nothing in the api zone ever
// needs to write either collection - that write path belongs to hp_worker
// alone.
// ---------------------------------------------------------------------------
print("=== hp_api ===");
dropRoleIfExists("hp_api");
// `remove` is granted on exactly the collections the api zone deletes from:
//   AccountService's GDPR cascade drops oauth_identities / refresh_tokens /
//   email_verification_tokens / password_reset_tokens / step_up_challenges;
//   AuthService consumes single-use verify + reset tokens; IdempotencyService
//   evicts idempotency_keys. NOT `users` - the deletion job anonymizes that row
//   in place rather than dropping it. Never on grants/settled_orders.
const API_DELETABLE = [
  ...AUTH_COLLECTIONS.filter((c) => c !== "users"),
  "idempotency_keys",
];

// The api zone READS these and never writes them:
//   licenses + license_audit are written only by hp_issuer (it alone mints and
//     supersedes a license, and alone appends to the signer's audit log);
//   wallet_accounts + wallet_transactions are written only by hp_worker, which
//     performs the atomic debit inside the settlement transaction (§5.4).
// GET /v1/licenses and GET /v1/wallet are reads. Giving the public tier write
// access here would let a compromised api forge issuance metadata or credit a
// wallet it was never allowed to touch.
const API_READ_ONLY = [
  ...SETTLEMENT_COLLECTIONS,
  ...LICENSING_COLLECTIONS,
  ...WALLET_COLLECTIONS,
];

db.createRole({
  role: "hp_api",
  privileges: [
    ...ALL_COLLECTIONS.filter(
      (c) => !API_READ_ONLY.includes(c) && !API_DELETABLE.includes(c)
    ).map((c) => ({
      resource: { db: DB_NAME, collection: c },
      actions: readWriteActions(),
    })),
    ...API_DELETABLE.map((c) => ({
      resource: { db: DB_NAME, collection: c },
      actions: [...readWriteActions(), "remove"],
    })),
    ...API_READ_ONLY.map((c) => ({
      resource: { db: DB_NAME, collection: c },
      actions: ["find"],
    })),
  ],
  roles: [],
});

// ---------------------------------------------------------------------------
// hp_worker - the ONLY role with insert/update on settled_orders + grants.
// Also needs the wallet collections (it performs the atomic debit +
// grant + settled_orders write in one transaction - §5.4) and read/write on
// orders/webhook_events/idempotency_keys to correlate webhooks and record
// order-status transitions, plus read on catalog for server-derived pricing
// (SF1 - the settlement worker, not the request handler, is the price
// authority for wallet spends).
// ---------------------------------------------------------------------------
print("=== hp_worker ===");
dropRoleIfExists("hp_worker");
db.createRole({
  role: "hp_worker",
  privileges: [
    ...SETTLEMENT_COLLECTIONS.map((c) => ({
      resource: { db: DB_NAME, collection: c },
      actions: readWriteActions(),
    })),
    ...WALLET_COLLECTIONS.map((c) => ({
      resource: { db: DB_NAME, collection: c },
      actions: readWriteActions(),
    })),
    ...COMMERCE_ORDERS_COLLECTIONS.map((c) => ({
      resource: { db: DB_NAME, collection: c },
      actions: readWriteActions(),
    })),
    ...CATALOG_COLLECTIONS.map((c) => ({
      resource: { db: DB_NAME, collection: c },
      actions: ["find"],
    })),
  ],
  roles: [],
});

// ---------------------------------------------------------------------------
// hp_issuer - read-only on grants + settled_orders + devices (it
// independently re-verifies settlement for the exact (user, skill) before
// signing, §6.2 - it must never be able to WRITE the very log it's checking).
// Write access is scoped to licenses + license_audit only.
// ---------------------------------------------------------------------------
print("=== hp_issuer ===");
dropRoleIfExists("hp_issuer");
db.createRole({
  role: "hp_issuer",
  privileges: [
    ...SETTLEMENT_COLLECTIONS.map((c) => ({
      resource: { db: DB_NAME, collection: c },
      actions: ["find"],
    })),
    ...DEVICES_COLLECTIONS.map((c) => ({
      resource: { db: DB_NAME, collection: c },
      actions: ["find"],
    })),
    ...LICENSING_COLLECTIONS.map((c) => ({
      resource: { db: DB_NAME, collection: c },
      actions: readWriteActions(),
    })),
  ],
  roles: [],
});

// ---------------------------------------------------------------------------
// hp_migrator - runs the versioned changesets and the catalog seeder. It is the
// ONLY identity able to create or drop an index, and the only one that can write
// the schema_migrations ledger or its lock.
//
// It exists because no zone identity can run the migrations, and giving one the
// privileges to do so would quietly undo the split this file exists to create:
// migrations create indexes on `grants` (which hp_api may only read) and on
// `users`/`licenses` (which hp_worker may only read). Granting either of them
// enough rights to migrate would hand the public tier the ability to drop the
// unique index that makes webhook dedupe work, or the partial index that stops a
// second active license per device.
//
// Custody: keep this URI OUT of Fly secrets and off every app. It belongs in the
// operator's shell or a CI secret, used by deploy/fly/migrate-cloud.ps1 and then
// forgotten. bootstrap-secrets.ps1 refuses to set it on any app.
// ---------------------------------------------------------------------------
print("=== hp_migrator ===");
dropRoleIfExists("hp_migrator");
db.createRole({
  role: "hp_migrator",
  privileges: [...ALL_COLLECTIONS, ...SYSTEM_COLLECTIONS].map((c) => ({
    resource: { db: DB_NAME, collection: c },
    actions: migratorActions(),
  })),
  roles: [],
});

// ---------------------------------------------------------------------------
// Users. One per zone, each granted exactly the one matching role above.
// ---------------------------------------------------------------------------
function createZoneUser(userName, roleName) {
  dropUserIfExists(userName);
  const password = randomPassword();
  db.createUser({
    user: userName,
    pwd: password,
    roles: [{ role: roleName, db: DB_NAME }],
  });
  print(`${userName}  (role: ${roleName})`);
  print(`  password: ${password}`);
  print(
    `  MONGODB_URI: mongodb+srv://${userName}:${password}@<your-cluster-host>/${DB_NAME}?retryWrites=true&w=majority`
  );
  print("");
}

print("");
print("=== Creating Hydropark least-privilege Atlas users ===");
print("Copy each password/URI NOW - it will not be printed again.");
print("");
createZoneUser("hp_api_user", "hp_api");
createZoneUser("hp_worker_user", "hp_worker");
createZoneUser("hp_issuer_user", "hp_issuer");
createZoneUser("hp_migrator_user", "hp_migrator");

print("=== Done ===");
print(
  "Set the three ZONE URIs as MONGODB_URI_API / MONGODB_URI_WORKER / MONGODB_URI_ISSUER"
);
print("before running deploy/fly/bootstrap-secrets.ps1.");
print("");
print("hp_migrator_user is DIFFERENT: it is the only identity that can create or");
print("drop an index. Export its URI as MONGODB_URI_MIGRATOR for");
print("deploy/fly/migrate-cloud.ps1, and never set it as a Fly app secret.");
