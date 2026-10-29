# TESTING.md — Proving Go behaves like TypeScript

## 1. Principle

The TS server is the specification, so the main test is a **comparison**: the
same request against both servers must give the same response and the same
database effects. Unit tests cover logic; contract tests cover parity; load
tests cover the latency budgets.

**No test of any kind runs against the production database or Redis.**

## 2. Unit tests

- Go `testing`, table-driven, `t.Run` per case.
- Required for: BS calendar, money, fines/khata maths, plan/period calculations,
  guards and capability checks, crypto round-trips, webhook signature checks,
  cache key and version logic, rate limiter, every job's selection query.
- **Vectors from TS.** For pure functions shared with the clients (`bs.ts`,
  `night-window.ts`, `plans/*`, money helpers), a small TS script generates
  input/output JSON into `server/testdata/vectors/`; Go tests read the same
  files. Both sides must pass the same vectors forever.

## 3. Contract tests (the parity proof)

**Record** (once per route, re-recorded when the change intake re-opens it):

1. Start the TS server locally against the **local** Mongo (a copy of the live
   data from `deploy/copy-live-db.ps1`, snapshot taken) and the local Redis.
2. Run the route's scripted cases: happy path, each guard failing (no token,
   wrong role, wrong hostel), one invalid body, edge cases from the code.
3. Save each request, response (status, headers that matter, body) and the
   changed documents to `server/testdata/contract/<group>/<route>.json`.

**Replay** (every run of `go test ./...`):

1. Restore the same Mongo snapshot.
2. Send the recorded requests to the Go router in-process (`httptest`).
3. Diff status, body and changed documents. Masks cover values that can't match
   by design: generated ObjectIDs, timestamps, ETags of freshly written data,
   random reference codes — masked by JSON path, listed in the recording.

A route is ☑ in `PARITY.md` only with a green contract test.

Side effects that leave the process (email, push, Pusher, R2, gateways, LLMs)
are captured by fakes in both recordings and replays, and their calls are part
of the diff.

## 4. Golden files

`server/testdata/golden/` — email HTML/text, PDFs (page images compared with a
tolerance), images, ID cards, CSV/xlsx exports. Produced by TS from the same
inputs; Go output must match.

## 5. Load tests

k6 scripts under `server/testdata/k6/`:

- **Baseline** first, against the current TS production endpoints for the
  routes listed in DESIGN.md §2 — read-only routes only, and with a test
  account.
- Then against the local Go stack, and against the VPS before each cut-over
  step.
- Pass = DESIGN.md §2 budgets met at p95 on `Server-Timing: app`; error rate 0.

## 6. Commands (once Go is installed)

```bash
go test ./...
```

```bash
go test -race ./...
```

```bash
docker compose -f deploy/compose.yaml -f deploy/compose.local.yaml up -d --build
```

```bash
pwsh deploy/copy-live-db.ps1
```

```bash
k6 run testdata/k6/reads.js
```

## 7. Before ticking a route

- ☐ Contract test recorded from TS at the current baseline and green on Go
- ☐ Guard failures covered (401/403/423 as TS answers)
- ☐ Tenant isolation case covered for hostel-owned data
- ☐ `go test -race` clean
- ☐ `Server-Timing` within budget on the local stack
