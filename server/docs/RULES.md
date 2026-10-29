# RULES.md — What must never break

## 1. Before any task

1. Read `README.md`, then the `PHASES.md` phase in progress, then its rows in `PARITY.md`.
2. Run the change intake (`PARITY.md` §2). Handle every line before porting.
3. Read the TS route **and** the service it calls **and** the model. Port what
   the code does, not what a doc or a client type says it does — the server has
   repeatedly accepted or returned more than the hand-written client types.
4. Record the contract test from the TS server before writing the Go handler.

## 2. Parity

- Same path, method, status code, `errorCode`, message text, JSON field names,
  field order where clients depend on it, `null` vs absent, number vs string.
- Same side effects: rows written, notifications, pushes, emails, realtime
  events, cache bumps, audit entries — in the same order where order matters.
- A bug found while porting is fixed in TS first, then ported. Go never
  "quietly fixes" behaviour; the spec has to move first.
- No route is ☑ without a green contract test at the current baseline.

## 3. Tenant isolation (the most important rule)

- Every query on hostel-owned data is filtered by the principal's hostel scope.
  No exceptions, no "admin can see all" shortcuts outside the platform guards.
- The `tenant-isolation` cases are ported in Phase 1 and must stay green.
- Cache keys are per user. A shared key would hand one person's view to another.

## 4. Privacy and security invariants

- **Location pings never persist coordinates.** One test enforces it in TS; port
  that test with the attendance module.
- The **private R2 bucket never gets a public URL** — presigned, short-lived only.
- Personal data (`Resident.detailsData`, ID numbers) is stored encrypted with the
  existing key and layout; never logged.
- Logs never contain tokens, cookies, passwords, PINs, OTPs, personal data or
  coordinates.
- Maintenance voice notes: record/store/play only; never transcribed.
- Claim evidence trusts only verified payer-controlled data.
- Webhooks verify signatures before reading the body's claims.
- `X-Forwarded-For` is trusted only from Caddy.

## 5. Money

- Amounts are **paisa in `int64`**. Never `float64`, never rupees with decimals.
- A period is a **BS month** (`2083-05` = Bhadra). `end` is not a due date.
- The hostel day is Nepal time (UTC+5:45); every "today" goes through
  `internal/platform/bs`.
- One-off invoices (admission fee + deposit) have `period: null`; month-keyed
  readers must handle it.
- Joining is one payment: one invoice, one reference code, raised once.
- The rate card is the only price.
- Every settled payment bumps the hostel cache (`settleEvent`).

## 6. Database

- Same collections, fields, enums and indexes. No renames, no new required
  fields without a TS-side migration first.
- Every Mongoose default, `timestamps`, hook and virtual is reproduced explicitly
  in Go (`DATABASE.md` §3) — the driver applies none of them.
- Indexes are a migration (`cmd/indexes`), never built implicitly at boot.
- **Never connect a dev, test or CI Go server to the production cluster.** The
  root `.env` holds the production URI; the Go stack reads its own env file.

## 7. Approved libraries

Use the ones in `ARCHITECTURE.md` §3. Adding another needs a line in
`CHANGELOG.md` saying why the standard library or an existing dependency
couldn't do it.

## 8. What the AI must never do unprompted

- Run `eas build` / `submit` / `update`, deploy, or push. Hand over the commands.
- Change the TS server's behaviour to make a contract test pass.
- Point anything at the production database or Redis.
- Delete TS routes, modules or env vars before `PARITY.md` §11 says so.
- Write durations into plans or docs.
- Drive the browser to check web UI — typecheck + lint, then hand off.

## 9. Definition of done (per item)

- Go code + table-driven unit tests where there's logic
- Contract test recorded from TS and green on Go
- `Server-Timing` within the DESIGN.md §2 budget on the local stack
- Row ticked in `PARITY.md`
- `CHANGELOG.md` line if it closes a phase gate
