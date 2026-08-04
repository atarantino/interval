#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const backendSource = fs.readFileSync(path.join(root, "backend/convex/sync.ts"), "utf8");
const acornModule = await import("../backend/node_modules/prettier/plugins/acorn.js");
const { transform } = await import("../backend/node_modules/esbuild/lib/main.js");

const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)];
assert.equal(scripts.length, 1, "expected one inline script");
const inline = scripts[0][1];
const sourceFile = await acornModule.default.parsers.acorn.parse(
  inline,
  { filepath: "index.inline.js" },
);

const wantedVariables = new Set(["PROBLEMS", "TIER_INFO", "lkey", "kkey", "validTime"]);
const wantedFunctions = new Set([
  "normalizePrefTs",
  "migrate",
  "canonical",
  "mergeStates",
]);
const clientParts = [];
for (const statement of sourceFile.body) {
  if (statement.type === "FunctionDeclaration" && wantedFunctions.has(statement.id?.name)) {
    clientParts.push(inline.slice(statement.start, statement.end));
  } else if (statement.type === "VariableDeclaration" &&
    statement.declarations.some((d) =>
      d.id.type === "Identifier" && wantedVariables.has(d.id.name))) {
    clientParts.push(inline.slice(statement.start, statement.end));
  }
}
assert.equal(clientParts.length, wantedVariables.size + wantedFunctions.size,
  "could not extract every client migration/merge declaration");

const clientContext = {};
vm.runInNewContext(
  `${clientParts.join("\n")}\nthis.api = { migrate, mergeStates };`,
  clientContext,
  { filename: "index.inline.merge.js" },
);
const client = clientContext.api;

const compiledBackend = (await transform(backendSource, {
  loader: "ts",
  format: "cjs",
  target: "es2022",
  sourcefile: "sync.ts",
})).code;
const backendExports = {};
const validator = new Proxy({}, { get: () => () => ({}) });
const backendContext = {
  exports: backendExports,
  module: { exports: backendExports },
  require(specifier) {
    if (specifier === "./_generated/server") return { mutation: (definition) => definition };
    if (specifier === "convex/values") return { v: validator };
    throw new Error(`unexpected backend import: ${specifier}`);
  },
};
vm.runInNewContext(compiledBackend, backendContext, { filename: "sync.compiled.js" });
const backend = backendContext.module.exports;

const plain = (value) => JSON.parse(JSON.stringify(value));
// Only forward `message` when there is one: Node rejects an explicit `undefined`
// with ERR_INVALID_ARG_TYPE, which would mask a real failure behind a TypeError.
const same = (actual, expected, message) => message === undefined
  ? assert.deepEqual(plain(actual), plain(expected))
  : assert.deepEqual(plain(actual), plain(expected), message);
const pass = (message) => console.log(`PASS  ${message}`);

const legacy = {
  log: [{ pid: 1, d: "2026-07-01", r: "cold", m: 18, n: "" }],
  klog: [{ kid: 101, d: "2026-07-02", r: "miss" }],
  dismissed: [9, 2, 2],
  newPerDay: 3,
  prefT: 1_000,
};
const migrated = plain(client.migrate(structuredClone(legacy)));
assert.equal(migrated.tier, 150);
assert.equal(migrated.linkPref, "nc");
same(migrated.dismissed, [2, 9]);
same(migrated.prefTs, {
  dismissed: 1_000,
  newPerDay: 1_000,
  tier: 0,
  linkPref: 0,
});
const invalidPrefs = plain(client.migrate({
  log: [],
  tier: "250",
  linkPref: "both",
  newPerDay: 0,
}));
assert.equal(invalidPrefs.tier, 150);
assert.equal(invalidPrefs.linkPref, "nc");
assert.equal(invalidPrefs.newPerDay, 2);
assert.equal("i" in migrated.log[0], false, "migration must not mint a log attempt ID");
assert.equal("i" in migrated.klog[0], false, "migration must not mint a kata attempt ID");
same(client.migrate(client.migrate(structuredClone(legacy))), migrated,
  "migration must be idempotent");
pass("migration preserves ID-less history and is idempotent");

const a = {
  log: [{ pid: 1, d: "2026-07-01", r: "cold", m: 18, n: "" }],
  dismissed: [2],
  newPerDay: 2,
  tier: 250,
  linkPref: "nc",
  prefTs: { dismissed: 100, newPerDay: 100, tier: 400, linkPref: 100 },
};
const b = {
  log: [{ pid: 1, d: "2026-07-01", r: "cold", m: 18, n: "hash set" }],
  dismissed: [3],
  newPerDay: 4,
  tier: 150,
  linkPref: "lc",
  prefTs: { dismissed: 200, newPerDay: 300, tier: 100, linkPref: 500 },
};
const ab = plain(client.mergeStates(structuredClone(a), structuredClone(b)));
const ba = plain(client.mergeStates(structuredClone(b), structuredClone(a)));
same(ab, ba);
assert.equal(ab.tier, 250);
assert.equal(ab.linkPref, "lc");
assert.equal(ab.newPerDay, 4);
same(ab.dismissed, [3]);
assert.equal(ab.log[0].n, "hash set");
same(client.mergeStates(ab, ab), ab);
pass("client A/B preference merges commute and are idempotent");

const legacyAttempt = { pid: 7, d: "2026-07-10", r: "cold", m: 20, n: "" };
const richerLegacyAttempt = { ...legacyAttempt, m: 17, n: "hash set" };
const legacyMergeLeft = { log: [legacyAttempt] };
const legacyMergeRight = { log: [richerLegacyAttempt] };
const legacyMerged = plain(client.mergeStates(legacyMergeLeft, legacyMergeRight));
assert.equal(legacyMerged.log.length, 1);
assert.equal(legacyMerged.log[0].n, "hash set");

const legacyLogKey = "7|2026-07-10|cold";
const legacyDeleted = plain(client.mergeStates(
  { log: [legacyAttempt] },
  { deletedLog: [legacyLogKey] },
));
same(legacyDeleted.log, []);
assert.ok(legacyDeleted.deletedLog.includes(legacyLogKey));

const malformedIdMerged = plain(client.mergeStates(
  { log: [{ ...legacyAttempt, i: { malformed: true } }] },
  { log: [{ ...richerLegacyAttempt, i: ["malformed"] }] },
));
assert.equal(malformedIdMerged.log.length, 1,
  "malformed IDs must fall back to composite identity");
pass("legacy log entries merge by composite key and legacy tombstones still delete them");

const ATTEMPT_X = "00000000000a";
const ATTEMPT_Y = "00000000000b";
const sameCompositeX = { i: ATTEMPT_X, pid: 8, d: "2026-07-11", r: "hints", m: 14, n: "first" };
const sameCompositeY = { i: ATTEMPT_Y, pid: 8, d: "2026-07-11", r: "hints", m: 12, n: "second" };
const stableIdLeft = { log: [sameCompositeX] };
const stableIdRight = { log: [sameCompositeY] };
const stableIdMerged = plain(client.mergeStates(stableIdLeft, stableIdRight));
same(stableIdMerged.log.map((entry) => entry.i), [ATTEMPT_X, ATTEMPT_Y]);
pass("different stable IDs preserve honest attempts with the same composite fields");

const relogLeft = { log: [sameCompositeX], deletedLog: [`i:${ATTEMPT_X}`] };
const relogRight = { log: [sameCompositeX, sameCompositeY] };
const relogMerged = plain(client.mergeStates(relogLeft, relogRight));
same(relogMerged.log.map((entry) => entry.i), [ATTEMPT_Y],
  "deleting one attempt must not suppress a later re-log sharing its problem/date/result");
assert.ok(relogMerged.deletedLog.includes(`i:${ATTEMPT_X}`),
  "the deleted attempt's own tombstone must survive the merge");
same(legacyDeleted.log, [], "legacy composite tombstones must remain effective");
pass("an ID tombstone deletes only its attempt, so a same-day re-log survives");

const DIRECT_ID = "000000000010";
const TRANSFER_ID = "000000000011";
const directAttempt = {
  i: DIRECT_ID, pid: 9, d: "2026-07-12", r: "cold", m: 11, n: "my genuine insight",
};
const transferAttempt = {
  i: TRANSFER_ID, pid: 9, d: "2026-07-12", r: "cold", m: null,
  n: "Transfer rep — solved cold on a sibling problem with a deliberately longer note",
};
const transferLeft = { log: [directAttempt] };
const transferRight = { log: [transferAttempt] };
const transferMerged = plain(client.mergeStates(transferLeft, transferRight));
assert.equal(transferMerged.log.length, 2);
assert.equal(transferMerged.log.find((entry) => entry.i === DIRECT_ID)?.n, "my genuine insight");
pass("transfer and direct reps both survive without replacing the direct note");

const mixedLeft = {
  log: [legacyAttempt, sameCompositeX],
  deletedLog: ["10|2026-07-13|video"],
};
const mixedRight = {
  log: [richerLegacyAttempt, sameCompositeY,
    { pid: 10, d: "2026-07-13", r: "video", m: 25, n: "deleted legacy" }],
};
const mixedAB = plain(client.mergeStates(mixedLeft, mixedRight));
const mixedBA = plain(client.mergeStates(mixedRight, mixedLeft));
same(mixedAB, mixedBA);
same(client.mergeStates(mixedAB, mixedRight), mixedAB);
assert.equal(mixedAB.log.length, 3);
pass("mixed legacy/ID-bearing log merges are commutative and idempotent");

const KATA_X = "00000000001a";
const KATA_Y = "00000000001b";
const legacyKataAttempt = { kid: 201, d: "2026-07-14", r: "miss" };
const legacyKataDuplicate = { ...legacyKataAttempt, elapsed: 30 };
const legacyKataLeft = { klog: [legacyKataAttempt] };
const legacyKataRight = { klog: [legacyKataDuplicate] };
const legacyKataMerged = plain(client.mergeStates(legacyKataLeft, legacyKataRight));
assert.equal(legacyKataMerged.klog.length, 1);

const legacyKataKey = "201|2026-07-14|miss";
const deletedLegacyKata = plain(client.mergeStates(
  { klog: [legacyKataAttempt] },
  { deletedKlog: [legacyKataKey] },
));
same(deletedLegacyKata.klog, []);

const kataAttemptX = { i: KATA_X, kid: 202, d: "2026-07-15", r: "hit" };
const kataAttemptY = { i: KATA_Y, kid: 202, d: "2026-07-15", r: "hit" };
const kataStableLeft = { klog: [kataAttemptX] };
const kataStableRight = { klog: [kataAttemptY] };
const kataStableMerged = plain(client.mergeStates(kataStableLeft, kataStableRight));
same(kataStableMerged.klog.map((entry) => entry.i), [KATA_X, KATA_Y]);

const kataRelogLeft = { klog: [kataAttemptX], deletedKlog: [`i:${KATA_X}`] };
const kataRelogRight = { klog: [kataAttemptX, kataAttemptY] };
const kataRelogMerged = plain(client.mergeStates(kataRelogLeft, kataRelogRight));
same(kataRelogMerged.klog.map((entry) => entry.i), [KATA_Y]);

const kataMixedLeft = { klog: [legacyKataAttempt, kataAttemptX] };
const kataMixedRight = { klog: [legacyKataDuplicate, kataAttemptY] };
const kataMixedAB = plain(client.mergeStates(kataMixedLeft, kataMixedRight));
same(client.mergeStates(kataMixedRight, kataMixedLeft), kataMixedAB);
same(client.mergeStates(kataMixedAB, kataMixedRight), kataMixedAB);
pass("klog has matching legacy, stable-ID, tombstone, commutativity, and idempotence coverage");

const orderingLeft = {
  log: [
    { i: "000000000001", pid: 20, d: "2026-07-20", r: "cold" },
    { i: "ffffffffffff", pid: 10, d: "2026-07-20", r: "cold" },
  ],
  klog: [
    { i: "000000000002", kid: 220, d: "2026-07-20", r: "hit" },
    { i: "eeeeeeeeeeee", kid: 210, d: "2026-07-20", r: "hit" },
  ],
};
const orderingMerged = plain(client.mergeStates(orderingLeft, {}));
same(orderingMerged.log.map((entry) => entry.pid), [10, 20]);
same(orderingMerged.klog.map((entry) => entry.kid), [210, 220]);
pass("same-day merge order groups entries by problem/kata ID before random identity");

assert.equal((inline.match(/state\.log\.push\(\{i:attemptId\(\)/g) || []).length, 2,
  "direct attempts and transfer reps must mint IDs");
assert.equal((inline.match(/state\.klog\.push\(\{i:attemptId\(\)/g) || []).length, 1,
  "kata attempts must mint IDs");
pass("all three fresh-attempt creation paths mint stable IDs");

same(backend.migrateState(structuredClone(legacy)), migrated);
const mergeFixtures = [
  [a, b],
  [legacyMergeLeft, legacyMergeRight],
  [{ log: [legacyAttempt] }, { deletedLog: [legacyLogKey] }],
  [stableIdLeft, stableIdRight],
  [relogLeft, relogRight],
  [transferLeft, transferRight],
  [mixedLeft, mixedRight],
  [legacyKataLeft, legacyKataRight],
  [{ klog: [legacyKataAttempt] }, { deletedKlog: [legacyKataKey] }],
  [kataStableLeft, kataStableRight],
  [kataRelogLeft, kataRelogRight],
  [kataMixedLeft, kataMixedRight],
  [orderingLeft, {}],
];
for (const [left, right] of mergeFixtures) {
  same(
    backend.mergeStates(structuredClone(left), structuredClone(right)),
    client.mergeStates(structuredClone(left), structuredClone(right)),
  );
  same(
    backend.mergeStates(structuredClone(right), structuredClone(left)),
    client.mergeStates(structuredClone(right), structuredClone(left)),
  );
}
pass("Convex and client migration/merge twins agree across every fixture in both directions");

const incoming = {
  ...migrated,
  tier: 250,
  linkPref: "lc",
  prefTs: { ...migrated.prefTs, tier: 2_000, linkPref: 2_001 },
};
const roundTrip = plain(backend.mergeStates(structuredClone(migrated), structuredClone(incoming)));
assert.equal(roundTrip.tier, 250);
assert.equal(roundTrip.linkPref, "lc");
same(backend.mergeStates(roundTrip, incoming), roundTrip);
pass("tier/linkPref survive a Convex merge round-trip");

console.log("PASS  state merge sanity checks complete (12 groups)");
