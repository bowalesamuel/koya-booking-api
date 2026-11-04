# Clinic booking API

Koya assessment, task 1: an API that lets patients book appointment slots, plus a web page that uses it.
Built to the spec at [koyaacademy.com/assessment-api](https://koyaacademy.com/assessment-api).

**Stack:** TypeScript on Netlify Functions, Postgres.

## Progress

- [x] **Level 1:** list slots, book one, look up a booking
- [x] **Level 2:** API key, validation
- [ ] Level 3: no double booking, cancellation
- [ ] Level 4: idempotent retries, pagination
- [ ] Level 5: rate limiting

## Endpoints

| Method | Path | |
|---|---|---|
| `POST` | `/reset` | Delete every booking and replace all slots |
| `GET` | `/slots?provider=` | Every slot, earliest first, with `available` |
| `POST` | `/bookings` | Book a slot: `{ slot_id, name, email }` → `201` |
| `GET` | `/bookings/{id}` | Look up a booking |

Errors are always `{ "error": "<message>" }`.

### Authentication

Every request needs an `X-API-Key` header matching the server's `API_KEY` environment variable. A missing or wrong key gets `401`. The key is compared in constant time. If `API_KEY` isn't set, every request is refused rather than the API being left open.

### Booking rules

| Status | When |
|---|---|
| `201` | Booked. `name` and `email` are trimmed, and `email` is stored in lower case |
| `400` | `slot_id`, `name` or `email` missing or empty, `email` not valid, invalid JSON, or the slot has already started |
| `404` | The slot doesn't exist |

## Run the tests

Needs a local Postgres. Tests run against a real database rather than mocks.

```bash
npm install
createdb koya_booking_test
npm test
```
