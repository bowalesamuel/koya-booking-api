# Clinic booking API

Koya assessment, task 1: an API that lets patients book appointment slots, plus a web page that uses it.
Built to the spec at [koyaacademy.com/assessment-api](https://koyaacademy.com/assessment-api).

**Stack:** TypeScript on Netlify Functions, Postgres.

## Progress

- [x] **Level 1:** list slots, book one, look up a booking
- [ ] Level 2: API key, validation
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

## Run the tests

Needs a local Postgres. Tests run against a real database rather than mocks.

```bash
npm install
createdb koya_booking_test
npm test
```
