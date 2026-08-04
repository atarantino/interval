import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { createRemoteJWKSet, jwtVerify } from "jose";

/* Plain HTTP endpoint so the app stays a dependency-free static file — the client
   syncs with fetch(), no Convex SDK in the browser. CORS is open because auth is the
   capability key itself, never a cookie, so cross-origin requests carry no ambient
   authority. */

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const RECOVER_ORIGINS = new Set([
  "https://intervalreps.vercel.app",
  "https://neetcode-spaced-reps.vercel.app",
  "http://localhost:8000",
]);
const GOOGLE_JWKS = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));

function recoverCors(req: Request): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
  const origin = req.headers.get("Origin");
  if (origin && RECOVER_ORIGINS.has(origin)) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

function recoverJson(req: Request, body: object, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...recoverCors(req), "Content-Type": "application/json" },
  });
}

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

http.route({
  path: "/recover",
  method: "OPTIONS",
  handler: httpAction(async (_ctx, req) =>
    new Response(null, { status: 204, headers: recoverCors(req) })),
});

http.route({
  path: "/recover",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    let body: any;
    try {
      body = await req.json();
    } catch {
      return recoverJson(req, { error: "invalid json" }, 400);
    }
    const { credential, key = null } = body || {};

    let subject: string;
    try {
      if (typeof credential !== "string" || !credential) throw new Error("missing credential");
      const clientId = process.env.GOOGLE_CLIENT_ID;
      if (!clientId) throw new Error("missing Google client id");
      // TODO: Add nonce/replay protection if this flow grows beyond key recovery.
      const { payload } = await jwtVerify(credential, GOOGLE_JWKS, {
        algorithms: ["RS256"],
        issuer: ["https://accounts.google.com", "accounts.google.com"],
        audience: clientId,
      });
      if (typeof payload.sub !== "string" || !payload.sub.trim()) throw new Error("missing subject");
      subject = `google:${payload.sub}`;
    } catch {
      return recoverJson(req, { error: "bad credential" }, 401);
    }
    if (key !== null && (typeof key !== "string" || !/^[a-f0-9]{32,64}$/.test(key))) {
      return recoverJson(req, { error: "bad key" }, 400);
    }

    const recoveredKey = await ctx.runMutation(internal.recover.getOrCreate, { subject, key });
    return recoverJson(req, { key: recoveredKey });
  }),
});

export default http;
