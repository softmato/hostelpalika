# PHASES.md — Build order

Phases are ordered by dependency. A phase starts only when the phase before it
has every ☐ ticked. There are no durations here on purpose — work takes what it
takes; the order is what matters.

Each phase ends with a `CHANGELOG.md` entry and, once code exists, a
`MEMORY.md` update. The per-route and per-model ☐ live in `PARITY.md`; this file
holds the phase-level gates.

---

## Phase 0 — Ground

**Needs:** nothing. **Unblocks:** everything.

- ☑ Go installed; `server/go.mod` created (module `github.com/softmato/hostelpalika/server`), `go` + `toolchain` lines pinned — go1.27.0, MSYS2 UCRT64 gcc + libvips 8.18.7 for govips (CGO on). `go 1.27.0` is the pin: `go mod tidy` drops a `toolchain` line equal to it, add one only when the toolchain moves ahead of `go`
- ☑ Folder skeleton per `FOLDER_STRUCTURE.md` — module folders are created as each module is ported
- ☑ `internal/platform/config` — every env var in `ENVIRONMENT.md` §2, typed, validated at boot — defaults/fallbacks ported from `lib/env.ts` + each `process.env` call site (TS `??` vs `||` kept); bad values fail boot where TS silently fell back; refuses an Atlas URI outside production; `COOKIE_SECURE` is read by only `public/search/parse` (session cookies use `IsProduction`); `GOMEMLIMIT` is read by the runtime, not config
- ☑ `cmd/api` — Gin (`gin.New()`, release mode), graceful shutdown, `/api/v1/health` — Gin 1.12 + sonic 1.15.5 (JIT path covers go < 1.28; check sonic before bumping Go); health body byte-identical to TS, 405 on wrong method; `httpx` has the envelope + recover only (Phase 1 adds validation/dup/Softmato mapping); SIGTERM drain is first exercised by the `deploy/` item (Windows can't send it)
- ☑ `deploy/` — Dockerfile (multi-stage, Debian-slim runtime with libvips + poppler), `compose.yaml` (`caddy`, `api`, `redis`), `Caddyfile` — trixie builder+runtime, non-root, `api healthcheck` probe; Caddy at static 172.28.0.10 = `TRUSTED_PROXIES`, h3 advertised, unported paths fall through to `TS_UPSTREAM`; `redis.conf` volatile-lru, unpublished; 2026-10-29: `up --build` all healthy, `stop api` → "stopped cleanly" exit 0 in <1 s
- ☑ Local stack runs with a **local** MongoDB container holding a copy of the live data (`deploy/copy-live-db.ps1`: read-only dump from Atlas → restore into `hostelpalika_dev`) — the Go server itself never gets the production URI. No seeds: the user ruled them out (2026-10-29), real data is already there; 2026-10-29: first copy restored — 145 collections, indexes included, archive deleted
- ☑ Contract test harness (`TESTING.md` §3): recorder against the TS server, replayer against Go, JSON diff with volatile-field masks — `internal/contract` (masks with `*`, media-type compare, key-order check, unit-tested), `go run ./cmd/dev record -base … <case.json>`, `router/contract_test.go` replays every file; health recorded from live TS at 541e46cf and green. First catch: Next sends a bare 405 (no body, no content type), Gin sent text — fixed with a `NoMethod` handler
- ☑ k6 baseline recorded against the **current** TS production endpoints for the routes in DESIGN.md §2, so later numbers have something to beat — `testdata/k6/baseline.js` (5 public GETs, 2 req/s each, 60 s, from the dev machine in Nepal); results `testdata/k6/results/ts-prod-2026-10-29.json`. TTFB ms, med / p95 / p99 / max: health 88/119/1317/1601 · site-config 85/115/170/252 · hostels list 81/104/202/345 · hostel detail 84/122/201/461 · reviews 96/276/2062/2881; 0 errors. Medians ≈ network floor (health reads no DB yet sits at 88); the tails (1.3–2.9 s on health and reviews) are the cold starts Go has to remove. Compare Go from the same machine against the VPS, not localhost

**Gate:** `docker compose up` gives a healthy API; the harness can record and replay `/api/v1/health`.

---

## Phase 1 — Platform core

**Needs:** Phase 0. **Unblocks:** every route.

- ☑ Mongo client (warm pool), Redis client (in-compose container, production included — ARCHITECTURE.md §5) — `cmd/api` opens Mongo (5–50 pool, ping) before listening, fatal on failure; `internal/platform/redis` (go-redis v9.23, 500 ms read/write, 4 warm conns) is fail-open: unreachable at boot = warning, empty `REDIS_URL` = nil client; both handed to routes as `router.Deps`. `/health?deep=1` pings both → 503 `SERVICE_UNAVAILABLE` (reason logged, not in the body); plain `/health` stays dependency-free. 2026-10-29: verified in compose — Redis stopped → deep 503, plain 200; restarted → deep 200
- ☑ Response envelope, error mapping, zod-shaped validation errors (`PARITY.md` §3) — `httpx.Fail` follows `handleRouteError`: `*httpx.ValidationError` → 422 `{formErrors, fieldErrors, issues}` (first-seen key order), `*Error` → own status, anything with `SoftmatoRejection()` → 502 `SOFTMATO_REJECTED`, E11000 → 409 `DUPLICATE_VALUE` with the email/phone messages (keyPattern read from write, bulk and command errors), else 500. `internal/platform/valid` carries zod v4 English messages (Type, OneOf, TooSmall/TooBig, Pattern, Format, Received). Envelopes are encoded with `sonic.ConfigDefault` (no HTML escaping, as `JSON.stringify`) and sent as bare `application/json` like Next — Gin had been writing `>` for `>`. Golden test = zod 4.4.3 output, green with and without `-tags=sonic`
- ☑ JWT issue/verify with the shared secrets; refresh rotation; purpose tokens — `internal/platform/auth`: golang-jwt v5.3.1, header `{"alg":"HS256"}` and claims in jose's key order, so a Go access token is **byte-identical** to jose's for the same claims and clock (test pins it); HS256 only, exp checked with no leeway as jose; refresh drops `lockPin`; purpose tokens let `tokenType`/`tokenVersion` override extra claims. `Sessions` ports the row state machine: insert with hash, `Find` (reuse of a token two rotations old revokes the session), `Rotate` (CAS on presented hash; browser reuse inside 60 s → no new token; lost phone reply → reissue), `Logout`, `Revoke`, `RevokeAll`; every update stamps `updatedAt` like mongoose. Re-authorising the user between `Find` and `Rotate` (active user, temporary credential, stranded resident, payload extras) belongs to the auth routes at this phase's gate. 2026-10-29: rotation cases from auth.service.test.ts green against the compose Mongo (throwaway db)
- ☐ Cookies (`hostelpalika_*` + legacy fallbacks), domain-ready
- ☐ All 14 guards, roles, capabilities, hostel scoping; `tenant-isolation` cases ported and green
- ☐ Rate limiting on Redis
- ☐ Read cache + version bump + singleflight + version ETags
- ☐ `afterResponse` equivalent with shutdown drain
- ☐ Audit log + usage counter writers
- ☐ `Server-Timing`, request id, slog, pprof

**Gate:** `/api/v1/auth/*` (20 routes) pass contract tests; a token minted by TS works on Go and the reverse; a refresh through Go invalidates the old token for TS too.

---

## Phase 2 — Shared domain libraries

**Needs:** Phase 1. **Unblocks:** any module that uses them (most do).

- ☐ BS calendar + hostel day (UTC+5:45) + night window — test vectors generated from `packages/shared` and checked in under `server/testdata/vectors/`
- ☐ Money helpers (paisa `int64`), plan catalogue values
- ☐ Personal-data crypto + finance secret crypto — decrypt a sample of real-format ciphertexts produced by TS
- ☐ R2 (both buckets, presign), upload verification
- ☐ Email sender + identity + topic opt-out + daily cap; templates ported as each module needs them (`PARITY.md` §8)
- ☐ Push fan-out (Expo + Web Push), Pusher publish + channel auth
- ☐ Images (govips), PDF out, PDF in, xlsx, CSV, zip, QR — each with golden files
- ☐ Sealed archive (nacl) — archives sealed by TS open in Go and the reverse

**Gate:** every library in `PARITY.md` §3 is ☑.

---

## Phase 3 — Public read path

**Needs:** Phase 2. **Unblocks:** web SEO pages moving off direct Mongo.

- ☐ `public` (32), `bookings` public reads (`availability`, `guide`, `policy`), `hostel-registration` (5), `feedback`, `usage`, `email-preferences`, `health`
- ☐ Demo hostels merge, search + LLM search quota, maps (geocoding, nearby, routing)
- ☐ Web pages in `PARITY.md` §9 that only read public data switch to `fetch(API_URL)` (`API_URL` is the TS origin until cut-over, so a page switches early only if its TS route exists; the rest switch at cut-over)

**Gate:** home, city/near pages, hostel detail and software pages render from the Go API with no `@/modules` import.

---

## Phase 4 — Cookie domain + client base URL (clients stay on TS)

**Needs:** Phase 1 (auth on Go). Can run alongside Phase 3.

- ☐ TS server widens auth cookies to `Domain=.hostelpalika.com` (ARCHITECTURE.md §4); release stays live until active sessions have refreshed
- ☐ Web: one `API_URL` / `NEXT_PUBLIC_API_URL`; every client call uses it — value stays `https://hostelpalika.com` until cut-over
- ☐ App + PWA: same base-URL setting, value unchanged until cut-over (the switch ships by OTA if the runtime fingerprint allows, else in the next native build)
- ☐ Web `/api/*` → `api.hostelpalika.com` rewrite (`beforeFiles`) behind an env flag, off until cut-over

**Gate:** every client reads its API host from one setting; nothing calls `api.hostelpalika.com` yet.

---

## Phase 5 — Resident-side surfaces

**Needs:** Phases 2 and 4.

- ☐ `resident` (39), `guardian` (6), `cook` (11), `community` (10), `notifications` (4), `push` (4), `realtime` (2), `account` (9), `mobile` (1), `files` (5)
- ☐ `bookings` signed-in routes except money: create/list, detail, cancel, quote, documents (`checkout`, `payment`, `return` wait for Phase 8)

**Gate:** a resident, a guardian and a cook can complete their daily flows on Go only.

---

## Phase 6 — Hostel admin

**Needs:** Phase 5 (shared notification paths).

The biggest group (179 routes). Port module by module, in this order, so money
moves last within it:

- ☐ rooms/floors, residents (incl. existing-residents list, join link, admission forms, Form QR), arrivals, move-checklist
- ☐ food, notices, complaints, maintenance (voice notes), safety (SOS, night status), attendance
- ☐ stock/inventory, store orders, wardens, team members, reports, exports
- ☐ KYC wizard + signed agreement, hostel leave, backup (Drive OAuth callback), settings
- ☐ finance: invoices, receipts, khata, late fine, deposits, expenses, staff cash, statement import, evidence pipeline, reconciliation

**Gate:** a hostel admin and a warden run a full month (BS month) — bills issued, paid, receipted, reported — on Go only.

---

## Phase 7 — Platform, team, store, users

**Needs:** Phase 6.

- ☐ `platform` (99), `platform-admin` (2), `team` (16), `store` (13), `users` (11)
- ☐ Site config / SEO config / page copy editors
- ☐ Referrals (hostel + partner), offer program, subscriptions, manual plan-payment review

**Gate:** superadmin and team flows complete on Go only.

---

## Phase 8 — Money in from outside

**Needs:** Phase 7.

- ☐ `webhooks/:provider` (eSewa, Khalti, Fonepay), `webhooks/softmato`, `integrations/questioncall/*`
- ☐ `bookings/:id/checkout`, `bookings/:id/payment`, `bookings/:id/return`
- ☐ Checkout intents, settlement, reconciliation, gateway health — **offline shadow**: replay real provider events (the stored webhook/verification payloads) against the live-data copy and compare Go's resulting rows with what TS wrote for the same events

**Gate:** replaying a full `gateway-settlement-recon` window shows zero drift between Go's rows and TS's.

---

## Phase 9 — Jobs in-process

**Needs:** the module each job touches is on Go.

- ☐ Each of the 19 jobs in `PARITY.md` §5 ported, with one observed run on the local stack against the live-data copy (outbound calls faked) matching what the TS job did for the same data

**Gate:** all 19 jobs proven locally; switching them on is part of the cut-over.

---

## Phase 10 — Cut-over and cleanup

**Needs:** every phase above.

- ☐ Cut-over (ARCHITECTURE.md §11 step 3): final change intake + full contract run at HEAD, Go on the Kathmandu VPS against production Atlas (warm, `/health?deep=1` green), web `API_URL` → `api.hostelpalika.com` + rewrite on, app/PWA base URL by OTA, cron-job.org off, `SCHEDULER_ENABLED=true`
- ☐ Rollback lever proven before the switch: Caddy `BACKEND=ts` answers from Vercel TS
- ☐ Rollback window passed with TS still deployable; then everything in `PARITY.md` §11
- ☐ Upstash dropped from the web's env
- ☐ Web drops `MONGODB_URI`, the API routes, `modules/` and server-only `lib`
- ☐ `server/` committed

**Gate:** `PARITY.md` has no ☐ left.

---

## Later, optional

- Own WebSocket server replacing Pusher (`coder/websocket`, Redis pub/sub if more than one instance) — once Pusher cost or limits make it worth it.
- Durable job queue — only if a lost background job is shown to matter.
- REST v2 cleanup — as its own project after cut-over.
