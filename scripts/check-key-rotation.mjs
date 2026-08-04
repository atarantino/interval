/* Key rotation is leak response, so the properties worth pinning are all negative
   ones: the old key must stop working, must not come back on its own, and must not
   become a route to its replacement. Runs the real recover.ts and sync.ts handlers
   against an in-memory stand-in for ctx.db — no deployment, no network. */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

// Same resolution as check-state-merge.mjs: the repo ships no root package.json, so
// esbuild is reached through the backend's install rather than a bare specifier.
const { transform } = await import("../backend/node_modules/esbuild/lib/main.js");

const root = new URL("../backend/convex/", import.meta.url);

class ConvexError extends Error {
  constructor(data) {
    super(typeof data === "string" ? data : JSON.stringify(data));
    this.data = data;
  }
}

async function loadModule(file) {
  const source = await readFile(new URL(file, root), "utf8");
  const code = (await transform(source, {
    loader: "ts", format: "cjs", target: "es2022", sourcefile: file,
  })).code;
  const exports = {};
  const validator = new Proxy({}, { get: () => () => ({}) });
  const context = {
    exports,
    module: { exports },
    crypto: globalThis.crypto,
    Date,
    require(specifier) {
      if (specifier === "./_generated/server") {
        return {
          mutation: (d) => d,
          internalMutation: (d) => d,
        };
      }
      if (specifier === "convex/values") return { v: validator, ConvexError };
      throw new Error(`unexpected import: ${specifier}`);
    },
  };
  vm.runInNewContext(code, context, { filename: file });
  return context.module.exports;
}

/* Minimal ctx.db: enough of the query builder for withIndex(...).unique()/.collect(),
   plus insert/patch/delete. Index names are ignored — the equality predicate the
   handler supplies is the whole filter, which is exactly what these tables use. */
function makeDb(seed = {}) {
  const tables = new Map(Object.entries(seed).map(([t, rows]) => [
    t, rows.map((r, i) => ({ _id: `${t}:${i}`, ...r })),
  ]));
  let counter = 0;
  const rowsOf = (t) => tables.get(t) ?? (tables.set(t, []), tables.get(t));
  return {
    tables,
    query(table) {
      let predicate = () => true;
      const builder = {
        withIndex(_name, fn) {
          const clauses = [];
          fn({ eq: (field, value) => (clauses.push([field, value]), builder.q) });
          predicate = (row) => clauses.every(([f, val]) => row[f] === val);
          return builder;
        },
        q: { eq: (field, value) => builder.q },
        async unique() {
          const hits = rowsOf(table).filter(predicate);
          if (hits.length > 1) throw new Error(`unique() matched ${hits.length} rows`);
          return hits[0] ?? null;
        },
        async collect() {
          return rowsOf(table).filter(predicate);
        },
      };
      return builder;
    },
    async insert(table, doc) {
      const row = { _id: `${table}:new${counter++}`, ...doc };
      rowsOf(table).push(row);
      return row._id;
    },
    async patch(id, fields) {
      for (const rows of tables.values()) {
        const row = rows.find((r) => r._id === id);
        if (row) return Object.assign(row, fields);
      }
      throw new Error(`no such row: ${id}`);
    },
    async delete(id) {
      for (const rows of tables.values()) {
        const i = rows.findIndex((r) => r._id === id);
        if (i >= 0) return rows.splice(i, 1);
      }
      throw new Error(`no such row: ${id}`);
    },
  };
}

const recover = await loadModule("recover.ts");
const sync = await loadModule("sync.ts");

const KEY = "a".repeat(32);
const OTHER = "b".repeat(32);
const HEX = /^[a-f0-9]{32}$/;
const pass = (m) => console.log(`PASS  ${m}`);
const stateOf = (db, key) => db.tables.get("states").find((r) => r.key === key);
// JSON round-trip before comparing: values built inside the vm carry that realm's
// Array.prototype, and deepStrictEqual compares prototypes.
const logOf = (state) =>
  JSON.parse(JSON.stringify((state?.log ?? []).map((e) => e.i ?? `${e.pid}|${e.d}|${e.r}`)));
const attempt = { i: "aaaaaaaaaaaa", pid: 1, d: "2026-08-04", r: "cold", m: 9, n: "carried" };

async function rejects(fn, match, message) {
  await assert.rejects(fn, (err) => new RegExp(match).test(String(err?.message ?? err)), message);
}

/* ---- the state survives, and the old key does not ---- */
{
  const db = makeDb({
    states: [{ key: KEY, state: { log: [attempt] }, updated: 1 }],
    keyOwners: [{ subject: "google:1", key: KEY, createdAt: 1 }],
  });
  const fresh = await recover.rotate.handler({ db }, { subject: "google:1", oldKey: null });

  assert.ok(HEX.test(fresh), "rotation must mint a valid key");
  assert.notEqual(fresh, KEY);
  assert.deepEqual(logOf(stateOf(db, fresh).state), ["aaaaaaaaaaaa"],
    "the log must be carried to the new key intact");

  const old = stateOf(db, KEY);
  assert.equal(old.revoked, true, "the old key must be tombstoned, not deleted");
  assert.equal(old.state, null, "the tombstone must not retain the data");
  assert.equal(db.tables.get("keyOwners")[0].key, fresh, "the owner row must re-point");
  pass("rotation carries the log to a fresh key and tombstones the old one");

  // The whole point: a tombstone must not be a route to its replacement.
  assert.equal(JSON.stringify(old).includes(fresh), false,
    "the tombstone must record no pointer to the new key");
  pass("the tombstone leaks no path from the old key to the new one");
}

/* ---- push() refuses a revoked key instead of resurrecting it ---- */
{
  const db = makeDb({
    states: [{ key: KEY, state: { log: [attempt] }, updated: 1 }],
    keyOwners: [],
  });
  await recover.rotate.handler({ db }, { subject: null, oldKey: KEY });

  await rejects(
    () => sync.push.handler({ db }, { key: KEY, state: { log: [] } }),
    "revoked",
    "pushing a rotated key must fail",
  );
  // The regression that makes revocation meaningless: push() inserts a row for any
  // unseen key, so a missing guard turns a dead key into a live empty one.
  assert.equal(db.tables.get("states").filter((r) => r.key === KEY).length, 1,
    "a rejected push must not create a second row for the dead key");
  assert.equal(stateOf(db, KEY).state, null, "a rejected push must not refill the tombstone");
  pass("a rotated key cannot resurrect itself through push()");

  await rejects(
    () => recover.rotate.handler({ db }, { subject: null, oldKey: KEY }),
    "key revoked",
    "rotating a revoked key must fail rather than mint a live one",
  );
  pass("a revoked key cannot be rotated into a live one");
}

/* ---- a live key still works normally after someone else rotates ---- */
{
  const db = makeDb({
    states: [
      { key: KEY, state: { log: [attempt] }, updated: 1 },
      { key: OTHER, state: { log: [] }, updated: 1 },
    ],
    keyOwners: [],
  });
  await recover.rotate.handler({ db }, { subject: null, oldKey: KEY });
  const merged = await sync.push.handler({ db }, { key: OTHER, state: { log: [attempt] } });
  assert.deepEqual(logOf(merged), ["aaaaaaaaaaaa"], "an unrelated key must be unaffected");
  pass("rotating one key leaves every other key working");
}

/* ---- two accounts sharing one key both re-point ---- */
{
  // Reachable today: sign in as A on a device holding K, then as B on the same
  // device. getOrCreate writes a row per subject, both pointing at K. A .unique()
  // lookup here would throw for exactly the users most likely to rotate.
  const db = makeDb({
    states: [{ key: KEY, state: { log: [] }, updated: 1 }],
    keyOwners: [
      { subject: "google:1", key: KEY, createdAt: 1 },
      { subject: "google:2", key: KEY, createdAt: 2 },
    ],
  });
  const fresh = await recover.rotate.handler({ db }, { subject: "google:1", oldKey: null });
  assert.deepEqual(db.tables.get("keyOwners").map((r) => r.key), [fresh, fresh],
    "every owner of the rotated key must be re-pointed");
  pass("two accounts sharing a key both follow the rotation");
}

/* ---- signing in after rotation returns the new key, never the dead one ---- */
{
  const db = makeDb({
    states: [{ key: KEY, state: { log: [attempt] }, updated: 1 }],
    keyOwners: [{ subject: "google:1", key: KEY, createdAt: 1 }],
  });
  const fresh = await recover.rotate.handler({ db }, { subject: "google:1", oldKey: null });
  // A rotated-out device signs in holding its stale key; the account's binding wins.
  const recovered = await recover.getOrCreate.handler({ db }, { subject: "google:1", key: KEY });
  assert.equal(recovered, fresh, "sign-in must return the rotated key, not the revoked one");
  pass("a rotated-out device recovers the new key by signing in");
}

/* ---- rotating an account with no key is an error, not a silent mint ---- */
{
  const db = makeDb({ states: [], keyOwners: [] });
  await rejects(
    () => recover.rotate.handler({ db }, { subject: "google:nobody", oldKey: null }),
    "no key for this account",
    "rotating an unbound account must fail",
  );
  assert.equal(db.tables.get("states").length, 0, "a failed rotation must write nothing");
  pass("rotating an account with no key fails without writing");
}

/* ---- malformed capability input is rejected ---- */
{
  const db = makeDb({ states: [], keyOwners: [] });
  for (const bad of [null, "", "nothex", "a".repeat(31), "A".repeat(32)]) {
    await rejects(
      () => recover.rotate.handler({ db }, { subject: null, oldKey: bad }),
      "invalid key",
      `rotate must reject ${JSON.stringify(bad)}`,
    );
  }
  pass("malformed keys are rejected on the capability path");
}

console.log("PASS  key rotation sanity checks complete (8 groups)");
