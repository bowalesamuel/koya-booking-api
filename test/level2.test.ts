import { beforeEach, describe, expect, it } from "vitest";
import { handle } from "../src/api.js";
import { book, send, SLOTS, t } from "./helpers.js";

beforeEach(async () => {
  expect((await send("POST", "/reset", { slots: SLOTS })).status).toBe(200);
});

const ROUTES = [
  ["GET", "/slots"],
  ["POST", "/reset"],
  ["POST", "/bookings"],
  ["GET", "/bookings/x"],
  ["GET", "/nope"],
];

describe("Level 2: API key", () => {
  it.each(ROUTES)("%s %s returns 401 with a wrong key", async (method, path) => {
    const res = await send(method, path, undefined, { "x-api-key": "wrong" });
    expect(res).toMatchObject({ status: 401, body: { error: expect.any(String) } });
  });

  it.each(ROUTES)("%s %s returns 401 with no key", async (method, path) => {
    const res = await handle(new Request(`https://clinic.test${path}`, { method }), t.ctx);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: expect.any(String) });
  });

  it("locks everything if the server has no key configured", async () => {
    const res = await handle(
      new Request("https://clinic.test/slots", { headers: { "x-api-key": "" } }),
      { ...t.ctx, apiKey: "" },
    );
    expect(res.status).toBe(401);
  });

  it("does nothing when the key is wrong", async () => {
    await send("POST", "/reset", { slots: [] }, { "x-api-key": "wrong" });
    expect((await send("GET", "/slots")).body.slots).toHaveLength(SLOTS.length);
  });
});

describe("Level 2: booking validation", () => {
  it.each([
    [{ name: "Ada", email: "a@b.co" }, "slot_id"],
    [{ slot_id: "s1", email: "a@b.co" }, "name"],
    [{ slot_id: "s1", name: "Ada" }, "email"],
    [{ slot_id: "", name: "Ada", email: "a@b.co" }, "slot_id"],
    [{ slot_id: "s1", name: "   ", email: "a@b.co" }, "name"],
    [{ slot_id: "s1", name: "Ada", email: "  " }, "email"],
    [{ slot_id: "s1", name: "Ada", email: "not-an-email" }, "email"],
    [{ slot_id: "s1", name: "Ada", email: "a@b" }, "email"],
    [{ slot_id: "s1", name: "Ada", email: "a b@c.co" }, "email"],
    [{ slot_id: 1, name: "Ada", email: "a@b.co" }, "slot_id"],
    [{ slot_id: "s1", name: null, email: "a@b.co" }, "name"],
  ])("400 for %j", async (body, field) => {
    const res = await send("POST", "/bookings", body);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain(field);
  });

  it("400 for invalid JSON or a non-object body", async () => {
    expect((await send("POST", "/bookings", "{oops")).status).toBe(400);
    expect((await send("POST", "/bookings", [])).status).toBe(400);
  });

  it("404 for a slot that doesn't exist", async () => {
    expect(await send("POST", "/bookings", book("nope"))).toMatchObject({ status: 404, body: { error: expect.any(String) } });
  });

  it("400 for a slot that has already started", async () => {
    expect((await send("POST", "/bookings", book("past"))).status).toBe(400);
  });

  it("400 for a slot starting right now", async () => {
    t.clock = new Date(SLOTS[1].start);
    expect((await send("POST", "/bookings", book("s1"))).status).toBe(400);
    t.clock = undefined;
  });

  it("trims name and email, and stores email in lower case", async () => {
    const { status, body } = await send("POST", "/bookings", book("s1", "  Ada@Example.COM ", "  Ada Obi  "));
    expect(status).toBe(201);
    expect(body).toMatchObject({ name: "Ada Obi", email: "ada@example.com" });
    expect((await send("GET", `/bookings/${body.id}`)).body.email).toBe("ada@example.com");
  });

  it("nothing is booked when validation fails", async () => {
    await send("POST", "/bookings", { slot_id: "s1", name: "Ada", email: "bad" });
    expect((await send("GET", "/slots")).body.slots.every((s: { available: boolean }) => s.available)).toBe(true);
  });
});
