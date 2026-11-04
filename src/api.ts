import { randomUUID, timingSafeEqual } from "node:crypto";
import { withTx, type Db } from "./db.js";

// Implements https://koyaacademy.com/assessment-api (Clinic booking API 1.0).
// Web-standard Request in, Response out, so it runs on Netlify Functions and in tests alike.

export interface Context {
  db: Db;
  apiKey: string;
  now?: () => Date;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

/** Constant-time compare, so the key can't be guessed from response timing. */
function keyMatches(given: string | null, expected: string): boolean {
  if (!given || !expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function handle(req: Request, ctx: Context): Promise<Response> {
  const now = ctx.now ?? (() => new Date());
  try {
    // Level 2: every request needs the key. An unset key on the server locks everything.
    if (!keyMatches(req.headers.get("x-api-key"), ctx.apiKey)) {
      throw new HttpError(401, "missing or invalid API key");
    }

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
      const id = decodeURIComponent(match[1]);
      if (method === "GET") return await getBooking(ctx.db, id);
      if (method === "DELETE") return await cancelBooking(ctx.db, id);
      throw new HttpError(405, "method not allowed");
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
  const input = (body && typeof body === "object" && !Array.isArray(body) ? body : {}) as Record<string, unknown>;

  // Level 2: trim, lower-case the email, and turn away anything missing or invalid.
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const slotId = str(input.slot_id);
  const name = str(input.name);
  const email = str(input.email).toLowerCase();
  if (!slotId) throw new HttpError(400, "slot_id is required");
  if (!name) throw new HttpError(400, "name is required");
  if (!email) throw new HttpError(400, "email is required");
  if (!EMAIL_RE.test(email)) throw new HttpError(400, "email is not valid");

  const slot = await db.query("select start_at from slots where id = $1", [slotId]);
  if (!slot.rows[0]) throw new HttpError(404, "slot not found");
  if (new Date(slot.rows[0].start_at) <= now) throw new HttpError(400, "slot has already started");

  // Level 3: the partial unique index decides, not a "check then insert" in
  // code (which two simultaneous requests could both pass). Exactly one insert
  // wins; the others hit the conflict and get no row back.
  const { rows } = await db.query<BookingRow>(
    `insert into bookings (id, slot_id, name, email, status, created_at)
     values ($1, $2, $3, $4, 'confirmed', $5)
     on conflict (slot_id) where status = 'confirmed' do nothing
     returning ${BOOKING_COLUMNS}`,
    [randomUUID(), slotId, name, email, now],
  );
  if (!rows[0]) throw new HttpError(409, "slot is already booked");
  return json(201, present(rows[0]));
}

async function cancelBooking(db: Db, id: string): Promise<Response> {
  // Conditional update: of two cancels racing, only one can flip the status.
  const { rows } = await db.query<BookingRow>(
    `update bookings set status = 'cancelled'
     where id = $1 and status = 'confirmed'
     returning ${BOOKING_COLUMNS}`,
    [id],
  );
  if (rows[0]) return json(200, present(rows[0]));
  const exists = await db.query("select 1 from bookings where id = $1", [id]);
  if (!exists.rows[0]) throw new HttpError(404, "booking not found");
  throw new HttpError(409, "booking is already cancelled");
}

async function getBooking(db: Db, id: string): Promise<Response> {
  const { rows } = await db.query<BookingRow>(`select ${BOOKING_COLUMNS} from bookings where id = $1`, [id]);
  if (!rows[0]) throw new HttpError(404, "booking not found");
  return json(200, present(rows[0]));
}
