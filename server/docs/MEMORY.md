# MEMORY.md — where the Go server stands

Read this after README.md. Update it at the end of every session.

## HANDOFF: Phases 0–9 done (2026-11-04). Phase 10 runs in its own session. Start here.

Every phase up to 9 has every ☐ ticked except Phase 4's outside step: `COOKIE_DOMAIN=.hostelpalika.com`
on Vercel plus a deploy (owner). Every `PARITY.md` §6 row is ☑; check with the coverage rule in
`PHASE7_PROMPT.md` (a row is ☑ only when each method matches a recorded case and the suite is green).
Contract fixture groups 16 `admin-finance`, 17 `admin-branches`, 18 `admin-notice-pushes` are taken; the
next new group uses 19. The TS recorder must run outside the sandbox: inside it Turbopack cannot start its
PostCSS worker (exit 0xc0000142) and every newly compiled route answers 500. `dev record` takes `-fixture`
as a flag and the case files as arguments. Left from Phase 7: the app's platform shell on a device after the
owner's OTA, and the first real `pwa` row in `usageevents` once the PWA export redeploys.

## Earlier: Phase 6 done (2026-11-03)

Phase 6 closed: every hostel-admin route on Go, contract-green; resident identity +
avatar + saved-hostels ported; all Phase 6 findings ☑ in Go and TS (only R28's Phase 8
half is open). Not pushed: R17 (push `main`, get `server.yml` green) is still the first
outside step, then the Phase 4 cookie release. Owner step: `db:indexes` on production
for PLAN-1. Phase 7 starts with `platform`, `team` (incl. the field-team copies of the
existing-residents routes), `store`, the 7 `users` routes left, and the log viewer (R18).
Tests on Windows: `go test -p 2 ./...` (full parallel compile runs out of memory), never
alongside vitest.

## Earlier: Phase 6 in progress (2026-11-02)

One session, no subagents. Everything below is committed on `main`; push with `git push origin main` (no Claude co-author line).

**Tools for porting:** `CONTRACT_ACCEPT="<finding>|<case regexp>"` on a `go test -run TestContract/<group>` replaces those recordings with Go's answer (proven TS bugs only). Mask `**dates` hides every timestamp and minted id. `fixture.extendGroup` adds rows to a group from a later-sorted file. CI is green except what the last push shows; read it with `gh run list --workflow "Go server"`.

**Done and contract-green:** ops slice entire (notices, pushes, complaints, sos, night status, community moderation, campaigns, maintenance, attendance, food routine + photo, cooks, cook portal); rooms, room types, inquiries, move-events; wardens, referrals, hostel-referrals, service-providers; billing + settings reads.
**Order left, by dependency:** expenses admin (`expenses` needs role-aware actor) → stock (needs expenses; `admin-stock/stock.json.pending` must be re-recorded, rename back to `.json`) → reports → setup (kyc, leave, backup, profile, branches, subscription, payout, billing writes) → finance (billing run, fee schedules, invoices, khata, late fine, money rules, gateways, payment profile, concessions, statements) → residents (createResident needs the billing run) + bookings + lookup/scan.
TS fixes done: RES-1 rooms bad ids, RES-2 room `position` not in the schema, RES-3 move-events crash, OPS-1 campaign read counts, OPS-2 attendance settings `_id` in answer (Go only), OPS-3 enabling the cook portal after the last cook left answered 500.

**Findings to log in `review_fixes_needed.md` (Critical FIN-1):**
- FIN-1 Critical: reverse and cash looked rows up by id alone, across hostels. Fixed in TS and Go. Tell the owner: real exposure, check `auditlogs` for cross-hostel reversals.
- FIN-2: cash above the threshold could never be approved, since `approveCashPayment` has no route. Fixed in Go only (`ListStaffQueue`, `approveClaim`). **TS still owed.**
- FIN-3: a second reverse repeats notice and audit. Go only. **TS owed.**
- FIN-4: reversing an overpayment leaves its credit spendable. Go only. **TS owed.**
- FIN-5: `entries.idempotencyKey`'s unique index does not guard within one row, so a replay could credit twice. Go only (conditional push). **TS owed.**
- Reverse of an unsettled event answered 500. Now `EVENT_NOT_SETTLED` 409. Add to TS's `FINANCE_ERROR_STATUS` too.
- Notices `.partial()` bug: fixed by the ops session in `notice.validation.ts`, not logged.

**State of each slice (written is not verified; nothing below is contract-green except where said):**
| Slice | Written | Left |
|---|---|---|
| residents (52) | `hostelrooms`, `inquiries`, `movechecklist` (move-events only), mounted; 3 case files, recording was in flight | `residents` 30, `resident-lookup`, `resident-scan`, `bookings` 6, tenant cases |
| ops (43) | `notices/admin.go`, `noticepushes`, `opsscope`, mounted; `notices` cases unrecorded, replay failed | maintenance, attendance, food, complaints, sos-alerts, night-status, community, cooks, cook-portal, notifications, tenant cases |
| stock (47) | `stock/fold.go`, seed, 127 cases, **but dynamic-id cases recorded HTML 500 when TS crashed: re-record**; no handlers | stock handlers, reports 12, expenses 9, wardens, service-providers, referrals, hostel-referrals |
| setup (40) | `billing/{admin,state}.go`, `hostels/{admin,branches,branchschema,owned,payout}.go`, `setup_templates.go`, mounted; `billing.json` + `settings.json` recorded, not replayed. `branches.go` `totalsBy` was reported unfinished; I removed a duplicate `objectIDs` | kyc, leave, backup, profile, subscription, rest of branches, payout |
| finance (41) | `financeadmin/handler.go`: events list/approve/reject/reverse/bulk, cash, void, receipt PDF, no cases yet. Read in TS already: payment-event, receipt, credit, cash, notify, billing, review | cases + fixture `admin_finance.go`; billing-runs, fee-schedules, invoices (list/ledger/periods/waive-fine), khata, late-fine, money-rules, payment-gateways, payment-profile, rent-concessions, residents ledger, statements, ask-resident, assign |

Port order inside finance: the billing run needs `fee-schedule.service`, `reference-sequence`, `late-fine`, `khata`, `rent-concession`, `resident-leave`, offer fee-offs. Per invoice, use `InTx`.

**Also still open:** R31 intake (`account/saved-hostels` route, `User.savedHostelIds`, `cash method` done in Go, claim-verified notice wording done in `ledger`, guardian done; `hostel-suspension` `PLAN_OVERDUE`, plan sweep, `report.service`, `hostel-referral.service`, `hostel-branch.service`), then move the `PARITY.md` baseline to `dfb807f1`. Tick `PARITY.md` and `PHASES.md`, write `CHANGELOG.md`. Phase 4 cookie release (a Vercel `auth.json` exists on this machine; CLI not on PATH). Then Phase 7.

**Last, on the owner's request:** clear the stopped sessions' disk use on C: if safe (Go build cache is regenerable: `go clean -cache` only when nothing is building; `$TEMP/go-build*`, `/tmp/devrec.exe`; C: had 15 GB free). Four idle linked sessions remain unarchived: the owner has not agreed to archive them.

**Environment gotchas:** `package internal/trace/tracev2 is not in std` = corrupt Go module index: delete cache entries starting `go index`, or set `GODEBUG=goindex=0`. The machine has 7.7 GB RAM. Next compiles each route on first hit, so a first recording is slow. Very long `Bash` commands fail: write files with the tool. Real services rule: `MISSION.md` addition 5 (real Mongo read-only, R2 under a test prefix, no test write ever touches a real hostel).

## State (2026-11-01)

- **`MISSION.md` is the owner's binding brief: read it first.** The owner's bug rule replaced "TS is the spec, even its bugs": a TS bug is fixed in Go in the best way and in TS too (`RULES.md` §2); paths and methods stay exact.
- **Phases 0–5 reviewed; `review_fixes_needed.md` is the list, ticked one by one.** Added: `httpx/guard.go` (body limit, deadline, security headers, JSON 404), `obs/metrics.go` (`METRICS_ADDR`), `background.Parallel`, IP-wide limiter budget, `TestRoutesMatchWeb`, `TestAnonymousIsRefused`, `.github/workflows/server.yml`. New route past 30 s → `routeBudgets` in `router.go`.
- **Roadmap:** Phase 6 is next. New Phase 10 = production grade (measured), Phase 11 = cut-over. Phase 7 carries the superadmin log viewer.
- Measured: 613 TS method+path pairs, 179 on Go, 0 mismatched, 434 to port (`hostel-admin` 223, `platform` 123, cron 19, `users` 18, `team` 16, `store` 16). `ROUTES_LIST=<file> go test -run TestRoutesMatchWeb ./internal/router` writes the list.
- **All repo work is Claude's; outside work Claude does what it can reach and the owner mostly helps or does the rest (`MISSION.md` addition 4).** Phase 6 starts with the "Open items" table in `review_fixes_needed.md`.
- The owner's TS work landed in `dfb807f1` (`saved-hostels`, `PLAN_OVERDUE`, finance, branches, `bs.ts`) and is not in the intake yet: run it at the start of Phase 6 (R31). `bs.ts` and Go's `bs.FormatDate` now match.
- `C:` was 99 % full with a 17 GB Go build cache, which made the linker fail with "cannot open file". If that error comes back, it is the disk: `go clean -cache`.
- A contract answer changed for a fixed bug carries a `corrected` field naming the finding. Correct by hand, or re-record from a TS server that has the fix.
- Python rewriting a file here: write to `<file>.tmp`, then `os.replace`. A direct open failed once with Errno 22.

- **Phase 5 done (2026-11-01); Phase 6 is next, and PHASES.md says it starts once Phase 5 is ticked (Phase 4 still waits on the Vercel cookie release).** Booking modules: `bookings/{signed,terms,document}.go`, `platform/idcard`. Ported + contract-green: notifications, push, realtime, mobile, account prefs + invite, files, safety, notices, complaints, attendance, guardian, dashboard/profile/activate, referral, offer-program, reviews, questioncall, leaving, room. Modules: `safety`, `notices`, `complaints`, `attendance`, `guardian`, `residentaccount` (needs auth for sessions), `residentportal`, `users/issue.go`; `finance/{ledger,evidence}.go`. Fixture: `contract/fixture/resident.go`.
  Gotchas found: an `undefined` nested inside a Mixed value reaches Mongo as **null** (settle's `data.answer`); zod's `.partial()` keeps `.default()`, so PATCH /resident/guardians/:id writes false for every key left out (TS bug, kept as spec, fix in TS first); `go test -run` splits on `/`, so filter by group name only; on-day values (`foodMenu.dayOfWeek`) must be masked.

- **Phase 3 done; Phase 4 code done (2026-11-01).** Contract suite replayed green with Mongo + Redis up
  (start Docker first: without it Mongo tests skip and "ok" proves little). PARITY baseline moved to `8e965ad8`, intake empty.
  Phase 4's one open item needs the user: `COOKIE_DOMAIN=.hostelpalika.com` on Vercel + a deploy. Web calls go through
  `apps/web/src/lib/api-url.ts`; a new browser call uses `browserApi`/`apiFetch`/`apiUrl`. Never wrap a URL that gets saved.
  Next: Phase 5, which PHASES.md lists as needing Phase 4.

- **Phases 0 and 1 done (2026-10-29).** Gate passed: the 20 `/api/v1/auth/*`
  routes are contract-green (`testdata/contract/auth/`, 113 cases recorded from
  TS), tokens work across TS and Go both ways, and a refresh through Go kills the
  rotated-away token for TS (`router/interop_test.go`).
- **Phase 2 done (2026-10-29).** All 8 items ☑ (CHANGELOG has the per-library proof).
  Phase 3 is next to finish; Phase 4 may run alongside it.
  Libraries: `platform/{bs,money,plans,crypto,storage,email,realtime,push,qr,export,sheets,pdf,pdfin,images}`.
  Email attachments are still open — add with receipts. Raster ID cards are a Phase 5 item.
  `push.Hooks` (filter, deep link, web link) are filled in by the notifications module.
  A new PDF document = draw with `pdf.Cursor`, golden = the TS document, compare with `pdftest.Diff`.
  `httpx.EncodeURIComponent` is the one JS-compatible encoder.
- **Phase 3 nearly done (2026-10-30).** 31 of the 32 `public/*` routes are contract-green, plus
  bookings guide/policy/availability, feedback, usage, email-preferences, push public-key, health.
  **Not ported:** `POST /public/plan-checkout` and the 5 `hostel-registration/*` routes (they sit on the
  subscription service + Softmato payments, ~9k lines of `modules/billing`, Phase 5), and the maps
  nearby/routing libs (no Phase 3 route needs them). No web page was switched to the Go API.
  New modules: `feedback`, `usage`, `notifications` (service + email prefs + push key), `arrivals`,
  `files` (upload, claims, registration documents, applicant photo), `hostelreferrals`, `referrals`,
  `search`, `serviceproviders`, and in `hostels`: writes/inquiry/geocode/applications/quick/register
  (`NewHostelDoc` = mongoose `create` order + defaults, nested defaults land after the given keys),
  in `residents`: admission form + join link + `CheckExistingResidents`; libs `platform/{maps,llm,search}`,
  `valid.Form` (`Hard`, `Num` coerce, `Email`, `Nest`, `Join`, `JoinScalar`), email blocks + hostel/provider templates.
  Contract harness: placeholders `{{claim:<assetId>}}` and `{{bsperiod:±N}}`; a case may set
  `unorderedKeys` when the key order comes from a Mongo `$group`; `fixture/{join,providers}.go`.
  `public/service-provider-accept.json` is hand-written from the TS service: the TS dev server on :3100
  answered 404 for that path (its build lacks the route). Re-record it when it serves the route.
  Deviations: `files/upload` to the public bucket answers 503 when R2 is unset (TS writes Next's `public/uploads`).
  Gotchas: Gin — static POST-only siblings of `/public/hostels/:slug` need explicit GET→405 handlers.
  Fixture ids only need to be unique per collection, but `oid("xx")` is shared by every case file: grep
  before using one (a join user on `ee` broke `auth/signup`). BS-month fixtures need masks (`currentMonth`, `bills`).
  Array-element issues are `key.i` (use `JoinScalar`), not `key.i.v`.
- Vectors: `node_modules/.bin/jiti server/testdata/vectors/generate.ts` from the repo
  root regenerates every `testdata/vectors/*.json`, `platform/bs/table.go` and
  `platform/plans/defaults.json` from the TS code. Crypto/archive vectors are random
  per run. `HP_WRITE_VECTORS=1 go test ./internal/platform/crypto` writes
  `archive-go.json`, which the next generator run opens in TS (throws if it can't).
- Item 5 was re-scoped: `tenant-isolation.test.ts` asserts service filters, so its
  cases are attached to the Phase 6 residents / notices+complaints+maintenance /
  finance items; PARITY's Tenant isolation row stays ☐ until they are green.
- Ported for auth only, finish with their modules: `modules/hostels` (kyc/suspension
  readers), `modules/residents` (desk-intake link + promotion), `modules/users`
  (deletion cancel), `platform/email` (sender, identity, layout, 4 templates —
  topic opt-out and the daily cap are still open).
- 20 of 512 route files ☑ (the auth group). PARITY baseline
  `41b0ef10`; run the intake (`PARITY.md` §2) at the start of every port session.
  Uncommitted TS edits in the working tree are not intake — intake reads commits.
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
- Contract cases that read data run on the **fixture database** (`internal/contract/fixture`,
  `hostelpalika_contract`): fixed ids, test secrets, known passwords; reset before every
  file in record and replay. `{{access:<user>:<role>[:<hostels>][:lockPin]}}` and
  `{{purpose:<purpose>:<user>[:<version>]}}` mint tokens; `capture` feeds later cases.
  Record: start TS with the contract env (`router/contract_test.go` contractEnv, plus empty
  RESEND/UPSTASH/PUSHER keys — `fillMissing` keeps an empty var), check
  `lock-pin/touch` with a minted bearer answers 200 before recording (proves the overrides),
  then `go run ./cmd/dev record -base http://localhost:3100 -fixture <files in sorted order>`
  in one run (TS's in-memory limiter carries across files, so does Go's replay).
- Every multi-key response is an ordered struct, never `map[string]any`: sonic does not sort map keys.
- Docker Desktop can stop under you; a Mongo test that "passes" in 12 s skipped on a dial timeout.
- Record a contract: add the case to `testdata/contract/<group>/<file>.json`,
  `go run ./cmd/dev record -base <TS url> -baseline <sha> <file>`; replay is `go test ./internal/router`.
  Anything that reads data must be recorded from a TS server on the **local** copy, not prod.
- Latency: `k6 run -e BASE=… testdata/k6/baseline.js`.

## Decisions to keep

- The whole TS backend in `apps/web` is the spec: same paths and methods always, same wire bytes unless the behaviour is a bug (then fix both, `RULES.md` §2), faster inside.
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
- Set-Cookie lines are built by hand (`auth.Cookies.set`), never `http.Cookie`/`c.SetCookie`:
  Next writes `Path, Expires, Max-Age, Domain, Secure, HttpOnly, SameSite=lax` (lowercase).
  New TS goldens: drop a temporary `src/lib/zz-*.test.ts` into apps/web, run vitest,
  write results to a file (console output is swallowed), delete it.
- Guards: `authz.Use(g.RequireX)` as route middleware, `authz.From(c)` in the handler.
  A goroutine must never hold a `*gin.Context` (Gin recycles it) — use `background.Runner`.
- Mongo writes mimic mongoose: `__v: 0`, timestamps, `minimize` drops empty objects,
  undefined keys absent. Check a live row in the local copy before trusting a guess.
- Request schemas: collect `valid.Issues` in zod-declared order, return `.Err()`.
  Messages must be zod v4's (`valid.Type`, `OneOf`, …); add a builder when a
  route needs a new one, checked against real zod output.
- The Softmato client (later phase) must give its error a `SoftmatoRejection()` method.
- Body limits and deadlines are global now (`httpx/guard.go`); only long routes need a `routeBudgets` entry.

## Left behind by Phase 5

- Not run against real services: Vision, Gemini, R2 evidence fetch, presigned links, real ZIP contents. Needs a run with real keys before cut-over.
- Softmato client is Phase 8. Until then a configured deployment writes `softmatotasks` rows (`BOOKING_PAYMENT`, `REFUND_FILING`) and redraws a Softmato receipt it has no local copy of.
- `booking/guest.ts`, `hostel.ts`, `platform.ts` are ported only as far as Phase 5 sends them; the rest land with the routes in Phases 6 and 8, so those rows stay ☐. The payout advice layout lands with the hostel route.
- Harness: `create.json` needs a fresh `user-agent` tag per recording, since TS's in-memory limiter survives between runs (`booking-create`: 10 per 15 min).
- Check a raster golden by eye, not by the number alone: blank text scored only 4/255, and the first threshold of 3 nearly let it pass.
- Go numbers written to Mongo go through `jsInt` where TS writes a JS number: an `int64` lands as `NumberLong`.
- Fixed 2026-11-01 under the bug rule: receipts/x/pdf (now 404) and PATCH guardians (keys left out stay as they are). Left as is on purpose: a batched notification keeps its `createdAt`, so the row keeps its place in the bell.

## Phase 6 progress note (2026-11-02)
Done and contract-green: expenses, stock, 10 of 12 hostel report routes. Left in reports: `statement/pdf` and `overall/pdf`, both need the finance ledger (`getHostelLedger`).
CI green from 82064ea0: Go 1.27.3, patched modules, `staticcheck.conf` exempts ST1005 because error strings are the web's own answers.
Findings to log at closeout: REP-1 payments report filtered claims on `submittedAt`, a field PaymentEvent lacks (now `occurredAt`). REP-2 food and attendance `days=abc` made an invalid date. REP-3 overview crashed on an unreadable month such as 2083-13. REP-4 `$group` order shuffled invoice counts and tied attendance rows.

## Phase 6 progress note 2 (2026-11-02)
Done and contract-green in `admin-setup`: KYC + submit, leave form (`hostelleave/owner.go`), KYC agreement + letterhead PDF, profile + photos + change request + geocode.
Left, in order: billing writes (`checkout`, `claim`, `renew`, `pay-instructions`, `documents/:kind/:number`, all from `subscription.service`), backup (9), then finance + the two report PDFs, then residents, bookings, scan, lookup. `TestRoutesMatchWeb`: 298 of 613 TS routes not ported, most outside Phase 6.
Gotchas: `agreement-letterhead.pdf` was re-saved by pdf-lib with `useObjectStreams:false` because gofpdi cannot parse its xref stream. Very long Bash commands fail: write big files with the tool. pypdfium2 in a temp folder renders a PDF to PNG for looking at it.
Verified: the agreement fingerprint equals TS's on two signed rows; pages 1 and 3 of the PDF looked at. Not verified: contract fixture has no unique indexes, so `LEAVE_ALREADY_PENDING` and the agreement duplicate-key path never ran; founders' seals never drawn (R2 off in contract env); `Maps.Nearby`, `attachPhotoVariant` have no test.
Findings to log at closeout, with REP-1 to 4: PROF-1 a room-type edit rewrote `photos` from an earlier read and could lose a photo added meanwhile; fixed with `$pull` in Go and TS. Leave facts asked once per invoice in TS; one aggregate in Go.

## Phase 6 progress note 3 (2026-11-02)
Done and contract-green: all of finance (statements import/reconcile/assign/ask-resident added), `reports/statement/pdf` and `reports/overall/pdf`. Findings folded into `review_fixes_needed.md` ("Phase 6 findings"; `phase6-notes/closeout-findings.md` removed). Left: residents 29, bookings 6, resident-scan 2, resident-lookup 1, then the separate review.
Statements code: parsers `finance/stmtparse.go`, legacy `.xls` reader `finance/xlsread.go` (own BIFF8 reader; `extrame/xls` failed the eSewa export and was dropped), ladder `finance/matching.go`, routes `financeadmin/statements.go`. PDFs: `financeadmin/reportpdfs.go`; `pdf.Doc.AppendPDF` merges a part into a document; `hostels.Admin.BranchFigures` and `reports.Admin.PerformanceFor` feed it.
Gotchas: the contract env has R2 off, so a real import is only unit-tested on parsers; fixtures `admin_reports_statements.go` (ids c0–c7, resident b4) shifted `finance-invoices.json` and `reports.json`, both re-recorded. Long Bash heredocs fail here: write scripts with the Write tool, run them by path.
Residents work starts with `resident.service.ts` (1996 lines); bookings need `booking-*.service.ts` (about 2000); neither has a Go counterpart beyond the public/signed slices already in `bookings/` and the desk/join slices in `residents/`.

## Pre-cut-over check (2026-11-05)

- Ticks were wrong both ways: `PARITY.md` left 279 done rows unticked, and `cmd/ops` was an empty folder behind a "port to cmd/ops" decision. Check the code before trusting a tick.
- No local Mongo while Docker is down (D: is full): run the contract suite on the spare cluster with `CONTRACT_MONGO_URI` + `ALLOW_DEV_ATLAS_HOST`, `go test -p 1`. Run Go tests from PowerShell: Git Bash's PATH makes test binaries fail with `0xc0000139`.
- In-process memos (gate 5 s, site config 1 min) are off in the contract env (`IN_PROCESS_CACHE=off`): the fixture reseeds under the running router.
- Email goldens cover every template; a new template needs `emails-all.ts` re-run and a row in `template_table_test.go`.


## Web on Go, step 2 (2026-11-08, branch `web-on-go`)

- Public cache: `cache.PublicChanged(ctx)` bumps `v:hostel:public` (drops every `r:public:*` read) and POSTs the web's `/api/revalidate` with `REVALIDATE_SECRET` (same value in root `.env` and `server/.env`; empty = no call). Called at the Go twins of TS's 16 `revalidatePublicPages` sites plus every `capacitySummary` write. A field typed `realtime.Bumper` uses `cache.PublicChangedOn`.
- Cached signed-out reads (`Respond` with `cache.PublicScope`, 10 min TTL, ETag/304): listing, hostel by slug, sitemap, locations, near. Site config and pulse keep their in-process memos.
- One `*cache.Cache` for the whole router now (`ch` in `mountAPI`): one singleflight group.
- Locally the API container's `APP_URL` is `localhost:3000`, so its revalidate POST fails (logged, harmless); production's `APP_URL` is the web.
- Router contract suite needs `-timeout 60m` (it passed 10 min).
