import pg from "pg";

// Slots and bookings live in Postgres so they survive between requests and
// across serverless instances.

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

const SCHEMA = `
create table if not exists slots (
  id        text primary key,
  provider  text not null,
  start_raw text not null,          -- returned exactly as it was sent to /reset
  end_raw   text not null,
  start_at  timestamptz not null,   -- used for sorting
  end_at    timestamptz not null
);

create table if not exists bookings (
  id         text primary key,
  slot_id    text not null references slots(id) on delete cascade,
  name       text not null,
  email      text not null,
  status     text not null check (status in ('confirmed', 'cancelled')),
  created_at timestamptz not null default now()
);

-- Level 3: the database itself refuses a second confirmed booking for a slot,
-- however many requests arrive at once. Cancelled bookings don't count.
create unique index if not exists bookings_one_confirmed_per_slot
  on bookings (slot_id) where status = 'confirmed';

-- Level 4: a stable insert order for paging through a person's bookings.
alter table bookings add column if not exists seq bigserial;
create unique index if not exists bookings_seq on bookings (seq);
create index if not exists bookings_email_seq on bookings (email, seq);

-- Level 4: one stored response per Idempotency-Key.
create table if not exists idempotency_keys (
  key          text primary key,
  request_hash text not null,
  status_code  int not null,
  response     jsonb not null,
  created_at   timestamptz not null default now()
);

-- Level 5: one row per booking attempt, counted over a sliding minute.
create table if not exists booking_attempts (
  id    bigserial primary key,
  email text not null,
  at    timestamptz not null
);
create index if not exists booking_attempts_email_at on booking_attempts (email, at);
`;

let pool: Db | undefined;
let ready: Promise<void> | undefined;

export function connectionString(): string {
  const url = process.env.DATABASE_URL ?? process.env.NETLIFY_DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  return url;
}

/**
 * One small pool per function instance, schema checked once.
 *
 * Serverless sizing: an instance handles one request at a time, so it needs
 * one connection. Under a burst the platform starts many instances, so each
 * must hold as few connections as possible and let idle ones go quickly, or
 * together they exhaust the database's connection limit. In production, point
 * DATABASE_URL at a pooled endpoint (e.g. Neon's "-pooler" host).
 */
export async function getDb(url = connectionString()): Promise<Db> {
  if (!pool) {
    const p = new pg.Pool({
      connectionString: url,
      max: 1,
      idleTimeoutMillis: 5_000,
      connectionTimeoutMillis: 10_000,
      allowExitOnIdle: true,
      ssl: /localhost|127\.0\.0\.1|\/tmp/.test(url) ? undefined : { rejectUnauthorized: false },
    });
    pool = p;
    ready = migrate(p).catch(async (err) => {
      // Don't cache a failure: let the next request start over.
      pool = undefined;
      ready = undefined;
      await p.end().catch(() => {});
      throw err;
    });
  }
  const db = pool;
  await ready;
  return db;
}

// Bump whenever SCHEMA changes, so running instances pick up the new DDL.
const SCHEMA_VERSION = 5;

async function schemaIsCurrent(q: Db | Tx): Promise<boolean> {
  const { rows } = await q.query(
    `select to_regclass('schema_version') is not null as exists`,
  );
  if (!rows[0].exists) return false;
  const v = await q.query("select version from schema_version");
  return v.rows[0]?.version === SCHEMA_VERSION;
}

export async function migrate(db: Db): Promise<void> {
  // Every cold start lands here, often many at once under load. DDL takes
  // table locks even when there's nothing to create, and that can deadlock
  // with bookings in flight on warm instances. So: one cheap read in the
  // common case, and the DDL only when the schema is actually out of date.
  if (await schemaIsCurrent(db)) return;

  await withTx(db, async (tx) => {
    // Serialise migrations; re-check once we hold the lock, since another
    // instance may have just finished.
    await tx.query("select pg_advisory_xact_lock(0)");
    if (await schemaIsCurrent(tx)) return;
    await tx.query(SCHEMA);
    await tx.query("create table if not exists schema_version (version int not null)");
    await tx.query("delete from schema_version");
    await tx.query("insert into schema_version (version) values ($1)", [SCHEMA_VERSION]);
  });
}

export async function withTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
