// ---------------------------------------------------------------------------
// Asserts that the Atlas role split in atlas-roles.js actually holds.
//
// "Isolation is not authorization" (BACKEND-DESIGN §6.2 N3) is only true if the
// database enforces it. Run this after atlas-roles.js, once per zone user, and
// again after any privilege edit. It writes only throwaway `privcheck-*` docs
// and cleans them up.
//
//   mongosh "mongodb+srv://hp_api_user:...@cluster/hydropark" \
//     --eval "var ROLE='hp_api'" --file privcheck.js
//   ... and again with ROLE='hp_worker', ROLE='hp_issuer'
//
// Every line must read PASS. A single FAIL means a compromised tier can do
// something the design says it cannot.
// ---------------------------------------------------------------------------
// Asserts the Atlas role split actually holds. Run as each zone user.
// Usage: mongosh "<uri>" --eval "var ROLE='hp_api'" --file privcheck.js
const d = db.getSiblingDB("hydropark");
let fails = 0;

function attempt(fn) {
  try {
    fn();
    return "ALLOWED";
  } catch (e) {
    const msg = String(e.message || e);
    if (/not authorized|Unauthorized/i.test(msg)) return "DENIED";
    return "ERROR:" + msg.slice(0, 60);
  }
}

function expect(label, want, got) {
  const ok = want === got;
  if (!ok) fails++;
  print(`  [${ok ? "PASS" : "FAIL"}] ${label.padEnd(46)} want=${want.padEnd(8)} got=${got}`);
}

const probeId = "privcheck-" + ROLE;

print(`\n=== ${ROLE} ===`);

// Reads every zone legitimately performs.
expect("find grants", "ALLOWED", attempt(() => d.grants.findOne()));
expect("find settled_orders", "ALLOWED", attempt(() => d.settled_orders.findOne()));

// THE keystone: only hp_worker may write the settlement log or ownership grants.
const wantSettlementWrite = ROLE === "hp_worker" ? "ALLOWED" : "DENIED";
expect("insert settled_orders", wantSettlementWrite, attempt(() => d.settled_orders.insertOne({ _id: probeId, user_id: "x" })));
expect("insert grants", wantSettlementWrite, attempt(() => d.grants.insertOne({ _id: probeId, user_id: "x", skill_id: "y" })));

// Only hp_issuer mints licenses / appends to the signer audit log.
const wantLicenseWrite = ROLE === "hp_issuer" ? "ALLOWED" : "DENIED";
expect("insert licenses", wantLicenseWrite, attempt(() => d.licenses.insertOne({ _id: probeId })));
expect("insert license_audit", wantLicenseWrite, attempt(() => d.license_audit.insertOne({ _id: probeId })));

// Only hp_worker moves money.
const wantWalletWrite = ROLE === "hp_worker" ? "ALLOWED" : "DENIED";
expect("insert wallet_transactions", wantWalletWrite, attempt(() => d.wallet_transactions.insertOne({ _id: probeId })));

// Only hp_api serves users/orders/devices.
const wantApiWrite = ROLE === "hp_api" ? "ALLOWED" : "DENIED";
expect("insert users", wantApiWrite, attempt(() => d.users.insertOne({ _id: probeId })));
expect("insert devices", wantApiWrite, attempt(() => d.devices.insertOne({ _id: probeId })));
expect("insert device_slot_counters", wantApiWrite, attempt(() => d.device_slot_counters.insertOne({ _id: probeId, activeSlots: 0 })));

// GDPR cascade deletes sub-collections but NEVER the users row (it anonymizes in place).
expect("remove refresh_tokens", wantApiWrite, attempt(() => d.refresh_tokens.deleteOne({ _id: "nonexistent" })));
expect("remove users", "DENIED", attempt(() => d.users.deleteOne({ _id: "nonexistent" })));

// No running zone may create or drop an index. Correctness invariants live in indexes.
expect("createIndex on skills", "DENIED", attempt(() => d.skills.createIndex({ privcheck: 1 })));
expect("dropIndex on webhook_events", "DENIED", attempt(() => d.webhook_events.dropIndex("webhook_events_provider_event_id_unique_partial")));

// Nor write the migration ledger.
expect("insert schema_migrations", "DENIED", attempt(() => d.schema_migrations.insertOne({ _id: probeId })));

// Clean up anything that did land.
[d.settled_orders, d.grants, d.licenses, d.license_audit, d.wallet_transactions, d.users, d.devices, d.device_slot_counters].forEach((c) => {
  try { c.deleteOne({ _id: probeId }); } catch (e) { /* not authorized to clean = also fine */ }
});

print(`  -> ${fails === 0 ? "all expectations held" : fails + " EXPECTATION(S) VIOLATED"}`);
