import { beforeEach, describe, expect, it } from "vitest";
import { book, send, SLOTS, t } from "./helpers.js";

beforeEach(async () => {
  expect((await send("POST", "/reset", { slots: SLOTS })).status).toBe(200);
});

const bookingCount = async () => (await t.db.query("select count(*)::int as n from bookings")).rows[0].n;

describe("Level 4: idempotent retries", () => {
  it("a retry with the same key and body returns the same booking, and books nothing new", async () => {
    const h = { "idempotency-key": "retry-1" };
    const first = await send("POST", "/bookings", book("s1"), h);
    const again = await send("POST", "/bookings", book("s1"), h);
    expect(first.status).toBe(201);
    expect(again).toMatchObject({ status: 201, body: first.body });
    expect(await bookingCount()).toBe(1);
  });

  it("treats the same body with different key order or spacing as the same request", async () => {
    const h = { "idempotency-key": "order" };
    const first = await send("POST", "/bookings", { slot_id: "s1", name: "Ada", email: "a@b.co" }, h);
    const again = await send("POST", "/bookings", '{ "email": "a@b.co",  "name": "Ada", "slot_id": "s1" }', h);
    expect(again.body.id).toBe(first.body.id);
  });

  it("10 simultaneous retries with one key create exactly one booking", async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () => send("POST", "/bookings", book("s2"), { "idempotency-key": "burst" })),
    );
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    expect(await bookingCount()).toBe(1);
  });

  it("replays the same status for failed requests too", async () => {
    const h = { "idempotency-key": "err" };
    expect((await send("POST", "/bookings", book("nope"), h)).status).toBe(404);
    expect((await send("POST", "/bookings", book("nope"), h)).status).toBe(404);

    await send("POST", "/bookings", book("s1", "bo@example.com"));
    const h2 = { "idempotency-key": "conflict" };
    expect((await send("POST", "/bookings", book("s1"), h2)).status).toBe(409);
    expect((await send("POST", "/bookings", book("s1"), h2)).status).toBe(409);
  });

  it("422 when the key is reused with a different body, and nothing is booked", async () => {
    const h = { "idempotency-key": "k" };
    await send("POST", "/bookings", book("s1"), h);
    const res = await send("POST", "/bookings", book("s2"), h);
    expect(res).toMatchObject({ status: 422, body: { error: expect.any(String) } });
    expect(await bookingCount()).toBe(1);
  });

  it("different keys are independent, and requests without a key still work", async () => {
    expect((await send("POST", "/bookings", book("s1"), { "idempotency-key": "a" })).status).toBe(201);
    expect((await send("POST", "/bookings", book("s2"), { "idempotency-key": "b" })).status).toBe(201);
    expect((await send("POST", "/bookings", book("s3"))).status).toBe(201);
    expect((await send("POST", "/bookings", book("s3"))).status).toBe(409);
  });

  it("reset clears stored keys", async () => {
    const h = { "idempotency-key": "after-reset" };
    const first = await send("POST", "/bookings", book("s1"), h);
    await send("POST", "/reset", { slots: SLOTS });
    const again = await send("POST", "/bookings", book("s1"), h);
    expect(again.status).toBe(201);
    expect(again.body.id).not.toBe(first.body.id);
  });
});

describe("Level 4: paging through a person's bookings", () => {
  const DAYS = Array.from({ length: 7 }, (_, i) => ({
    id: `d${i}`,
    provider: "Dr Ade",
    start: `2099-01-0${i + 1}T09:00:00Z`,
    end: `2099-01-0${i + 1}T09:30:00Z`,
  }));

  it("pages oldest first, matching email case-insensitively, until next_cursor is null", async () => {
    await send("POST", "/reset", { slots: DAYS });
    const ids: string[] = [];
    for (const s of DAYS.slice(0, 5)) ids.push((await send("POST", "/bookings", book(s.id))).body.id);
    await send("POST", "/bookings", book("d5", "someone@else.com"));

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const q = `/bookings?email=ADA@Example.com&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const { status, body } = await send("GET", q);
      expect(status).toBe(200);
      expect(body.bookings.length).toBeLessThanOrEqual(2);
      seen.push(...body.bookings.map((b: { id: string }) => b.id));
      cursor = body.next_cursor;
      pages++;
    } while (cursor);
    expect(seen).toEqual(ids);
    expect(pages).toBe(3);
  });

  it("includes cancelled bookings, and doesn't skip or repeat when new ones arrive between pages", async () => {
    await send("POST", "/reset", { slots: DAYS });
    const a = (await send("POST", "/bookings", book("d0"))).body;
    const b = (await send("POST", "/bookings", book("d1"))).body;
    await send("DELETE", `/bookings/${a.id}`);

    const page1 = (await send("GET", "/bookings?email=ada@example.com&limit=1")).body;
    expect(page1.bookings.map((x: { id: string; status: string }) => [x.id, x.status])).toEqual([[a.id, "cancelled"]]);

    const c = (await send("POST", "/bookings", book("d2"))).body;
    const page2 = (await send("GET", `/bookings?email=ada@example.com&limit=5&cursor=${page1.next_cursor}`)).body;
    expect(page2.bookings.map((x: { id: string }) => x.id)).toEqual([b.id, c.id]);
    expect(page2.next_cursor).toBeNull();
  });

  it("defaults to 10 per page", async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      id: `m${i}`, provider: "Dr Ade", start: `2099-02-${String(i + 1).padStart(2, "0")}T09:00:00Z`, end: `2099-02-${String(i + 1).padStart(2, "0")}T09:30:00Z`,
    }));
    await send("POST", "/reset", { slots: many });
    for (const s of many) await send("POST", "/bookings", book(s.id));
    const first = (await send("GET", "/bookings?email=ada@example.com")).body;
    expect(first.bookings).toHaveLength(10);
    const rest = (await send("GET", `/bookings?email=ada@example.com&cursor=${first.next_cursor}`)).body;
    expect(rest.bookings).toHaveLength(2);
    expect(rest.next_cursor).toBeNull();
  });

  it("an email with no bookings gets an empty last page", async () => {
    expect((await send("GET", "/bookings?email=nobody@example.com")).body).toEqual({ bookings: [], next_cursor: null });
  });

  it.each(["0", "51", "-1", "abc", "1.5", "", "10abc"])("400 for limit=%s", async (limit) => {
    const res = await send("GET", `/bookings?email=a@b.co&limit=${limit}`);
    expect(res).toMatchObject({ status: 400, body: { error: expect.any(String) } });
  });

  it("accepts limit 1 and 50", async () => {
    expect((await send("GET", "/bookings?email=a@b.co&limit=1")).status).toBe(200);
    expect((await send("GET", "/bookings?email=a@b.co&limit=50")).status).toBe(200);
  });

  it("400 without an email, or with a made-up cursor", async () => {
    expect((await send("GET", "/bookings")).status).toBe(400);
    expect((await send("GET", "/bookings?email=a@b.co&cursor=garbage")).status).toBe(400);
  });
});
