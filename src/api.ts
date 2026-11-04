import { randomUUID } from "node:crypto";
import { withTx, type Db } from "./db.js";

// Implements https://koyaacademy.com/assessment-api (Clinic booking API 1.0).
// Web-standard Request in, Response out, so it runs on Netlify Functions and in tests alike.

export interface Context {
  db: Db;
  now?: () => Date;
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export async function handle(req: Request, ctx: Context): Promise<Response> {
  const now = ctx.now ?? (() => new Date());
  try {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method.toUpperCase();

    if (path === "/reset") {
      if (method !== "POST") throw new HttpError(405, "method not allowed");
      return await reset(ctx.db, await readJson(req));
    }
    if (path === "/slots") {
      if (method !== "GET") throw new HttpError(405, "method not allowed");
      return await listSlots(ctx.db, url.searchParams.get("provider"));
    }
    if (path === "/bookings") {
      if (method !== "POST") throw new HttpError(405, "method not allowed");
      return await createBooking(ctx.db, await readJson(req), now());
    }
    const match = path.match(/^\/bookings\/([^/]+)$/);
    if (match) {
      if (method !== "GET") throw new HttpError(405, "method not allowed");
      return await getBooking(ctx.db, decodeURIComponent(match[1]));
    }
    throw new HttpError(404, "not found");
  } catch (err) {
    if (err instanceof HttpError) return json(err.status, { error: err.message });
    console.error(err);
    return json(500, { error: "internal server error" });
  }
}

async function readJson(req: Request): Promise<unknown> {
  try {
    return JSON.parse(await req.text());
  } catch {
    throw new HttpError(400, "request body must be valid JSON");
  }
}

// ---- Slots ---------------------------------------------------------------

async function reset(db: Db, body: unknown): Promise<Response> {
  const slots = (body as { slots?: unknown })?.slots;
  if (!Array.isArray(slots)) throw new HttpError(400, "slots must be an array");

  const seen = new Set<string>();
  const rows = slots.map((s, i) => {
    const slot = s as Record<string, unknown>;
    for (const field of ["id", "provider", "start", "end"]) {
      if (typeof slot?.[field] !== "string" || (slot[field] as string).trim() === "") {
        throw new HttpError(400, `slots[${i}].${field} is required`);
      }
    }
    const { id, provider, start, end } = slot as Record<string, string>;
    if (Number.isNaN(Date.parse(start)) || Number.isNaN(Date.parse(end))) {
      throw new HttpError(400, `slots[${i}] has an invalid start or end`);
    }
    if (seen.has(id)) throw new HttpError(400, `duplicate slot id "${id}"`);
    seen.add(id);
    return [id, provider, start, end];
  });

  // Deletes every booking and replaces all slots, in one transaction.
  await withTx(db, async (tx) => {
    await tx.query("truncate bookings, slots");
    if (rows.length) {
      await tx.query(
        `insert into slots (id, provider, start_raw, end_raw, start_at, end_at)
         select id, provider, s, e, s::timestamptz, e::timestamptz
         from unnest($1::text[], $2::text[], $3::text[], $4::text[]) as t(id, provider, s, e)`,
        [rows.map((r) => r[0]), rows.map((r) => r[1]), rows.map((r) => r[2]), rows.map((r) => r[3])],
      );
    }
  });
  return json(200, { slots: rows.length });
}

async function listSlots(db: Db, provider: string | null): Promise<Response> {
  const { rows } = await db.query(
    `select s.id, s.provider, s.start_raw as start, s.end_raw as "end",
            not exists (select 1 from bookings b where b.slot_id = s.id and b.status = 'confirmed') as available
     from slots s
     where $1::text is null or s.provider = $1
     order by s.start_at, s.id`,
    [provider],
  );
  return json(200, { slots: rows });
}

// ---- Bookings ------------------------------------------------------------

interface BookingRow {
  id: string;
  slot_id: string;
  name: string;
  email: string;
  status: "confirmed" | "cancelled";
  created_at: Date;
}

function present(b: BookingRow) {
  return {
    id: b.id,
    slot_id: b.slot_id,
    name: b.name,
    email: b.email,
    status: b.status,
    created_at: new Date(b.created_at).toISOString(),
  };
}

const BOOKING_COLUMNS = "id, slot_id, name, email, status, created_at";

async function createBooking(db: Db, body: unknown, now: Date): Promise<Response> {
  const input = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const { slot_id: slotId, name, email } = input as Record<string, string>;

  const slot = await db.query("select 1 from slots where id = $1", [slotId]);
  if (!slot.rows[0]) throw new HttpError(404, "slot not found");

  const { rows } = await db.query<BookingRow>(
    `insert into bookings (id, slot_id, name, email, status, created_at)
     values ($1, $2, $3, $4, 'confirmed', $5)
     returning ${BOOKING_COLUMNS}`,
    [randomUUID(), slotId, name, email, now],
  );
  return json(201, present(rows[0]));
}

async function getBooking(db: Db, id: string): Promise<Response> {
  const { rows } = await db.query<BookingRow>(`select ${BOOKING_COLUMNS} from bookings where id = $1`, [id]);
  if (!rows[0]) throw new HttpError(404, "booking not found");
  return json(200, present(rows[0]));
}
