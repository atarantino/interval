import { mutation } from "./_generated/server";
import { v } from "convex/values";

/* Merge, not overwrite. Two devices can both log attempts before either syncs;
   last-write-wins would silently eat one side's reps. The data model makes real
   merging cheap:
   - log/klog entries are immutable facts → set-union by identity key, minus tombstones
   - katas are editable documents → newest edit wins per id, minus tombstones
   - dismissed/newPerDay are small prefs → whichever side changed them most recently
   The mutation runs atomically in Convex, so concurrent pushes serialize and both
   devices converge on the next round-trip. */

const lkey = (a: any) => `${a.pid}|${a.d}|${a.r}`;
const kkey = (a: any) => `${a.kid}|${a.d}|${a.r}`;

function unionBy(a: any[], b: any[], keyFn: (x: any) => string, dead: Set<string>) {
  const out = new Map<string, any>();
  for (const x of [...(a || []), ...(b || [])]) {
    const k = keyFn(x);
    if (dead.has(k)) continue;
    const prev = out.get(k);
    // identical identity: keep the richer record (a note beats no note)
    if (!prev || ((x.n || "").length > (prev.n || "").length)) out.set(k, x);
  }
  return [...out.values()];
}

export function mergeStates(a: any, b: any) {
  const deadLog = new Set<string>([...(a.deletedLog || []), ...(b.deletedLog || [])]);
  const deadKlog = new Set<string>([...(a.deletedKlog || []), ...(b.deletedKlog || [])]);
  const deadKata = new Set<(string | number)>([...(a.kataTombs || []), ...(b.kataTombs || [])]);

  const katas = new Map<any, any>();
  for (const k of [...(a.katas || []), ...(b.katas || [])]) {
    if (deadKata.has(k.id)) continue;
    const prev = katas.get(k.id);
    if (!prev || (k.u || 0) >= (prev.u || 0)) katas.set(k.id, k);
  }

  const newerPrefs = (b.prefT || 0) >= (a.prefT || 0) ? b : a;
  const sortD = (x: any, y: any) => (x.d < y.d ? -1 : x.d > y.d ? 1 : 0);

  return {
    log: unionBy(a.log, b.log, lkey, deadLog).sort(sortD),
    klog: unionBy(a.klog, b.klog, kkey, deadKlog).sort(sortD),
    katas: [...katas.values()],
    dismissed: newerPrefs.dismissed || [],
    newPerDay: newerPrefs.newPerDay ?? 2,
    prefT: Math.max(a.prefT || 0, b.prefT || 0),
    deletedLog: [...deadLog],
    deletedKlog: [...deadKlog],
    kataTombs: [...deadKata],
    nextKataId: Math.max(a.nextKataId || 1, b.nextKataId || 1),
  };
}

/* Delete a key's stored state entirely. Capability-gated like everything else:
   holding the key is what authorizes removing its data. */
export const wipe = mutation({
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
    const merged = row ? mergeStates(row.state, args.state) : args.state;
    if (row) {
      await ctx.db.patch(row._id, { state: merged, updated: Date.now() });
    } else {
      await ctx.db.insert("states", { key: args.key, state: merged, updated: Date.now() });
    }
    return merged;
  },
});
