import { internalMutation } from "./_generated/server";
import { v } from "convex/values";

const VALID_KEY = /^[a-f0-9]{32,64}$/;

function newSyncKey() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

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
