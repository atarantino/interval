import { mutation, internalMutation } from "./_generated/server";
import { ConvexError, v } from "convex/values";

/* Merge, not overwrite. Two devices can both log attempts before either syncs;
   last-write-wins would silently eat one side's reps. The data model makes real
   merging cheap:
   - log/klog entries are immutable facts → set-union by identity key, minus tombstones
   - katas are editable documents → newest edit wins per id, minus tombstones
   - small prefs are independent LWW registers → newest value wins per field
   The mutation runs atomically in Convex, so concurrent pushes serialize and both
   devices converge on the next round-trip.

   Keep this deliberately literal twin of index.html's migrate()/mergeStates().
   The client also merges the response with any edits made while its request was in
   flight, so both copies must make the same deterministic choice on every tie. */

const lkey = (a: any) => (typeof a.i === "string" && a.i) ? `i:${a.i}` : `${a.pid}|${a.d}|${a.r}`;
const kkey = (a: any) => (typeof a.i === "string" && a.i) ? `i:${a.i}` : `${a.kid}|${a.d}|${a.r}`;
const validTime = (n: any) => Number.isFinite(n) && n >= 0 ? n : 0;

function normalizePrefTs(st: any) {
  const legacy = validTime(st.prefT);
  const raw = st.prefTs && typeof st.prefTs === "object" ? st.prefTs : {};
  return {
    dismissed: Math.max(validTime(raw.dismissed), legacy),
    newPerDay: Math.max(validTime(raw.newPerDay), legacy),
    tier: validTime(raw.tier),
    linkPref: validTime(raw.linkPref),
  };
}

export function migrateState(input: any) {
  const st = input && typeof input === "object" ? { ...input } : {};
  if (!Array.isArray(st.log)) st.log = [];
  st.dismissed = [...new Set((Array.isArray(st.dismissed) ? st.dismissed : [])
    .filter((id: any) => Number.isInteger(id) && id >= 1 && id <= 250))]
    .sort((a: any, b: any) => a - b);
  if (!Number.isInteger(st.newPerDay) || st.newPerDay < 1 || st.newPerDay > 20) st.newPerDay = 2;
  if (![75, 150, 250].includes(st.tier)) st.tier = 150;
  if (st.linkPref !== "nc" && st.linkPref !== "lc") st.linkPref = "nc";
  if (!Array.isArray(st.katas)) st.katas = [];
  if (!Array.isArray(st.klog)) st.klog = [];
  if (!Number.isFinite(st.nextKataId)) {
    st.nextKataId = 1 + st.katas.reduce((m: number, k: any) => Math.max(m, k.id || 0), 0);
  }
  if (!Array.isArray(st.deletedLog)) st.deletedLog = [];
  if (!Array.isArray(st.deletedKlog)) st.deletedKlog = [];
  if (!Array.isArray(st.kataTombs)) st.kataTombs = [];
  st.prefT = validTime(st.prefT);
  st.prefTs = normalizePrefTs(st);
  return st;
}

function canonical(v: any): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v).sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "undefined";
}

export function mergeStates(a: any, b: any) {
  a = migrateState(a);
  b = migrateState(b);
  const deadLog = new Set<string>([...(a.deletedLog || []), ...(b.deletedLog || [])]);
  const deadKlog = new Set<string>([...(a.deletedKlog || []), ...(b.deletedKlog || [])]);
  const deadKata = new Set<(string | number)>([...(a.kataTombs || []), ...(b.kataTombs || [])]);

  const unionBy = (
    x: any[],
    y: any[],
    keyFn: (entry: any) => string,
    dead: Set<string>,
  ) => {
    const out = new Map<string, any>();
    for (const entry of [...(x || []), ...(y || [])]) {
      const key = keyFn(entry);
      if (dead.has(key)) continue;
      const prev = out.get(key);
      const richer = (entry.n || "").length - (prev?.n || "").length;
      if (!prev || richer > 0 || (richer === 0 && canonical(entry) > canonical(prev))) {
        out.set(key, entry);
      }
    }
    return [...out.values()].sort((m, n) => {
      const mid = m.pid ?? m.kid;
      const nid = n.pid ?? n.kid;
      return m.d < n.d ? -1 : m.d > n.d ? 1 :
        mid < nid ? -1 : mid > nid ? 1 : keyFn(m).localeCompare(keyFn(n));
    });
  };

  const katas = new Map<any, any>();
  for (const k of [...(a.katas || []), ...(b.katas || [])]) {
    if (deadKata.has(k.id)) continue;
    const prev = katas.get(k.id);
    if (!prev || (k.u || 0) > (prev.u || 0) ||
      ((k.u || 0) === (prev.u || 0) && canonical(k) > canonical(prev))) {
      katas.set(k.id, k);
    }
  }

  const pref = (name: "dismissed" | "newPerDay" | "tier" | "linkPref") => {
    const at = a.prefTs[name] || 0;
    const bt = b.prefTs[name] || 0;
    if (at !== bt) return at > bt ? a[name] : b[name];
    return canonical(a[name]) >= canonical(b[name]) ? a[name] : b[name];
  };
  const prefTs = Object.fromEntries(
    (["dismissed", "newPerDay", "tier", "linkPref"] as const)
      .map((name) => [name, Math.max(a.prefTs[name] || 0, b.prefTs[name] || 0)]),
  );

  return migrateState({
    log: unionBy(a.log, b.log, lkey, deadLog),
    klog: unionBy(a.klog, b.klog, kkey, deadKlog),
    katas: [...katas.values()].sort((m, n) =>
      String(m.id).localeCompare(String(n.id), undefined, { numeric: true })),
    dismissed: pref("dismissed"),
    newPerDay: pref("newPerDay"),
    tier: pref("tier"),
    linkPref: pref("linkPref"),
    prefTs,
    prefT: Math.max(a.prefT || 0, b.prefT || 0),
    deletedLog: [...deadLog].sort(),
    deletedKlog: [...deadKlog].sort(),
    kataTombs: [...deadKata].sort((m, n) =>
      String(m).localeCompare(String(n), undefined, { numeric: true })),
    nextKataId: Math.max(a.nextKataId || 1, b.nextKataId || 1),
  });
}

/* Delete a key's stored state entirely. Capability-gated like everything else:
   holding the key is what authorizes removing its data. Internal, and reached only
   through the HTTP route — a public mutation is callable by anyone holding the
   deployment URL, which put destruction on a different footing than every other
   operation in this model. */
export const wipe = internalMutation({
  args: { key: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("states")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .unique();
    if (row) await ctx.db.delete(row._id);
    return row !== null;
  },
});

export const push = mutation({
  args: { key: v.string(), state: v.any() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("states")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .unique();
    // Must precede the insert path below. An unseen key gets a fresh row, so without
    // this a device still holding a rotated key would recreate it as an empty state
    // and report healthy sync while writing somewhere nobody reads.
    if (row?.revoked) throw new ConvexError({ code: "revoked" });
    const merged = row ? mergeStates(row.state, args.state) : migrateState(args.state);
    if (row) {
      await ctx.db.patch(row._id, { state: merged, updated: Date.now() });
    } else {
      await ctx.db.insert("states", { key: args.key, state: merged, updated: Date.now() });
    }
    return merged;
  },
});
