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
const DEVICES_COLLECTIONS = ["devices"];
const WALLET_COLLECTIONS = ["wallet_accounts", "wallet_transactions"];

const ALL_COLLECTIONS = [
  ...AUTH_COLLECTIONS,
  ...CATALOG_COLLECTIONS,
  ...COMMERCE_ORDERS_COLLECTIONS,
  ...SETTLEMENT_COLLECTIONS,
  ...LICENSING_COLLECTIONS,
  ...DEVICES_COLLECTIONS,
  ...WALLET_COLLECTIONS,
];

function readWriteActions() {
  // No "remove" beyond what each role explicitly needs below - nothing in
  // this system hard-deletes rows as its normal write path (GDPR deletion
  // is a separate anonymization job, not modeled here). createIndex is
  // included because migrations run under these same zone identities in
  // some environments; drop it per-role below if that's not true in yours.
  return ["find", "insert", "update", "createIndex"];
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
db.createRole({
  role: "hp_api",
  privileges: [
    ...ALL_COLLECTIONS.filter((c) => !SETTLEMENT_COLLECTIONS.includes(c)).map(
      (c) => ({
        resource: { db: DB_NAME, collection: c },
        actions: readWriteActions(),
      })
    ),
    ...SETTLEMENT_COLLECTIONS.map((c) => ({
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
print("=== Done ===");
print(
  "Set the three URIs as MONGODB_URI_API / MONGODB_URI_WORKER / MONGODB_URI_ISSUER"
);
print("before running deploy/fly/bootstrap-secrets.ps1.");
