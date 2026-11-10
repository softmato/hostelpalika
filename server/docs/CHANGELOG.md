# CHANGELOG.md — server/

Newest first. One entry per closed phase gate, plus any decision that changes
these docs.

## [Block an account; blocked accounts get no session] — 2026-11-09

- `PATCH/DELETE /api/v1/platform/users/:id/block` (superadmin, both servers): status SUSPENDED,
  `tokenVersion` bump, sessions deleted, `USER_BLOCKED`/`USER_UNBLOCKED` audit. Platform admins
  are refused (Admins' revoke owns them). Used by the web Users panel and the app's Users sheet.
- `issueSession` refuses SUSPENDED/ARCHIVED with 401 `USER_INACTIVE` on both servers, so a
  temporary login, activation or residency invite can no longer open a blocked account (P11-31).

## [Free plan: one rule, over-limit grace, read-only] — 2026-11-09

Owner decision: every hostel without a live paid plan is on Free, and Free's caps always hold.

### Changed (Go and TS)
- `planState` / `planState()`: live paid plan (period not over, or lifetime) → its caps; running
  trial → none; no plan and no trial (pre-trial hostels) → none; everything else → Free.
- A lapsed paid plan no longer schedules `PLAN_OVERDUE`; it falls to Free. The sweep clears
  `TRIAL_ENDED` and `PLAN_OVERDUE` blocks left from before. `PLAN_PAYMENT` (platform admin) stays.
- `Hostel.planLimit { overSince, readOnlyFrom }`: stamped when a Free hostel is over its caps,
  read-only after `plans.free.overLimitGraceDays` (default 7), cleared once back within them.
  Refreshed by the daily renewal sweep, by `GET /hostel-admin/billing/usage`, and by the gate.
- Gate: 423 `PLAN_OVER_LIMIT` on hostel-admin writes past the grace, except billing/KYC/settings
  (as after a trial) and what reduces usage (move-out, status, deleting a resident/warden/cook).
  Re-checked before refusing, so paying or a move-out lifts it on the next request.
- New route `GET /api/v1/hostel-admin/billing/usage`; contract case hand-checked (the TS recorder
  could not start beside a running `next dev`).

### UI
- Web + app: usage meters and a "which plan fits" chooser on Billing, an over-limit banner
  (web: every hostel-admin screen; app: Home + Billing), and one dialog/sheet for
  `PLAN_LIMIT_REACHED` / `PLAN_OVER_LIMIT` with Compare plans.

## [Free plan] — 2026-11-09

Owner decision: a free-forever tier, like ChatGPT/Claude. `plans.free` in the site config
(name, badge, copy, button, caps; default 10 residents / 1 warden / 1 cook), edited in
Website Config → Plans & Pricing and drawn as a full-width row under the paid cards (web + app).

### Changed (Go and TS)
- A trial that ends without a paid plan drops to the free caps (`capsFor` / `planForCaps`)
  instead of a `TRIAL_ENDED` suspension. KYC approval no longer writes one; the renewal
  sweep clears any left from before. `TRIAL_ENDED_KYC` (KYC not approved) is unchanged.
- Trial-ending email and bell say the hostel moves to Free.
- `testdata/vectors/*.ts` import paths fixed (platform-config defaults moved to `lib/`).

## [Pre-cut-over check — server side through Phase 11] — 2026-11-05

Every tracker tick re-checked against the code (`READINESS.md`, re-check section).

### Fixed
- CI: two contract recordings stale after P11-19, one clock-dependent dashboard series, 7 staticcheck findings (P11-24).
- P11-16 (security), P11-17 (latency), P11-18 (low) closed in Go and in TS where shared.
- P11-22 unescaped name in the Softmato "server is back" email (Go and TS); P11-23 three Go booking emails drawn unlike TS.

### Added
- `cmd/ops`: `recover-admin`, `rotate-finance-key`, `verify-finance-ledger`, `check-private-documents`, `sync-plan-services`, `check-softmato`; `cmd/dev`: `generate-vapid`, `mint-session`, `send-test-emails` (P11-25). `ops` ships in the image.
- Byte-for-byte goldens for all 95 email templates (`emails-all.ts`, `TestEveryTemplateMatchesTS`).
- Second Redis for cached bodies (`redis-cache`, `REDIS_CACHE_URL`), `REDIS_PASSWORD` on both.
- Spare-cluster test runs: `CONTRACT_MONGO_URI`, `ALLOW_DEV_ATLAS_HOST`; `copy-live-db.ps1 -TargetEnv`.

### Docs
- `PARITY.md` §2–§8 and §10 ticked from code (279 rows); §9 (web pages) and §11 (cut-over) stay open.

## [Phase 9 — done] — 2026-11-04

### Added
- Every job in `PARITY.md` §5 runs in-process: `router/jobs.go` registers all 19 on the route instances (`jobHosts`), with their TS deadlines and success messages; heavy jobs share one slot. `cmd/api` builds the runner, ensures the `cronruns` indexes, closes stale runs at boot, schedules when `SCHEDULER_ENABLED=true` and drains runs on shutdown.
- Payment reminders complete: the dunning ladder (`ledger/dunning.go`, `NextDunningAction` + `RunPaymentReminders`, one rent email per resident per run, escalation email per hostel), the admins' morning payment digest, and move-out reminders (`residentportal/leaving_reminders.go`). Emails `PaymentDueReminder`, `PaymentOverdue` (golden vectors with `UnpaidFees`).
- Automatic platform-push rows (PLAN_DUE, FEE_DUE, FREE_MONTH) wired to their senders; platform-push also sweeps bookings and retries Softmato tasks (BOOKING_PAYMENT, REFUND_FILING).
- Web: Cron tab under *System* (`/platform/system/cron`).
- Gate: `dev shadow-phase9` — zero drift on all 19 jobs (PHASES.md Phase 9).

### Fixed
- P9-1 (attendance retention purge skipped in hostels with no active residents) in Go and TS; P9-2..P9-4, Go only. P9-5 (TS notification emails dropped the template category) fixed in TS.

## [Phase 7 — done] — 2026-11-04

### Added
- Contract groups recorded from TS (`2bcde4d2`) and green on Go: `admin-finance` (claim queue, approve, reject, bulk-approve, reverse, cash, void, receipt PDF; fixture group 16), `admin-branches` (list, names, summary, details, a real branch request; group 17), `admin-notice-pushes` (seeded default, create now/later/daily, pause, resume, send, delete; group 18), `cron` (no-secret and wrong-secret refusals on all 19 doors, the bearer form, a real `purge-expired-otps` run, `platform-backup` 422, plus the Softmato webhook and QuestionCall doors), `store/cart.json` (cart clear and item removal) and `team/existing-write.json` (geocode refusals, existing-residents put, file, add, clear). With the 267 rows ticked earlier, every `PARITY.md` §6 row is ☑; the five `(non-v1)` routes stay in Next.js.
- App: superadmin shell `app/(platform)` (Home with the System tiles, Community, More), built from `PLATFORM_NAV`; SUPERADMIN lands there instead of the browse app (moderators keep browsing until they have native screens). Native `manage/system/logs`, `process`, `cron`, `active-users`, `analytics`, on `lib/platform-api.ts`. They read the Go-only routes, so they answer from cut-over on.
- PWA usage client through a web stand-in (`apps/mobile/web/usage-client.ts`), replacing a `Platform.OS` branch in `src/`.

### Fixed
- P7-44 (money): `appendEvent` deduped only through the unique index, so a database without it settled the same paper cash slip twice. Go and TS look the idempotency key up first; the index stays the race guard.
- P7-45, P7-46 (Go only): the cash answer's `receipt` shape and the receipt PDF's malformed-id 404.

### Left
- On-device check of the platform shell after the owner's OTA; the first real `pwa` row in `usageevents` once the PWA export is redeployed.

## [Phase 7 — progress] — 2026-11-03

### Added
- `platform/bookings/*` (`bookings/platform.go`): the queues with every count, one booking, cancel for the platform, pause and resume a hostel, screenshot review, transfers (list, mark sent, reveal), payout accounts (list with same-number twins, audited reveal, review; `hostels/payout_platform.go`), the booking terms through the email-confirmed setting change, and any booking paper for a superadmin (`serveDocument`, shared with the booker's route). Contract group `platform-bookings` (7 files), green; `team/register` and `team/members` recorded and green.
- Emails: `BookingPaymentRejected`, `BookingRefundSent`, `BookingPayoutSent`, `PayoutAccountReviewed`.
- System tabs (Go-only, `goOnlyAllowed`): `GET /platform/logs/health` (`obs.ReadHealth`: request rate, p95 from the histogram buckets, error rate, Mongo pool, cache hit rate, rate-limit refusals, since boot), `GET /platform/system/process`, `GET /platform/system/active-users` (DAU/WAU/MAU per Kathmandu day over `usageevents`). Web: `/platform/logs`, `/platform/system/process`, `/platform/system/active-users`, `/platform/analytics` under *System*.
- Fixed: P7-31 and P7-33 in Go and TS, P7-32 in Go (TS was right), P7-34 in Go and TS.


## [Phase 8 — done] — 2026-11-03

Started beside Phase 7 (owner's call); the two sessions split `billing` by file.

### Added
- `POST /integrations/questioncall/sso` and `/conversion` (package `questioncall`): shared secret header, constant-time compare, 503 when unset.
- `POST /webhooks/softmato` (`billing/webhook.go`): HMAC over the raw bytes, five-minute window, pinned to the SDK's `SHARED_VECTOR`; idempotent on the transaction number. Plan invoices settle through `billing.Settler.SettlePayment` (TS `settlePayment`: receipt number, Softmato receipt read, invoice status, team commission, lifetime, renewal plan switch, plan period, publish, suspension lift, referral go-live, owner access hook, receipt email for money Softmato never saw, audit). Booking fees settle through `bookings.Signed.SettleFromSoftmato` / `MarkPaid`; team prepayments through `Settler.MarkTeamPrepaymentPaid`.
- Hostel referral go-live rewards (`hostelreferrals.Service.GoLive`, TS `settleHostelReferrals`).
- Softmato client: `GetReceipt`, invoice `status` and `payments`. Email: `SubscriptionReceipt`, `BookingPaymentVerified`, `BookingRequest`.
- Verified: unit tests on the webhook signature (SDK vector) and money parsing; an integration test against local Mongo (settles once on a duplicate delivery, suspension lifted, SYSTEM audit, prepayment and unknown-number branches); `TestRoutesMatchWeb`, `TestAnonymousIsRefused`.
- Fixed: P8-1 in Go and TS; P8-2..P8-4 in Go (`review_fixes_needed.md`).

### Added (late 2026-11-03)
- Gateway stack (`modules/gateway`): eSewa/Khalti adapters, intents, `POST /resident/finance/invoices/:id/checkout`, `GET /resident/finance/checkout/:reference`, `POST /webhooks/:provider`.
- `bookings/:id/checkout|payment|return` (`bookings/checkout.go`); booking creation raises the Softmato invoice straight away instead of the placeholder retry task.
- `hostel-registration/*` (5) and `team/hostels/:id/checkout` (`hostels/registration_billing.go`); `billing.Settler.ReadReturnState` and `Reconcile` (TS `readReturnState`, `reconcileInvoiceFromSoftmato`).
- `POST /public/plan-checkout` (`billing/plancheckout.go`): email + Hostel ID → OTP (resumes inside the resend cooldown) or signed pay link → one-hour token → invoice/months/resume/pay/claim. `billing/renewal.go`: `RaiseRenewalInvoice` with defer/reshape, `ChangeOpenInvoiceMonths`, `InvoiceMonthsLocked`, `PlanAfterPayment`; the portal's renew button now goes through it.
- `team/prepayments` (4, `billing/prepayment.go` + `hostels/team_prepayments.go`); `IssueSubscriptionInvoice` / `IssueSetupFeeInvoice` take a prepaid document; the team registration publishes on a paid online prepayment (claim before writing, release on failure).
- Contract group `billing-online` (71 cases) with its fixture.
- Fixed in Go and TS: P8-5 (eSewa callbacks never resolved), P8-6 (a died-midway gateway verify never settled), P8-7 (booking screenshot left in review with no row). Also fixed: the account and admin `hostel-leave` handlers had no background runner, so records were never rebuilt.

### Closed
- Gateway jobs in Go (`gateway/jobs.go`): `RunGatewayHealth` (verdict, profile health fields, admin in-app + `email.GatewayUnhealthy`, 24 h renotify) and `RunSettlementRecon` (14-day recheck of closed attempts, succeeded ↔ event checks). `ExpireStale` was already there. Reconciliation run rows through the new `modules/recon.WithRun`. Phase 9 schedules them and adds their `/cron/*` doors.
- Gate: `dev shadow-phase8` on a live-data copy — zero drift (PHASES.md Phase 8).
- P8-8 fixed in Go and TS: plan settlement checks the invoice before claiming the payment; Go writes the money rows in one transaction (closes R28).
- `payment-gateways` / `payment-profile` ticked: already covered by `admin-reports/finance-gateways.json`.

## [Phase 6 — done] — 2026-11-03

### Closed
- Resident identity: `/users/resident-identity` (profile, sharing, QR, email and phone checks, photo, signature), `/users/:userId/avatar`, the first-card email (`email.IDCardIssued`, `idcard.Render`). Contract group `account-identity`.
- RES-16: intake and the existing-residents add make the ID card from the admission form (or a draft the editor opens).
- R31: `account/saved-hostels`; referral-code preview `coverUrl`.
- Fixed in Go and TS: FIN-9 (a month discount is its own CREDIT line, backfill base is rent only), FIN-13 (assign and settle in one transaction; `InTx` joins an open one), PLAN-1 (partial unique index on an in-review claim).
- TS fixes owed by the bug rule: FIN-2, FIN-3, FIN-4, FIN-5, FIN-5b, FIN-7, FIN-12, PERF-1, R28 billing run (`lib/transaction.ts`, `transactionAsyncLocalStorage`).
- Contract cases whose figures follow the clock (stock projections, plan days left, bare days) are masked; `**dates` now covers `YYYY-MM-DD`.

### Owner step
- `npm --prefix apps/web run db:indexes` on production, for PLAN-1's index. It refuses to build if one invoice already has two claims `IN_REVIEW`.

## [Phase 6 — in progress] — 2026-11-02

### Added
- Finance statements: import (eSewa, Khalti, bank; CSV, `.xlsx` and legacy `.xls`), the matching ladder and scoring, reconciliation buckets, approve-matched, assign orphan, ask resident. A small BIFF8 reader (`finance/xlsread.go`) reads `.xls`, because `extrame/xls` could not open the eSewa app's own export.
- Reports: account statement PDF and all-branches PDF (cover table, then each branch's pages).
- Fixed in Go and TS: a failed row no longer ends a statement import (FIN-11). All Phase 6 findings so far are in `review_fixes_needed.md`.

- Residents: roll, record, contacts, photo, guardians, forms and Form QR, leave, move-in/out, write-off, activation codes, status change (links or returns the login, bills the move-in month), intake `POST /residents` (duplicate and live-residency checks, plan limit, room claim, held booking check-in, referral link, admission and first-month invoices, account link, registration notices and mail, pay methods), bookings admin (6), resident-scan (2), resident-lookup (1). Contract groups `admin-residents-roll` and `admin-residents-intake`.
- Fixed in Go and TS: RES-14, RES-15, BKG-1.

- Existing-residents list (list, save, clear, Excel/CSV file, template, add all, add one), join link and join requests (link, list, add, send back). Contract group `admin-residents-existing`. `TestRoutesMatchWeb` now reads `export const { GET } = x.y` re-exports, which hid 17 TS routes.

### Still to do in Phase 6
- RES-16 (the ID card made from the form at intake), the field-team copies of the existing-residents routes (with the team group); then the review, run separately.

## [Review of Phases 0–5] — 2026-11-01

### Decided by the owner
- `MISSION.md` holds the binding brief. A TS bug is fixed in Go and in TS, never copied (`RULES.md` §2). Routes match the web exactly. Logs, categories and levels are visible in the superadmin portal (Phase 7). `RULES.md`, `PHASES.md` and `README.md` changed to match.
- Phases: new Phase 10 (production grade, measured), cut-over is now Phase 11.
- All repo work is Claude's, with full permission, including the CI push. Outside work: Claude does what it can reach, and the owner mostly helps or does the rest (`MISSION.md` addition 4).

### Fixed (`review_fixes_needed.md`)
- Bodies capped, every request has a deadline, background work bounded with a deadline, no bare goroutines in fan-out, DB faults no longer sign people out, limiter has an IP-wide budget, garbage token is a 401, client mistakes are 4xx, guardian PATCH keeps the keys it was not sent, security headers on, sponsor impressions count every sponsor.
- `TestRoutesMatchWeb` and `TestAnonymousIsRefused` guard paths and auth for every route to come.

### New dependency
- `prometheus/client_golang`: `MISSION.md` §11 needs latency distributions, pool use and Go runtime metrics, and writing histograms and the exposition format by hand would be more code to maintain than this one library. Served on `METRICS_ADDR`, never published.

## [Phase 5] — 2026-11-01

### Gate
- Resident, guardian and cook surfaces replay green against TS recordings on Go only, `go test -race -tags=sonic ./...` clean.
- Gateway checkout for residents moved to Phase 8 with the booking checkout routes. Until then a resident on Go pays by QR and sends proof.

### Added / Changed
- Signed-in bookings: create, list, detail, cancel, quote, documents. Email attachments in the sender. Rows written by cancel and create diffed against TS field by field; that diff caught money landing as `NumberLong` where JS writes int32.
- `platform/idcard`: ID card PNGs with embedded Inter as outlines plus a GPOS pair-kerning reader, because `x/image` reads only the legacy `kern` table and lines wrapped at a different word without it.
- New TS-generated goldens: `testdata/vectors/bookings.ts`, `testdata/vectors/idcards.ts`; booking templates added to `emails.ts`.

### Parity
- Baseline moved: `8e965ad8` → `6281d03d`.
- `bs.FormatDate` now prints `Baisakh 15, 2083 BS`, following the uncommitted change in `packages/shared/src/calendar/bs.ts`. Other uncommitted TS backend files are not yet reviewed against Go: the baseline diff will show them once they are committed.
- TS bugs kept as spec, to fix in TS first: batched notification `createdAt` is stripped by Mongoose; `GET /resident/finance/receipts/x/pdf` answers 500 on a malformed id; `PATCH /resident/guardians/:id` writes false for omitted permissions.

---

## [Unreleased]

### 2026-11-01 — Phase 4 code: cookie domain, one API setting, CORS

Phase 3 gate re-checked with Mongo + Redis up. `COOKIE_DOMAIN` (TS + Go), `NEXT_PUBLIC_API_URL`
through `apps/web/src/lib/api-url.ts`, flagged `/api/v1` rewrite, `httpx.CORS`. Everything is off
until its env value is set, so behaviour today is unchanged. Open: `COOKIE_DOMAIN` on Vercel + deploy.

### 2026-10-29 — Host is Kathmandu; clients switch at cut-over

- API + Redis (one compose) on a Kathmandu VPS, not Mumbai. Web stays on Vercel
  `bom1`, Atlas in Mumbai — both are cross-border hops, so reads are
  Redis-first and public/static data is warmed into Redis at boot (`s:*`).
- Web + app stay on TS at `hostelpalika.com` until Go is production-grade, then
  switch to `api.hostelpalika.com` in one step. Caddy `BACKEND=ts` is the
  rollback lever only; Phase 4 no longer points clients at the API host early.
- Atlas stays in Mumbai (no managed database from Nepal VPS providers). Jobs:
  cursor batches, streamed uploads, one shared slot for heavy jobs (§8).

### 2026-10-29 — Redis decision changed

- Go uses its own in-compose Redis in production from day one; Upstash is off
  the Go request path (latency). No cross-server cache sync: the
  two servers never serve live traffic together (ARCHITECTURE.md §11).
  ARCHITECTURE.md §5, ENVIRONMENT.md, PHASES.md updated.

## [Phase 2] — 2026-10-29

### Gate
- Every Phase 2 library is held to output the TS code itself produced:
  `node_modules/.bin/jiti server/testdata/vectors/generate.ts` writes
  `testdata/vectors/*.json`, `testdata/golden/pdf/*` and the generated tables
  (`bs/table.go`, `plans/defaults.json`, `realtime/topics.json`, `pdf/kerning.json`).
- BS calendar + night window: 1,914 instants, 276 periods identical; a
  one-constant mutation fails 143 checks.
- Crypto: TS-sealed personal-data and finance envelopes open in Go; rotation,
  scope binding and the blind index match. Sealed archives open both ways
  (`HP_WRITE_VECTORS=1` writes a Go archive the generator opens in TS).
- Pusher auth + signed batch query byte-identical to the `pusher` npm package.
- Spreadsheets read cell-for-cell like SheetJS, including the real eSewa
  `.xls`/`.xlsx` and Khalti exports in the repo.
- PDF out: a page drawn through `pdf.Cursor` is glyph-identical (character,
  font, size, position ±0.05pt) to `layout.ts` + pdf-lib; a 0.5pt layout
  change fails it.
- Images: WebP variants pixel-close to sharp (mean diff ≤4/255) with identical
  sizes; integrity stats and evidence-hash pixels identical on opaque images.
- `GIN_MODE=release go test -race -tags=sonic ./...` green.

### Added / Changed
- `platform/{bs,money,plans,crypto,storage,realtime,push,qr,export,sheets,pdf,pdfin,images}`.
- `platform/email`: topic opt-out (`Notify`/`NotifyBatch`), unsubscribe line +
  RFC 8058 headers, batch sends. The "one routine email a day" rule is job
  cadence in TS, so it travels with the Phase 9 jobs.
- `push.Hooks`: the preference filter and both routing tables are supplied by
  the notifications module when it is ported.
- `httpx.EncodeURIComponent` is the one JS-compatible encoder.
- `.xls` via shakinm/xlsReader (extrame/xls crashed on plain BIFF8); a CFB root
  entry named other than "Root Entry" (SheetJS writes "R") is normalised first.
- QR: matrices can differ from npm `qrcode` (segmenting/mask); tests require
  that every code scans back to its text and is pixel-identical where the
  matrices agree.
- Raster ID cards moved to a Phase 5 item (owned by no phase before).

### Parity
- routes ☑ this phase: 0 (total 20/512) — Phase 2 is libraries only
- baseline unchanged: `41b0ef10`

## [Phase 0] — 2026-10-29

### Gate
- `docker compose -f deploy/compose.yaml -f deploy/compose.local.yaml up -d --build`
  → mongo, redis, api, caddy all healthy; `https://localhost/api/v1/health` 200
  through Caddy; `stop api` → "stopped cleanly", exit 0, < 1 s.
- Harness recorded `/api/v1/health` (GET + wrong method) from live TS at
  `541e46cf` and replays green; `go test -race ./...` green.

### Added / Changed
- Toolchain: Go 1.27.0; MSYS2 UCRT64 gcc 16.2 + libvips 8.18.7 (CGO on);
  MongoDB Database Tools; k6.
- Deps: gin 1.12, sonic 1.15.5 (JIT covers go < 1.28 — check before bumping Go),
  mongo-driver/v2 2.9.2. All from ARCHITECTURE.md §3.
- `internal/platform/config` (every env var, TS defaults, `??` vs `||` kept,
  boot errors on bad values, Atlas refused outside production), `httpx`
  (envelope + recover), `log`, `mongo` (Connect: min 5 / max 50 pool),
  `router` (health, bare 405 like Next), `contract` harness, `cmd/api`,
  `cmd/dev record`, `deploy/` (Dockerfile, compose, compose.local, Caddyfile,
  redis.conf, copy-live-db.ps1), `testdata/k6/baseline.js`.
- **No seeds** (user decision): `cmd/seed` removed; local data is a read-only
  copy of live Atlas (`deploy/copy-live-db.ps1` → `hostelpalika_dev`, 145
  collections). PARITY seed row closed as not ported.
- `compose.test.yaml` replaced by `compose.local.yaml`.
- k6 baseline vs TS production: TTFB median ≈ 85 ms on every route (network
  floor), p99 up to 1.3–2.9 s (cold starts); `testdata/k6/results/ts-prod-2026-10-29.json`.

### Parity
- routes ☑ this phase: 0 (health recorded, but `/health` is ticked in PARITY with Phase 3's public group)
- baseline not moved: still `7bf6c91b`; the change intake (`PARITY.md` §2) to HEAD has **not** been run yet

### 2026-10-28 — Docs set created

- `server/` created at the repo root and gitignored until parity.
- Docs: README, PRD, ARCHITECTURE, PHASES, PARITY, RULES, API, DATABASE,
  DESIGN, FOLDER_STRUCTURE, CODING_STANDARDS, ENVIRONMENT, TESTING, CHANGELOG.
  `MEMORY.md` waits for the first line of Go.
- Inventory baseline `7bf6c91b`: 512 route files, 146 models, 37 modules,
  19 scheduled jobs, 68 email templates, 56 web files importing server code.
- Decisions: Go + Gin; REST kept, GraphQL rejected (ARCHITECTURE.md §10); Redis
  in-compose (Upstash shared during the move); in-process scheduler with Redis
  locks; Pusher kept for now; Caddy strangler routing; contract tests recorded
  from the TS server instead of a hand-written OpenAPI spec.

---

## Template

```
## [Phase N] — YYYY-MM-DD

### Gate
- what was proven, and how

### Added / Changed
- …

### Parity
- routes ☑ this phase: n (total n/512)
- baseline moved: `old` → `new`
```
