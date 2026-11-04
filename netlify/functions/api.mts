import type { Config } from "@netlify/functions";
import { handle } from "../../src/api.js";
import { getDb } from "../../src/db.js";

export default async (req: Request) => handle(req, { db: await getDb(), apiKey: process.env.API_KEY ?? "" });

export const config: Config = {
  path: ["/reset", "/slots", "/bookings", "/bookings/:id"],
};
