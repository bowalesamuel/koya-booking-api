import { beforeEach, describe, expect, it } from "vitest";
import { book, send, SLOTS } from "./helpers.js";

beforeEach(async () => {
  expect((await send("POST", "/reset", { slots: SLOTS })).status).toBe(200);
});

describe("Level 1: list slots, book one, look up a booking", () => {
  it("lists slots earliest first, exactly as sent, with availability", async () => {
    const { status, body } = await send("GET", "/slots");
    expect(status).toBe(200);
    expect(body.slots.map((s: { id: string }) => s.id)).toEqual(["past", "s1", "s2", "s3"]);
    expect(body.slots[1]).toEqual({ ...SLOTS[1], available: true });
  });

  it("filters by provider (exact match)", async () => {
    const { body } = await send("GET", "/slots?provider=Dr%20Ade");
    expect(body.slots.map((s: { id: string }) => s.id)).toEqual(["past", "s1", "s3"]);
    expect((await send("GET", "/slots?provider=dr%20ade")).body.slots).toEqual([]);
  });

  it("books a slot and looks it up", async () => {
    const created = await send("POST", "/bookings", book("s1"));
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ slot_id: "s1", name: "Ada Obi", email: "ada@example.com", status: "confirmed" });
    expect(typeof created.body.id).toBe("string");
    expect(new Date(created.body.created_at).toISOString()).toBe(created.body.created_at);

    expect(await send("GET", `/bookings/${created.body.id}`)).toMatchObject({ status: 200, body: created.body });
  });

  it("marks a booked slot unavailable", async () => {
    await send("POST", "/bookings", book("s1"));
    const slots = (await send("GET", "/slots")).body.slots;
    expect(slots.find((s: { id: string }) => s.id === "s1").available).toBe(false);
    expect(slots.find((s: { id: string }) => s.id === "s2").available).toBe(true);
  });

  it("404s an unknown booking", async () => {
    expect(await send("GET", "/bookings/nope")).toMatchObject({ status: 404, body: { error: expect.any(String) } });
  });

  it("reset deletes bookings and replaces slots", async () => {
    const { body } = await send("POST", "/bookings", book("s1"));
    await send("POST", "/reset", { slots: [SLOTS[0]] });
    expect((await send("GET", `/bookings/${body.id}`)).status).toBe(404);
    expect((await send("GET", "/slots")).body.slots).toEqual([{ ...SLOTS[0], available: true }]);
  });

  it("rejects a malformed reset", async () => {
    expect((await send("POST", "/reset", { slots: [{ id: "x" }] })).status).toBe(400);
    expect((await send("POST", "/reset", "nope")).status).toBe(400);
  });

  it("404s unknown routes and 405s wrong methods, as JSON errors", async () => {
    expect(await send("GET", "/nope")).toMatchObject({ status: 404, body: { error: expect.any(String) } });
    expect(await send("PUT", "/slots")).toMatchObject({ status: 405, body: { error: expect.any(String) } });
  });
});
