# Clinic booking API

Koya assessment, task 1: an API that lets patients book appointment slots, plus a web page that uses it.
Built to the spec at [koyaacademy.com/assessment-api](https://koyaacademy.com/assessment-api).

**Stack:** TypeScript on Netlify Functions, Postgres.

## Progress

- [x] **Level 1:** list slots, book one, look up a booking
- [x] **Level 2:** API key, validation
- [x] **Level 3:** no double booking, cancellation
- [x] **Level 4:** idempotent retries, pagination
- [ ] Level 5: rate limiting

## Endpoints

| Method | Path | |
|---|---|---|
| `POST` | `/reset` | Delete every booking and replace all slots |
| `GET` | `/slots?provider=` | Every slot, earliest first, with `available` |
| `POST` | `/bookings` | Book a slot: `{ slot_id, name, email }` → `201` |
| `GET` | `/bookings?email=&limit=&cursor=` | A person's bookings, oldest first, paged |
| `GET` | `/bookings/{id}` | Look up a booking |
| `DELETE` | `/bookings/{id}` | Cancel a booking and free the slot |

Errors are always `{ "error": "<message>" }`.

### Authentication

Every request needs an `X-API-Key` header matching the server's `API_KEY` environment variable. A missing or wrong key gets `401`. The key is compared in constant time. If `API_KEY` isn't set, every request is refused rather than the API being left open.

### Booking rules

| Status | When |
|---|---|
| `201` | Booked. `name` and `email` are trimmed, and `email` is stored in lower case |
| `400` | `slot_id`, `name` or `email` missing or empty, `email` not valid, invalid JSON, or the slot has already started |
| `404` | The slot doesn't exist |
| `409` | The slot already has a confirmed booking |
| `422` | The `Idempotency-Key` was already used with a different body |

### No double booking, even at the same moment

Checking "is this slot free?" in code and then inserting has a gap: two requests can both see the slot as free, and both insert. So the database enforces the rule instead. There's a partial unique index on `bookings(slot_id) WHERE status = 'confirmed'`, and the insert uses `ON CONFLICT DO NOTHING`. However many requests arrive at once, Postgres lets exactly one insert succeed; the rest get no row back and return `409`. A cancelled booking falls outside the index, so cancelling frees the slot.

Cancelling is a single conditional update (`... WHERE status = 'confirmed'`), so two simultaneous cancels can't both succeed: one gets `200` and the other `409`.

The tests fire 20 simultaneous bookings at one slot over 20 real database connections, and check that exactly one wins.

### Safe retries (`Idempotency-Key`)

If a client sends a booking, the connection drops, and it retries, the retry must not book a second time. When a request carries an `Idempotency-Key` header:

1. A transaction takes a Postgres advisory lock on that key. A retry that arrives while the first request is still running waits for it to finish, rather than racing it.
2. If the key has been seen before, the stored status and body are returned as they are. That's the same status code and the same booking `id`, and nothing new is created.
3. Otherwise the booking is attempted, and the outcome (success or error) is stored under the key in the same transaction.

The body is compared by a hash of its canonical JSON, so key order and whitespace don't matter. The same key with a different body gets `422`. `/reset` clears stored keys along with the bookings they referred to.

### Paging through a person's bookings

`GET /bookings?email=…` returns that person's bookings oldest first (email matching ignores case), 10 per page by default and up to 50. Each booking gets an increasing sequence number when it's created. `next_cursor` is an opaque encoding of the last one on the page, and the next page starts after it. Unlike page numbers, this can't skip or repeat bookings if new ones are made between pages. The last page has `next_cursor: null`.

## Run the tests

Needs a local Postgres. Tests run against a real database rather than mocks.

```bash
npm install
createdb koya_booking_test
npm test
```
