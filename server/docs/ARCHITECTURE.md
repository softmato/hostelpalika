# ARCHITECTURE.md — Standalone API

## 1. Topology

```
             Android app / PWA                Web (Next.js, Vercel bom1)
             bearer + refresh                 browser: cookies .hostelpalika.com
                     │                        SSR: server-side fetch
                     └──────────────┬─────────────────┘
                                    ▼
                    api.hostelpalika.com  (VPS, Kathmandu)
             ┌──────────────────────────────────────────────┐
             │  caddy   TLS · HTTP/2 · HTTP/3 · zstd/gzip   │
             │    │                                         │
             │    ▼                                         │
             │  api (Go/Gin)  ── in-process scheduler (19)  │
             │    │   │                                     │
             │    │   └── redis (cache · limits · locks)    │
             └────┼─────────────────────────────────────────┘
                  ▼
     MongoDB Atlas (Mumbai)   R2 (public + private)   Resend   Pusher
     Expo push   Web Push   eSewa · Khalti · Fonepay   Softmato
     Google (OAuth, Drive, Vision)   LLM providers   OSM upstreams   QuestionCall
```

Where things sit (user decision, 2026-10-29):

- **API + Redis: one VPS in a Kathmandu datacenter**, one Docker Compose. Phones
  in Nepal reach it without leaving the country; Redis is a same-host hop.
- **Web: Vercel `bom1` (Mumbai)**, the nearest Vercel region. Each SSR fetch
  crosses the border to the VPS; public pages cache with `next: { revalidate }`
  (PARITY.md §9), so most renders never call the API at all.
- **Atlas: Mumbai** (no Nepal region). Every Mongo round trip from the VPS
  crosses the border, so reads are Redis-first (§5) and independent queries in a
  handler run in parallel, never one after another. Atlas stays here (user
  decision, 2026-10-29: Nepal VPS providers offer no managed database).
- Every other outside service (R2, Resend, Pusher, Expo, Google, gateways) is
  off the box too — background (§9) or parallel, never serial on a request.

## 2. Request lifecycle

Gin is built with `gin.New()` (no default logger/recovery — we add our own,
cheaper ones). Middleware, outermost first:

1. **recover** — panic → 500 envelope, logged with request id.
2. **request id** — honour `X-Request-Id` from Caddy or mint one.
3. **timing** — starts the clock; writes `Server-Timing: app;dur=…, db;dur=…,
   redis;dur=…` on the way out. This is how latency is measured (DESIGN.md §2).
4. **real IP** — trust `X-Forwarded-For` **only** from Caddy's address.
5. **CORS** — allow-list of web origins, credentials on; the app sends no
   `Origin` and is unaffected.
6. **body limit** — per-route ceiling (uploads go straight to R2 by presigned
   URL, so API bodies stay small).
7. per route: **rate limit** → **guard** (principal, role, capability, hostel
   scope) → **handler** → **ETag**.

Each route also gets a context deadline equal to its TS `maxDuration` (PARITY.md
§6 `maxNs`), so a stuck upstream can't hold a goroutine forever.

## 3. TypeScript → Go mapping

| Concern | TypeScript today | Go |
|---|---|---|
| HTTP | Next.js route handlers | `gin-gonic/gin` |
| JSON | `JSON.stringify` | Gin with `-tags=sonic` (bytedance/sonic; Gin docs → "Build with json replacement") |
| Validation | `zod` | `go-playground/validator/v10` via Gin binding + hand-written checks where zod refines; errors re-shaped to zod's `flatten()` output |
| Mongo | `mongoose` | `go.mongodb.org/mongo-driver/v2` |
| Redis | `@upstash/redis` (REST) | `redis/go-redis/v9` (native protocol) |
| JWT | `jose` HS256 | `golang-jwt/jwt/v5` HS256 |
| Google ID token | Google certs | `google.golang.org/api/idtoken` |
| Google service account (Vision) | RS256 SA JWT | `golang.org/x/oauth2/google` |
| Passwords / PIN | `bcryptjs` cost 12 | `golang.org/x/crypto/bcrypt` (reads `$2a$`/`$2b$` hashes as-is) |
| Personal-data crypto | `node:crypto` AES-256-GCM | `crypto/aes` + `crypto/cipher` GCM — same byte layout |
| Sealed archives | `tweetnacl` | `golang.org/x/crypto/nacl` (same primitive) |
| R2 | `@aws-sdk/client-s3` + presigner | `aws/aws-sdk-go-v2/service/s3` + `s3.NewPresignClient` |
| Images | `sharp` | `davidbyttow/govips/v2` (libvips — sharp's own engine) |
| Raster cards (ID cards) | `@napi-rs/canvas` | SVG template rendered by libvips (librsvg) |
| PDF out | `pdf-lib` | `signintech/gopdf` for drawn documents; `pdfcpu` for merge/stamp |
| PDF in | `unpdf` | `pdftotext -layout` (poppler-utils) via `os/exec` |
| xlsx | SheetJS | `xuri/excelize/v2` |
| CSV | `papaparse` / `lib/csv.ts` | `encoding/csv` |
| Zip | `lib/zip-stream.ts` | `archive/zip` streaming to the response |
| QR | `qrcode` | `skip2/go-qrcode` |
| Email | Resend SDK | `resend/resend-go/v2` |
| Realtime | `pusher` | `pusher/pusher-http-go/v5` |
| Web push | `web-push` | `SherClockHolmes/webpush-go` |
| Expo push | HTTP | `net/http` |
| Google Drive | REST | `google.golang.org/api/drive/v3` + `x/oauth2` |
| Softmato | `@softmato/sdk` | `net/http` client of the same endpoints (read the SDK) |
| LLM providers | `lib/llm/providers.ts` | `net/http`; same key pools, same `LLM_PROVIDER_ORDER` |
| BS calendar | `packages/shared/src/calendar/bs.ts`, `nepali-date-converter` | `internal/platform/bs` (hand port + shared vectors) |
| Logging | `lib/logger.ts` | `log/slog` JSON |
| Scheduler | cron-job.org → HTTP | `go-co-op/gocron/v2` + `gocron-redis-lock/v2` |
| "after response" | `next/server` `after()` | goroutine on a tracked `sync.WaitGroup`, drained on SIGTERM |
| Stampede guard | — | `golang.org/x/sync/singleflight` |

libvips and poppler are C libraries, so the API image is Debian-slim with cgo,
not distroless-static (ENVIRONMENT.md §4).

## 4. Auth and sessions

Go and TS must accept each other's tokens for the whole migration.

- **Same secrets.** `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `OTP_HASH_SECRET`,
  `ACTIVATION_CODE_SECRET`, `PERSONAL_DATA_ENCRYPTION_KEY`, `FINANCE_MASTER_KEY`
  (+ `_PREVIOUS`) are shared with the TS server, byte for byte.
- **Same claims, same TTLs** (`ACCESS_TOKEN_TTL`, `REFRESH_TOKEN_TTL`).
- **Refresh rotates.** Every `/auth/refresh` revokes the presented refresh token
  and issues a new pair (the `Session` collection). A client that keeps only the
  access token gets one refresh, then a logout — port exactly.
- **Purpose tokens** — `verifyPurposeToken` in `lib/auth.ts` (e.g. the
  per-resident night-status answer token from the Android shade); same purposes,
  same expiry.
- **App lock PIN** — server-side 4-digit PIN gates the app and every web portal
  (`/unlock`, `hostelpalika_unlock` cookie).
- **Cookie names** — `hostelpalika_access_token`, `hostelpalika_refresh`,
  `hostelpalika_unlock`, with the legacy `hostelhub_*` names still read as
  fallbacks.

### Cookie domain change (the one auth migration step)

Today the cookies are host-only on `hostelpalika.com`. A browser will not send
them to `api.hostelpalika.com`. So, before the web starts calling the API host:

1. The TS server starts setting every auth cookie with
   `Domain=.hostelpalika.com; Secure; HttpOnly; SameSite=Lax` (and clearing the
   host-only copy on refresh).
2. That release stays live until active sessions have refreshed through it.
3. Only then does the web switch to `api.hostelpalika.com`.

`hostelpalika.com` and `api.hostelpalika.com` are the same *site*, so
`SameSite=Lax` cookies travel on credentialed `fetch`. The app and PWA use
bearer tokens and are unaffected.

## 5. Redis

One Redis 7 container beside the API, reached over the Docker network.

| Use | Key | Notes |
|---|---|---|
| Hostel cache version | `v:hostel:{hostelId}` | `INCR` on every write to that hostel |
| Read cache | `c:{hostelId}:{version}:{userId}:{routeKey}` | 60 s TTL; value JSON `{"value": …}`; only when the principal has exactly one hostel; 150 ms timeout → Mongo |
| Warm data (Go only) | `s:{name}` | public/static reads — site config sections, plans, demo hostels, public listings, cities, SEO — loaded at boot, rewritten on every write to them, 24 h TTL as a backstop |
| Rate limits | `rl:{namespace}:{subject}` | shared across instances (TS today is per instance, in memory) |
| Job locks | `gocron` lock keys | one runner per job per tick |
| Realtime fan-out | `rt:*` pub/sub | only once we run our own WebSockets on more than one instance |

The key format and value shape above are **exactly the TS format** (except
`s:*`, which is Go's own), so a key means the same thing on either server.

**Go uses its own in-compose Redis from day one, in production too** (user
decision, 2026-10-29). Upstash is never on the Go request path: a command to a
container on the same Docker network is ~0.1–0.3 ms, while every Upstash call is
a TLS round trip off the box (and TS reaches it over REST, one HTTPS request per
command). A cached read is then one sub-millisecond hop, and a hit never
touches Mongo.

No cross-server cache sync is needed: Go and TS never serve live traffic at
the same time (§11). At cut-over Go's Redis starts empty; a missing
`v:hostel:*` reads as version 0 and the cache fills on first reads. Upstash is
dropped from the web's env after cut-over.

Local Redis config: `maxmemory` set, `maxmemory-policy volatile-lru` (every key
has a TTL), persistence off (`save ""`, `appendonly no`) — everything in it can
be rebuilt. Turn AOF on only if a durable job queue is ever added.

Go additions on top of the TS design:

- **warm at boot** — `s:*` is loaded before `/health?deep=1` passes, so a
  deploy or restart never serves its first public reads from Mongo.
- **singleflight** — concurrent misses for the same key run one Mongo query.
- **pre-serialized bytes** — the cached value is the final JSON; a hit is
  written to the socket without decoding or re-encoding.
- **304 before work** — a cached route stores the finished envelope with its
  ETag beside it (`r:{hostelId}:{version}:{userId}:{routeKey}`), so `If-None-Match`
  is answered `304` after two Redis GETs, without Mongo or re-encoding. The tag is
  TS's body hash, not one derived from the version alone: a change that does not
  bump the version must still show within the 60 s TTL (`cache.Respond`).

## 6. Files, images and documents

- **Two buckets, two trust levels.** `R2_BUCKET_PUBLIC` serves through
  `R2_PUBLIC_URL`; `R2_BUCKET_PRIVATE` is only ever read through short-lived
  presigned URLs. The private bucket must never get a public URL.
- **Uploads bypass the API.** Client asks for a presigned PUT, uploads to R2,
  then the API verifies (`lib/uploads/verify.ts`, `sniff.ts`,
  `image-integrity.ts`) and records the `FileAsset`.
- **Images** — libvips via govips; same sizes and formats as `sharp` produces
  today (golden-image tests).
- **PDFs** — receipts (HP- codes + QR, `/verify-receipt`), invoices, KYC
  agreement on letterhead, exports with date ranges, Softmato document redraws.
  Each PDF type gets a golden test comparing rendered pages.
- **Statement import** — eSewa/Khalti/bank exports; parse with `pdftotext` /
  `excelize` / `encoding/csv`, tested only against **real exports**.

## 7. Notifications

- **Bell rows** — `Notification` + `NotificationReceipt`, same categories and
  topic bridge (`lib/realtime/channels.ts`, `CATEGORY_TOPICS`).
- **Realtime** — Pusher channels `private-user-{id}`, `private-hostel-{id}`,
  `private-platform`, `private-global`, `presence-hostel-registration-track-sheet`;
  channel auth at `POST /api/v1/realtime/auth`.
- **Push** — one fan-out (`sendPushToUsers`) over `DeviceToken`: Expo for the
  app, Web Push (VAPID) for `platform: "WEB"`. Notification sound "one claim"
  rule: socket and push claim the same row id. Expo receipts read hourly.
- **Email** — Resend, per-category mailboxes on `EMAIL_DOMAIN`, sender/reply-to
  from admin config, ≤1 routine email per person per day, per-address topic
  opt-out with `List-Unsubscribe`.

## 8. Scheduled jobs

All 19 jobs (PARITY.md §5) run inside the API process:

- `gocron` scheduler with `time.LoadLocation("Asia/Kathmandu")`.
- `gocron-redis-lock` so a job runs once per tick even with two containers
  (blue/green deploys overlap for a moment).
- Each job keeps its own idempotency (claim-out-of-`SCHEDULED`, flagged-once
  fields, exact-day offsets). The lock is an extra guard, not the guarantee.
- Each job has a per-run deadline equal to its TS `maxDuration`, and batches
  exactly as the TS job does (whatever doesn't fit runs next tick).
- Memory stays flat: jobs read with a Mongo cursor in batches (never `All()` on
  a collection) and stream uploads (Drive backups, R2) instead of buffering
  them. The heavy ones — `customer-backup`, `billing-cycle`, `ledger-drift`,
  `hostel-purge` — share one slot, so their peaks never stack (several jobs
  fire together at 08:45). Check `docker stats` after cut-over.
- `POST /api/v1/cron/{name}` stays, guarded by `x-cron-secret`, for manual runs
  and for `platform-backup`, which GitHub Actions calls.
- Before cut-over each job is proven on the local stack against the live-data
  copy (outbound email/push/gateway calls faked). At cut-over all of them move
  together: cron-job.org jobs disabled, `SCHEDULER_ENABLED=true` on the VPS.
  Rollback re-enables cron-job.org.

## 9. Background work

`after()` exists because serverless freezes the function after the response. A
long-lived Go process doesn't freeze, but it does restart on deploy. So:

- fire-and-finish work runs in a goroutine registered on a process-wide
  `WaitGroup`, with its own context (not the request's);
- on SIGTERM the server stops accepting, finishes in-flight requests, then waits
  for the `WaitGroup` (bounded by the container's stop grace period).

That is the same guarantee `after()` gives today. A durable queue (e.g. asynq on
Redis) is only worth adding if a lost background job is ever shown to matter.

## 10. Decision: REST, not GraphQL

**Keep REST.** GraphQL was considered for the "near 0 ms" goal and rejected.

| | REST (chosen) | GraphQL |
|---|---|---|
| HTTP caching | one URL = one cacheable answer; ETag/304 per route already in every client | one POST endpoint; caching needs persisted queries and custom keys |
| Redis read cache | key = route + query string (exists today) | key = normalized query + variables; harder to version per hostel |
| Server work per request | route match → handler | parse + validate + plan the query, then resolvers |
| N+1 queries | each handler writes its own aggregation | resolvers fan out per field unless every edge gets a dataloader |
| Authorization | one guard per route (PARITY.md §6) | per field/type; every tenant check moves into resolvers |
| Clients | web + app + PWA already call these 512 routes | every client call rewritten — breaks the "base URL only" goal |
| Over-fetching (GraphQL's strength) | screen-shaped endpoints already exist (dashboard, bootstrap, lists) | — |

Where a screen makes several calls on open, the answer is a screen-shaped REST
endpoint (one round trip, one cache key), not a query language. Round trips are
the cost that matters here: each one from Vercel or to Atlas crosses the Nepal–India border.

## 11. Migration strategy (one cut-over)

The Go server is built to full parity first. Until then web (Vercel) and app
keep calling the TS server at `hostelpalika.com` exactly as today. When Go is
production-grade it goes live on the Kathmandu VPS at `api.hostelpalika.com`,
and web + app switch to that host in one step (user decision, 2026-10-29). The
two servers never serve live traffic side by side.

```
before cut-over  web + app → hostelpalika.com/api/v1 (Vercel, TS)       api host unused
from cut-over    web + app → api.hostelpalika.com → caddy → api:8080 (Go)
                 old app builds → hostelpalika.com/api/* → rewrite → api host
rollback only    api.hostelpalika.com → caddy BACKEND=ts → Vercel TS
```

1. **Build and prove offline.** Every route ported and contract-green; jobs and
   money flows replayed against the live-data copy on the local stack.
2. **Prepare clients, still on TS** (Phase 4): cookie domain widened by a TS
   release; web reads one `API_URL` / `NEXT_PUBLIC_API_URL`, app/PWA one base
   URL — all still `hostelpalika.com`; a `beforeFiles` rewrite of `/api/*` to
   the API host built behind an env flag, off. Switching host is then a value
   change, not a code change.
3. **Cut over:** final change intake + full contract run at HEAD → Go on the
   VPS against production Atlas, warm and `/health?deep=1` green → web env
   `API_URL` / `NEXT_PUBLIC_API_URL` = `https://api.hostelpalika.com` with the
   rewrite on (stale app builds and cached PWAs land on Go too) + Vercel
   redeploy → app/PWA base URL by OTA → cron-job.org off,
   `SCHEDULER_ENABLED=true`.
4. **Rollback:** web env back to `hostelpalika.com` with the rewrite off (first,
   or the two hosts proxy each other) → Caddy `BACKEND=ts` + reload →
   cron-job.org back on. Go writes the same collections, fields and enums as
   TS, so TS reads whatever Go wrote. TS stays deployable (same env values)
   until the rollback window closes.

Go shares Mongo and the JWT secrets with TS, so sessions issued by TS keep
working on Go after the switch — nobody is logged out.

## 12. Observability

- `slog` JSON to stdout, one line per request: id, route, status, `app`/`db`/
  `redis` durations, principal id (never tokens, never personal data, never
  coordinates).
- `Server-Timing` on every response — visible in browser dev tools and in k6.
- `net/http/pprof` on a separate port bound to localhost only.
- `GET /api/v1/health` — liveness (process up); `?deep=1` also pings Mongo and
  Redis for readiness.

## 13. Performance settings

- `GOMAXPROCS` follows the container CPU limit automatically (Go 1.25+).
- `GOMEMLIMIT` ≈ 85 % of the container memory limit.
- Mongo client: one per process, `minPoolSize` > 0 so connections are warm,
  `maxPoolSize` sized to Atlas tier limits.
- HTTP server: `ReadHeaderTimeout`, `IdleTimeout` set; keep-alive on; Caddy
  holds the client connections and reuses upstream ones.
- Compression in Caddy, not Go.
