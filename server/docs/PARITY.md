# PARITY.md — Everything the TypeScript server does, ticked off as Go does it

This is the master tracker. Nothing about the Go server is "done" until every ☐ in
this file is ☑. Work it item by item: port → contract test green → flip ☐ to ☑ →
next item. Never tick in batches.

---

## 1. Baseline

| | |
|---|---|
| Baseline commit | `8bea0625` (`main`, 2026-10-30) |
| Source of truth for behaviour | the TypeScript server at the baseline commit |
| Inventory taken from | `apps/web/src/app/**/route.ts`, `apps/web/src/modules/*`, `apps/web/src/lib/*`, `packages/db/src/models/*`, `packages/shared/src/*`, `docs/CRON.md` |

Every table below was generated from the code at the baseline, not written from
memory. Counts at baseline: **513 route files, 146 models, 37 modules, 19 cron
jobs, 68 email templates, 56 web pages that import server code directly.**

---

## 2. Change intake — keeping up with the TypeScript server

The TypeScript server keeps changing while Go is being built. Nothing relies on
anyone remembering to log a change; git already knows.

**Before starting any port session, run:**

```bash
git diff --name-status 8bea0625..HEAD -- apps/web/src/app apps/web/src/modules apps/web/src/lib packages/db/src packages/shared/src docs/CRON.md
```

For every line it prints:

1. `A` (added) route/model/template/cron → add a ☐ row to the right table below.
2. `M` (modified) → if that item is already ☑, flip it back to ☐ and add a row to
   the intake log; its contract test must be re-recorded from the TS server.
3. `D` (deleted) → strike the row (`~~path~~`) and delete the Go code for it.
4. `R` (renamed) → update the row in place.

Once every printed line is handled, **move the baseline**: replace `8bea0625` in
§1 and in the command above with the new `HEAD` SHA, and add a line to the log.

### Intake log

| Date | From → to SHA | Items added | Items re-opened | Items removed |
|---|---|---|---|---|
| 2026-10-28 | — → `7bf6c91b` | initial inventory | — | — |
| 2026-10-29 | `7bf6c91b` → `541e46cf` | — | — (2 M: `reports/report.validation.ts`, `stock/stock.service.ts`; neither ported yet) | — |
| 2026-10-29 | `541e46cf` → `41b0ef10` | — (no TS changes; only `server/` commits) | — | — |
| 2026-10-29 | `41b0ef10` → `2be44935` | — (no TS changes; only `server/` commits) | — | — |
| 2026-10-29 | `2be44935` → working tree (uncommitted) | `Hostel.photos[].mediumUrl` (640px WebP card copy); `npm --prefix apps/web run backfill:photo-variants` | `GET /public/hostels`, `/public/hostels/:slug`, `/public/hostels/compare` — every photo now carries `mediumUrl` (`""` until made); `POST /hostel-admin/profile/photos` (☐) must run `attachPhotoVariant` after responding: `lib/image-optimizer` MEDIUM variant → `photos.$[p].mediumUrl` | — |
| 2026-10-30 | `2be44935` → `8bea0625` | `PUT /hostel-admin/rooms/order` (new, ☐, hostels); `Hostel.photos[].mediumUrl` is committed now (`8bea0625`), so the working-tree entry above is closed | `GET /public/hostels`, `/:slug`, `/compare` — `mediumUrl` is in the Go serializers and the three fixtures were re-recorded; `hostel-profile.service.ts`, `hostel-rooms.service.ts` and `notifications/web-routing.ts` changed (all ☐, to read when their module is ported) | — |

---

## 3. Platform layer (must exist before any route is ported)

| ☐ | Concern | TypeScript today | Go target |
|---|---|---|---|
| ☐ | Config + boot validation | `lib/env.ts`, `lib/load-root-env.ts` | `internal/platform/config` — typed struct from env, fail fast on boot |
| ☑ | Response envelope | `lib/api-response.ts` (`success/message/data`, `success/message/errorCode/details`) | `internal/platform/httpx` — byte-identical JSON |
| ☑ | Validation errors | zod → 422 `VALIDATION_ERROR`, `details = { formErrors, fieldErrors, issues[] }` | same shape, same field paths |
| ☑ | Error mapping | `handleRouteError` incl. `SoftmatoApiError` pass-through | `httpx.Fail(c, err)` |
| ☑ | Auth tokens | `lib/auth.ts` — jose HS256 access/refresh, purpose tokens | `golang-jwt/jwt/v5`, **same secrets, same claims** |
| ☑ | Refresh rotation | `lib/auth-refresh.ts` — every refresh revokes the old token | same, same `Session` rows |
| ☑ | Cookies | `lib/auth-cookies.ts`, `lib/session-cookies.ts`, `lib/lock-pin-cookie.ts` (`hostelpalika_*` + legacy `hostelhub_*` fallbacks) | same names, plus `Domain=.hostelpalika.com` |
| ☑ | Principal + guards | `lib/api-auth.ts` — 14 guards (`requireApiPrincipal`, `requirePlatformPrincipal`, `requireSuperadminPrincipal`, `requireTeamPrincipal`, `requireHostelStaffPrincipal`, `requireHostelCapability`, `requireHostelAdminPrincipal`, `requireHostelScopedPrincipal`, `requireResidentPrincipal`, `requireGuardianPrincipal`, `loadApiPrincipal`, `assertApiRoles`, `assertHostelScopedApiAccess`, `assertPrimaryCredentialPrincipal`) | Gin middleware per guard |
| ☑ | Roles, permissions, capabilities | `lib/roles.ts`, `lib/permissions.ts`, `lib/warden-capability.ts`, `lib/route-access.ts`, `lib/tenant.ts` | `internal/platform/authz` |
| ☐ | Tenant isolation | `modules/tenant-isolation.test.ts` (guard layer ☑ in `authz`; service cases travel with their Phase 6 modules) | the same test cases, ported first |
| ☑ | Mobile client header | `x-hostelhub-client`, `x-hostel-id` (`lib/mobile-auth.ts`) | same headers |
| ☑ | Passwords + PIN | `lib/password.ts` — bcrypt cost 12 | `x/crypto/bcrypt`, existing hashes verify unchanged |
| ☑ | OTP | `OtpChallenge`, `OTP_*` env, `lib/auth-attempts.ts` | same rules |
| ☑ | Rate limiting | `lib/rate-limit.ts` — in-memory per instance | Redis, shared by every instance |
| ☑ | Read cache | `lib/redis-cache.ts` — per-user keys, per-hostel version, 60 s TTL, 150 ms timeout falls through to Mongo | same design on local Redis + `singleflight` |
| ☐ | Cache invalidation | `bumpHostelCache`, `lib/realtime/announce-writes.ts`, `publishResourceChange`, `settleEvent` | same call sites |
| ☑ | ETag / 304 | `lib/etag.ts` | same tag bytes (FNV-1a, UTF-16; `httpx.ETag`); `cache.Respond` answers the 304 from cached bytes + tag before any work |
| ☑ | Background work | `lib/after-response.ts` (`after()`) | tracked goroutine, drained on shutdown |
| ☐ | Cron auth | `lib/cron-auth.ts` — `x-cron-secret` | kept for manual triggers |
| ☑ | Realtime | `lib/realtime/*` — Pusher: `private-user-*`, `private-hostel-*`, `private-platform`, `private-global`, `presence-hostel-registration-track-sheet`; topic/category bridge | `pusher-http-go`, same channels, same events |
| ☑ | Push (mobile) | Expo push + receipts (`PushTicket`, `DeviceToken`) | plain HTTP to Expo |
| ☑ | Push (web) | `web-push` + VAPID, `DeviceToken.platform = "WEB"`, one fan-out `sendPushToUsers` | `webpush-go`, same fan-out |
| ☑ | Email | `packages/shared/src/email/{sender,identity}.ts`, Resend, per-category mailboxes, topic opt-out, `List-Unsubscribe`, ≤1 routine email/person/day | `resend-go`, same rules |
| ☑ | File storage | `lib/r2.ts`, two buckets (public/private — security boundary), presigned URLs, `lib/uploads/*` (sniff, verify, integrity) | `aws-sdk-go-v2/s3` + presign |
| ☑ | Image processing | `sharp`, `lib/image-optimizer.ts`, `lib/sharp.ts` | `govips` (libvips, same engine as sharp) |
| ☑ | PDF out | `pdf-lib` (receipts, agreements, statements, exports) | see ARCHITECTURE.md §6 |
| ☑ | PDF in | `unpdf` (statement import) | `pdftotext` (poppler) |
| ☑ | Spreadsheets | `xlsx` (SheetJS), `papaparse`, `lib/csv.ts` | `excelize`, `encoding/csv` |
| ☐ | Raster cards (Phase 5) | `@napi-rs/canvas` (ID cards, `lib/platform-id-card.server.ts`) | SVG template → libvips |
| ☑ | QR codes | `qrcode` | `skip2/go-qrcode` |
| ☑ | Zip streams | `lib/zip-stream.ts` | `archive/zip` streaming |
| ☑ | Personal-data crypto | `lib/personal-data-crypto.ts` — AES-256-GCM, `PERSONAL_DATA_ENCRYPTION_KEY` | `crypto/cipher` GCM, reads every existing ciphertext |
| ☑ | Finance secrets | `EncryptedSecret`, `FINANCE_MASTER_KEY` + `_PREVIOUS` rotation | same |
| ☑ | Sealed backups | `tweetnacl`, `packages/shared/src/backup/sealed-archive.ts` | `x/crypto/nacl`, archives open in both |
| ☑ | Bikram Sambat calendar | `packages/shared/src/calendar/bs.ts`, `lib/hostel-day.ts` (UTC+5:45), `nepali-date-converter` | `internal/platform/bs`, shared test vectors |
| ☑ | Night window | `packages/shared/src/night/night-window.ts` | same vectors |
| ☑ | Plans catalogue | `packages/shared/src/plans/{catalog,lifetime}.ts` | `internal/platform/plans`; `defaults.json` written by the vector generator |
| ☑ | Money | whole rupees (finance) + paisa (store, Softmato) | `internal/platform/money`, `int64`, never float |
| ☑ | Logging | `lib/logger.ts` | `log/slog` JSON |
| ☐ | Audit log | `modules/audit`, `AuditLog` | same rows |
| ☐ | Usage counters | `modules/usage`, `ApiUsageCounter` | same rows |
| ☐ | Search + LLM | `lib/search/*`, `lib/llm/*` — Gemini/Groq/OpenRouter/Mistral/Cerebras key pools, `SEARCH_QUOTA_SECRET` | plain HTTP clients, same provider order |
| ☐ | Evidence OCR | Vision (`GCP_VISION_SA_KEY`, RS256 service-account JWT) + Gemini fallback, monthly caps | `oauth2/google` + Vision REST |
| ☐ | Maps | `lib/maps/*` — geocoding, Overpass nearby places, routing, upstream fetch politeness | same upstreams, same delays |
| ☐ | Softmato billing | `@softmato/sdk`, `SOFTMATO_*`, `modules/billing/softmato/*` | HTTP client of the same calls |
| ☑ | Google sign-in | Google ID token (`GOOGLE_CLIENT_ID`) | `google.golang.org/api/idtoken` |
| ☐ | Google Drive backup | `GOOGLE_DRIVE_CLIENT_*`, `modules/backup` | `x/oauth2` + Drive v3 |
| ☐ | QuestionCall | SSO `hp_code` handoff, conversion webhook (`QUESTIONCALL_WEBHOOK_SECRET`) | same |
| ☐ | Demo hostels | `modules/hostels/demo-hostels.json` merged server-side | same file, same merge |
| ☐ | Site config / SEO config | `lib/site-config-server.ts`, `lib/seo-config.ts`, `modules/platform-config` | same `PlatformSetting` rows |

---

## 4. Modules

Go mirrors these names one-to-one under `internal/modules/`. A module is ☑ when
all of its routes in §5 are ☑.

| ☐ | Module | Source files |
|---|---|---|
| ☐ | `arrivals` | 1 |
| ☐ | `attendance` | 3 |
| ☐ | `audit` | 2 |
| ☐ | `auth` | 5 |
| ☐ | `backup` | 4 |
| ☐ | `billing` | 42 |
| ☐ | `bookings` | 29 |
| ☐ | `community` | 6 |
| ☐ | `complaints` | 5 |
| ☐ | `expert-consultation` | 2 |
| ☐ | `feedback` | 1 |
| ☐ | `finance` | 87 |
| ☐ | `food` | 12 |
| ☐ | `guardian` | 5 |
| ☐ | `hostel-referrals` | 3 |
| ☐ | `hostels` | 32 |
| ☐ | `listing-flags` | 2 |
| ☐ | `maintenance` | 3 |
| ☐ | `move-checklist` | 5 |
| ☐ | `notices` | 5 |
| ☐ | `notifications` | 15 |
| ☐ | `offer-program` | 3 |
| ☐ | `platform-config` | 10 |
| ☐ | `questioncall` | 2 |
| ☐ | `referrals` | 3 |
| ☐ | `reports` | 13 |
| ☐ | `residents` | 28 |
| ☐ | `reviews` | 3 |
| ☐ | `safety` | 5 |
| ☐ | `service-providers` | 3 |
| ☐ | `sponsors` | 2 |
| ☐ | `stock` | 3 |
| ☐ | `store` | 9 |
| ☐ | `team` | 8 |
| ☐ | `usage` | 2 |
| ☐ | `users` | 12 |
| ☐ | `wardens` | 3 |

---

## 5. Scheduled jobs

All 19 jobs move into the Go process (`internal/jobs`, see ARCHITECTURE.md §8).
Times are **Asia/Kathmandu**. Each job keeps its HTTP endpoint (`POST
/api/v1/cron/<name>`, `x-cron-secret`) so it can still be run by hand. A job is ☑
when it runs in-process under a Redis lock **and** its cron-job.org entry is
switched off.

| ☐ | Job | Schedule (NPT) | Crontab | What it does |
|---|---|---|---|---|
| ☐ | `platform-push` | every minute | `* * * * *` | sends superadmin pushes whose time has come |
| ☐ | `gateway-expiry-sweep` | every 5 min | `*/5 * * * *` | closes checkout attempts whose window has passed |
| ☐ | `notification-dispatch` | every 15 min | `*/15 * * * *` | sends scheduled campaigns; claims each out of `SCHEDULED` first |
| ☐ | `meal-call-reminders` | every 15 min | `*/15 * * * *` | tells cooks a meal's "Food ready" is due |
| ☐ | `night-status-prompt` | every 15 min | `*/15 * * * *` | night-status prompts per hostel hour |
| ☐ | `push-receipts` | hourly :00 | `0 * * * *` | reads Expo receipts (batches of ≤1000 ids) |
| ☐ | `refresh-nearby-places` | hourly :00 | `0 * * * *` | refreshes nearby-places caches (1 s/req politeness) |
| ☐ | `customer-backup` | hourly :05 | `5 * * * *` | each connected hostel's daily encrypted Drive backup, oldest first |
| ☐ | `billing-cycle` | daily 00:15 | `15 0 * * *` | issues the BS month's invoices |
| ☐ | `payment-reminders` | daily 07:45 | `45 7 * * *` | due-soon and overdue reminders (plan + resident fees) |
| ☐ | `purge-expired-otps` | daily 08:45 | `45 8 * * *` | backup sweep behind the TTL index |
| ☐ | `account-purge` | daily 08:45 | `45 8 * * *` | erases accounts past the 60-day grace |
| ☐ | `hostel-purge` | daily 08:45 | `45 8 * * *` | erases archived hostels past grace, incl. R2 objects |
| ☐ | `ledger-drift` | daily 08:45 | `45 8 * * *` | scans every invoice for drift |
| ☐ | `complaint-sla` | daily 09:45 | `45 9 * * *` | flags complaints past SLA, alerts once |
| ☐ | `attendance-maintenance` | daily 10:45 | `45 10 * * *` | absence alerts + attendance-log retention purge |
| ☐ | `gateway-health` | daily 12:15 | `15 12 * * *` | is each hostel's online checkout working |
| ☐ | `gateway-settlement-recon` | Mondays 09:45 | `45 9 * * 1` | weekly settlement reconciliation |
| ☐ | `platform-backup` | on demand | — | **not scheduled**: the nightly GitHub workflow and the restore drill POST to it |

Every job is idempotent today (claimed rows, exact-day offsets, flags set once).
The Go port keeps each mechanism exactly; the Redis lock is an extra guard, not a
replacement for them.

---

## 6. Routes

Generated from every `route.ts` at the baseline. Paths use Gin syntax (`:id`,
`*path`). **Guard** is the auth helper the route calls; `cap:x` is
`requireHostelCapability(…, "x")`; `in x.routes.ts` means the handler is
re-exported from that module file and its guard lives there; `public` means no
principal guard was found — most of those check a token, signature or secret
inside the handler, so read the handler before porting. **Notes:** `redis` =
`cachedRead`, `etag` = `withEtag`, `after` = `afterResponse`, `maxNs` = the
route's `maxDuration` in seconds (in Go, a per-route context timeout).

The `(non-v1)` group is web-domain plumbing (`apple-app-site-association`,
`llms.txt`, `get-app`, the PWA share target). It **stays in Next.js** unless a
row says otherwise; tick it once that decision is confirmed per row.

### Route totals

| Group | Route files |
|---|---|
| `(non-v1)` | 5 |
| `account` | 9 |
| `auth` | 20 |
| `bookings` | 11 |
| `community` | 10 |
| `cook` | 11 |
| `cron` | 19 |
| `email-preferences` | 2 |
| `feedback` | 1 |
| `files` | 5 |
| `guardian` | 6 |
| `health` | 1 |
| `hostel-admin` | 180 |
| `hostel-registration` | 5 |
| `integrations` | 2 |
| `mobile` | 1 |
| `notifications` | 4 |
| `platform` | 99 |
| `platform-admin` | 2 |
| `public` | 32 |
| `push` | 4 |
| `realtime` | 2 |
| `resident` | 39 |
| `store` | 13 |
| `team` | 16 |
| `usage` | 1 |
| `users` | 11 |
| `webhooks` | 2 |
| **Total** | **513** |

### `(non-v1)` (5)

| ☐ | Methods | Path | Guard | Notes | Modules |
|---|---|---|---|---|---|
| ☐ | GET | `/api/apple-app-site-association` | public |  |  |
| ☐ | POST | `/api/receipt-share` | public |  |  |
| ☐ | GET | `/get-app` | public |  |  |
| ☐ | GET | `/llms-full.txt` | public |  |  |
| ☐ | GET | `/llms.txt` | public |  |  |

### `account` (9)

| ☐ | Methods | Path | Guard | Notes | Modules |
|---|---|---|---|---|---|
| ☐ | GET PATCH | `/api/v1/account/email-preferences` | requireApiPrincipal | etag | notifications |
| ☐ | GET POST | `/api/v1/account/hostel-leave` | requireApiPrincipal |  | hostels |
| ☐ | GET | `/api/v1/account/hostel-leave/:requestId/files` | requireApiPrincipal |  | hostels |
| ☐ | GET | `/api/v1/account/hostel-leave/:requestId/files/:fileId` | requireApiPrincipal |  | hostels |
| ☐ | GET | `/api/v1/account/hostel-leave/:requestId/files/zip` | requireApiPrincipal | max300s | hostels |
| ☐ | GET PATCH | `/api/v1/account/notification-preferences` | requireApiPrincipal | etag | notifications |
| ☐ | GET | `/api/v1/account/residency-invite` | requireApiPrincipal | etag | residents |
| ☐ | POST | `/api/v1/account/residency-invite/:residentId/accept` | requireApiPrincipal |  | residents |
| ☐ | POST | `/api/v1/account/residency-invite/:residentId/decline` | requireApiPrincipal |  | residents |

### `auth` (20)

| ☐ | Methods | Path | Guard | Notes | Modules |
|---|---|---|---|---|---|
| ☑ | POST | `/api/v1/auth/biometric/code` | requireApiPrincipal, assertPrimaryCredentialPrincipal |  | auth |
| ☑ | POST | `/api/v1/auth/biometric/verify` | requireApiPrincipal, assertPrimaryCredentialPrincipal |  | auth |
| ☑ | POST | `/api/v1/auth/cancel-account-deletion` | rateLimitPublicForm |  | users |
| ☑ | POST | `/api/v1/auth/change-password` | public |  | auth |
| ☑ | POST | `/api/v1/auth/forgot-password` | rateLimitPublicForm |  | auth |
| ☑ | POST | `/api/v1/auth/google` | rateLimitPublicForm |  | auth |
| ☑ | DELETE PUT | `/api/v1/auth/lock-pin` | requireApiPrincipal, assertPrimaryCredentialPrincipal |  | auth |
| ☑ | POST | `/api/v1/auth/lock-pin/touch` | loadApiPrincipal |  |  |
| ☑ | POST | `/api/v1/auth/lock-pin/verify` | requireApiPrincipal |  | auth |
| ☑ | POST | `/api/v1/auth/login` | public |  | auth |
| ☑ | POST | `/api/v1/auth/logout` | public |  | auth |
| ☑ | GET | `/api/v1/auth/me` | public | etag | auth |
| ☑ | POST | `/api/v1/auth/otp/request` | rateLimitAuthAttempts |  | auth |
| ☑ | POST | `/api/v1/auth/otp/verify` | public |  | auth |
| ☑ | POST | `/api/v1/auth/refresh` | public |  | auth |
| ☑ | POST | `/api/v1/auth/register` | rateLimitAuthAttempts |  | auth |
| ☑ | POST | `/api/v1/auth/resend-verification` | rateLimitPublicForm |  | auth |
| ☑ | POST | `/api/v1/auth/reset-password` | rateLimitAuthAttempts |  | auth |
| ☑ | POST | `/api/v1/auth/signup` | rateLimitPublicForm |  | auth |
| ☑ | POST | `/api/v1/auth/verify-email` | rateLimitAuthAttempts |  | auth |

### `bookings` (11)

| ☐ | Methods | Path | Guard | Notes | Modules |
|---|---|---|---|---|---|
| ☐ | GET POST | `/api/v1/bookings` | requireApiPrincipal, rateLimitPublicForm | etag | bookings |
| ☐ | GET | `/api/v1/bookings/:id` | requireApiPrincipal | etag | bookings |
| ☐ | POST | `/api/v1/bookings/:id/cancel` | requireApiPrincipal |  | bookings |
| ☐ | POST | `/api/v1/bookings/:id/checkout` | requireApiPrincipal |  | bookings |
| ☐ | POST | `/api/v1/bookings/:id/payment` | requireApiPrincipal |  | bookings |
| ☐ | GET | `/api/v1/bookings/:id/return` | requireApiPrincipal |  | bookings |
| ☑ | GET | `/api/v1/bookings/availability` | public | etag | bookings, hostels |
| ☐ | GET | `/api/v1/bookings/documents/:kind/:number` | requireApiPrincipal |  | bookings |
| ☑ | GET | `/api/v1/bookings/guide` | public |  | bookings |
| ☑ | GET | `/api/v1/bookings/policy` | public |  | bookings |
| ☐ | GET | `/api/v1/bookings/quote` | loadApiPrincipal | etag | bookings |

### `community` (10)

| ☐ | Methods | Path | Guard | Notes | Modules |
|---|---|---|---|---|---|
| ☐ | GET POST | `/api/v1/community` | loadApiPrincipal, requireApiPrincipal | etag | community |
| ☐ | DELETE GET | `/api/v1/community/:postId` | loadApiPrincipal, requireApiPrincipal | etag | community |
| ☐ | GET POST | `/api/v1/community/:postId/comments` | loadApiPrincipal, requireApiPrincipal | etag | community |
| ☐ | DELETE | `/api/v1/community/:postId/comments/:commentId` | requireApiPrincipal |  | community |
| ☐ | POST | `/api/v1/community/:postId/comments/:commentId/vote` | requireApiPrincipal |  | community |
| ☐ | POST | `/api/v1/community/:postId/reactions` | requireApiPrincipal |  | community |
| ☐ | POST | `/api/v1/community/:postId/report` | requireApiPrincipal |  | community |
| ☐ | GET | `/api/v1/community/sidebar` | loadApiPrincipal | etag | community, sponsors |
| ☐ | GET | `/api/v1/community/spaces` | loadApiPrincipal | etag | community |
| ☐ | POST | `/api/v1/community/sponsors/:sponsorId/click` | public |  | sponsors |

### `cook` (11)

| ☐ | Methods | Path | Guard | Notes | Modules |
|---|---|---|---|---|---|
| ☐ | POST | `/api/v1/cook/accept-invitation` | public |  | food |
| ☐ | GET POST | `/api/v1/cook/expenses` | requireApiPrincipal, assertApiRoles | etag | finance |
| ☐ | POST | `/api/v1/cook/expenses/:id/void` | requireApiPrincipal, assertApiRoles |  | finance |
| ☐ | GET POST | `/api/v1/cook/food-photos` | requireApiPrincipal, assertApiRoles | etag | food |
| ☐ | GET POST | `/api/v1/cook/food-ready` | requireApiPrincipal, assertApiRoles | redis etag | food |
| ☐ | GET | `/api/v1/cook/khata` | requireApiPrincipal, assertApiRoles | etag | finance, food |
| ☐ | POST | `/api/v1/cook/khata/:id` | requireApiPrincipal, assertApiRoles |  | finance, food |
| ☐ | GET | `/api/v1/cook/residents` | requireApiPrincipal, assertApiRoles | redis etag | food |
| ☐ | GET POST | `/api/v1/cook/stock` | requireApiPrincipal, assertApiRoles | etag | stock |
| ☐ | POST | `/api/v1/cook/stock/entries/:id/undo` | requireApiPrincipal, assertApiRoles |  | stock |
| ☐ | GET | `/api/v1/cook/today` | requireApiPrincipal, assertApiRoles | redis etag | food |

### `cron` (19)

| ☐ | Methods | Path | Guard | Notes | Modules |
|---|---|---|---|---|---|
| ☐ | POST | `/api/v1/cron/account-purge` | validateCronRequest | max60s | users |
| ☐ | POST | `/api/v1/cron/attendance-maintenance` | validateCronRequest | max60s | attendance |
| ☐ | POST | `/api/v1/cron/billing-cycle` | validateCronRequest | max60s | finance |
| ☐ | POST | `/api/v1/cron/complaint-sla` | validateCronRequest | max60s | complaints |
| ☐ | POST | `/api/v1/cron/customer-backup` | validateCronRequest | max300s | backup |
| ☐ | POST | `/api/v1/cron/gateway-expiry-sweep` | validateCronRequest | max120s | finance |
| ☐ | POST | `/api/v1/cron/gateway-health` | validateCronRequest | max300s | finance |
| ☐ | POST | `/api/v1/cron/gateway-settlement-recon` | validateCronRequest | max300s | finance |
| ☐ | POST | `/api/v1/cron/hostel-purge` | validateCronRequest | max60s | hostels |
| ☐ | POST | `/api/v1/cron/ledger-drift` | validateCronRequest | max300s | finance |
| ☐ | POST | `/api/v1/cron/meal-call-reminders` | validateCronRequest | max60s | food |
| ☐ | POST | `/api/v1/cron/night-status-prompt` | validateCronRequest | max60s | safety |
| ☐ | POST | `/api/v1/cron/notification-dispatch` | validateCronRequest | max60s | notifications, notices |
| ☐ | POST | `/api/v1/cron/payment-reminders` | validateCronRequest | max60s | billing, finance, move-checklist |
| ☐ | POST | `/api/v1/cron/platform-backup` | validateCronRequest |  | backup |
| ☐ | POST | `/api/v1/cron/platform-push` | validateCronRequest | max60s | billing, bookings, notices, notifications |
| ☐ | POST | `/api/v1/cron/purge-expired-otps` | validateCronRequest |  |  |
| ☐ | POST | `/api/v1/cron/push-receipts` | validateCronRequest | max60s | notifications |
| ☐ | POST | `/api/v1/cron/refresh-nearby-places` | validateCronRequest | max60s | hostels |

### `email-preferences` (2)

| ☐ | Methods | Path | Guard | Notes | Modules |
|---|---|---|---|---|---|
| ☑ | POST | `/api/v1/email-preferences` | public |  | notifications |
| ☑ | POST | `/api/v1/email-preferences/unsubscribe` | public |  | notifications |

### `feedback` (1)

| ☐ | Methods | Path | Guard | Notes | Modules |
|---|---|---|---|---|---|
| ☑ | POST | `/api/v1/feedback` | rateLimitPublicForm, requireApiPrincipal |  | feedback |

### `files` (5)

| ☐ | Methods | Path | Guard | Notes | Modules |
|---|---|---|---|---|---|
| ☐ | POST | `/api/v1/files/:assetId/complete` | loadApiPrincipal |  | finance |
| ☐ | POST | `/api/v1/files/:assetId/optimize` | loadApiPrincipal |  |  |
| ☐ | GET | `/api/v1/files/:assetId/url` | loadApiPrincipal | etag |  |
| ☐ | POST | `/api/v1/files/presign` | requireApiPrincipal |  | residents |
| ☐ | POST | `/api/v1/files/upload` | loadApiPrincipal |  | finance |

### `guardian` (6)

| ☐ | Methods | Path | Guard | Notes | Modules |
|---|---|---|---|---|---|
| ☐ | POST | `/api/v1/guardian/accept-invitation` | public |  | guardian |
| ☐ | GET | `/api/v1/guardian/dashboard` | requireGuardianPrincipal | etag | guardian |
| ☐ | GET | `/api/v1/guardian/food` | requireGuardianPrincipal | etag | guardian |
| ☐ | GET | `/api/v1/guardian/notices` | requireGuardianPrincipal | etag | guardian |
| ☐ | GET | `/api/v1/guardian/payments` | requireGuardianPrincipal | etag | guardian |
| ☐ | GET | `/api/v1/guardian/safety-summary` | requireGuardianPrincipal | etag | guardian |

### `health` (1)

| ☐ | Methods | Path | Guard | Notes | Modules |
|---|---|---|---|---|---|
| ☑ | GET | `/api/v1/health` | public |  |  |

### `hostel-admin` (180)

| ☐ | Methods | Path | Guard | Notes | Modules |
|---|---|---|---|---|---|
| ☐ | GET | `/api/v1/hostel-admin/attendance` | cap:viewNightStatus | etag | attendance |
| ☐ | PATCH | `/api/v1/hostel-admin/attendance/:residentId/override` | cap:updateNightStatus |  | attendance |
| ☐ | GET | `/api/v1/hostel-admin/attendance/alerts` | cap:viewNightStatus | etag | attendance |
| ☐ | PATCH | `/api/v1/hostel-admin/attendance/alerts/:id/resolve` | cap:updateNightStatus |  | attendance |
| ☐ | GET PATCH | `/api/v1/hostel-admin/attendance/settings` | requireHostelAdminPrincipal | etag | attendance |
| ☐ | GET POST | `/api/v1/hostel-admin/backup` | requireHostelAdminPrincipal | max300s | backup |
| ☐ | DELETE POST | `/api/v1/hostel-admin/backup/drive` | requireHostelAdminPrincipal |  | backup |
| ☐ | GET | `/api/v1/hostel-admin/backup/drive/callback` | public |  | backup |
| ☐ | POST PUT | `/api/v1/hostel-admin/backup/key` | requireHostelAdminPrincipal |  | backup |
| ☐ | POST | `/api/v1/hostel-admin/backup/restore` | requireHostelAdminPrincipal |  | backup |
| ☐ | GET | `/api/v1/hostel-admin/backup/runs/:runId/file` | requireHostelAdminPrincipal | max120s | backup |
| ☐ | GET | `/api/v1/hostel-admin/billing` | requireHostelStaffPrincipal | etag | billing |
| ☐ | POST | `/api/v1/hostel-admin/billing/checkout` | requireHostelAdminPrincipal |  | billing |
| ☐ | POST | `/api/v1/hostel-admin/billing/claim` | requireHostelAdminPrincipal |  | billing |
| ☐ | GET | `/api/v1/hostel-admin/billing/documents/:kind/:number` | requireHostelStaffPrincipal |  | billing |
| ☐ | GET | `/api/v1/hostel-admin/billing/pay-instructions` | requireHostelAdminPrincipal | etag | billing |
| ☐ | POST | `/api/v1/hostel-admin/billing/renew` | requireHostelAdminPrincipal |  | billing |
| ☐ | GET | `/api/v1/hostel-admin/bookings` | requireHostelAdminPrincipal | etag | bookings, hostels |
| ☐ | POST | `/api/v1/hostel-admin/bookings/:id/:action` | requireHostelAdminPrincipal |  | bookings |
| ☐ | GET | `/api/v1/hostel-admin/bookings/card` | cap:registerResidents | etag | bookings, hostels |
| ☐ | GET | `/api/v1/hostel-admin/bookings/documents/:number` | requireHostelAdminPrincipal |  | bookings |
| ☐ | GET PUT | `/api/v1/hostel-admin/bookings/short-stays` | requireHostelAdminPrincipal | etag | bookings, hostels |
| ☐ | GET POST | `/api/v1/hostel-admin/branches` | requireHostelAdminPrincipal | etag | billing, hostels |
| ☐ | GET | `/api/v1/hostel-admin/branches/:branchId` | requireHostelAdminPrincipal | etag | billing, hostels |
| ☐ | GET | `/api/v1/hostel-admin/branches/names` | requireHostelStaffPrincipal | etag | hostels |
| ☐ | GET | `/api/v1/hostel-admin/branches/summary` | requireHostelAdminPrincipal | etag | hostels |
| ☐ | GET POST | `/api/v1/hostel-admin/community` | requireHostelStaffPrincipal | etag | community |
| ☐ | DELETE PATCH | `/api/v1/hostel-admin/community/:postId/hide` | requireHostelStaffPrincipal |  | community |
| ☐ | GET | `/api/v1/hostel-admin/complaints` | cap:viewComplaints | redis etag | complaints |
| ☐ | POST | `/api/v1/hostel-admin/complaints/:id/reply` | cap:updateComplaints |  | complaints |
| ☐ | PATCH | `/api/v1/hostel-admin/complaints/:id/status` | cap:updateComplaints |  | complaints |
| ☐ | GET PATCH | `/api/v1/hostel-admin/cook-portal` | cap:manageFood | etag | food |
| ☐ | GET POST | `/api/v1/hostel-admin/cooks` | cap:manageFood | etag | food |
| ☐ | DELETE PATCH | `/api/v1/hostel-admin/cooks/:cookId` | cap:manageFood |  | food |
| ☐ | PUT | `/api/v1/hostel-admin/cooks/fingerprint` | requireHostelAdminPrincipal |  | food, finance |
| ☐ | GET POST | `/api/v1/hostel-admin/expenses` | cap:recordExpenses | redis etag | finance |
| ☐ | POST | `/api/v1/hostel-admin/expenses/:id/cash` | cap:recordExpenses |  | finance |
| ☐ | POST | `/api/v1/hostel-admin/expenses/:id/void` | cap:recordExpenses |  | finance |
| ☐ | POST | `/api/v1/hostel-admin/expenses/categories` | requireHostelAdminPrincipal |  | finance |
| ☐ | PATCH | `/api/v1/hostel-admin/expenses/categories/:id` | requireHostelAdminPrincipal |  | finance |
| ☐ | PUT | `/api/v1/hostel-admin/expenses/cook` | requireHostelAdminPrincipal |  | finance |
| ☐ | POST | `/api/v1/hostel-admin/expenses/receipt/read` | rateLimitPublicForm, cap:recordExpenses | max30s | finance |
| ☐ | GET | `/api/v1/hostel-admin/expenses/wallet` | cap:recordExpenses | etag | finance |
| ☐ | GET POST | `/api/v1/hostel-admin/finance/billing-runs` | cap:manageFeeSchedule, cap:viewPayments | etag max60s | finance, hostels |
| ☐ | GET | `/api/v1/hostel-admin/finance/events` | cap:viewPayments | etag | finance, hostels |
| ☐ | POST | `/api/v1/hostel-admin/finance/events/:id/approve` | cap:approvePayments |  | finance |
| ☐ | POST | `/api/v1/hostel-admin/finance/events/:id/ask-resident` | cap:viewPayments |  | finance |
| ☐ | POST | `/api/v1/hostel-admin/finance/events/:id/assign` | cap:approvePayments |  | finance |
| ☐ | POST | `/api/v1/hostel-admin/finance/events/:id/reject` | cap:approvePayments |  | finance |
| ☐ | POST | `/api/v1/hostel-admin/finance/events/:id/reverse` | cap:reversePayments |  | finance |
| ☐ | POST | `/api/v1/hostel-admin/finance/events/bulk-approve` | cap:approvePayments | max60s | finance, hostels |
| ☐ | GET POST | `/api/v1/hostel-admin/finance/fee-schedules` | cap:viewPayments, cap:manageFeeSchedule | etag | finance, hostels |
| ☐ | DELETE | `/api/v1/hostel-admin/finance/fee-schedules/:id` | cap:manageFeeSchedule |  | finance, hostels |
| ☐ | POST | `/api/v1/hostel-admin/finance/fee-schedules/:id/close` | cap:manageFeeSchedule |  | finance, hostels |
| ☐ | POST | `/api/v1/hostel-admin/finance/fee-schedules/kyc` | cap:manageFeeSchedule |  | finance, hostels |
| ☐ | GET | `/api/v1/hostel-admin/finance/invoices` | cap:viewPayments | redis etag | finance, hostels |
| ☐ | POST | `/api/v1/hostel-admin/finance/invoices/:id/cash` | cap:recordCash |  | finance |
| ☐ | POST | `/api/v1/hostel-admin/finance/invoices/:id/void` | cap:reversePayments |  | finance |
| ☐ | POST | `/api/v1/hostel-admin/finance/invoices/:id/waive-fine` | cap:manageFeeSchedule |  | finance |
| ☐ | GET | `/api/v1/hostel-admin/finance/invoices/ledger` | cap:viewPayments | redis etag | finance, hostels |
| ☐ | GET | `/api/v1/hostel-admin/finance/invoices/periods` | cap:viewPayments | redis etag | finance, hostels |
| ☐ | GET PUT | `/api/v1/hostel-admin/finance/khata` | cap:viewPayments, cap:recordCash | redis etag | finance, hostels |
| ☐ | POST | `/api/v1/hostel-admin/finance/khata/residents/:residentId` | cap:recordCash |  | finance, hostels |
| ☐ | GET PUT | `/api/v1/hostel-admin/finance/late-fine` | cap:viewPayments, cap:manageFeeSchedule | redis etag | finance, hostels |
| ☐ | GET PUT | `/api/v1/hostel-admin/finance/money-rules` | cap:viewPayments, cap:manageFeeSchedule | redis etag | finance, hostels |
| ☐ | DELETE GET PUT | `/api/v1/hostel-admin/finance/payment-gateways` | cap:managePaymentProfile | etag | finance, hostels |
| ☐ | GET PATCH | `/api/v1/hostel-admin/finance/payment-profile` | cap:viewPayments, cap:managePaymentProfile | etag | finance, hostels |
| ☐ | GET | `/api/v1/hostel-admin/finance/receipts/:id/pdf` | cap:viewPayments |  | finance |
| ☐ | GET POST | `/api/v1/hostel-admin/finance/rent-concessions` | cap:viewPayments, cap:manageFeeSchedule | etag | finance, hostels |
| ☐ | DELETE | `/api/v1/hostel-admin/finance/rent-concessions/:id` | cap:manageFeeSchedule |  | finance, hostels |
| ☐ | GET | `/api/v1/hostel-admin/finance/residents/:residentId/ledger` | cap:viewPayments | etag | finance, hostels |
| ☐ | GET POST | `/api/v1/hostel-admin/finance/statements` | cap:approvePayments | etag | finance, hostels |
| ☐ | GET | `/api/v1/hostel-admin/finance/statements/:id` | cap:approvePayments | etag | finance |
| ☐ | POST | `/api/v1/hostel-admin/finance/statements/:id/approve-matched` | cap:approvePayments |  | finance |
| ☐ | POST | `/api/v1/hostel-admin/food/photos` | cap:manageFood |  | food |
| ☐ | GET PUT | `/api/v1/hostel-admin/food/routine` | cap:manageFood | redis etag | food |
| ☐ | GET | `/api/v1/hostel-admin/hostel-referrals` | requireHostelStaffPrincipal | etag | hostel-referrals, food |
| ☐ | POST | `/api/v1/hostel-admin/hostel-referrals/invite` | requireHostelStaffPrincipal |  | hostel-referrals, food |
| ☐ | GET | `/api/v1/hostel-admin/inquiries` | requireHostelStaffPrincipal | redis etag | hostels |
| ☐ | POST | `/api/v1/hostel-admin/inquiries/:id/notes` | requireHostelStaffPrincipal |  | hostels |
| ☐ | PATCH | `/api/v1/hostel-admin/inquiries/:id/status` | requireHostelStaffPrincipal |  | hostels |
| ☐ | DELETE GET POST | `/api/v1/hostel-admin/kyc` | requireHostelAdminPrincipal | etag | hostels |
| ☐ | GET POST | `/api/v1/hostel-admin/kyc/agreement` | requireHostelAdminPrincipal |  | hostels, users |
| ☐ | POST | `/api/v1/hostel-admin/kyc/submit` | requireHostelAdminPrincipal |  | hostels |
| ☐ | DELETE GET POST | `/api/v1/hostel-admin/leave` | requireHostelAdminPrincipal |  | hostels |
| ☐ | GET POST | `/api/v1/hostel-admin/maintenance/requests` | cap:manageMaintenance | redis etag | maintenance |
| ☐ | POST | `/api/v1/hostel-admin/maintenance/requests/:id/comment` | cap:manageMaintenance |  | maintenance |
| ☐ | PATCH | `/api/v1/hostel-admin/maintenance/requests/:id/provider` | requireHostelStaffPrincipal |  | maintenance |
| ☐ | PATCH | `/api/v1/hostel-admin/maintenance/requests/:id/status` | cap:manageMaintenance |  | maintenance |
| ☐ | GET | `/api/v1/hostel-admin/maintenance/settings` | requireHostelStaffPrincipal | etag | maintenance |
| ☐ | GET | `/api/v1/hostel-admin/move-events` | cap:registerResidents | etag | move-checklist |
| ☐ | GET | `/api/v1/hostel-admin/night-status` | cap:viewNightStatus | redis etag | safety |
| ☐ | PATCH | `/api/v1/hostel-admin/night-status/:residentId/override` | cap:updateNightStatus |  | safety |
| ☐ | GET POST | `/api/v1/hostel-admin/notice-pushes` | cap:manageNotices | etag | notices |
| ☐ | DELETE PATCH | `/api/v1/hostel-admin/notice-pushes/:id` | cap:manageNotices |  | notices |
| ☐ | POST | `/api/v1/hostel-admin/notice-pushes/:id/send` | cap:manageNotices |  | notices |
| ☐ | GET POST | `/api/v1/hostel-admin/notices` | cap:manageNotices | redis etag | notices |
| ☐ | PATCH | `/api/v1/hostel-admin/notices/:id` | cap:manageNotices |  | notices |
| ☐ | GET POST | `/api/v1/hostel-admin/notifications` | requireHostelStaffPrincipal | etag | notifications |
| ☐ | GET PUT | `/api/v1/hostel-admin/payout-account` | requireHostelAdminPrincipal | etag | bookings, hostels |
| ☐ | GET PATCH | `/api/v1/hostel-admin/profile` | requireHostelStaffPrincipal, cap:editHostelProfile | redis etag | hostels |
| ☐ | POST | `/api/v1/hostel-admin/profile/change-request` | cap:editHostelProfile |  | hostels |
| ☐ | GET | `/api/v1/hostel-admin/profile/geocode` | cap:editHostelProfile | etag | hostels |
| ☐ | POST | `/api/v1/hostel-admin/profile/photos` | cap:editHostelProfile |  | hostels |
| ☐ | DELETE | `/api/v1/hostel-admin/profile/photos/:photoId` | cap:editHostelProfile |  | hostels |
| ☐ | GET | `/api/v1/hostel-admin/referrals` | requireHostelStaffPrincipal | etag | referrals |
| ☐ | PATCH | `/api/v1/hostel-admin/referrals/:id/confirm` | requireHostelStaffPrincipal |  | referrals |
| ☐ | PATCH | `/api/v1/hostel-admin/referrals/:id/reward` | requireHostelStaffPrincipal |  | referrals |
| ☐ | GET | `/api/v1/hostel-admin/reports/attendance` | requireHostelStaffPrincipal | etag | reports |
| ☐ | GET | `/api/v1/hostel-admin/reports/complaints` | requireHostelStaffPrincipal | etag | reports |
| ☐ | GET | `/api/v1/hostel-admin/reports/dashboard` | requireHostelStaffPrincipal | redis etag | reports |
| ☐ | GET | `/api/v1/hostel-admin/reports/export` | requireHostelStaffPrincipal |  | reports |
| ☐ | GET | `/api/v1/hostel-admin/reports/food` | cap:manageFood | etag | reports |
| ☐ | GET | `/api/v1/hostel-admin/reports/maintenance` | requireHostelStaffPrincipal | etag | reports |
| ☐ | GET | `/api/v1/hostel-admin/reports/overall/pdf` | requireHostelAdminPrincipal |  | finance, hostels, reports |
| ☐ | GET | `/api/v1/hostel-admin/reports/overview` | requireHostelStaffPrincipal | etag | reports |
| ☐ | GET | `/api/v1/hostel-admin/reports/payments` | requireHostelStaffPrincipal | etag | reports |
| ☐ | GET | `/api/v1/hostel-admin/reports/performance` | requireHostelStaffPrincipal | etag | reports |
| ☐ | GET | `/api/v1/hostel-admin/reports/performance/pdf` | requireHostelStaffPrincipal |  | reports |
| ☐ | GET | `/api/v1/hostel-admin/reports/statement/pdf` | cap:viewPayments |  | finance, hostels, reports |
| ☐ | GET | `/api/v1/hostel-admin/resident-lookup` | rateLimitPublicForm, cap:registerResidents | etag | users |
| ☐ | GET | `/api/v1/hostel-admin/resident-scan` | rateLimitPublicForm, cap:registerResidents, cap:viewPayments | etag | users |
| ☐ | GET | `/api/v1/hostel-admin/resident-scan/photo` | cap:registerResidents |  | users |
| ☐ | GET POST | `/api/v1/hostel-admin/residents` | requireHostelStaffPrincipal, cap:registerResidents | redis etag | residents |
| ☐ | DELETE GET PATCH | `/api/v1/hostel-admin/residents/:id` | requireHostelStaffPrincipal, cap:registerResidents | etag | residents |
| ☐ | PATCH POST | `/api/v1/hostel-admin/residents/:id/activation-code` | cap:registerResidents |  | residents |
| ☐ | GET | `/api/v1/hostel-admin/residents/:id/contacts` | cap:registerResidents | etag | residents |
| ☐ | POST | `/api/v1/hostel-admin/residents/:id/emergency-contacts` | cap:registerResidents |  | residents |
| ☐ | POST | `/api/v1/hostel-admin/residents/:id/guardians` | cap:registerResidents |  | residents |
| ☐ | GET POST | `/api/v1/hostel-admin/residents/:id/leave` | cap:viewPayments, cap:recordCash | etag | finance, hostels |
| ☐ | DELETE | `/api/v1/hostel-admin/residents/:id/leave/:leaveId` | cap:recordCash |  | finance, hostels |
| ☐ | GET POST | `/api/v1/hostel-admin/residents/:id/move-in` | cap:registerResidents | etag | move-checklist |
| ☐ | GET POST | `/api/v1/hostel-admin/residents/:id/move-out` | cap:registerResidents, cap:recordCash | etag | move-checklist |
| ☐ | GET | `/api/v1/hostel-admin/residents/:id/photo` | requireHostelStaffPrincipal |  | residents |
| ☐ | PUT | `/api/v1/hostel-admin/residents/:id/room` | cap:registerResidents |  | hostels |
| ☐ | PATCH | `/api/v1/hostel-admin/residents/:id/status` | cap:registerResidents |  | residents |
| ☐ | POST | `/api/v1/hostel-admin/residents/:id/write-off` | cap:recordCash |  | move-checklist |
| ☐ | GET PATCH | `/api/v1/hostel-admin/residents/admission-form-link` | hostelStaffScope | etag | residents |
| ☐ | GET | `/api/v1/hostel-admin/residents/admission-forms` | hostelStaffScope | etag | residents |
| ☐ | DELETE GET | `/api/v1/hostel-admin/residents/admission-forms/:formId` | hostelStaffScope | etag | residents |
| ☐ | GET | `/api/v1/hostel-admin/residents/admission-forms/:formId/photo` | hostelStaffScope |  | residents |
| ☐ | DELETE GET PUT | `/api/v1/hostel-admin/residents/existing` | in existing-residents.routes.ts |  | residents |
| ☐ | POST | `/api/v1/hostel-admin/residents/existing/add` | in existing-residents.routes.ts | max300s | residents |
| ☐ | POST | `/api/v1/hostel-admin/residents/existing/file` | in existing-residents.routes.ts |  | residents |
| ☐ | POST | `/api/v1/hostel-admin/residents/existing/one` | in existing-residents.routes.ts | max300s | residents |
| ☐ | GET | `/api/v1/hostel-admin/residents/existing/template` | in existing-residents.routes.ts |  | residents |
| ☐ | PATCH | `/api/v1/hostel-admin/residents/fees` | cap:manageFeeSchedule |  | finance, hostels |
| ☐ | GET | `/api/v1/hostel-admin/residents/intake-quote` | cap:registerResidents | etag | hostels, residents |
| ☐ | GET PATCH | `/api/v1/hostel-admin/residents/join-link` | in existing-residents.routes.ts |  | residents |
| ☐ | GET | `/api/v1/hostel-admin/residents/join-requests` | in existing-residents.routes.ts |  | residents |
| ☐ | POST | `/api/v1/hostel-admin/residents/join-requests/:requestId` | in existing-residents.routes.ts | max300s | residents |
| ☐ | GET | `/api/v1/hostel-admin/residents/leaving-today` | cap:registerResidents |  | hostels, move-checklist |
| ☐ | GET | `/api/v1/hostel-admin/room-types` | cap:registerResidents | etag | hostels |
| ☐ | GET POST | `/api/v1/hostel-admin/rooms` | requireHostelStaffPrincipal, cap:manageRooms | etag | hostels |
| ☐ | DELETE PATCH | `/api/v1/hostel-admin/rooms/:roomId` | cap:manageRooms |  | hostels |
| ☐ | GET | `/api/v1/hostel-admin/rooms/requests` | requireHostelStaffPrincipal | etag | hostels |
| ☐ | POST | `/api/v1/hostel-admin/rooms/requests/:requestId` | cap:registerResidents |  | hostels |
| ☐ | PUT | `/api/v1/hostel-admin/rooms/order` | requireHostelAdminPrincipal |  | hostels |
| ☐ | PUT | `/api/v1/hostel-admin/rooms/tracking` | requireHostelAdminPrincipal |  | hostels |
| ☐ | GET | `/api/v1/hostel-admin/service-providers` | requireHostelStaffPrincipal | etag | service-providers |
| ☐ | GET | `/api/v1/hostel-admin/service-providers/:id` | requireHostelStaffPrincipal | etag | service-providers |
| ☐ | GET PATCH | `/api/v1/hostel-admin/settings/community` | requireHostelAdminPrincipal | etag | community |
| ☐ | GET | `/api/v1/hostel-admin/sos-alerts` | requireHostelStaffPrincipal | etag | safety |
| ☐ | PATCH | `/api/v1/hostel-admin/sos-alerts/:id/status` | requireHostelStaffPrincipal |  | safety |
| ☐ | GET POST | `/api/v1/hostel-admin/stock` | cap:manageStock | redis etag | stock |
| ☐ | PUT | `/api/v1/hostel-admin/stock/cook` | requireHostelAdminPrincipal |  | stock |
| ☐ | POST | `/api/v1/hostel-admin/stock/entries/:id/approve` | cap:manageStock |  | stock |
| ☐ | POST | `/api/v1/hostel-admin/stock/entries/:id/cancel` | cap:manageStock |  | stock |
| ☐ | POST | `/api/v1/hostel-admin/stock/entries/:id/receive` | cap:manageStock |  | stock |
| ☐ | POST | `/api/v1/hostel-admin/stock/items` | cap:manageStock |  | stock |
| ☐ | PATCH | `/api/v1/hostel-admin/stock/items/:id` | cap:manageStock |  | stock |
| ☐ | POST | `/api/v1/hostel-admin/stock/payments` | cap:manageStock |  | stock |
| ☐ | POST | `/api/v1/hostel-admin/stock/payments/:id/cancel` | cap:manageStock |  | stock |
| ☐ | GET | `/api/v1/hostel-admin/stock/report` | cap:manageStock | redis etag | reports, stock |
| ☐ | POST | `/api/v1/hostel-admin/stock/suppliers` | cap:manageStock |  | stock |
| ☐ | GET PATCH | `/api/v1/hostel-admin/stock/suppliers/:id` | cap:manageStock | etag | stock |
| ☐ | GET | `/api/v1/hostel-admin/stock/usage` | cap:manageStock | redis etag | stock |
| ☐ | GET | `/api/v1/hostel-admin/subscription` | requireHostelStaffPrincipal | redis etag | billing |
| ☐ | GET POST | `/api/v1/hostel-admin/wardens` | requireHostelAdminPrincipal | etag | wardens |
| ☐ | DELETE PATCH | `/api/v1/hostel-admin/wardens/:id` | requireHostelAdminPrincipal |  | wardens |

### `hostel-registration` (5)

| ☐ | Methods | Path | Guard | Notes | Modules |
|---|---|---|---|---|---|
| ☐ | POST | `/api/v1/hostel-registration/:hostelId/invoice` | requireApiPrincipal |  | billing |
| ☐ | POST | `/api/v1/hostel-registration/:hostelId/pay` | requireApiPrincipal |  | billing |
| ☐ | POST | `/api/v1/hostel-registration/:hostelId/plan` | requireApiPrincipal |  | billing, hostels |
| ☐ | GET | `/api/v1/hostel-registration/:hostelId/state` | requireApiPrincipal | etag | billing |
| ☐ | GET | `/api/v1/hostel-registration/return` | loadApiPrincipal, requireApiPrincipal |  | billing |

### `integrations` (2)

| ☐ | Methods | Path | Guard | Notes | Modules |
|---|---|---|---|---|---|
| ☐ | POST | `/api/v1/integrations/questioncall/conversion` | public |  | questioncall |
| ☐ | POST | `/api/v1/integrations/questioncall/sso` | public |  | questioncall |

### `mobile` (1)

| ☐ | Methods | Path | Guard | Notes | Modules |
|---|---|---|---|---|---|
| ☐ | DELETE POST | `/api/v1/mobile/device-token` | requireApiPrincipal |  | notifications |

### `notifications` (4)

| ☐ | Methods | Path | Guard | Notes | Modules |
|---|---|---|---|---|---|
| ☐ | GET | `/api/v1/notifications` | requireApiPrincipal | etag | notifications |
| ☐ | PATCH | `/api/v1/notifications/:id/read` | requireApiPrincipal |  | notifications |
| ☐ | PATCH | `/api/v1/notifications/:id/resolve` | requireApiPrincipal |  | notifications |
| ☐ | PATCH | `/api/v1/notifications/read-all` | requireApiPrincipal |  | notifications |

### `platform` (99)

| ☐ | Methods | Path | Guard | Notes | Modules |
|---|---|---|---|---|---|
| ☐ | GET | `/api/v1/platform/account-deletions` | requirePlatformPrincipal, assertApiRoles | etag | users |
| ☐ | POST | `/api/v1/platform/account-deletions/:id/review` | requirePlatformPrincipal, assertApiRoles |  | users |
| ☐ | GET POST | `/api/v1/platform/admins` | requireSuperadminPrincipal | etag | users |
| ☐ | DELETE PATCH | `/api/v1/platform/admins/:id` | requireSuperadminPrincipal |  | users |
| ☐ | GET | `/api/v1/platform/admins/email-check` | requireSuperadminPrincipal | etag | users |
| ☐ | GET POST | `/api/v1/platform/admins/invites` | requireSuperadminPrincipal | etag | users |
| ☐ | DELETE | `/api/v1/platform/admins/invites/:id` | requireSuperadminPrincipal |  | users |
| ☐ | POST | `/api/v1/platform/app-apk` | requireSuperadminPrincipal |  |  |
| ☐ | GET | `/api/v1/platform/audit-logs` | requirePlatformPrincipal | etag | audit |
| ☐ | GET | `/api/v1/platform/backup-status` | requireSuperadminPrincipal |  | backup |
| ☐ | GET | `/api/v1/platform/bookings` | requireSuperadminPrincipal | etag | bookings |
| ☐ | DELETE GET | `/api/v1/platform/bookings/:id` | requireSuperadminPrincipal | etag | bookings |
| ☐ | GET | `/api/v1/platform/bookings/documents/:kind/:number` | requirePlatformPrincipal |  | bookings |
| ☐ | POST | `/api/v1/platform/bookings/hostels/:hostelId/pause` | requireSuperadminPrincipal |  | bookings |
| ☐ | GET | `/api/v1/platform/bookings/payments` | requireSuperadminPrincipal | etag | bookings |
| ☐ | POST | `/api/v1/platform/bookings/payments/:id` | requireSuperadminPrincipal |  | bookings |
| ☐ | GET | `/api/v1/platform/bookings/payout-accounts` | requireSuperadminPrincipal | etag | bookings |
| ☐ | POST | `/api/v1/platform/bookings/payout-accounts/:hostelId/reveal` | requireSuperadminPrincipal |  | bookings |
| ☐ | POST | `/api/v1/platform/bookings/payout-accounts/:hostelId/review` | requireSuperadminPrincipal |  | bookings |
| ☐ | GET POST | `/api/v1/platform/bookings/settings` | requireSuperadminPrincipal | etag | bookings, platform-config |
| ☐ | GET | `/api/v1/platform/bookings/transfers` | requireSuperadminPrincipal | etag | bookings |
| ☐ | POST | `/api/v1/platform/bookings/transfers/:id/:action` | requireSuperadminPrincipal |  | bookings |
| ☐ | GET | `/api/v1/platform/community` | requirePlatformPrincipal | etag | community |
| ☐ | DELETE PATCH | `/api/v1/platform/community/:postId/hide` | requirePlatformPrincipal |  | community |
| ☐ | GET | `/api/v1/platform/complaints` | requirePlatformPrincipal | etag | reports |
| ☐ | GET | `/api/v1/platform/feedback` | requirePlatformPrincipal | etag | feedback |
| ☐ | PATCH | `/api/v1/platform/feedback/:id` | requirePlatformPrincipal |  | feedback |
| ☐ | GET | `/api/v1/platform/hostel-leaves` | requireSuperadminPrincipal |  | hostels |
| ☐ | GET | `/api/v1/platform/hostel-leaves/:id` | requireSuperadminPrincipal |  | hostels |
| ☐ | POST | `/api/v1/platform/hostel-leaves/:id/approve` | requireSuperadminPrincipal | max60s | hostels |
| ☐ | POST | `/api/v1/platform/hostel-leaves/:id/reject` | requireSuperadminPrincipal |  | hostels |
| ☐ | GET PUT | `/api/v1/platform/hostel-referrals` | requireSuperadminPrincipal | etag | hostel-referrals |
| ☐ | PATCH | `/api/v1/platform/hostel-referrals/:referralId` | requireSuperadminPrincipal |  | hostel-referrals |
| ☐ | POST | `/api/v1/platform/hostel-referrals/codes` | requireSuperadminPrincipal |  | hostel-referrals |
| ☐ | PATCH | `/api/v1/platform/hostel-referrals/codes/:codeId` | requireSuperadminPrincipal |  | hostel-referrals |
| ☐ | GET POST | `/api/v1/platform/hostels` | requirePlatformPrincipal | etag | hostels |
| ☐ | DELETE GET | `/api/v1/platform/hostels/:id` | requirePlatformPrincipal, requireSuperadminPrincipal | etag | hostels |
| ☐ | GET | `/api/v1/platform/hostels/:id/agreement` | requireSuperadminPrincipal |  | hostels |
| ☐ | PATCH | `/api/v1/platform/hostels/:id/approve` | requirePlatformPrincipal |  | hostels |
| ☐ | PATCH | `/api/v1/platform/hostels/:id/archive` | requireSuperadminPrincipal |  | hostels |
| ☐ | PATCH | `/api/v1/platform/hostels/:id/owner-email` | requireSuperadminPrincipal |  | hostels |
| ☐ | PATCH | `/api/v1/platform/hostels/:id/owner-invite` | requireSuperadminPrincipal |  | hostels |
| ☐ | PATCH | `/api/v1/platform/hostels/:id/publish` | requirePlatformPrincipal |  | hostels |
| ☐ | POST | `/api/v1/platform/hostels/:id/recharge` | requireSuperadminPrincipal |  | billing, hostels |
| ☐ | PATCH | `/api/v1/platform/hostels/:id/reject` | requirePlatformPrincipal |  | hostels |
| ☐ | PATCH | `/api/v1/platform/hostels/:id/request-documents` | requirePlatformPrincipal |  | hostels |
| ☐ | PATCH | `/api/v1/platform/hostels/:id/restore` | requireSuperadminPrincipal |  | hostels |
| ☐ | POST | `/api/v1/platform/hostels/:id/run-duplicate-check` | requirePlatformPrincipal |  | listing-flags |
| ☐ | DELETE PATCH | `/api/v1/platform/hostels/:id/suspend` | requireSuperadminPrincipal |  | hostels |
| ☐ | PATCH | `/api/v1/platform/hostels/:id/unpublish` | requirePlatformPrincipal |  | hostels |
| ☐ | GET | `/api/v1/platform/listing-flags` | requirePlatformPrincipal | etag | listing-flags |
| ☐ | PATCH | `/api/v1/platform/listing-flags/:id/resolve` | requirePlatformPrincipal |  | listing-flags |
| ☐ | GET POST | `/api/v1/platform/notifications` | requirePlatformPrincipal, requireSuperadminPrincipal | etag | notifications |
| ☐ | GET | `/api/v1/platform/offer-program` | requireSuperadminPrincipal | etag | offer-program |
| ☐ | POST | `/api/v1/platform/offer-program/awards` | requireSuperadminPrincipal |  | offer-program |
| ☐ | PATCH | `/api/v1/platform/offer-program/awards/:awardId` | requireSuperadminPrincipal |  | offer-program |
| ☐ | POST | `/api/v1/platform/offer-program/perks` | requireSuperadminPrincipal |  | offer-program |
| ☐ | DELETE PATCH | `/api/v1/platform/offer-program/perks/:perkId` | requireSuperadminPrincipal |  | offer-program |
| ☐ | GET PUT | `/api/v1/platform/operations-config` | requireSuperadminPrincipal | etag | platform-config |
| ☐ | GET | `/api/v1/platform/payments` | requirePlatformPrincipal | etag | reports |
| ☐ | GET POST | `/api/v1/platform/push` | requireSuperadminPrincipal | etag | notifications |
| ☐ | PATCH | `/api/v1/platform/push/schedules/:id` | requireSuperadminPrincipal |  | notifications |
| ☐ | GET | `/api/v1/platform/questioncall/analytics` | requireSuperadminPrincipal, requirePlatformPrincipal | etag | questioncall |
| ☐ | GET | `/api/v1/platform/reports/dashboard` | requirePlatformPrincipal | etag | reports |
| ☐ | GET | `/api/v1/platform/reports/export` | requireSuperadminPrincipal |  | reports |
| ☐ | GET | `/api/v1/platform/reviews` | requirePlatformPrincipal | etag | reviews |
| ☐ | PATCH | `/api/v1/platform/reviews/:id/hide` | requirePlatformPrincipal |  | reviews |
| ☐ | PATCH | `/api/v1/platform/reviews/:id/unhide` | requirePlatformPrincipal |  | reviews |
| ☐ | GET | `/api/v1/platform/service-providers` | requirePlatformPrincipal | etag | service-providers |
| ☐ | GET | `/api/v1/platform/service-providers/:id` | requirePlatformPrincipal | etag | service-providers |
| ☐ | PATCH | `/api/v1/platform/service-providers/:id/approve` | requirePlatformPrincipal |  | service-providers |
| ☐ | PATCH | `/api/v1/platform/service-providers/:id/hide` | requirePlatformPrincipal |  | service-providers |
| ☐ | PATCH | `/api/v1/platform/service-providers/:id/reject` | requirePlatformPrincipal |  | service-providers |
| ☐ | DELETE | `/api/v1/platform/setting-changes/:id` | requireSuperadminPrincipal |  | platform-config |
| ☐ | GET POST | `/api/v1/platform/setting-changes/confirm` | requireSuperadminPrincipal | etag | platform-config |
| ☐ | GET | `/api/v1/platform/site-config` | requireSuperadminPrincipal | etag | platform-config |
| ☐ | PUT | `/api/v1/platform/site-config/:section` | requireSuperadminPrincipal |  | platform-config |
| ☐ | GET POST | `/api/v1/platform/sponsors` | requireSuperadminPrincipal | etag | sponsors |
| ☐ | DELETE PATCH | `/api/v1/platform/sponsors/:sponsorId` | requireSuperadminPrincipal |  | sponsors |
| ☐ | GET POST | `/api/v1/platform/store/categories` | requireSuperadminPrincipal | etag | store |
| ☐ | DELETE PATCH | `/api/v1/platform/store/categories/:categoryId` | requireSuperadminPrincipal |  | store |
| ☐ | GET PATCH | `/api/v1/platform/store/config` | requireSuperadminPrincipal | etag | store |
| ☐ | GET | `/api/v1/platform/store/orders` | requireSuperadminPrincipal | etag | store |
| ☐ | PATCH | `/api/v1/platform/store/orders/:orderId/status` | requireSuperadminPrincipal |  | store |
| ☐ | GET POST | `/api/v1/platform/store/products` | requireSuperadminPrincipal | etag | store |
| ☐ | DELETE PATCH | `/api/v1/platform/store/products/:productId` | requireSuperadminPrincipal |  | store |
| ☐ | GET | `/api/v1/platform/store/summary` | requireSuperadminPrincipal | etag | store |
| ☐ | GET | `/api/v1/platform/subscriptions` | requirePlatformPrincipal | etag | billing |
| ☐ | GET | `/api/v1/platform/subscriptions/cash` | requirePlatformPrincipal | etag | billing |
| ☐ | POST | `/api/v1/platform/subscriptions/cash/:id/check` | requirePlatformPrincipal |  | billing |
| ☐ | GET | `/api/v1/platform/subscriptions/claims` | requirePlatformPrincipal | etag | billing |
| ☐ | POST | `/api/v1/platform/subscriptions/claims/:paymentId/review` | requirePlatformPrincipal |  | billing |
| ☐ | GET | `/api/v1/platform/subscriptions/documents/:kind/:number` | requirePlatformPrincipal |  | billing |
| ☐ | GET | `/api/v1/platform/team` | requireSuperadminPrincipal | etag | team |
| ☐ | DELETE PATCH | `/api/v1/platform/team/members/:id` | requireSuperadminPrincipal |  | team |
| ☐ | GET | `/api/v1/platform/team/wallets` | requireSuperadminPrincipal | etag | team |
| ☐ | POST | `/api/v1/platform/team/wallets/:agentId` | requireSuperadminPrincipal |  | team |
| ☐ | GET | `/api/v1/platform/usage` | requireSuperadminPrincipal |  | usage |
| ☐ | GET | `/api/v1/platform/users` | requirePlatformPrincipal | etag | reports |

### `platform-admin` (2)

| ☐ | Methods | Path | Guard | Notes | Modules |
|---|---|---|---|---|---|
| ☐ | POST | `/api/v1/platform-admin/accept-invitation` | public |  | users |
| ☐ | GET | `/api/v1/platform-admin/invitation` | public | etag | users |

### `public` (32)

| ☐ | Methods | Path | Guard | Notes | Modules |
|---|---|---|---|---|---|
| ☑ | GET POST | `/api/v1/public/admission-form/:token` | rateLimitPublicForm, loadApiPrincipal | etag | residents |
| ☑ | POST | `/api/v1/public/files/upload` | rateLimitPublicForm |  |  |
| ☑ | POST | `/api/v1/public/hostel-applications/:id/resubmit-documents` | requireApiPrincipal |  | hostels |
| ☑ | GET | `/api/v1/public/hostel-applications/my-applications` | requireApiPrincipal | etag | hostels |
| ☑ | GET | `/api/v1/public/hostel-referral-codes/:code` | rateLimitPublicForm | etag | hostel-referrals |
| ☑ | GET | `/api/v1/public/hostels` | public | etag | hostels |
| ☑ | GET | `/api/v1/public/hostels/:slug` | public |  | hostels |
| ☑ | POST | `/api/v1/public/hostels/:slug/arriving` | rateLimitPublicForm, requireApiPrincipal |  | arrivals |
| ☑ | POST | `/api/v1/public/hostels/:slug/inquiries` | rateLimitPublicForm, loadApiPrincipal |  | hostels, users |
| ☑ | GET | `/api/v1/public/hostels/:slug/reviews` | public |  | reviews |
| ☑ | POST | `/api/v1/public/hostels/:slug/views` | rateLimitPublicForm, loadApiPrincipal |  | hostels |
| ☑ | GET | `/api/v1/public/hostels/compare` | public | etag | hostels |
| ☑ | POST | `/api/v1/public/hostels/impressions` | rateLimitPublicForm |  | hostels |
| ☑ | POST | `/api/v1/public/hostels/quick-register` | rateLimitPublicForm, requireApiPrincipal |  | hostels |
| ☑ | POST | `/api/v1/public/hostels/register` | rateLimitPublicForm, loadApiPrincipal |  | hostels |
| ☑ | GET | `/api/v1/public/hostels/register/geocode` | rateLimitPublicForm, requireApiPrincipal | etag | hostels |
| ☑ | POST | `/api/v1/public/inquiries/with-referral` | rateLimitPublicForm |  | referrals |
| ☑ | GET | `/api/v1/public/join-requests/me` | requireApiPrincipal | etag | residents |
| ☑ | GET POST | `/api/v1/public/join/:token` | rateLimitPublicForm, loadApiPrincipal, requireApiPrincipal | etag | residents |
| ☑ | GET | `/api/v1/public/lifetime` | public |  | billing |
| ☑ | GET | `/api/v1/public/offer-perks` | public |  | offer-program |
| ☑ | GET | `/api/v1/public/places` | rateLimitPublicForm | etag |  |
| ☐ | POST | `/api/v1/public/plan-checkout` | rateLimitPublicForm |  | billing |
| ☑ | GET | `/api/v1/public/pulse` | public |  | reports |
| ☑ | POST | `/api/v1/public/search/parse` | public |  |  |
| ☑ | GET | `/api/v1/public/service-providers` | public | etag | service-providers |
| ☑ | GET | `/api/v1/public/service-providers/me` | requireApiPrincipal | etag | service-providers |
| ☑ | GET | `/api/v1/public/service-providers/me/jobs` | requireApiPrincipal | etag | service-providers |
| ☑ | PATCH | `/api/v1/public/service-providers/me/jobs/:id` | requireApiPrincipal |  | service-providers |
| ☑ | POST | `/api/v1/public/service-providers/me/jobs/:id/accept` | requireApiPrincipal |  | service-providers |
| ☑ | POST | `/api/v1/public/service-providers/register` | rateLimitPublicForm, requireApiPrincipal |  | service-providers |
| ☑ | GET | `/api/v1/public/site-config` | public |  | platform-config |

### `push` (4)

| ☐ | Methods | Path | Guard | Notes | Modules |
|---|---|---|---|---|---|
| ☑ | GET | `/api/v1/push/public-key` | requireApiPrincipal | etag | notifications |
| ☐ | GET | `/api/v1/push/status` | requireApiPrincipal | etag | notifications |
| ☐ | POST | `/api/v1/push/subscribe` | requireApiPrincipal |  | notifications |
| ☐ | POST | `/api/v1/push/unsubscribe` | requireApiPrincipal |  | notifications |

### `realtime` (2)

| ☐ | Methods | Path | Guard | Notes | Modules |
|---|---|---|---|---|---|
| ☐ | POST | `/api/v1/realtime/auth` | requireApiPrincipal, authorizeRealtimeChannel |  |  |
| ☐ | GET | `/api/v1/realtime/config` | requireApiPrincipal | etag |  |

### `resident` (39)

| ☐ | Methods | Path | Guard | Notes | Modules |
|---|---|---|---|---|---|
| ☐ | POST | `/api/v1/resident/activate` | requireApiPrincipal |  | residents |
| ☐ | GET | `/api/v1/resident/activation-status` | requireApiPrincipal | etag | residents |
| ☐ | DELETE GET | `/api/v1/resident/attendance` | requireResidentPrincipal | etag | attendance |
| ☐ | GET POST | `/api/v1/resident/complaints` | requireResidentPrincipal | etag | complaints |
| ☐ | PATCH | `/api/v1/resident/complaints/:id/confirm-resolution` | requireResidentPrincipal |  | complaints |
| ☐ | POST | `/api/v1/resident/consent` | requireResidentPrincipal |  | attendance |
| ☐ | GET | `/api/v1/resident/dashboard` | requireResidentPrincipal | redis etag | residents |
| ☐ | GET | `/api/v1/resident/emergency-contacts` | requireResidentPrincipal | etag | safety |
| ☐ | GET | `/api/v1/resident/finance/checkout/:reference` | requireResidentPrincipal | etag | finance |
| ☐ | POST | `/api/v1/resident/finance/evidence/:assetId/read` | requireResidentPrincipal | max30s | finance, residents |
| ☐ | GET | `/api/v1/resident/finance/invoices` | requireResidentPrincipal | etag | finance |
| ☐ | POST | `/api/v1/resident/finance/invoices/:id/checkout` | requireResidentPrincipal |  | finance |
| ☐ | POST | `/api/v1/resident/finance/invoices/:id/claims` | rateLimitPublicForm, requireResidentPrincipal |  | finance |
| ☐ | GET | `/api/v1/resident/finance/invoices/:id/pay-instructions` | requireResidentPrincipal | etag | finance |
| ☐ | GET POST | `/api/v1/resident/finance/khata` | requireResidentPrincipal | etag | finance |
| ☐ | GET | `/api/v1/resident/finance/receipts/:id/pdf` | requireResidentPrincipal |  | finance, residents |
| ☐ | GET | `/api/v1/resident/finance/statement/pdf` | requireResidentPrincipal |  | finance, residents |
| ☐ | GET | `/api/v1/resident/food` | requireResidentPrincipal | redis etag | food |
| ☐ | POST | `/api/v1/resident/food/feedback` | requireResidentPrincipal |  | food |
| ☐ | POST | `/api/v1/resident/food/photos` | requireResidentPrincipal |  | food |
| ☐ | GET POST | `/api/v1/resident/guardians` | requireResidentPrincipal | etag | guardian |
| ☐ | DELETE PATCH | `/api/v1/resident/guardians/:id` | requireResidentPrincipal |  | guardian |
| ☐ | DELETE GET PUT | `/api/v1/resident/leaving` | requireResidentPrincipal |  | move-checklist |
| ☐ | POST | `/api/v1/resident/location/ping` | requireResidentPrincipal |  | attendance |
| ☐ | GET | `/api/v1/resident/me` | requireResidentPrincipal | etag | residents |
| ☐ | GET POST | `/api/v1/resident/night-status` | requireResidentPrincipal | etag | safety |
| ☐ | POST | `/api/v1/resident/night-status/answer` | verifyPurposeToken |  | safety |
| ☐ | GET | `/api/v1/resident/night-status/history` | requireResidentPrincipal | etag | safety |
| ☐ | GET | `/api/v1/resident/notices` | requireResidentPrincipal | redis etag | notices |
| ☐ | PATCH | `/api/v1/resident/notices/:id/read` | requireResidentPrincipal |  | notices |
| ☐ | POST | `/api/v1/resident/notices/read-all` | requireResidentPrincipal |  | notices |
| ☐ | GET | `/api/v1/resident/offer-program` | requireResidentPrincipal | etag | offer-program |
| ☐ | GET | `/api/v1/resident/profile` | requireResidentPrincipal | etag | residents |
| ☐ | POST | `/api/v1/resident/questioncall/click` | requireResidentPrincipal |  | questioncall |
| ☐ | GET | `/api/v1/resident/questioncall/status` | requireResidentPrincipal | etag | questioncall |
| ☐ | GET | `/api/v1/resident/referral` | requireResidentPrincipal | etag | referrals |
| ☐ | POST | `/api/v1/resident/reviews` | requireResidentPrincipal |  | reviews |
| ☐ | DELETE GET POST | `/api/v1/resident/room` | requireResidentPrincipal | etag | hostels |
| ☐ | GET POST | `/api/v1/resident/sos` | requireResidentPrincipal | etag | safety |

### `store` (13)

| ☐ | Methods | Path | Guard | Notes | Modules |
|---|---|---|---|---|---|
| ☐ | DELETE GET | `/api/v1/store/cart` | requireHostelAdminPrincipal | etag | store |
| ☐ | GET | `/api/v1/store/cart/count` | requireHostelAdminPrincipal | etag | store |
| ☐ | POST | `/api/v1/store/cart/items` | requireHostelAdminPrincipal |  | store |
| ☐ | DELETE PATCH | `/api/v1/store/cart/items/:productId` | requireHostelAdminPrincipal |  | store |
| ☐ | GET | `/api/v1/store/categories` | requireHostelAdminPrincipal | etag | store |
| ☐ | GET | `/api/v1/store/checkout` | requireHostelAdminPrincipal | etag | store |
| ☐ | GET | `/api/v1/store/home` | requireHostelAdminPrincipal | etag | store |
| ☐ | GET POST | `/api/v1/store/orders` | requireHostelAdminPrincipal | etag | store |
| ☐ | GET | `/api/v1/store/orders/:orderId` | requireHostelAdminPrincipal | etag | store |
| ☐ | POST | `/api/v1/store/orders/:orderId/cancel` | requireHostelAdminPrincipal |  | store |
| ☐ | GET | `/api/v1/store/products` | requireHostelAdminPrincipal | etag | store |
| ☐ | GET | `/api/v1/store/products/:handle` | requireHostelAdminPrincipal | etag | store |
| ☐ | GET | `/api/v1/store/shelves` | requireHostelAdminPrincipal | etag | store |

### `team` (16)

| ☐ | Methods | Path | Guard | Notes | Modules |
|---|---|---|---|---|---|
| ☐ | GET | `/api/v1/team/collection-qr` | requireTeamPrincipal | etag | platform-config |
| ☐ | GET | `/api/v1/team/email-check` | requireTeamPrincipal | etag | hostels |
| ☐ | GET | `/api/v1/team/geocode` | requireTeamPrincipal | etag | hostels |
| ☐ | GET POST | `/api/v1/team/hostels` | requireTeamPrincipal | etag | hostels, team |
| ☐ | POST | `/api/v1/team/hostels/:id/checkout` | requireTeamPrincipal |  | billing, team |
| ☐ | DELETE GET PUT | `/api/v1/team/hostels/:id/existing-residents` | in existing-residents.routes.ts |  | residents |
| ☐ | POST | `/api/v1/team/hostels/:id/existing-residents/add` | in existing-residents.routes.ts | max300s | residents |
| ☐ | POST | `/api/v1/team/hostels/:id/existing-residents/file` | in existing-residents.routes.ts |  | residents |
| ☐ | GET | `/api/v1/team/hostels/:id/existing-residents/template` | in existing-residents.routes.ts |  | residents |
| ☐ | GET POST | `/api/v1/team/prepayments` | requireTeamPrincipal | etag | hostels, team |
| ☐ | GET PATCH | `/api/v1/team/prepayments/:id` | requireTeamPrincipal | etag | team |
| ☐ | GET PUT | `/api/v1/team/registration-track-sheet` | requireTeamPrincipal | etag | team |
| ☐ | POST | `/api/v1/team/registration-track-sheet/focus` | requireTeamPrincipal |  |  |
| ☐ | GET | `/api/v1/team/setup-fee` | requireTeamPrincipal | etag | platform-config |
| ☐ | GET | `/api/v1/team/summary` | requireTeamPrincipal | etag | team |
| ☐ | GET | `/api/v1/team/wallet` | requireTeamPrincipal | etag | team |

### `usage` (1)

| ☐ | Methods | Path | Guard | Notes | Modules |
|---|---|---|---|---|---|
| ☑ | POST | `/api/v1/usage/events` | rateLimitPublicForm, requireApiPrincipal |  | usage |

### `users` (11)

| ☐ | Methods | Path | Guard | Notes | Modules |
|---|---|---|---|---|---|
| ☐ | GET | `/api/v1/users/:userId/avatar` | requireApiPrincipal |  | users |
| ☐ | GET POST | `/api/v1/users/account-deletion` | requireApiPrincipal | etag | users |
| ☐ | GET POST | `/api/v1/users/expert-consultation-requests` | requireApiPrincipal | etag | expert-consultation |
| ☐ | GET PATCH PUT | `/api/v1/users/resident-identity` | requireApiPrincipal | etag | users |
| ☐ | GET | `/api/v1/users/resident-identity/email-check` | rateLimitPublicForm, requireApiPrincipal | etag | users |
| ☐ | GET | `/api/v1/users/resident-identity/phone-check` | rateLimitPublicForm, requireApiPrincipal | etag | users |
| ☐ | DELETE GET PUT | `/api/v1/users/resident-identity/photo` | requireApiPrincipal |  | users |
| ☐ | GET | `/api/v1/users/resident-identity/qr` | requireApiPrincipal | etag | users |
| ☐ | GET | `/api/v1/users/resident-identity/signature` | requireApiPrincipal |  | users |
| ☐ | GET POST | `/api/v1/users/temporary-credentials` | requireApiPrincipal, assertPrimaryCredentialPrincipal, rateLimitAuthAttempts | etag | auth |
| ☐ | DELETE | `/api/v1/users/temporary-credentials/:id` | requireApiPrincipal, assertPrimaryCredentialPrincipal |  | auth |

### `webhooks` (2)

| ☐ | Methods | Path | Guard | Notes | Modules |
|---|---|---|---|---|---|
| ☐ | POST | `/api/v1/webhooks/:provider` | public |  | finance |
| ☐ | POST | `/api/v1/webhooks/softmato` | public |  | billing |


---

## 7. Models (collections)

Same collections, same field names, same indexes. ☑ when the Go struct exists, every Mongoose default/hook/virtual/enum for it is reproduced (DATABASE.md §3), and a document written by Go reads back identically in TS and vice versa.

**146 models.**

| ☐ | Model | ☐ | Model | ☐ | Model |
|---|---|---|---|---|---|
| ☐ | `AccountDeletionRequest` | ☐ | `AdmissionForm` | ☐ | `AdmissionFormLink` |
| ☐ | `ApiUsageCounter` | ☐ | `AttendanceAlert` | ☐ | `AttendanceLog` |
| ☐ | `AuditLog` | ☐ | `AuthAttempt` | ☐ | `Booking` |
| ☐ | `BookingPayment` | ☐ | `BookingTransfer` | ☐ | `CommunityComment` |
| ☐ | `CommunityCommentVote` | ☐ | `CommunityPost` | ☐ | `CommunityReaction` |
| ☐ | `CommunityReport` | ☐ | `Complaint` | ☐ | `ComplaintAttachment` |
| ☐ | `ComplaintUpdate` | ☐ | `ConsentLog` | ☐ | `CookAccount` |
| ☐ | `CreditBalance` | ☐ | `DepositRecord` | ☐ | `DepositRefund` |
| ☐ | `DeviceToken` | ☐ | `DuplicateCheckResult` | ☐ | `EmailPreference` |
| ☐ | `EmergencyContact` | ☐ | `EncryptedSecret` | ☐ | `ExistingResidentList` |
| ☐ | `Expense` | ☐ | `ExpertConsultationRequest` | ☐ | `Feedback` |
| ☐ | `FeeSchedule` | ☐ | `FileAsset` | ☐ | `finance-fields` |
| ☐ | `FoodFeedback` | ☐ | `FoodPhoto` | ☐ | `FoodReadyLog` |
| ☐ | `FoodRoutine` | ☐ | `FreePlanClaim` | ☐ | `Guardian` |
| ☐ | `GuardianAccess` | ☐ | `GuardianPermission` | ☐ | `Hostel` |
| ☐ | `HostelAgreement` | ☐ | `HostelAgreementSignature` | ☐ | `HostelApplication` |
| ☐ | `HostelBackup` | ☐ | `HostelBackupRun` | ☐ | `HostelDocument` |
| ☐ | `HostelExpenseCategory` | ☐ | `HostelLeaveRequest` | ☐ | `HostelListingImpression` |
| ☐ | `HostelMember` | ☐ | `HostelPageView` | ☐ | `HostelPaymentProfile` |
| ☐ | `HostelPayoutAccount` | ☐ | `HostelReferral` | ☐ | `HostelReferralCode` |
| ☐ | `HostelRoom` | ☐ | `HostelSettings` | ☐ | `HostelSubscription` |
| ☐ | `HostelVerification` | ☐ | `IncidentLog` | ☐ | `Inquiry` |
| ☐ | `InquiryNote` | ☐ | `Invoice` | ☐ | `InvoiceBalance` |
| ☐ | `KhataEntry` | ☐ | `ListingFlag` | ☐ | `MaintenanceComment` |
| ☐ | `MaintenanceHistory` | ☐ | `MaintenanceRequest` | ☐ | `ManualStatusOverride` |
| ☐ | `MealCallReminder` | ☐ | `MoveInChecklist` | ☐ | `MoveOutChecklist` |
| ☐ | `NightStatus` | ☐ | `NightStatusLog` | ☐ | `NightStatusPrompt` |
| ☐ | `Notice` | ☐ | `NoticePush` | ☐ | `NoticeReadStatus` |
| ☐ | `Notification` | ☐ | `NotificationCampaign` | ☐ | `NotificationPreference` |
| ☐ | `OAuthAccount` | ☐ | `OfferAward` | ☐ | `OfferPerk` |
| ☐ | `OtpChallenge` | ☐ | `PaymentEvent` | ☐ | `PaymentIntent` |
| ☐ | `PlatformAdminInvite` | ☐ | `PlatformBackupReport` | ☐ | `PlatformDocumentSequence` |
| ☐ | `PlatformPushSchedule` | ☐ | `PlatformSetting` | ☐ | `PlatformSettingChange` |
| ☐ | `ProvidedItem` | ☐ | `PushTicket` | ☐ | `QRActivation` |
| ☐ | `QuestionCallClick` | ☐ | `RatingReview` | ☐ | `Receipt` |
| ☐ | `ReceiptCounter` | ☐ | `ReconciliationRun` | ☐ | `Referral` |
| ☐ | `ReferralCode` | ☐ | `ReferralReward` | ☐ | `RentConcession` |
| ☐ | `Resident` | ☐ | `ResidentApplication` | ☐ | `ResidentDocument` |
| ☐ | `ResidentJoinLink` | ☐ | `ResidentLeave` | ☐ | `ReviewModerationLog` |
| ☐ | `RolePermission` | ☐ | `RoomChangeRequest` | ☐ | `RoomConditionPhoto` |
| ☐ | `ServiceProvider` | ☐ | `ServiceProviderApplication` | ☐ | `ServiceProviderDocument` |
| ☐ | `Session` | ☐ | `SoftmatoDocument` | ☐ | `SoftmatoTask` |
| ☐ | `SOSAlert` | ☐ | `Sponsor` | ☐ | `StatementImport` |
| ☐ | `StockEntry` | ☐ | `StockItem` | ☐ | `StockPayment` |
| ☐ | `StockSupplier` | ☐ | `StoreCart` | ☐ | `StoreCategory` |
| ☐ | `StoreOrder` | ☐ | `StoreProduct` | ☐ | `SubscriptionInvoice` |
| ☐ | `SubscriptionPayment` | ☐ | `TeamPrepayment` | ☐ | `TeamWalletEntry` |
| ☐ | `TemporaryCredential` | ☐ | `UsageDaily` | ☐ | `UsageEvent` |
| ☐ | `User` | ☐ | `UserResidentProfile` |  |  |

---

## 8. Email templates

Every template in `packages/shared/src/email/templates/`. Ported to Go
`html/template` + text part. ☑ only when a golden test shows the Go output
matches the TS output for the same input (subject, HTML, text, headers).

| ☐ | Template |
|---|---|
| ☐ | `account/deletion-cancelled.ts` |
| ☐ | `account/deletion-requested.ts` |
| ☐ | `account/id-card-issued.ts` |
| ☐ | `auth/account-upgraded.ts` |
| ☐ | `auth/credentials-issued.ts` |
| ☐ | `auth/otp-code.ts` |
| ☐ | `auth/password-reset.ts` |
| ☐ | `auth/verification.ts` |
| ☐ | `billing/plan-due.ts` |
| ☐ | `billing/plan-suspension-notice.ts` |
| ☐ | `billing/subscription-claim-received.ts` |
| ☐ | `billing/subscription-claim-rejected.ts` |
| ☐ | `billing/subscription-invoice.ts` |
| ☐ | `billing/subscription-receipt.ts` |
| ☐ | `booking/guest.ts` |
| ☐ | `booking/hostel.ts` |
| ☐ | `booking/parts.ts` |
| ☐ | `booking/payout-account.ts` |
| ☐ | `booking/platform.ts` |
| ☐ | `cook/credentials.ts` |
| ☐ | `cook/invitation.ts` |
| ☐ | `guardian/invitation.ts` |
| ☐ | `guardian/sos-alert.ts` |
| ☐ | `guardian/ward-registered.ts` |
| ☐ | `hostel/cook-portal-enabled.ts` |
| ☐ | `hostel/documents-requested.ts` |
| ☐ | `hostel/hostel-approved.ts` |
| ☐ | `hostel/hostel-kyc.ts` |
| ☐ | `hostel/hostel-leave.ts` |
| ☐ | `hostel/hostel-published.ts` |
| ☐ | `hostel/hostel-referral-invite.ts` |
| ☐ | `hostel/hostel-registered-by-team.ts` |
| ☐ | `hostel/hostel-rejected.ts` |
| ☐ | `hostel/hostel-unpublished.ts` |
| ☐ | `hostel/hostel-verified.ts` |
| ☐ | `hostel/inquiry-received.ts` |
| ☐ | `hostel/owner-email-changed.ts` |
| ☐ | `hostel/staff-alerts.ts` |
| ☐ | `hostel/submission-received.ts` |
| ☐ | `layout.ts` |
| ☐ | `payment/gateway-unhealthy.ts` |
| ☐ | `payment/payment-due-reminder.ts` |
| ☐ | `payment/payment-overdue.ts` |
| ☐ | `payment/payment-rejected.ts` |
| ☐ | `payment/payment-reversed.ts` |
| ☐ | `payment/payment-verified.ts` |
| ☐ | `platform/account-deletion-review.ts` |
| ☐ | `platform/admin-invitation.ts` |
| ☐ | `platform/new-hostel-pending.ts` |
| ☐ | `platform/setting-change-confirm.ts` |
| ☐ | `platform/team-requests.ts` |
| ☐ | `resident/complaint-resolved.ts` |
| ☐ | `resident/complaint-status-updated.ts` |
| ☐ | `resident/existing-resident-added.ts` |
| ☐ | `resident/join-request-returned.ts` |
| ☐ | `resident/new-notice.ts` |
| ☐ | `resident/offer-awarded.ts` |
| ☐ | `resident/qr-activation.ts` |
| ☐ | `resident/resident-access-cleared.ts` |
| ☐ | `resident/resident-linked.ts` |
| ☐ | `resident/resident-registered.ts` |
| ☐ | `service-provider/provider-approved.ts` |
| ☐ | `service-provider/provider-rejected.ts` |
| ☐ | `service-provider/registration-received.ts` |
| ☐ | `store/items-table.ts` |
| ☐ | `store/store-order-placed-buyer.ts` |
| ☐ | `store/store-order-received-platform.ts` |
| ☐ | `store/store-order-status-buyer.ts` |

---

## 9. Web pages that call server code directly

These Next.js files import `@/modules/*` or `@hostel/db` and run Mongo queries
inside the web process. Once the web is a pure client of the API they must fetch
from the Go API instead (server-side `fetch` to `API_URL` with
`next: { revalidate }` where the page is public). ☑ when the file no longer
imports `@/modules/*` or `@hostel/db`.

| ☐ | File (under `apps/web/src/app/`) |
|---|---|
| ☐ | `(hostel-admin)/[hostelSlug]/admin/layout.tsx` |
| ☐ | `(public)/community/[postId]/page.tsx` |
| ☐ | `(public)/features/[module]/page.tsx` |
| ☐ | `(public)/hostels/[slug]/load-hostel.ts` |
| ☐ | `(public)/how-booking-works/page.tsx` |
| ☐ | `(public)/layout.tsx` |
| ☐ | `(public)/page.tsx` |
| ☐ | `(public)/plans-pricing/[service]/page.tsx` |
| ☐ | `(public)/plans-pricing/badge/[tier]/page.tsx` |
| ☐ | `(public)/plans-pricing/page.tsx` |
| ☐ | `(public)/refund-policy/page.tsx` |
| ☐ | `(public)/service-providers/page.tsx` |
| ☐ | `(public)/vs/[slug]/page.tsx` |
| ☐ | `_components/admission-forms-panel.tsx` |
| ☐ | `_components/booking-checkout-page.tsx` |
| ☐ | `_components/branch-registration-form.tsx` |
| ☐ | `_components/checkout-return-page.tsx` |
| ☐ | `_components/existing-residents-panel.tsx` |
| ☐ | `_components/existing-residents-sheet.tsx` |
| ☐ | `_components/hostel-admin-billing-page.tsx` |
| ☐ | `_components/hostel-admin-bookings-page.tsx` |
| ☐ | `_components/hostel-admin-fee-schedule-page.tsx` |
| ☐ | `_components/hostel-admin-pay-plan.tsx` |
| ☐ | `_components/hostel-admin-proof-review-modal.tsx` |
| ☐ | `_components/hostel-admin-review-queue.tsx` |
| ☐ | `_components/hostel-admin-stock-page.tsx` |
| ☐ | `_components/hostel-admin-wardens-page.tsx` |
| ☐ | `_components/hostel-booking-requests-reminder.tsx` |
| ☐ | `_components/hostel-branch-detail-page.tsx` |
| ☐ | `_components/hostel-payout-account-panel.tsx` |
| ☐ | `_components/hostel-short-stays-panel.tsx` |
| ☐ | `_components/lifetime-deal.tsx` |
| ☐ | `_components/my-bookings-page.tsx` |
| ☐ | `_components/plan-checkout-page.tsx` |
| ☐ | `_components/plans-catalog.ts` |
| ☐ | `_components/platform-bookings-page.tsx` |
| ☐ | `_components/platform-config-content-page.tsx` |
| ☐ | `_components/platform-config-lifetime-tab.tsx` |
| ☐ | `_components/platform-config-seo-page.tsx` |
| ☐ | `_components/platform-config-shared.tsx` |
| ☐ | `_components/platform-subscription-claims.tsx` |
| ☐ | `_components/platform-subscriptions-page.tsx` |
| ☐ | `_components/platform-usage-page.tsx` |
| ☐ | `_components/public-booking-guide-page.tsx` |
| ☐ | `_components/public-hostel-detail-page.tsx` |
| ☐ | `_components/public-refund-policy-page.tsx` |
| ☐ | `_components/public-software-pages.tsx` |
| ☐ | `_components/registration-track-sheet.tsx` |
| ☐ | `_components/resident-join-page.tsx` |
| ☐ | `_components/resident-join-panel.tsx` |
| ☐ | `_components/team-desk-page.tsx` |
| ☐ | `_components/team-register-hostel-page.tsx` |
| ☐ | `email-preferences/page.tsx` |
| ☐ | `pay/[reference]/page.tsx` |
| ☐ | `sitemap.ts` |
| ☐ | `verify-receipt/page.tsx` |

---

## 10. Scripts and one-off jobs

These are the `apps/web` npm scripts. Each needs a decision, not a port by
default; the TS copies keep working against the same database until the web
stops holding server code.

| ☐ | Script(s) | Decision |
|---|---|---|
| ☐ | `db:indexes` (autoIndex is off — indexes are a migration) | port: `cmd/indexes`; Go owns indexes after cut-over |
| ☑ | `seed:platform-owner`, `seed:demo`, `seed:fee-schedules`, `seed:community(:clean)`, `seed:store(:clean)` | **not ported** (user, 2026-10-29): local data is a copy of the live database (`deploy/copy-live-db.ps1`); the TS seeds stay where they are |
| ☐ | `recover:admin`, `rotate:finance-key`, `verify:finance-ledger`, `check:private-documents`, `check:softmato`, `sync:plan-services` | port: `cmd/ops` subcommands — operations still needed after cut-over |
| ☐ | `generate:vapid`, `dev:mint-session`, `send:test-emails` | port: `cmd/dev` subcommands |
| ☐ | `audit:test-data`, `purge:test-data` | port when next needed |
| ☐ | `evidence:fixtures`, `evidence:score` | port with the evidence pipeline |
| ☐ | `check:public-registration`, `check:team-registration`, `deploy:check` | replace with Go contract/smoke tests |
| ☐ | `build:paper-agreement`, `upload:agreement-seals` | stay in TS (offline tools) |
| ☐ | every `migrate:*`, `backfill:*`, `repair:*`, `fix:*`, `compare:clusters`, `migrate:cluster` | one-offs, already run — do not port |

---

## 11. Cut-over checklist

Ticked in order; each depends on the one above.

| ☐ | Step |
|---|---|
| ☐ | Every row in §3–§9 is ☑ at the current baseline |
| ☐ | TS server sets auth cookies with `Domain=.hostelpalika.com` (widening release), live long enough for active sessions to refresh |
| ☐ | Go live on the Kathmandu VPS at `api.hostelpalika.com`, warm, every route contract-green against production Atlas |
| ☐ | Web `NEXT_PUBLIC_API_URL` / `API_URL` = `https://api.hostelpalika.com` with the `/api/*` rewrite on; app + PWA base URL switched (OTA if the fingerprint allows, else native build) |
| ☐ | cron-job.org: every job disabled |
| ☐ | Upstash Redis removed from env |
| ☐ | Rollback window closed: Caddy `BACKEND=ts` removed |
| ☐ | `apps/web/src/app/api/v1/**`, `apps/web/src/modules/**` and server-only `lib` files deleted from the web |
| ☐ | Web has no `MONGODB_URI` |
| ☐ | `server/` removed from `.gitignore` and committed |
