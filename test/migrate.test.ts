import pg from "pg";
import { describe, expect, it } from "vitest";
import { migrate } from "../src/db.js";
import { book, send, SLOTS } from "./helpers.js";

const DB_URL = process.env.TEST_DATABASE_URL ?? "postgres://localhost/koya_booking_test";

// Regression test: under load Netlify starts many function instances at once,
// and each runs migrate() on its cold start. Running the DDL every time took
// table locks that deadlocked with bookings in flight. Now an up-to-date
// schema is detected with a plain read and no DDL runs.
describe("cold starts", () => {
  it("many instances starting while bookings are in flight don't deadlock or fail", async () => {
    await send("POST", "/reset", { slots: SLOTS });
    const pools = Array.from({ length: 8 }, () => new pg.Pool({ connectionString: DB_URL, max: 1 }));
    try {
      const results = await Promise.all([
        ...pools.map((p) => migrate(p).then(() => "migrated")),
        ...Array.from({ length: 12 }, (_, i) =>
          send("POST", "/bookings", book(i % 2 ? "s1" : "s2", `cold${i}@example.com`)).then((r) => r.status),
        ),
      ]);
      const statuses = results.filter((r) => typeof r === "number");
      expect(results.filter((r) => r === "migrated")).toHaveLength(8);
      expect(statuses.every((s) => s === 201 || s === 409)).toBe(true);
      expect(statuses.filter((s) => s === 201)).toHaveLength(2);
    } finally {
      await Promise.all(pools.map((p) => p.end()));
    }
  });
});
