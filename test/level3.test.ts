import { beforeEach, describe, expect, it } from "vitest";
import { book, send, SLOTS, t } from "./helpers.js";

beforeEach(async () => {
  expect((await send("POST", "/reset", { slots: SLOTS })).status).toBe(200);
});

const confirmedCount = async (slotId: string) =>
  (await t.db.query("select count(*)::int as n from bookings where slot_id = $1 and status = 'confirmed'", [slotId]))
    .rows[0].n;

describe("Level 3: no double booking", () => {
  it("409 when the slot already has a confirmed booking", async () => {
    expect((await send("POST", "/bookings", book("s1"))).status).toBe(201);
    const second = await send("POST", "/bookings", book("s1", "bo@example.com"));
    expect(second).toMatchObject({ status: 409, body: { error: expect.any(String) } });
  });

  it("exactly one of 20 simultaneous requests wins", async () => {
    // The test pool has 20 connections, so these really hit Postgres at once.
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => send("POST", "/bookings", book("s2", `p${i}@example.com`))),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(19);
    expect(await confirmedCount("s2")).toBe(1);
  });

  it("holds across several slots booked at once", async () => {
    const results = await Promise.all(
      ["s1", "s2", "s3"].flatMap((slot) =>
        Array.from({ length: 8 }, (_, i) => send("POST", "/bookings", book(slot, `${slot}-${i}@example.com`))),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(3);
    for (const slot of ["s1", "s2", "s3"]) expect(await confirmedCount(slot)).toBe(1);
  });
});

describe("Level 3: cancellation", () => {
  it("cancels a booking, returns it, and frees the slot", async () => {
    const { body } = await send("POST", "/bookings", book("s1"));
    const cancelled = await send("DELETE", `/bookings/${body.id}`);
    expect(cancelled).toMatchObject({ status: 200, body: { ...body, status: "cancelled" } });
    expect((await send("GET", `/bookings/${body.id}`)).body.status).toBe("cancelled");

    const slot = (await send("GET", "/slots")).body.slots.find((s: { id: string }) => s.id === "s1");
    expect(slot.available).toBe(true);
    expect((await send("POST", "/bookings", book("s1", "bo@example.com"))).status).toBe(201);
  });

  it("409 when cancelling twice, 404 for an unknown booking", async () => {
    const { body } = await send("POST", "/bookings", book("s1"));
    await send("DELETE", `/bookings/${body.id}`);
    expect(await send("DELETE", `/bookings/${body.id}`)).toMatchObject({ status: 409, body: { error: expect.any(String) } });
    expect(await send("DELETE", "/bookings/nope")).toMatchObject({ status: 404, body: { error: expect.any(String) } });
  });

  it("only one of many simultaneous cancels succeeds", async () => {
    const { body } = await send("POST", "/bookings", book("s1"));
    const results = await Promise.all(Array.from({ length: 10 }, () => send("DELETE", `/bookings/${body.id}`)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(9);
  });

  it("a freed slot can be rebooked by only one of many simultaneous requests", async () => {
    const { body } = await send("POST", "/bookings", book("s1"));
    await send("DELETE", `/bookings/${body.id}`);
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => send("POST", "/bookings", book("s1", `r${i}@example.com`))),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(await confirmedCount("s1")).toBe(1);
  });

  it("needs the API key", async () => {
    const { body } = await send("POST", "/bookings", book("s1"));
    expect((await send("DELETE", `/bookings/${body.id}`, undefined, { "x-api-key": "wrong" })).status).toBe(401);
    expect((await send("GET", `/bookings/${body.id}`)).body.status).toBe("confirmed");
  });
});
