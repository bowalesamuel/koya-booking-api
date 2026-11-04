// Checks a deployed API against every level of the spec, over real HTTP.
// WARNING: calls /reset, which deletes every booking. Run `node scripts/seed.mjs` after.
// Run it against the deployed site: `netlify dev` replaces a function's 404 for a POST
// with 405 (it falls back to static files), so "404 for unknown slot" fails only locally.
//
//   BASE_URL=https://your-site.netlify.app API_KEY=... node scripts/smoke.mjs

const BASE_URL = process.env.BASE_URL?.replace(/\/+$/, "");
const API_KEY = process.env.API_KEY;
if (!BASE_URL || !API_KEY) {
  console.error("Set BASE_URL and API_KEY");
  process.exit(1);
}

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : `  ${detail}`}`);
  if (!ok) failures++;
}

async function call(method, path, body, headers = {}) {
  const res = await fetch(BASE_URL + path, {
    method,
    headers: { "content-type": "application/json", "x-api-key": API_KEY, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, body: json, headers: res.headers };
}

const unique = Date.now().toString(36);
const email = (tag) => `${tag}-${unique}@example.com`;
const SLOTS = [
  { id: "s2", provider: "Dr Bello", start: "2099-12-10T10:00:00Z", end: "2099-12-10T10:30:00Z" },
  { id: "s1", provider: "Dr Ade", start: "2099-12-10T09:00:00Z", end: "2099-12-10T09:30:00Z" },
  { id: "s3", provider: "Dr Ade", start: "2099-12-11T09:00:00Z", end: "2099-12-11T09:30:00Z" },
  { id: "past", provider: "Dr Ade", start: "2020-01-01T09:00:00Z", end: "2020-01-01T09:30:00Z" },
  ...Array.from({ length: 6 }, (_, i) => ({
    id: `p${i}`, provider: "Dr Page", start: `2099-01-0${i + 1}T09:00:00Z`, end: `2099-01-0${i + 1}T09:30:00Z`,
  })),
];

console.log(`Checking ${BASE_URL}\n`);

// Level 2: key
for (const [method, path] of [["GET", "/slots"], ["POST", "/reset"], ["POST", "/bookings"], ["GET", "/bookings/x"]]) {
  const res = await call(method, path, undefined, { "x-api-key": "wrong" });
  check(`401 with a wrong key: ${method} ${path}`, res.status === 401 && typeof res.body.error === "string", res.status);
}

// Level 1
let r = await call("POST", "/reset", { slots: SLOTS });
check("POST /reset", r.status === 200, `${r.status} ${JSON.stringify(r.body)}`);
r = await call("GET", "/slots");
check("GET /slots earliest first", r.body.slots?.[0]?.id === "past" && r.body.slots?.[1]?.id?.startsWith("p"), JSON.stringify(r.body).slice(0, 200));
check("slot fields returned as sent", JSON.stringify(r.body.slots.find((s) => s.id === "s1")) === JSON.stringify({ ...SLOTS[1], available: true }));
r = await call("GET", "/slots?provider=Dr%20Bello");
check("GET /slots?provider=", r.body.slots?.length === 1 && r.body.slots[0].id === "s2");
const ada = email("ada");
r = await call("POST", "/bookings", { slot_id: "s1", name: "  Ada Obi ", email: `  ${ada.toUpperCase()} ` });
check("POST /bookings → 201 confirmed", r.status === 201 && r.body.status === "confirmed", `${r.status} ${JSON.stringify(r.body)}`);
check("name/email trimmed, email lower-cased", r.body.name === "Ada Obi" && r.body.email === ada);
const booking = r.body;
r = await call("GET", `/bookings/${booking.id}`);
check("GET /bookings/{id}", r.status === 200 && r.body.id === booking.id);
check("GET unknown booking → 404", (await call("GET", "/bookings/nope")).status === 404);

// Level 2: validation
for (const [label, body] of [
  ["missing slot_id", { name: "A", email: email("v1") }],
  ["empty name", { slot_id: "s2", name: " ", email: email("v2") }],
  ["invalid email", { slot_id: "s2", name: "A", email: "nope" }],
]) {
  check(`400 for ${label}`, (await call("POST", "/bookings", body)).status === 400);
}
check("404 for unknown slot", (await call("POST", "/bookings", { slot_id: "zzz", name: "A", email: email("v3") })).status === 404);
check("400 for a slot that has started", (await call("POST", "/bookings", { slot_id: "past", name: "A", email: email("v4") })).status === 400);

// Level 3
check("409 for an already-booked slot", (await call("POST", "/bookings", { slot_id: "s1", name: "B", email: email("b") })).status === 409);
const race = await Promise.all(
  Array.from({ length: 20 }, (_, i) => call("POST", "/bookings", { slot_id: "s2", name: "R", email: email(`race${i}`) })),
);
const wins = race.filter((x) => x.status === 201).length;
check("20 simultaneous bookings → exactly one 201", wins === 1 && race.filter((x) => x.status === 409).length === 19,
  JSON.stringify(race.map((x) => x.status)));
r = await call("DELETE", `/bookings/${booking.id}`);
check("DELETE cancels", r.status === 200 && r.body.status === "cancelled");
check("cancel again → 409", (await call("DELETE", `/bookings/${booking.id}`)).status === 409);
check("cancel unknown → 404", (await call("DELETE", "/bookings/nope")).status === 404);
r = await call("GET", "/slots");
check("cancelled slot is available again", r.body.slots.find((s) => s.id === "s1")?.available === true);

// Level 4: idempotency
const idem = { "idempotency-key": `smoke-${unique}` };
const body = { slot_id: "s3", name: "Idem", email: email("idem") };
const first = await call("POST", "/bookings", body, idem);
const again = await call("POST", "/bookings", body, idem);
check("same Idempotency-Key → same status and id", first.status === 201 && again.status === 201 && again.body.id === first.body.id);
check("same key, different body → 422", (await call("POST", "/bookings", { ...body, slot_id: "s1" }, idem)).status === 422);

// Level 4: pagination
const pager = email("pager");
for (let i = 0; i < 5; i++) await call("POST", "/bookings", { slot_id: `p${i}`, name: "P", email: pager });
const seen = [];
let cursor = null;
let pages = 0;
do {
  r = await call("GET", `/bookings?email=${encodeURIComponent(pager.toUpperCase())}&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
  seen.push(...(r.body.bookings ?? []).map((b) => b.slot_id));
  cursor = r.body.next_cursor;
  pages++;
} while (cursor && pages < 10);
check("pages oldest first, ends with next_cursor null", JSON.stringify(seen) === JSON.stringify(["p0", "p1", "p2", "p3", "p4"]) && pages === 3,
  `${JSON.stringify(seen)} in ${pages} pages`);
check("limit=0 → 400", (await call("GET", `/bookings?email=${pager}&limit=0`)).status === 400);
check("limit=51 → 400", (await call("GET", `/bookings?email=${pager}&limit=51`)).status === 400);

// Level 5: rate limit (pager has used 5 attempts in the last minute)
r = await call("POST", "/bookings", { slot_id: "p5", name: "P", email: pager });
check("6th attempt in a minute → 429 with Retry-After", r.status === 429 && Number(r.headers.get("retry-after")) >= 1,
  `${r.status} retry-after=${r.headers.get("retry-after")}`);
check("other emails unaffected", (await call("POST", "/bookings", { slot_id: "p5", name: "Q", email: email("other") })).status === 201);

console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) failed.`}`);
console.log("Bookings were reset. Run scripts/seed.mjs to put real slots back.");
process.exit(failures ? 1 : 0);
