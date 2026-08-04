import { internalMutation } from "./_generated/server";
import { v } from "convex/values";

const VALID_KEY = /^[a-f0-9]{32,64}$/;

function newSyncKey() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/* Rotation is leak response, so it is deliberately not a "move" the old key can
   follow: the state is copied to a fresh key, every owner row is re-pointed, and
   the old key is tombstoned in the same transaction. Convex serializes mutations,
   so two concurrent rotations chain (the second reads the first's key and rotates
   from that) rather than forking the state.

   It stops future access. It cannot un-read what an attacker already pulled. */
export const rotate = internalMutation({
  args: { subject: v.union(v.string(), v.null()), oldKey: v.union(v.string(), v.null()) },
  returns: v.string(),
  handler: async (ctx, args) => {
    let current: string;
    if (args.subject !== null) {
      const owner = await ctx.db
        .query("keyOwners")
        .withIndex("by_subject", (q) => q.eq("subject", args.subject as string))
        .unique();
      if (!owner) throw new Error("no key for this account");
      current = owner.key;
    } else {
      if (args.oldKey === null || !VALID_KEY.test(args.oldKey)) throw new Error("invalid key");
      current = args.oldKey;
    }

    const row = await ctx.db
      .query("states")
      .withIndex("by_key", (q) => q.eq("key", current))
      .unique();
    // Rotating a dead key would mint a live one from a capability that was already
    // revoked, handing an attacker exactly what rotation took away.
    if (row?.revoked) throw new Error("key revoked");

    const key = newSyncKey();
    if (row) {
      await ctx.db.insert("states", { key, state: row.state, updated: Date.now() });
      await ctx.db.patch(row._id, { state: null, revoked: true, revokedAt: Date.now() });
    }

    // .collect(), not .unique(): two Google accounts legitimately share one key when
    // both sign in on the same device, and those users are the likeliest to rotate.
    // Re-pointing is unconditional — a stale owner row would resurrect the dead key
    // on the next sign-in.
    const owners = await ctx.db
      .query("keyOwners")
      .withIndex("by_key", (q) => q.eq("key", current))
      .collect();
    for (const owner of owners) {
      await ctx.db.patch(owner._id, { key, rotatedAt: Date.now() });
    }
    return key;
  },
});

export const getOrCreate = internalMutation({
  args: { subject: v.string(), key: v.union(v.string(), v.null()) },
  returns: v.string(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("keyOwners")
      .withIndex("by_subject", (q) => q.eq("subject", args.subject))
      .unique();
    if (row) return row.key;

    const key = args.key === null ? newSyncKey() : args.key;
    if (!VALID_KEY.test(key)) throw new Error("invalid recovery key");
    await ctx.db.insert("keyOwners", {
      subject: args.subject,
      key,
      createdAt: Date.now(),
    });
    return key;
  },
});
