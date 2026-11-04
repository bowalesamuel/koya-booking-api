import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { withTx, type Db, type Tx } from "./db.js";

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
      if (method === "POST") return await createBooking(ctx.db, req, now());
      if (method === "GET") return await listBookings(ctx.db, url.searchParams);
      throw new HttpError(405, "method not allowed");
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
    await tx.query("truncate bookings, slots, idempotency_keys");
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

type Outcome = { status: number; body: unknown };

/** Stable hash of the request body, so key order and whitespace don't matter. */
function hashBody(raw: string): string {
  let canonical = raw;
  try {
    const sort = (v: unknown): unknown =>
      Array.isArray(v)
        ? v.map(sort)
        : v && typeof v === "object"
          ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])]))
          : v;
    canonical = JSON.stringify(sort(JSON.parse(raw)));
  } catch {
    // Not valid JSON: hash the raw text. The request gets a 400 anyway.
  }
  return createHash("sha256").update(canonical).digest("hex");
}

async function createBooking(db: Db, req: Request, now: Date): Promise<Response> {
  const raw = await req.text();
  const idemKey = req.headers.get("idempotency-key");
  if (!idemKey) {
    const { status, body } = await attemptBooking(db, raw, now);
    return json(status, body);
  }

  // Level 4: the whole attempt runs in one transaction holding a lock on the
  // key, so a retry that arrives while the first request is still running
  // waits for it and then replays its stored response instead of booking again.
  const requestHash = hashBody(raw);
  const { status, body } = await withTx(db, async (tx): Promise<Outcome> => {
    await tx.query("select pg_advisory_xact_lock(hashtext($1))", [idemKey]);
    const { rows } = await tx.query(
      "select request_hash, status_code, response from idempotency_keys where key = $1",
      [idemKey],
    );
    if (rows[0]) {
      if (rows[0].request_hash !== requestHash) {
        return { status: 422, body: { error: "Idempotency-Key was already used with a different request body" } };
      }
      return { status: rows[0].status_code, body: rows[0].response };
    }

    const result = await attemptBooking(tx, raw, now);
    await tx.query(
      "insert into idempotency_keys (key, request_hash, status_code, response) values ($1, $2, $3, $4)",
      [idemKey, requestHash, result.status, JSON.stringify(result.body)],
    );
    return result;
  });
  return json(status, body);
}

/** One booking attempt, as a status and body, so the result can be stored and replayed. */
async function attemptBooking(q: Db | Tx, raw: string, now: Date): Promise<Outcome> {
  try {
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      throw new HttpError(400, "request body must be valid JSON");
    }
    return { status: 201, body: await bookSlot(q, body, now) };
  } catch (err) {
    if (err instanceof HttpError) return { status: err.status, body: { error: err.message } };
    throw err;
  }
}

async function bookSlot(db: Db | Tx, body: unknown, now: Date) {
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
  return present(rows[0]);
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

// Level 4: cursor pagination. The cursor is the last row's insert sequence,
// base64url-encoded so clients treat it as opaque. Unlike page numbers, it
// can't skip or repeat rows when new bookings arrive between pages.
const encodeCursor = (seq: string) => Buffer.from(`seq:${seq}`).toString("base64url");

function decodeCursor(cursor: string): string {
  const m = Buffer.from(cursor, "base64url").toString().match(/^seq:(\d{1,18})$/);
  if (!m) throw new HttpError(400, "cursor is not valid");
  return m[1];
}

async function listBookings(db: Db, params: URLSearchParams): Promise<Response> {
  const email = (params.get("email") ?? "").trim().toLowerCase();
  if (!email) throw new HttpError(400, "email is required");

  let limit = 10;
  const rawLimit = params.get("limit");
  if (rawLimit !== null) {
    if (!/^\d+$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 50) {
      throw new HttpError(400, "limit must be a whole number from 1 to 50");
    }
    limit = Number(rawLimit);
  }

  const cursor = params.get("cursor");
  const after = cursor ? decodeCursor(cursor) : "0";

  // Fetch one extra row to know whether there's another page.
  const { rows } = await db.query<BookingRow & { seq: string }>(
    `select seq, ${BOOKING_COLUMNS} from bookings
     where email = $1 and seq > $2::bigint
     order by seq
     limit $3`,
    [email, after, limit + 1],
  );
  const page = rows.slice(0, limit);
  const nextCursor = rows.length > limit ? encodeCursor(page[page.length - 1].seq) : null;
  return json(200, { bookings: page.map(present), next_cursor: nextCursor });
}
