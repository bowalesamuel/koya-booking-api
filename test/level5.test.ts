import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { book, send, SLOTS, t } from "./helpers.js";

beforeEach(async () => {
  expect((await send("POST", "/reset", { slots: SLOTS })).status).toBe(200);
});
afterEach(() => {
  t.clock = undefined;
});

const T0 = Date.parse("2030-01-01T00:00:00Z");
const at = (seconds: number) => (t.clock = new Date(T0 + seconds * 1000));

describe("Level 5: rate limiting bookings per email", () => {
  it("allows 5 attempts a minute, failed ones included; the 6th gets 429 with Retry-After", async () => {
    at(0);
    expect((await send("POST", "/bookings", book("s1"))).status).toBe(201);
    expect((await send("POST", "/bookings", book("s1"))).status).toBe(409);
    expect((await send("POST", "/bookings", book("nope"))).status).toBe(404);
    expect((await send("POST", "/bookings", { ...book("s2"), name: "" })).status).toBe(400);
    at(10);
    expect((await send("POST", "/bookings", book("past"))).status).toBe(400);

    at(20);
    const limited = await send("POST", "/bookings", book("s2"));
    expect(limited).toMatchObject({ status: 429, body: { error: expect.any(String) } });
    // The oldest attempt (t=0) leaves the window at t=60, 40 seconds from now.
    expect(limited.headers.get("retry-after")).toBe("40");
    // A 429 never books anything.
    expect((await send("GET", "/slots")).body.slots.find((s: { id: string }) => s.id === "s2").available).toBe(true);
  });

  it("other emails aren't affected", async () => {
    at(0);
    for (let i = 0; i < 5; i++) await send("POST", "/bookings", book("nope"));
    expect((await send("POST", "/bookings", book("s1"))).status).toBe(429);
    expect((await send("POST", "/bookings", book("s1", "bo@example.com"))).status).toBe(201);
  });

  it("counts the email after trimming and ignoring case", async () => {
    at(0);
    for (const email of ["ada@example.com", "ADA@example.com", " Ada@Example.com ", "ada@EXAMPLE.COM", "ada@example.com"]) {
      await send("POST", "/bookings", book("nope", email));
    }
    expect((await send("POST", "/bookings", book("s1", "Ada@example.com"))).status).toBe(429);
  });

  it("is a sliding window: attempts free up one by one as they turn a minute old", async () => {
    for (let i = 0; i < 5; i++) {
      at(i * 10); // attempts at 0, 10, 20, 30, 40s
      await send("POST", "/bookings", book("nope"));
    }
    at(59);
    expect((await send("POST", "/bookings", book("s1"))).headers.get("retry-after")).toBe("1");
    at(60.001);
    expect((await send("POST", "/bookings", book("s1"))).status).toBe(201); // t=0 has dropped out
    at(61);
    const next = await send("POST", "/bookings", book("s2"));
    expect(next.status).toBe(429); // 10, 20, 30, 40 and 60 are still in the window
    expect(next.headers.get("retry-after")).toBe("9");
  });

  it("a rejected attempt doesn't extend the wait", async () => {
    at(0);
    for (let i = 0; i < 5; i++) await send("POST", "/bookings", book("nope"));
    for (let s = 1; s < 60; s += 10) {
      at(s);
      expect((await send("POST", "/bookings", book("s1"))).status).toBe(429);
    }
    at(60.001);
    expect((await send("POST", "/bookings", book("s1"))).status).toBe(201);
  });

  it("holds under a burst: exactly 5 of 12 simultaneous attempts get through", async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, () => send("POST", "/bookings", book("nope", "spam@example.com"))),
    );
    expect(results.filter((r) => r.status === 404)).toHaveLength(5);
    const limited = results.filter((r) => r.status === 429);
    expect(limited).toHaveLength(7);
    for (const r of limited) expect(Number(r.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
  });

  it("replaying an Idempotency-Key doesn't use up an attempt", async () => {
    at(0);
    const h = { "idempotency-key": "replay" };
    const first = await send("POST", "/bookings", book("s1"), h);
    for (let i = 0; i < 6; i++) {
      expect(await send("POST", "/bookings", book("s1"), h)).toMatchObject({ status: 201, body: { id: first.body.id } });
    }
  });

  it("a 429 isn't stored against an Idempotency-Key, so the retry works after the wait", async () => {
    at(0);
    for (let i = 0; i < 5; i++) await send("POST", "/bookings", book("nope"));
    const h = { "idempotency-key": "later" };
    expect((await send("POST", "/bookings", book("s1"), h)).status).toBe(429);
    at(61);
    expect((await send("POST", "/bookings", book("s1"), h)).status).toBe(201);
  });

  it("reset clears the counters", async () => {
    at(0);
    for (let i = 0; i < 5; i++) await send("POST", "/bookings", book("nope"));
    await send("POST", "/reset", { slots: SLOTS });
    expect((await send("POST", "/bookings", book("s1"))).status).toBe(201);
  });
});
