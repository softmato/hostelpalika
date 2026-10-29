# MEMORY.md — where the Go server stands

Read this after README.md. Update it at the end of every session.

## State (2026-10-29)

- **Phase 0 done.** **Phase 1 in progress: items 1–3 of 10 ☑** (Mongo/Redis
  clients + deep health; error mapping + zod validation; JWT + purpose tokens +
  Session rotation). Next: item 4, cookies (`lib/auth-cookies.ts`,
  `lib/session-cookies.ts`, `lib/lock-pin-cookie.ts`).
- 0 of 512 routes ☑. PARITY baseline `541e46cf` (intake run 2026-10-29); run
  the intake (`PARITY.md` §2) again at the start of every port session.
- `server/` is tracked in git since 2026-10-29 (`server/.gitignore` keeps `bin/` and `.env` out; `.gitattributes` pins LF).
- Tests that need Mongo dial `127.0.0.1:27018/<throwaway db>?directConnection=true` (the container is a replica set advertising `mongo:27017`) and skip when it's down.

## How to work here

- Shell: prepend `C:\Program Files\Go\bin` and `C:\msys64\ucrt64\bin` to PATH
  (a fresh shell has them; an old one may not). Docker CLI is in
  `C:\Program Files\Docker\Docker\resources\bin`.
- Build/test: `go vet ./...` · `GIN_MODE=release go test -race -tags=sonic ./...`
- Never let Python rewrite Go files without `io.open(..., encoding='utf-8', newline='')`:
  default cp1252 + CRLF truncated `httpx.go` once and breaks gofmt.
- Stack: `docker compose -f deploy/compose.yaml -f deploy/compose.local.yaml up -d --build`
  (start Docker Desktop first). API `https://localhost` via Caddy, or `go run ./cmd/api`
  on the host (reads `server/.env`, talks to Mongo `127.0.0.1:27018`, Redis `127.0.0.1:6380`).
- Fresh live data: `pwsh deploy/copy-live-db.ps1` (read-only from Atlas, replaces local `hostelpalika_dev`).
- Record a contract: add the case to `testdata/contract/<group>/<file>.json`,
  `go run ./cmd/dev record -base <TS url> -baseline <sha> <file>`; replay is `go test ./internal/router`.
  Anything that reads data must be recorded from a TS server on the **local** copy, not prod.
- Latency: `k6 run -e BASE=… testdata/k6/baseline.js`.

## Decisions to keep

- The whole TS backend in `apps/web` is the spec: same wire bytes, faster inside.
- No seeds — local data is a copy of live.
- The Go server never gets the production URI; config refuses Atlas outside `APP_ENV=production`.
- Redis: Go uses **its own in-compose Redis, production included, from day one**
  (user, 2026-10-29: Upstash latency is not acceptable). No cross-server sync
  — one cut-over. ARCHITECTURE.md §5.
- Host: API + Redis on a Kathmandu VPS; web on Vercel `bom1`; Atlas in Mumbai.
  Clients stay on TS (`hostelpalika.com`) until cut-over, then switch to
  `api.hostelpalika.com` in one step. ARCHITECTURE.md §1, §11.

## Known gaps carried into Phase 1

- Every JSON body goes through `httpx` (`write`/`abort`, sonic no-HTML-escape,
  bare `application/json`). Never `c.JSON` — it escapes `<>&` unlike `JSON.stringify`.
- Request schemas: collect `valid.Issues` in zod-declared order, return `.Err()`.
  Messages must be zod v4's (`valid.Type`, `OneOf`, …); add a builder when a
  route needs a new one, checked against real zod output.
- The Softmato client (later phase) must give its error a `SoftmatoRejection()` method.
- No request id, Server-Timing, CORS, body limits, auth, guards yet.
