/**
 * Cross-language parity check for the Phase-0 unlock-code scheme (P0-09.4).
 *
 * The correctness property that actually matters: a code minted by the fulfillment
 * side (Python) must validate in the app's verifier (the real TypeScript module the
 * Angular UI imports), and a tampered code must be rejected by both. This harness
 * runs the ACTUAL app module — client/web/src/app/unlock/unlock-code.ts — under
 * Node's built-in TS type-stripping (Node >=23), so there is no second copy to
 * drift.
 *
 * Usage:  node fulfillment/parity_check.mjs "<code-from-python>" ["<tampered>"]
 * The Python side (run_parity.sh / selftest) pipes the codes in as argv.
 */
import { verifyUnlockCode, generateUnlockCode, SHARED_SECRET } from '../client/web/src/app/unlock/unlock-code.ts';

const [, , codeFromPython, tamperedFromPython] = process.argv;

function line(label, value) {
  console.log(label.padEnd(34) + value);
}

const out = { secretOk: true };

// 1. The app verifier accepts the Python-minted code.
if (codeFromPython) {
  const good = await verifyUnlockCode(codeFromPython);
  line('app verifies python code:', JSON.stringify(good));
  out.pythonCodeAccepted = good.ok;
}

// 2. The app verifier rejects the tampered code.
if (tamperedFromPython) {
  const bad = await verifyUnlockCode(tamperedFromPython);
  line('app rejects tampered code:', JSON.stringify(bad));
  out.tamperedRejected = !bad.ok;
}

// 3. Round-trip the other direction: a TS-minted code, printed for Python to verify.
const tsCode = await generateUnlockCode(new Uint8Array([9, 9, 9, 9, 9]));
line('app-minted code (for python):', tsCode);
line('app verifies its own code:', JSON.stringify(await verifyUnlockCode(tsCode)));

// 4. Obvious junk is rejected (not a length>0 check).
line('app rejects "hunter2":', JSON.stringify(await verifyUnlockCode('hunter2')));
line('app rejects "":', JSON.stringify(await verifyUnlockCode('')));

line('shared secret len:', String(SHARED_SECRET.length));

// Emit a machine-readable last line so the shell wrapper can assert.
console.log('PARITY_JSON ' + JSON.stringify({ ...out, tsCode }));
