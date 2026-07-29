import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { api } from "./_generated/api";

/* Plain HTTP endpoint so the app stays a dependency-free static file — the client
   syncs with fetch(), no Convex SDK in the browser. CORS is open because auth is the
   capability key itself, never a cookie, so cross-origin requests carry no ambient
   authority. */

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const http = httpRouter();

http.route({
  path: "/sync",
  method: "OPTIONS",
  handler: httpAction(async () => new Response(null, { status: 204, headers: CORS })),
});

http.route({
  path: "/sync",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    let body: any;
    try {
      body = await req.json();
    } catch {
      return new Response(JSON.stringify({ error: "invalid json" }), { status: 400, headers: CORS });
    }
    const { key, state } = body || {};
    if (typeof key !== "string" || !/^[a-f0-9]{32,64}$/.test(key)) {
      return new Response(JSON.stringify({ error: "bad key" }), { status: 400, headers: CORS });
    }
    if (!state || !Array.isArray(state.log)) {
      return new Response(JSON.stringify({ error: "bad state" }), { status: 400, headers: CORS });
    }
    if (JSON.stringify(state).length > 900_000) {
      return new Response(JSON.stringify({ error: "state too large" }), { status: 413, headers: CORS });
    }
    const merged = await ctx.runMutation(api.sync.push, { key, state });
    return new Response(JSON.stringify({ state: merged }), {
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }),
});

export default http;
