# ENVIRONMENT.md — Env, Docker, VPS

## 1. Prerequisites (installed in Phase 0, not before)

- Go, latest stable
- Docker + Docker Compose
- `golangci-lint`, `staticcheck`
- k6 (load tests)
- For local runs outside Docker: libvips and poppler-utils

## 2. Environment variables

The Go server reads its **own** env file (`server/.env`, gitignored with the
folder) — never the root `.env`, which points at production.

### Shared with the TS server (identical values, so TS stays a working rollback)

| Group | Variables |
|---|---|
| App | `APP_URL`, `LOG_LEVEL`, `COOKIE_SECURE` |
| Database | `MONGODB_URI` (TS falls back to `DATABASE_URL`; Go reads only `MONGODB_URI`) |
| Auth | `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `ACCESS_TOKEN_TTL`, `REFRESH_TOKEN_TTL`, `ACTIVATION_CODE_SECRET` |
| OTP | `OTP_TTL_MINUTES`, `OTP_RESEND_COOLDOWN_SECONDS`, `OTP_RATE_LIMIT_WINDOW_MINUTES`, `OTP_RATE_LIMIT_MAX`, `OTP_HASH_SECRET` |
| Google | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_MAPS_API_KEY`, `GOOGLE_DRIVE_CLIENT_ID`, `GOOGLE_DRIVE_CLIENT_SECRET` |
| R2 | `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_PUBLIC`, `R2_BUCKET_PRIVATE`, `R2_KEY_PREFIX`, `R2_PUBLIC_URL`, `R2_CORS_ORIGINS` |
| Email | `RESEND_API_KEY`, `EMAIL_DOMAIN`, `EMAIL_REPLY_TO` |
| Cron | `CRON_SECRET` |
| Realtime | `PUSHER_APP_ID`, `PUSHER_KEY`, `PUSHER_SECRET`, `PUSHER_CLUSTER` |
| Push | `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, `EXPO_ACCESS_TOKEN` |
| Uploads | `UPLOAD_MAX_IMAGE_BYTES`, `UPLOAD_MAX_DOCUMENT_BYTES`, `UPLOAD_MAX_VIDEO_BYTES`, `UPLOAD_MAX_AUDIO_BYTES`, `ALLOWED_IMAGE_MIME_TYPES`, `ALLOWED_DOCUMENT_MIME_TYPES`, `ALLOWED_VIDEO_MIME_TYPES`, `ALLOWED_AUDIO_MIME_TYPES` |
| Rate limits | `PUBLIC_FORM_RATE_LIMIT_MAX`, `PUBLIC_FORM_RATE_LIMIT_WINDOW_SECONDS` |
| LLM / search | `GEMINI_API_KEYS`, `GROQ_API_KEYS`, `OPENROUTER_API_KEYS`, `MISTRAL_API_KEYS`, `CEREBRAS_API_KEYS`, `LLM_PROVIDER_ORDER`, `SEARCH_QUOTA_SECRET` |
| Crypto | `PERSONAL_DATA_ENCRYPTION_KEY`, `FINANCE_MASTER_KEY`, `FINANCE_MASTER_KEY_PREVIOUS` |
| Evidence OCR | `EVIDENCE_OCR`, `EVIDENCE_ENGINE`, `GCP_VISION_SA_KEY`, `GCP_VISION_REGION`, `EVIDENCE_VISION_TIMEOUT_MS`, `EVIDENCE_VISION_MONTHLY_CAP`, `EVIDENCE_GEMINI_MODEL`, `EVIDENCE_GEMINI_TIMEOUT_MS`, `EVIDENCE_GEMINI_MONTHLY_CAP` |
| Payments | `ESEWA_SANDBOX_MERCHANT_CODE`, `ESEWA_SANDBOX_SECRET`, `KHALTI_SANDBOX_MERCHANT_CODE`, `KHALTI_SANDBOX_SECRET`, `FONEPAY_SANDBOX_MERCHANT_CODE`, `FONEPAY_SANDBOX_SECRET`, and `<PROVIDER>_SANDBOX_WEBHOOK_SECRET` (built dynamically in `modules/finance/gateway/secret-store.ts`; live credentials are per hostel, encrypted in the DB) |
| Softmato | `SOFTMATO_BASE_URL`, `SOFTMATO_SECRET`, `SOFTMATO_WEBHOOK_SECRET` |
| QuestionCall | `QUESTIONCALL_WEBHOOK_SECRET` |
| Seed | not read by Go — no seeds; local data is a copy of live (`deploy/copy-live-db.ps1`) |

### New in Go

| Variable | Purpose |
|---|---|
| `APP_ENV` | `production` / `development` / `test` (replaces `NODE_ENV`) |
| `API_ADDR` | listen address, e.g. `:8080` |
| `REDIS_URL` | `redis://redis:6379/0` — the in-compose container, production included, from day one (ARCHITECTURE.md §5) |
| `CORS_ORIGINS` | comma-separated allowed web origins |
| `COOKIE_DOMAIN` | `.hostelpalika.com` |
| `TRUSTED_PROXIES` | Caddy's address on the Docker network |
| `SCHEDULER_ENABLED` | `true` on the production API only; `false` locally and in tests |
| `PPROF_ADDR` | `127.0.0.1:6060`; empty disables |
| `GOMEMLIMIT` | ≈ 85 % of the container memory limit |

### Stay on the web (Vercel)

`NEXT_PUBLIC_*`, `APPLE_APP_ID_PREFIX`, plus the new `API_URL` (server-side
fetch) and `NEXT_PUBLIC_API_URL` (browser). After cut-over the web holds no
database, Redis, R2, email, push or payment secrets.

## 3. Host

- **Region: Kathmandu** — a VPS in a Nepal datacenter (user decision,
  2026-10-29), so phones in Nepal never leave the country to reach the API.
  Atlas stays in Mumbai: on day one, time VPS → Atlas (`mongosh` ping, and
  `Server-Timing: db` on a cold read) and record it in `MEMORY.md` — it is the
  floor for every cache miss.
- **Size:** start at 2 vCPU / 4 GB; the API and Redis together need far less
  than that, the headroom is for PDF/image bursts and deploy overlap. Watch
  `Server-Timing` and memory, resize from evidence.
- **DNS:** `api.hostelpalika.com` A/AAAA → the VPS (Cloudflare DNS, proxy **off**
  so Caddy terminates TLS and HTTP/3 directly — or proxy on, if Cloudflare's
  edge is wanted, with Caddy using an origin certificate).
- **Firewall:** 80/443 open; 22 restricted; nothing else exposed. Redis and
  pprof are never published to the host.

## 4. Containers

`deploy/compose.yaml` — three services:

| Service | Image | Notes |
|---|---|---|
| `caddy` | `caddy` | 80/443 (+443/udp for HTTP/3), `encode zstd gzip`, reverse proxy chosen by `BACKEND` — `ts` (everything to the Vercel TS server — rollback only; nothing calls the API host before cut-over) or `go` (`api:8080` with health checks) — ARCHITECTURE.md §11; `flush_interval -1` on NDJSON progress routes |
| `api` | built from `deploy/Dockerfile` | multi-stage: `golang` builder (cgo on, `-tags=sonic`, `-trimpath`, `-ldflags="-s -w"`) → `debian:stable-slim` runtime with `libvips` + `poppler-utils` + `ca-certificates` + `tzdata`; runs as non-root; `stop_grace_period` long enough to drain background work |
| `redis` | `redis:7` | `deploy/redis.conf`: `maxmemory`, `maxmemory-policy volatile-lru`, `save ""`, `appendonly no`; no published port |

`tzdata` matters: `time.LoadLocation("Asia/Kathmandu")` fails without it.

## 5. Deploy

The user runs deploys; the AI prepares commands and checks, it does not run them.

1. Build and push the image (GitHub Actions → GHCR, tagged with the commit SHA).
2. On the VPS: pull, start the new `api` container beside the old one, let
   Caddy's health check pass, stop the old one. The scheduler's Redis lock
   keeps jobs from running twice during the overlap.
3. Roll back by starting the previous SHA's image the same way.

## 6. Web hosting note

Vercel Hobby is for non-commercial use only, and HostelPalika is commercial.
Keeping the web on Hobby risks the project being suspended. Alternatives: Vercel
Pro, Cloudflare Pages (free tier allows commercial use), or the Next.js web as a
fourth container on this VPS. The API design is the same in every case.
