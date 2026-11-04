import pg from "pg";
import { afterAll, beforeAll } from "vitest";
import { handle, type Context } from "../src/api.js";
import { migrate } from "../src/db.js";

// Tests run against a real Postgres (default: local koya_booking_test), so
// database guarantees are tested for real, not mocked.
const DB_URL = process.env.TEST_DATABASE_URL ?? "postgres://localhost/koya_booking_test";
const BASE = "https://clinic.test";
export const KEY = "test-key";

export const t = {
  db: undefined as unknown as pg.Pool,
  /** Set to freeze time; undefined means real time. */
  clock: undefined as Date | undefined,
  ctx: undefined as unknown as Context,
};

beforeAll(async () => {
  t.db = new pg.Pool({ connectionString: DB_URL, max: 20 });
  await migrate(t.db);
  t.ctx = { db: t.db, apiKey: KEY, now: () => t.clock ?? new Date() };
});
afterAll(() => t.db.end());

export function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  return handle(
    new Request(BASE + path, {
      method,
      headers: { "x-api-key": KEY, "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    }),
    t.ctx,
  );
}

export async function send(method: string, path: string, body?: unknown, headers?: Record<string, string>) {
  const res = await call(method, path, body, headers);
  return { status: res.status, body: await res.json(), headers: res.headers };
}

export const SLOTS = [
  { id: "s2", provider: "Dr Bello", start: "2099-12-10T10:00:00Z", end: "2099-12-10T10:30:00Z" },
  { id: "s1", provider: "Dr Ade", start: "2099-12-10T09:00:00Z", end: "2099-12-10T09:30:00Z" },
  { id: "s3", provider: "Dr Ade", start: "2099-12-11T09:00:00Z", end: "2099-12-11T09:30:00Z" },
  { id: "past", provider: "Dr Ade", start: "2020-01-01T09:00:00Z", end: "2020-01-01T09:30:00Z" },
];

export const book = (slot_id: string, email = "ada@example.com", name = "Ada Obi") => ({ slot_id, name, email });
