import type { Config } from "@netlify/functions";
import { handle } from "../../src/api.js";
import { getDb } from "../../src/db.js";

export default async (req: Request) => {
  try {
    return await handle(req, { db: await getDb(), apiKey: process.env.API_KEY ?? "" });
  } catch (err) {
    // Only reachable if the database can't be reached at all; handle() catches everything else.
    console.error(err);
    return Response.json({ error: "service unavailable" }, { status: 503 });
  }
};

export const config: Config = {
  path: ["/reset", "/slots", "/bookings", "/bookings/:id"],
};
