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
`;

let pool: Db | undefined;
let ready: Promise<void> | undefined;

export function connectionString(): string {
  const url = process.env.DATABASE_URL ?? process.env.NETLIFY_DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  return url;
}

/** One pool per process (per warm function instance), schema created once. */
export async function getDb(url = connectionString()): Promise<Db> {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: url,
      max: 5,
      ssl: /localhost|127\.0\.0\.1|\/tmp/.test(url) ? undefined : { rejectUnauthorized: false },
    });
    ready = migrate(pool);
  }
  await ready;
  return pool;
}

export async function migrate(db: Db): Promise<void> {
  // Serialise migrations so cold starts racing each other can't collide.
  await withTx(db, async (tx) => {
    await tx.query("select pg_advisory_xact_lock(0)");
    await tx.query(SCHEMA);
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
