# server/docs — HostelPalika standalone API (Go)

This folder documents the standalone backend that replaces the API routes living
inside `apps/web` today. One Go service, in Docker on a VPS, consumed by the web
(Vercel) and the mobile app / PWA alike.

`server/` is tracked in git (since 2026-10-29); `bin/` and `.env` stay out.

## Reading order

For an AI assistant or developer starting a session:

0. **`MISSION.md`** — ⭐⭐ the owner's binding brief. Read it first, every session. It wins over everything below
0. **`review_fixes_needed.md`** — ⭐ review of the finished phases: what is fixed, what is still owed
1. **`PRD.md`** — what this server is, why it exists, what "done" means
2. **`ARCHITECTURE.md`** — stack, request path, Redis, crons, realtime, the REST-vs-GraphQL decision
3. **`PHASES.md`** — ⭐ what to build now, and in what order
4. **`PARITY.md`** — ⭐ the master checklist: every route, model, cron, template, page
5. **`RULES.md`** — what must never break, what the AI must and must not do
6. **`API.md`** — the wire contract (envelope, auth, errors, caching headers)
7. **`DATABASE.md`** — how Go talks to the existing collections
8. **`DESIGN.md`** — API design and latency rules for new or changed endpoints
9. **`FOLDER_STRUCTURE.md`** + **`CODING_STANDARDS.md`** — where and how to write Go
10. **`ENVIRONMENT.md`** — env vars, Docker, VPS, Caddy, Redis
11. **`TESTING.md`** — contract tests against the TypeScript server, load tests
12. **`CHANGELOG.md`** — what changed, by phase

`MEMORY.md` — read after this file: where the work stands, and the commands.

## Golden rules

1. **The TypeScript server is the specification, except its bugs.** Same paths and
   methods, always (`TestRoutesMatchWeb`). Same JSON, status codes and side effects,
   unless that behaviour is a bug: then fix it in Go in the best way and in TS too
   (`RULES.md` §2). TS will be discarded; the Go server is what has to be right.
2. **Run the change intake (`PARITY.md` §2) before every port session.** The TS
   server keeps changing; git tells you what moved.
3. **Tick `PARITY.md` one item at a time** — port, contract test green, ☐ → ☑.
4. **Same database, same secrets.** Go reads and writes the live collections and
   verifies tokens the TS server issued, so both can run side by side during the
   move.
5. **Never point a dev or test Go server at the production Atlas cluster.** The
   root `.env` holds the production URI.
6. **No durations.** Plans state order and dependency, never days or weeks.

## Locked decisions

| Concern | Choice |
|---|---|
| Language | Go (latest stable, pinned in `go.mod` `go` + `toolchain` lines) |
| HTTP | Gin (`gin.New()`, release mode, `sonic` JSON build tag) |
| API style | **REST**, existing `/api/v1/*` paths and envelope — GraphQL rejected (ARCHITECTURE.md §10) |
| Database | MongoDB Atlas (Mumbai — across the border from the VPS), official `mongo-go-driver/v2`, existing collections |
| Cache / locks / limits | Redis in the same Docker Compose, `redis/go-redis/v9` |
| Scheduler | in-process `go-co-op/gocron/v2`, Asia/Kathmandu, Redis lock per job |
| Realtime | Pusher (`pusher-http-go`) first; own WebSockets later, optional |
| Edge | Caddy — TLS, HTTP/2 + HTTP/3, compression |
| Host | VPS in a Kathmandu datacenter at `api.hostelpalika.com`, Docker Compose (`caddy`, `api`, `redis`); web stays on Vercel `bom1` |
| Logs | `log/slog` JSON to stdout |
