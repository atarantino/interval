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

const wantedVariables = new Set(["PROBLEMS", "TIER_INFO", "validTime"]);
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
const same = (actual, expected, message) =>
  assert.deepEqual(plain(actual), plain(expected), message);
const pass = (message) => console.log(`PASS  ${message}`);

const legacy = {
  log: [{ pid: 1, d: "2026-07-01", r: "cold", m: 18, n: "" }],
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
pass("old-format client state migrates to tier 150 / NeetCode with legacy pref timestamps");

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

same(backend.migrateState(structuredClone(legacy)), migrated);
same(backend.mergeStates(structuredClone(a), structuredClone(b)), ab);
same(backend.mergeStates(structuredClone(b), structuredClone(a)), ab);
pass("Convex and client migration/merge functions make identical deterministic choices");

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

console.log("PASS  state merge sanity checks complete (4 groups)");
