import type { Config } from "@netlify/functions";
import { handle } from "../../src/api.js";
import { getDb } from "../../src/db.js";

// The web page calls /web/* instead of the API directly, so the API key stays
// on the server and is never shipped to the browser. Only the patient-facing
// routes are exposed here (not /reset), and every rule of the API (validation,
// double-booking, idempotency, rate limits) still applies.

const ALLOWED: [string, RegExp][] = [
  ["GET", /^\/slots$/],
  ["GET", /^\/bookings$/],
  ["POST", /^\/bookings$/],
  ["GET", /^\/bookings\/[^/]+$/],
  ["DELETE", /^\/bookings\/[^/]+$/],
];

export default async (req: Request) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/web/, "").replace(/\/+$/, "");
  if (!ALLOWED.some(([method, re]) => method === req.method && re.test(path))) {
    return Response.json({ error: "not found" }, { status: 404 });
  }

  const apiKey = process.env.API_KEY ?? "";
  const headers = new Headers({ "x-api-key": apiKey, "content-type": "application/json" });
  const idemKey = req.headers.get("idempotency-key");
  if (idemKey) headers.set("idempotency-key", idemKey);

  const forwarded = new Request(new URL(path + url.search, url.origin), {
    method: req.method,
    headers,
    body: req.method === "POST" ? await req.text() : undefined,
  });
  try {
    return await handle(forwarded, { db: await getDb(), apiKey });
  } catch (err) {
    console.error(err);
    return Response.json({ error: "service unavailable" }, { status: 503 });
  }
};

export const config: Config = {
  path: ["/web/slots", "/web/bookings", "/web/bookings/:id"],
};
