# PHASES.md — Build order

Phases are ordered by dependency. A phase starts only when the phase before it
has every ☐ ticked. There are no durations here on purpose — work takes what it
takes; the order is what matters.

Each phase ends with a `CHANGELOG.md` entry and, once code exists, a
`MEMORY.md` update. The per-route and per-model ☐ live in `PARITY.md`; this file
holds the phase-level gates.

`MISSION.md` is the owner's binding brief; these phases are how it gets done, and
they may be revised when the code shows a better order.

**Rules for every phase from 6 on:**

1. **The bug rule (`RULES.md` §2).** A bug, mistake or error found in TS is fixed in
   Go in the best way, made more production grade, and fixed in TS too. It is never
   copied because it is the spec. Log it in `review_fixes_needed.md`.
2. **Routes match the web exactly.** `TestRoutesMatchWeb` fails on any path or method
   with no `route.ts`; `TestAnonymousIsRefused` fails on a non-public route with no guard.
3. **Production grade while porting, not after:** bounded reads (limit or stream), a
   `routeBudgets` entry for anything past 30 s, no bare `go`, no ignored write in a
   critical path, a transaction where a partial write would lose money.
4. **Workflow per item (`MISSION.md` §17):** inspect, plan, implement, verify, review,
   update docs, report what was actually verified.
5. **Review after each phase:** read the phase's code once for what parity cannot
   see, and add findings to `review_fixes_needed.md` before the next phase starts.

---

## Phase 0 — Ground

**Needs:** nothing. **Unblocks:** everything.

- ☑ Go installed; `server/go.mod` created (module `github.com/softmato/hostelpalika/server`), `go` + `toolchain` lines pinned — go1.27.0, MSYS2 UCRT64 gcc + libvips 8.18.7 for govips (CGO on). `go 1.27.0` is the pin: `go mod tidy` drops a `toolchain` line equal to it, add one only when the toolchain moves ahead of `go`
- ☑ Folder skeleton per `FOLDER_STRUCTURE.md` — module folders are created as each module is ported
- ☑ `internal/platform/config` — every env var in `ENVIRONMENT.md` §2, typed, validated at boot — defaults/fallbacks ported from `lib/env.ts` + each `process.env` call site (TS `??` vs `||` kept); bad values fail boot where TS silently fell back; refuses an Atlas URI outside production; `COOKIE_SECURE` is read by only `public/search/parse` (session cookies use `IsProduction`); `GOMEMLIMIT` is read by the runtime, not config
- ☑ `cmd/api` — Gin (`gin.New()`, release mode), graceful shutdown, `/api/v1/health` — Gin 1.12 + sonic 1.15.5 (JIT path covers go < 1.28; check sonic before bumping Go); health body byte-identical to TS, 405 on wrong method; `httpx` has the envelope + recover only (Phase 1 adds validation/dup/Softmato mapping); SIGTERM drain is first exercised by the `deploy/` item (Windows can't send it)
- ☑ `deploy/` — Dockerfile (multi-stage, Debian-slim runtime with libvips + poppler), `compose.yaml` (`caddy`, `api`, `redis`), `Caddyfile` — trixie builder+runtime, non-root, `api healthcheck` probe; Caddy at static 172.28.0.10 = `TRUSTED_PROXIES`, h3 advertised, unported paths fall through to `TS_UPSTREAM`; `redis.conf` volatile-lru, unpublished; 2026-10-29: `up --build` all healthy, `stop api` → "stopped cleanly" exit 0 in <1 s
- ☑ Local stack runs with a **local** MongoDB container holding a copy of the live data (`deploy/copy-live-db.ps1`: read-only dump from Atlas → restore into `hostelpalika_dev`) — the Go server itself never gets the production URI. No seeds: the user ruled them out (2026-10-29), real data is already there; 2026-10-29: first copy restored — 145 collections, indexes included, archive deleted
- ☑ Real services in dev, fenced by `APP_ENV` (owner, 2026-11-02/03). `server/.env` has the real R2, encryption, LLM and Google keys. Outside production, config sets `R2.WriteRoot = <R2_KEY_PREFIX>/go-dev`: dev reads the live objects its Mongo copy points at, but put, delete and presigned upload refuse any key outside that root, and new keys are minted under it (`TestWriteRootFence`). Production has no fence, so nothing has to be changed at cut-over. Atlas is still refused outside production. Left out of dev on purpose, because they reach real people: Resend, Pusher, VAPID, Expo and the outbound Softmato secret
- ☑ Contract test harness (`TESTING.md` §3): recorder against the TS server, replayer against Go, JSON diff with volatile-field masks — `internal/contract` (masks with `*`, media-type compare, key-order check, unit-tested), `go run ./cmd/dev record -base … <case.json>`, `router/contract_test.go` replays every file; health recorded from live TS at 541e46cf and green. First catch: Next sends a bare 405 (no body, no content type), Gin sent text — fixed with a `NoMethod` handler
- ☑ k6 baseline recorded against the **current** TS production endpoints for the routes in DESIGN.md §2, so later numbers have something to beat — `testdata/k6/baseline.js` (5 public GETs, 2 req/s each, 60 s, from the dev machine in Nepal); results `testdata/k6/results/ts-prod-2026-10-29.json`. TTFB ms, med / p95 / p99 / max: health 88/119/1317/1601 · site-config 85/115/170/252 · hostels list 81/104/202/345 · hostel detail 84/122/201/461 · reviews 96/276/2062/2881; 0 errors. Medians ≈ network floor (health reads no DB yet sits at 88); the tails (1.3–2.9 s on health and reviews) are the cold starts Go has to remove. Compare Go from the same machine against the VPS, not localhost

**Gate:** `docker compose up` gives a healthy API; the harness can record and replay `/api/v1/health`.

---

## Phase 1 — Platform core

**Needs:** Phase 0. **Unblocks:** every route.

- ☑ Mongo client (warm pool), Redis client (in-compose container, production included — ARCHITECTURE.md §5) — `cmd/api` opens Mongo (5–50 pool, ping) before listening, fatal on failure; `internal/platform/redis` (go-redis v9.23, 500 ms read/write, 4 warm conns) is fail-open: unreachable at boot = warning, empty `REDIS_URL` = nil client; both handed to routes as `router.Deps`. `/health?deep=1` pings both → 503 `SERVICE_UNAVAILABLE` (reason logged, not in the body); plain `/health` stays dependency-free. 2026-10-29: verified in compose — Redis stopped → deep 503, plain 200; restarted → deep 200
- ☑ Response envelope, error mapping, zod-shaped validation errors (`PARITY.md` §3) — `httpx.Fail` follows `handleRouteError`: `*httpx.ValidationError` → 422 `{formErrors, fieldErrors, issues}` (first-seen key order), `*Error` → own status, anything with `SoftmatoRejection()` → 502 `SOFTMATO_REJECTED`, E11000 → 409 `DUPLICATE_VALUE` with the email/phone messages (keyPattern read from write, bulk and command errors), else 500. `internal/platform/valid` carries zod v4 English messages (Type, OneOf, TooSmall/TooBig, Pattern, Format, Received). Envelopes are encoded with `sonic.ConfigDefault` (no HTML escaping, as `JSON.stringify`) and sent as bare `application/json` like Next — Gin had been writing `>` for `>`. Golden test = zod 4.4.3 output, green with and without `-tags=sonic`
- ☑ JWT issue/verify with the shared secrets; refresh rotation; purpose tokens — `internal/platform/auth`: golang-jwt v5.3.1, header `{"alg":"HS256"}` and claims in jose's key order, so a Go access token is **byte-identical** to jose's for the same claims and clock (test pins it); HS256 only, exp checked with no leeway as jose; refresh drops `lockPin`; purpose tokens let `tokenType`/`tokenVersion` override extra claims. `Sessions` ports the row state machine: insert with hash, `Find` (reuse of a token two rotations old revokes the session), `Rotate` (CAS on presented hash; browser reuse inside 60 s → no new token; lost phone reply → reissue), `Logout`, `Revoke`, `RevokeAll`; every update stamps `updatedAt` like mongoose. Re-authorising the user between `Find` and `Rotate` (active user, temporary credential, stranded resident, payload extras) belongs to the auth routes at this phase's gate. 2026-10-29: rotation cases from auth.service.test.ts green against the compose Mongo (throwaway db)
- ☑ Cookies (`hostelpalika_*` + legacy fallbacks), domain-ready — `internal/platform/auth/cookies.go`: readers take the current name then `hostelhub_*` fallbacks, Next's parse rules (last duplicate wins, decodeURIComponent, empty = absent); writers emit Next's exact `Set-Cookie` bytes (attribute order, lowercase `SameSite=lax`, `Expires` only when max-age > 0, the raw `/api/v1/auth` clear line with its own order); `Secure` = `IsProduction`; `COOKIE_DOMAIN` set adds `Domain=` to every line, empty = host-only like TS. Unlock cookie signs/verifies `lock-pin-unlock` (missing `sessionId` claim refuses, as TS's `undefined !== ""`). 2026-10-29: golden lines captured from the real `session-cookies.ts` under vitest at a fixed clock, both NODE_ENVs, green. Not yet in `router.Deps` — the guards item wires `Tokens`/`Sessions`/`Cookies` together
- ☑ All 14 guards, roles, capabilities, hostel scoping; `tenant-isolation` cases ported and green — `internal/platform/authz`: every guard of `lib/api-auth.ts` (PIN lock 423 with lock-pin/biometric/logout open, `narrowToLiveHostels`: suspension 423 with billing/files/leave/subscription open, deleted hostels dropped for staff, branch via `x-hostel-id` id or slug only if held else the main hostel, KYC 423s), warden capabilities per request with the `verifyPayments` alias, temp-credential revocation per request, 404-not-403 tenant misses, `HostelScopedFilter`, `LandingPath`. Guard-level tenant cases green against the compose Mongo. **Re-scoped 2026-10-29:** `tenant-isolation.test.ts` asserts the Mongo filters inside the residents/notices/complaints/maintenance services and finance claim review, which do not exist before Phase 6 — each of those cases now travels with the item that ports its module (Phase 6 below), and PARITY's Tenant isolation row stays ☐ until all are green
- ☑ Rate limiting on Redis — `internal/platform/ratelimit`: fixed window `rl:{ns}:{ip}:{ua}` (INCR, PEXPIRE NX, PTTL in one MULTI), TS's 429 `RATE_LIMITED` + `retryAfterSeconds`; `PublicForm` (config budget) and `AuthAttempts` (5 / 15 min per door). IP is Gin's `ClientIP` (XFF trusted only from Caddy) — TS took the first XFF entry as given. Redis down → TS's in-memory window, never no limit. 2026-10-29: green on Redis and on the fallback
- ☑ Read cache + version bump + singleflight + version ETags — `internal/platform/cache`: `Read` = `cachedRead` (TS key/value format, 60 s, 150 ms per op, one hostel only, cached null is a hit, errors never cached) + singleflight; `Bump` = `bumpHostelCache`, called by the guard on every signed-in write now and after the response. `httpx.ETag()` = `withEtag`, tags byte-identical to TS (FNV-1a over UTF-16, golden from node). `cache.Respond` is the 27 TS routes' `withEtag(successResponse(cachedRead(…)))` in one step with the 304 answered before any work: the finished envelope is stored with its tag under `r:{hostel}:{version}:{user}:{key}`, so a revalidation is two Redis GETs, no Mongo, no re-encode, and a hit is copied to the socket. Tag = body hash, not version-only: a version-only tag would 304 a change that never bumped the version (TS lets those expire in 60 s). 2026-10-29: green on the compose Redis
- ☑ `afterResponse` equivalent with shutdown drain — `internal/platform/background`: `After(ctx, fn)` queues on the request (runs once the handlers finish, as `after()`), runs now outside a request; every goroutine tracked, detached from request cancellation, panics/errors logged and dropped; never holds a recycled `*gin.Context`. `cmd/api` drains it after `srv.Shutdown`, inside the same grace
- ☑ Audit log + usage counter writers — `internal/platform/audit`: `Write` = `AuditLogModel.create` (field order, `__v`, USER needs an actor, `minimize` drops empty metadata — checked against live rows), `WriteFinance` = `auditFinanceAction` (per-hostel sha256 chain; golden = two consecutive live TS entries, Go reproduces the second hash), `CountUsage` = the `ApiUsageCounter` upsert `$inc` (UTC month, timestamps + `__v` as mongoose writes them). The `UsageEvent`/`UsageDaily` analytics are a route module, ported with it
- ☑ `Server-Timing`, request id, slog, pprof — `internal/platform/obs` middleware (after recover): Caddy's `X-Request-Id` if sane, else minted, on every log line under the request (and its background work); `Server-Timing: app;dur, db;dur, redis;dur` stamped as the first byte leaves (304s too), db from a Mongo `CommandMonitor`, redis from a go-redis hook; one `request` line per request (method, route, status, durations, user id; health at debug). slog redacts credential keys. pprof on `PPROF_ADDR`, which config now refuses unless loopback. Router sets `ContextWithFallback` so a `*gin.Context` passed as ctx reaches those values

**Gate:** `/api/v1/auth/*` (20 routes) pass contract tests; a token minted by TS works on Go and the reverse; a refresh through Go invalidates the old token for TS too. **Passed 2026-10-29:** `testdata/contract/auth/` — 12 files, 113 cases recorded from TS at `41b0ef10` on the fixture database (`internal/contract/fixture`: fixed ids, test secrets, cost-4 hashes), replayed green 3× in a row: status, body, key order, Set-Cookie names/paths/flags. `router/interop_test.go` (with `CONTRACT_TS_BASE`): a TS-minted access token works on Go `/me` and a Go-minted one on TS `/me`; two refreshes through Go make the original token reuse on TS → 401 INVALID_SESSION, and the session is dead on Go too

---

## Phase 2 — Shared domain libraries

**Needs:** Phase 1. **Unblocks:** any module that uses them (most do).

- ☑ BS calendar + hostel day (UTC+5:45) + night window — test vectors generated from `packages/shared` and checked in under `server/testdata/vectors/`
- ☑ Money helpers (paisa `int64`), plan catalogue values
- ☑ Personal-data crypto + finance secret crypto — decrypt a sample of real-format ciphertexts produced by TS
- ☑ R2 (both buckets, presign), upload verification — image-integrity (sharp) travels with the images item
- ☑ Email sender + identity + topic opt-out + daily cap; templates ported as each module needs them (`PARITY.md` §8) — the daily cap is job cadence in TS (no code-level cap), so it travels with the Phase 9 jobs
- ☑ Push fan-out (Expo + Web Push), Pusher publish + channel auth — the preference filter and the two routing tables are `push.Hooks`, filled in by the notifications module
- ☑ Images (govips), PDF out, PDF in, xlsx, CSV, zip, QR — each with golden files. PDF out is the drawing layer + layout `Cursor` (glyph-identical to pdf-lib, incl. its measuring-only kerning) and the `pdftest` glyph harness; each document type is ported with its module and diffed against its TS output
- ☑ Sealed archive (nacl) — archives sealed by TS open in Go and the reverse

**Gate:** every library in `PARITY.md` §3 is ☑.

---

## Phase 3 — Public read path

**Needs:** Phase 2. **Unblocks:** web SEO pages moving off direct Mongo.

- ☑ `public` — 31 of 32 routes: everything but `POST /public/plan-checkout` (moved to Phase 8, see there); `bookings` public reads (`availability`, `guide`, `policy`), `feedback`, `usage`, `email-preferences`, `health`
- ☑ Demo hostels merge, search + LLM search quota, maps geocoding (`platform/maps`, `platform/llm`, `platform/search`)

**Gate:** every Phase 3 route green in the contract suite (web page switch moved to Phase 10: server first, web last).

---

## Phase 4 — Cookie domain + client base URL (clients stay on TS)

**Needs:** Phase 1 (auth on Go). Can run alongside Phase 3.

- ☐ TS server widens auth cookies to `Domain=.hostelpalika.com` (ARCHITECTURE.md §4); release stays live until active sessions have refreshed — **code done 2026-11-01:** `COOKIE_DOMAIN` in `lib/session-cookies.ts` + `lib/lock-pin-cookie.ts`, host-only copy expired first, old `hostelhub_*` cleared host-only, Go `auth.Cookies` the same. **Left, outside work (`review_fixes_needed.md`, "Open items"):** set `COOKIE_DOMAIN=.hostelpalika.com` on Vercel and deploy; this stays ☐ until that release has been live long enough for sessions to refresh
- ☑ Web: one `API_URL` / `NEXT_PUBLIC_API_URL`; every client call uses it — `lib/api-url.ts` (`apiUrl`, `apiFetch`, `pusherChannelAuth`); `browserApi`, the downloader, upload XHR, raw fetches, Pusher auth, and JSX `src`/`href`/form actions. Empty = this origin rather than the literal `https://hostelpalika.com`, so local and preview builds keep calling themselves. Paths saved in data stay relative on purpose and reach the API host through the rewrite below
- ☑ App + PWA: same base-URL setting, value unchanged until cut-over (the switch ships by OTA if the runtime fingerprint allows, else in the next native build) — already `API_BASE_URL` / `EXPO_PUBLIC_API_URL` in `apps/mobile/src/lib/api.ts`; the receipt-sheet native module is handed that URL for its refresh, and its own `https://hostelpalika.com` is only a fallback
- ☑ Web `/api/*` → `api.hostelpalika.com` rewrite (`beforeFiles`) behind an env flag, off until cut-over — `API_REWRITE_ENABLED=true` + `API_URL` in `next.config.ts`; `/api/v1/*` only, because `/api/receipt-share` and the AASA handler stay on the web
- ☑ Added for the cross-origin web calls: Go CORS (`httpx.CORS`, `CORS_ORIGINS`, API.md §8) with `ETag`/`Content-Disposition` exposed, since `browserApi` and the downloader read them

**Gate:** every client reads its API host from one setting; nothing calls `api.hostelpalika.com` yet. **Met in code 2026-11-01;** Phase 4 closes when the cookie release is live.

---

## Phase 5 — Resident-side surfaces

**Needs:** Phases 2 and 4.

- ☑ `resident` (37 of 39; both checkout routes moved to Phase 8, see there), `guardian` (6), `cook` (11), `community` (10), `notifications` (4), `push` (4), `realtime` (2), `account` (9), `mobile` (1), `files` (5). Cook's owner and warden sides are Phase 6; a hostel-leave export reports `recordsPending` until Phase 7 builds it
- ☑ `bookings` signed-in routes except money: create/list, detail, cancel, quote, documents (`checkout`, `payment`, `return` wait for Phase 8) — `modules/bookings/{signed,terms,document}.go`; email attachments in the sender; six booking templates against TS vectors; invoice, receipt and refund note against TS goldens. The rows both servers write were diffed field by field for cancel and create. The Softmato client is Phase 8: until then a configured deployment queues `BOOKING_PAYMENT` and `REFUND_FILING` tasks instead of calling it, and a Softmato receipt with no local copy is redrawn by us
- ☑ Raster ID cards — `platform/idcard`, drawn from the same geometry as `lib/platform-id-card.ts`: an SVG with Inter as glyph outlines and GPOS pair kerning, rendered by libvips. Six golden PNGs from `@napi-rs/canvas`, mean difference under 0.8/255. Library only: its callers (`sendIdCardEmail`) are Phase 7 approvals

**Gate:** a resident, a guardian and a cook can complete their daily flows on Go only. **Passed 2026-11-01 by contract replay,** with one carve-out decided that day: paying through a gateway (resident checkout, booking checkout) is Phase 8, so a resident on Go pays by QR and sends proof. Not exercised against real services: Vision and Gemini calls, R2 evidence fetch, presigned links, real ZIP contents. They are off in the contract environment and need a run with real keys before cut-over.

---

## Phase 6 — Hostel admin

**Needs:** Phase 5 (shared notification paths).

**Start here, before any module:** the "Open items" table in `review_fixes_needed.md`:
intake of the uncommitted TS work (R31), push and get CI green (R17), then the Phase 4
cookie release. Claude does the first two; the cookie release is outside work, so Claude
does it if it can reach Vercel, and otherwise hands the owner the step and moves on
(`MISSION.md` addition 4). Phase 6 does not wait for it.

**Status 2026-11-03: done.** Every hostel-admin route is on Go and contract-green
(`TestRoutesMatchWeb`: none of the 204 still unported is a hostel-admin route; they are
platform, team, store, cron, users and Phase 8 money-in). Closed on 2026-11-03: RES-16 (the
card made from the admission form, with `/users/resident-identity` and `/users/:userId/avatar`
ported for it), R31's intake (`account/saved-hostels`, referral-code `coverUrl`), FIN-9,
FIN-13, PLAN-1, and every TS fix the bug rule owed (FIN-2/3/4/5/5b/7/12, PERF-1, R28 billing
run). The field-team copies of the existing-residents routes mount with the team group, so
they move to Phase 7. Findings are in `review_fixes_needed.md` ("Phase 6 findings"), all ☑
but the Phase 8 half of R28.

The biggest group (223 routes). Port module by module, in this order, so money
moves last within it:

- ☑ rooms/floors, residents (incl. existing-residents list, join link, admission forms, Form QR), arrivals, move-checklist — with `tenant-isolation.test.ts`'s resident cases (`getResidentById` scoped + 404, `listResidents` list/count/search `$or` scoped, foreign `hostelId` → 404 before any query)
- ☑ food, notices, complaints, maintenance (voice notes), safety (SOS, night status), attendance — with the notices/complaints (incl. summary aggregate)/maintenance tenant cases
- ☑ stock/inventory, store orders, wardens, team members, reports, exports
- ☑ KYC wizard + signed agreement, hostel leave, backup (Drive OAuth callback), settings
- ☑ finance: invoices, receipts, khata, late fine, deposits, expenses, staff cash, statement import, evidence pipeline, reconciliation — with the approve/reject-claim tenant cases (`hostelId: {$in: caller's}`, foreign claim → 404 CLAIM_NOT_FOUND). Settling, approving and billing runs use a transaction where a partial write loses money (`review_fixes_needed.md` R28)
- ☑ Review of Phase 6 (bug rule; findings logged and fixed before Phase 7). 2026-11-03: the diff of the closing work read for correctness; every id-only Mongo read or write in the Phase 6 modules checked to take an id from a row already scoped to the caller's hostel (none take one from a request); cross-hostel contract cases present for residents, notices, complaints, maintenance, attendance, safety and claims

**Gate:** a hostel admin and a warden run a full month (BS month) — bills issued, paid, receipted, reported — on Go only. Proven by the contract groups (billing run, cash, claims, receipts, reports, warden capabilities) against the recorded TS behaviour; the same month on a deployed Go server comes with cut-over (Phase 11).

---

## Phase 7 — Platform, team, store, users

**Needs:** Phase 6.

**Status 2026-11-04: done.** Every §6 row of the phase is ☑ (contract groups `admin-finance`, `admin-branches`, `admin-notice-pushes`, `cron`, plus new files in `store` and `team`, recorded from TS at `2bcde4d2` and green; P7-44..P7-46). The app has a superadmin shell (`app/(platform)`) with native Logs, Process, Cron, Active users and Analytics screens; they read the Go-only routes, so like the web pages they answer from cut-over on, and the on-device check comes with the owner's next OTA. Earlier status, 2026-11-03: done and contract-green: the server log store and
`/platform/logs` (+summary), `users` (account deletion + `/platform/account-deletions`,
expert consultation, temporary logins; group `platform`), the whole supply store —
`store/*` and `platform/store/*` (group `store`), the team (group `team`) including
`POST /team/hostels` and `/platform/team/members/:id`, and `platform/bookings/*` (14 routes,
group `platform-bookings`). Ported and wired in `router/platform_admin.go` but not yet
contract-recorded: the rest of `platform/*` (hostels, listing flags, desk, config editors,
feedback/reviews/community, sponsors, hostel leaves, referrals, service providers, offer
program, notifications, push, reports, subscriptions, admins and invites). Findings
P7-1..P7-34 in `review_fixes_needed.md`. `team/prepayments*` and `team/hostels/:id/checkout`
moved to Phase 8: they run the Softmato plan payment, like `hostel-registration`.

- ☑ `platform` (99)
, `platform-admin` (2), `team` (16, plus the field-team copies of the existing-residents routes), `store` (13), `users` (7 left: account-deletion, expert-consultation-requests, temporary-credentials; resident-identity and avatar went with Phase 6)
- ☑ Site config / SEO config / page copy editors
- ☑ Referrals (hostel + partner), offer program, subscriptions, manual plan-payment review
- ☑ **Server logs in the superadmin portal** (owner's requirement, `MISSION.md` addition 3). All of it visible and filterable by a superadmin:
  - Every log line carries a **level** (debug, info, warn, error) and a **category** (`http`, `auth`, `security`, `payments`, `email`, `push`, `realtime`, `database`, `redis`, `storage`, `jobs`, `llm`), plus time, message, request id, route, status, duration, user id, hostel id. Categories are one list in `platform/log`, not free text
  - Go stores warn and above, and any info line marked operational, in a `serverlogs` collection with a TTL index. Stored through a bounded in-process batcher, so a request never waits for a log write and a Mongo outage cannot grow memory: when full it drops and counts the drop. Stdout stays complete either way. A surge (a log flood during an outage) is capped per category
  - The existing redaction holds in the store too: never tokens, cookies, passwords, PINs, OTPs, personal data or coordinates (`RULES.md` §4). A test writes each kind through the logger and reads the stored row
  - `GET /api/v1/platform/logs` (superadmin guard): filter by level, category, route, request id, user, hostel, time range and text; cursor pagination, newest first. `GET /api/v1/platform/logs/summary`: counts by level and category over a range. These are new routes with no `route.ts`, so each gets an entry in `goOnlyAllowed` with this reason
  - Level per category settable by a superadmin (site config), applied without a restart
  - Portal page: `/platform/logs` on the web and a native `manage` screen in the app, in `portal-nav.ts` and its search. Filters, level and category chips, a row opens the full entry, one request id shows the whole request's lines. Beside it a health strip from the metrics: request rate, p95, error rate, Mongo pool use, cache hit rate, rate-limit refusals
  - The web page reads through `API_URL`, so it goes live with cut-over
  - 2026-11-03: web done — `/platform/logs` with the strip (`GET /platform/logs/health`, since-boot figures from the metrics registry), chips with counts, filters, the full entry, *Whole request*, and the per-category level selects (site config `logs`). 2026-11-04: native screen done — `app/manage/system/logs.tsx` (health strip, level and category chips with counts, filter sheet, the full entry in a bottom sheet with *Whole request*, newer/older pages, level per category). SUPERADMIN now lands on `app/(platform)`, built from `PLATFORM_NAV` (owner, 2026-11-03: "we need the superadmin screens too"). Left: the on-device check, after the owner's OTA
- ☑ **Superadmin system tabs** (owner, 2026-11-03: "cron, logs, process logs, analytics, daily active users … each tab so superadmin can see those"). One portal area with five tabs, web and app `manage`, all in `portal-nav.ts` and its search, superadmin guard. The Go routes are new, so each one goes in `goOnlyAllowed`:
  - **Cron**: one row per job (schedule, last run, last status, next run, and a *missed* flag when the last success is older than its interval), then its run history from Phase 9's `cronruns`, filterable by job, status, trigger and time. A row opens the run's error and its log lines (by run id). A *Run now* button posts `/cron/{name}`
  - **Logs**: the server log page above
  - **Process**: the API process itself, per instance: uptime, boot and shutdown lines, version and commit, goroutines, heap and RSS, GC pauses, Mongo pool and Redis state, panics recovered. Read from the runtime, plus the stored `jobs`/`database`/`redis` lines that come from boot
  - **Analytics**: the existing usage page (`/platform/usage`: screens, features, people, role and hostel) moved under this area, not rebuilt
  - **Active users**: daily, weekly and monthly active users per Kathmandu day, split by user type (role) and client (app, PWA, web), plus the list of who was active on a chosen day (name, role, hostel, first and last seen, opens). An aggregation over `usageevents` (which already stores user, role, hostel, client and time), so it needs no new tracking. History reaches back as far as the usage TTL
  - 2026-11-03: web done for Logs, Process (`GET /platform/system/process`), Active users (`GET /platform/system/active-users`) and Analytics, as children of *System* in `portal-nav.ts` (search entries come with them), superadmin-only in `route-access.ts`. 2026-11-04: Cron shipped with Phase 9 on the web; native `manage/system/{process,cron,active-users,analytics}` in the platform shell (Cron: job rows, missed flag, Run now through `openConfirm`, run history with job/status/trigger filters, a run's error, counts and log lines). The PWA sends `pwa` through a web stand-in (`web/usage-client.ts`, not a `Platform.OS` branch in `src/`). Left: the on-device check after the OTA, and the first real `pwa` row in `usageevents` once the PWA export is redeployed

**Gate:** superadmin and team flows complete on Go only, and a failing request can be found in the portal by its request id.

---

## Phase 8 — Money in from outside

**Needs:** Phase 7.

**Status 2026-11-03: done.** Every Phase 8 route is on Go: contract group `billing-online`
(71 cases) plus `admin-reports/finance-gateways.json` for `payment-gateways` and
`payment-profile`, all recorded from TS and green. Findings P8-1..P8-7, each fixed in Go and TS.
The gate passed with zero drift (below). Fonepay has no adapter in TS either: it waits on the
bank's merchant API (outside the repo).

- ☑ `webhooks/:provider` (eSewa, Khalti), `webhooks/softmato`, `integrations/questioncall/*`
- ☑ `bookings/:id/checkout`, `bookings/:id/payment`, `bookings/:id/return`
- ☑ `team/prepayments` (4) and `team/hostels/:id/checkout`; the team registration's online publish path claims, settles and releases the prepayment
- ☑ `POST /public/plan-checkout` and `hostel-registration` (5: `[hostelId]/invoice|pay|plan|state`, `return`)
- ☑ Checkout intents, settlement, reconciliation, gateway health — **offline shadow**: `dev shadow-phase8` (run from the repo root on a fresh `deploy/copy-live-db.ps1` copy) runs Go's `gateway-health` and `gateway-settlement-recon` (`gateway/jobs.go`, run rows through `modules/recon`) and the Softmato reconcile over live data, then diffs against what TS recorded. 2026-11-03: 25/25 hostels match TS's latest health and recon runs; 18 Softmato plan invoices reconciled through Go (17 read back from Softmato, one pre-integration document 404s for TS too), 33 payments before and after, no invoice or subscription moved; 2 OPEN team prepayments still unpaid at Softmato. Live data holds no eSewa/Khalti attempt yet (no hostel has a gateway switched on), so provider-event replay starts with the first real one; the unit and contract tests cover that path meanwhile
**Gate:** replaying a full `gateway-settlement-recon` window shows zero drift between Go's rows and TS's. **Passed 2026-11-03.**

---

## Phase 9 — Jobs in-process

**Needs:** the module each job touches is on Go.

- ☑ Each of the 19 jobs in `PARITY.md` §5 ported, with one observed run on the local stack against the live-data copy (outbound calls faked) matching what the TS job did for the same data
  - 2026-11-04: `dev shadow-phase9` (`cmd/dev/shadow9.go`, TS half `testdata/jobs/shadow-ts.sh`): live copy cloned twice, each job posted to TS and to Go, answers and every collection diffed after each job; every non-local host blocked on both sides and logged (both tried the same hosts: Expo once, Overpass 15 times). Zero drift on all 18 scheduled jobs and on `platform-backup` (report, drill, invalid body). It caught P9-2..P9-4 first. Jobs whose window was shut at run time (meal call, night prompt) matched by both doing nothing
- ☑ **Cron run history** (owner, 2026-11-03: cron-job.org runs kept failing with no record). Every run goes through one runner, whether it comes from the scheduler or from `POST /cron/{name}`. The runner writes a `cronruns` row before the job starts and finishes it afterwards: job, trigger (`schedule`, `manual` or `http`), instance, run id, start and end, duration, status (`running`, `ok`, `failed`, `skipped` when another instance holds the lock, `timeout`), error, and the job's own counts. These are plain inserts, never through the droppable log batcher, with a TTL long enough to compare months. A row still `running` after the job's deadline is closed as `timeout` at boot. Each job's lines carry the run id in the `jobs` log category. A failed or missed run logs an error, and that error is shown on the Cron tab
  - 2026-11-04: `internal/jobs` runner + `POST /cron/{name}` doors + `GET /platform/system/cron[/runs]`; every job registered in `router/jobs.go` on the same instances the routes use; `cmd/api` closes stale runs at boot, schedules only with `SCHEDULER_ENABLED=true`, drains runs on shutdown. Web Cron tab at `/platform/system/cron` (job rows with missed flag and Run now, run history filters, a run opens its error, counts and log lines by run id)
- ☑ Maps nearby (Overpass) and routing in `platform/maps` — moved from Phase 3: only the nearby-places job and the owner profile call them, so they land with the first of those
  - 2026-11-04: nearby (`maps.Nearby`, Overpass then Google) serves the refresh job and the owner profile. Routing has no server side: `lib/maps/routing.ts` runs in the browser and the app against OSRM, so there is nothing to port

**Gate:** all 19 jobs proven locally; switching them on is part of the cut-over.

---

## Phase 10 — Production grade (after every route is on Go)

**Needs:** Phases 6–9. Added 2026-11-01 from `MISSION.md`. Not a formality: the gate is
measured. Findings land in `review_fixes_needed.md`.

**Targets (the numbers to prove, not claims).** Server time, excluding the client's
network: the p95 budgets in DESIGN.md §2, with the measured Kathmandu–Mumbai round
trip added for each Mongo call on the VPS. p50 and p99 are recorded beside each p95;
p99 is set once the first VPS run shows the real tail. Error rate under 0.1 %
excluding 4xx. Cache hit rate over 80 % on cacheable routes. Budgets: API 1 GB, Redis
256 MB, Mongo pool 50. Workload is derived from real data first: hostels × residents
× requests per active user, from the `UsageDaily` rows, and turned into req/s and
concurrency before any test.

- ☐ `cmd/indexes`: port `apps/web/scripts/ensure-indexes.mjs` so a fresh database can be built with TS gone (R19)
- ☐ Module-by-module read against `MISSION.md` §3 Phase B: correctness, not only parity (R27)
- ☐ Query review on the live-data copy: `explain` for each hot route, N+1s, reads with no limit (R29), slow-query log
- ☐ Load tests with k6 on the local stack, then the VPS: cold cache, warm cache, sustained, burst. Results recorded with environment, duration, concurrency, throughput, percentiles, errors and resources (`testdata/k6/results/`). A local number is never quoted as production capacity
- ☐ Profile under load (CPU, heap, allocations, block, mutex); fix what the profile proves, measure again
- ☐ Failure tests: Redis down, Mongo slow or down, provider hanging, overload and recovery, SIGTERM under load with no lost request
- ☐ Multi-instance check: two API containers behind Caddy, limits shared, jobs not doubled, no sticky-session need. Say plainly where scaling the API would not help because the limit is Atlas
- ☐ Race, static analysis and vulnerability checks clean in CI (R17)
- ☐ Tracing decision: request id through logs is the default; add OpenTelemetry only if a real incident shows it is needed
- ☐ Operator docs: runbook, alerts on the metrics, deploy, rollback and recovery steps, secret handling
- ☐ Final readiness report against `MISSION.md` §21, listing anything not met

**Gate:** targets met and recorded on the VPS; no Critical or High open in `review_fixes_needed.md`.

---

## Phase 11 — Cut-over and cleanup

**Needs:** every phase above.

- ☐ Web pages in `PARITY.md` §9 that only read public data switch to `fetch(API_URL)`; home, city/near pages, hostel detail and software pages render from the Go API with no `@/modules` import (moved from Phase 3)

- ☐ Cut-over (ARCHITECTURE.md §11 step 3): final change intake + full contract run at HEAD, Go on the Kathmandu VPS against production Atlas (warm, `/health?deep=1` green), web `API_URL` → `api.hostelpalika.com` + rewrite on, app/PWA base URL by OTA, cron-job.org off, `SCHEDULER_ENABLED=true`
- ☐ Rollback lever proven before the switch: Caddy `BACKEND=ts` answers from Vercel TS
- ☐ Rollback window passed with TS still deployable; then everything in `PARITY.md` §11
- ☐ Upstash dropped from the web's env
- ☐ Web drops `MONGODB_URI`, the API routes, `modules/` and server-only `lib`

**Gate:** `PARITY.md` has no ☐ left; `ROUTES_COMPLETE=1 go test ./internal/router` passes before TS is removed.

---

## Later, optional

- Own WebSocket server replacing Pusher (`coder/websocket`, Redis pub/sub if more than one instance) — once Pusher cost or limits make it worth it.
- Durable job queue — only if a lost background job is shown to matter.
- REST v2 cleanup — as its own project after cut-over.
