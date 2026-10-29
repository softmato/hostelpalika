# DESIGN.md — API design and latency rules

There is no visual design in a backend. This file is the server's design
system: how fast it must be, and the patterns that get it there.

## 1. Where time goes

A request from a phone in Nepal pays, roughly:

| Leg | Typical | Who controls it |
|---|---|---|
| Phone → Kathmandu VPS and back | in-country; measure from the VPS | the ISP — hide it, don't fight it |
| Vercel `bom1` SSR → VPS and back | one cross-border round trip per fetch | `revalidate` on public pages, screen-shaped endpoints |
| TLS + connection setup | one round trip on a new connection, ~0 on a reused one | Caddy (HTTP/2, HTTP/3, keep-alive) |
| Server time | **this file's budget** | us |
| Redis (same compose) | ~0.1–0.3 ms | us — first stop for every read |
| Mongo query (Atlas Mumbai, from Kathmandu) | one cross-border round trip + 1–3 ms on a dedicated tier; more and spikier on M0 | Redis-first reads, parallel queries, indexes, the tier |

So the server's job is to make its own slice negligible, and every **round trip
saved** is worth more than any micro-optimisation.

## 2. Server-time budgets

Measured as `Server-Timing: app` at p95, local stack under the k6 profile
(TESTING.md §5). These are targets for the code, not schedules.

| Route class | p95 server time |
|---|---|
| `304 Not Modified` (version ETag) | ≤ 1 ms |
| Cached read (Redis hit) | ≤ 2 ms |
| Uncached read, indexed | ≤ 15 ms |
| Write (single document) | ≤ 25 ms |
| Write fanning out (notify, push, email) | ≤ 25 ms to respond; fan-out continues in the background |
| Report / export / PDF | streamed; first byte ≤ 100 ms |

A route over budget is not ☑ until it is fixed or the reason is written next to
it in `PARITY.md`.

## 3. Patterns

1. **One round trip per screen open.** Prefer a screen-shaped endpoint
   (dashboard, bootstrap) to several small calls. That is why REST was kept over
   GraphQL (ARCHITECTURE.md §10).
2. **304 before work.** Compute the ETag from the hostel version before loading
   anything; return `304` the moment it matches.
3. **Cache the bytes.** Redis holds the finished JSON; a hit is copied to the
   socket.
4. **Collapse stampedes.** `singleflight` on the cache key.
5. **Respond, then fan out.** Notifications, pushes, emails, realtime events
   run after the response, on the tracked background group.
6. **Project, index, batch.** Never fetch a whole document to return three
   fields; never loop queries.
7. **Stream large bodies.** Exports and PDFs are written as they are produced.
8. **CPU work is free to use cores.** bcrypt, image resize, PDF render run in
   their own goroutines; nothing blocks other requests (the event-loop freeze
   problem doesn't exist in Go, but unbounded CPU work still needs a semaphore
   so a burst can't starve the API).
9. **Timeouts everywhere.** Every upstream call has a context deadline shorter
   than the route's.
10. **Fail open on cache, closed on auth.** Redis down → read from Mongo. Auth
    lookup failing → `401`, never "let it through".

## 4. Naming and shape (for any new endpoint)

New endpoints follow the existing conventions so clients stay uniform:

- Paths: `/api/v1/<portal>/<resource>[/<id>[/<sub-resource>|<action>]]`,
  kebab-case.
- Methods: `GET` read, `POST` create/action, `PATCH` partial update, `PUT`
  replace, `DELETE` remove.
- Lists: same pagination parameters and response shape as
  `lib/pagination.ts` / `lib/portal-pagination.ts`.
- Dates: ISO-8601 UTC strings in JSON; periods as BS `YYYY-MM`.
- Money: integer paisa.
- Envelope: always (API.md §2).
