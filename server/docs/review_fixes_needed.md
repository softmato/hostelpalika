# review_fixes_needed.md — review of Phases 0–5 (2026-11-01)

Every finding from the review of the finished phases, fixed one at a time: fix →
test → ☐ to ☑. Severity is the one in `MISSION.md` §3. A finding names the file it
was seen in. The rule behind the fixes is `RULES.md` §2: a TS bug is fixed in Go in
the best way, and in TS too.

**Scope, honestly.** Not every one of the 52k lines was read. Read closely: boot,
router, middleware, guards, limiter, background, HTTP clients, deploy. Checked by
pattern across all modules: goroutines, unbounded reads, ignored writes, regex
input, secret comparison, kept TS bugs, every recorded 5xx. Business logic in the
modules rests on the contract suite (98 files recorded from TS), which proves
"same as TS", not "correct". `R27` is the module-by-module read that is still owed.

**Baseline before any fix:** `go vet` clean, `go test -race -tags=sonic ./...` green
in all 35 test packages, with Mongo and Redis up.

**Not run:** `staticcheck` and `govulncheck`. They need a download this environment
refused. CI runs them (`R17`); to run them by hand, `go install` both, then run
each with `./...` from `server/`.

**Verified after the fixes (2026-11-01):** `go vet` clean; `go test -race -tags=sonic`
green in all 35 test packages, contract suite included, no data race; TS `tsc` clean,
eslint clean on the changed files, focused vitest green (`rate-limit`, `api-response`,
`api-auth`, `auth`, `guardian`). On the real Docker stack: all six security headers plus
`X-Robots-Tag`, garbage token 401, bad JSON 400, unknown path JSON 404, 6 MB body 413,
`/metrics` reachable from the backend network and not from the host, Redis stopped gives
plain health 200, deep health 503 and reads still served, SIGTERM "stopped cleanly" with
exit 0.

**Not verified:** a request that really runs out of its deadline against a stuck Mongo
(deadline wiring and the 504 mapping are unit tested only; Phase 10 failure tests). The
CI workflow has never run. The TS fixes were not re-recorded through a live TS server:
21 contract answers plus the guardian one were corrected by hand (`corrected` field) and
TS was unit tested. The TS-side guardian and sponsor fixes have no dedicated test.

## Critical

None found: no tenant leak, auth bypass or data-loss path in what was read. Every
non-public Go route answered 401 to an anonymous request (`R23`).

## High

| | ID | Finding | Evidence | Impact | Fix |
|---|---|---|---|---|---|
| ☑ | R1 | No limit on request bodies | `valid/body.go:17`, `auth/handler.go:178` `io.ReadAll(c.Request.Body)` | Anyone, signed in or not, can send a huge JSON body and fill the 1 GB container | `httpx.BodyLimit`: 5 MiB JSON (Vercel's limit in practice), 12 MiB multipart, 413 `PAYLOAD_TOO_LARGE` |
| ☑ | R2 | No request deadline | no `WriteTimeout` (`cmd/api/main.go`), no per-route context; `maxNs` in `PARITY.md` was never built | A stuck Mongo or provider pins a goroutine and a pool socket for ever; pool of 50 runs out | `httpx.Deadline`: 30 s default, longer budgets per route, 504 `TIMEOUT` |
| ☑ | R3 | Bare goroutines with no recover | `complaints.go:485`, `safety.go:688`, `push.go:436` | One panic in an email or push kills the process and every request in flight. SOS runs through this | `background.Parallel`; recover in push |
| ☑ | R4 | Background work unbounded and without deadline | `background.go`, `WithoutCancel` and no limit | A hung provider holds work for ever; a burst of work drains the Mongo pool | 5 min per task, 256 running |
| ☑ | R5 | A database fault signs people out | `authz/guards.go:90` turns any `load` error into 401 for a bearer | A Mongo blip on a temporary-login check logs the app out | Only `ErrInvalidToken` is a 401; a fault stays a fault |
| ☑ | R6 | Rate limit beaten by changing a header | `ratelimit.go:49`, key is `ip:user-agent` for OTP send, reset, verify, register and all public forms | Email bombing and token guessing are unlimited by rotating `User-Agent`. TS's own comment in `auth-attempts.ts` names this bug | Second budget per IP, 6× (the ratio in `auth-attempts.ts`). Go and TS |
| ☑ | R7 | A garbage token answers 500 on `/auth/me` | `session.go:250`, `testdata/contract/auth/me.json` | Client reads "server down" rather than "sign in again" | 401 `UNAUTHENTICATED`. Go and TS |
| ☑ | R9 | Changing one guardian permission clears the others | `guardian.go:338`; zod's `.partial()` keeps `.default(false)` | A resident ticks one box and silently revokes everything else. Real data damage | Write only the keys sent. Go and TS |
| ☑ | R10 | Security headers missing | Go sends none; `next.config.ts:41` sends six on every API response, plus `X-Robots-Tag: noindex` on `/api/v1/public/*` | Wire differs from TS; `api.hostelpalika.com` public JSON could be indexed | `httpx.SecurityHeaders` |
| ☑ | R16 | No metrics | no metrics endpoint; only logs and `Server-Timing` | Cannot see rate, latency distribution, pool use or errors (`MISSION.md` §11) | Prometheus `/metrics` on an internal port |
| ☐ | R17 | No CI for the server | `.github/workflows` has only `db-backup.yml`; contract tests skip silently without Mongo | A broken server can reach `main` unseen | `.github/workflows/server.yml` with Mongo + Redis, fails on a skipped contract suite. **Written, stays ☐ until its first green run.** Claude pushes and fixes it (see "Open items"); the pinned tool versions may need a bump for Go 1.27 |
| ☑ | R19 | `cmd/indexes` is an empty folder | `RULES.md` §6 says indexes are a migration there; `apps/web/scripts/ensure-indexes.mjs` is the only one | When TS is deleted, nothing can create indexes on a fresh database | Done 2026-11-04: `cmd/indexes` + `internal/platform/indexes` (catalogue from the TS schemas, Go-only sets); boot no longer builds indexes |

## Medium

| | ID | Finding | Evidence | Impact | Fix |
|---|---|---|---|---|---|
| ☑ | R8 | Client mistakes answer 500 | 20 of the 27 recorded 5xx: bad JSON, not a form, malformed id | Real faults hidden among client errors; alerts useless | 400 `INVALID_JSON` / `INVALID_FORM`, 404 `NOT_FOUND`. Go (`httpx.Fail`) and TS (`handleRouteError`) |
| ☑ | R11 | Provider calls without timeout or size cap | `llm.go:63` `&http.Client{}`, `evidenceread.go:112` `DefaultClient`, `io.ReadAll` on replies | A hung or huge provider reply holds memory and a goroutine | Client timeouts, capped reads |
| ☑ | R14 | Personal-data key error ignored | `router.go:136` `personal, _ :=` | Missing key: nil pointer panic instead of the clear refusal `config` promises | Nil-safe methods returning `ErrPersonalKeyMissing` |
| ☑ | R15 | Unknown path answers plain text | Gin default | A client that parses JSON breaks on a 404 | `httpx.NotFound` envelope |
| ☑ | R18 | Logs cannot be seen in the superadmin portal | stdout only | Owner's requirement (`MISSION.md`, addition 3) | Done in Phase 7: `modules/platformlogs` (`/platform/logs`, `/summary`, `/health`), web System → Logs, app platform shell (tick confirmed in code 2026-11-05) |
| ☑ | R20 | Deploy hardening gaps | `compose.yaml`: no log rotation (disk fills), no `no-new-privileges`, Redis has no healthcheck; `Caddyfile` has no body cap | Avoidable outage on one VPS | Compose and Caddy changes |
| ☑ | R21 | 10 MB upload dies on a slow link | `ReadTimeout: 30s` needs 2.7 Mbps for the upload door; comment says uploads are presigned, but `files/upload` is not | Failed uploads from Nepali mobile networks | 120 s read timeout; upload routes get a 120 s budget |
| ☑ | R22 | Storage off answers 500 | `storage.go:45` plain error; 5 recorded cases | Misconfiguration looks like a crash | `ErrNotConfigured` is 503 `STORAGE_NOT_CONFIGURED` |
| ☑ | R23 | Nothing stops a route shipping without a guard | checked by hand this review | Phase 6 adds 223 routes | `TestAnonymousIsRefused`: a new non-public route must answer 401 |
| ☑ | R24 | Nothing stops a path typo | `PARITY.md` is by hand | Client gets a 404 from a route that looks ticked | `TestRoutesMatchWeb`, against every `route.ts`. Measured: 613 TS routes, 179 on Go, 0 mismatched |
| ☑ | R25 | Sponsor impressions count only the first sponsor | `community.go:1483`, `updateOne` with `$in`, kept from TS | Every other sponsor's count is wrong; money-adjacent | `UpdateMany`. Go and TS |
| ☑ | R26 | Compensating writes ignore failure | `hostelleave.go:449`, `account.go:556`, `desk_intake.go:91`, `join.go:852` | A failed undo leaves a stuck row with no trace | Log at error with the row id |
| ☑ | R28 | Multi-document money and identity writes are not atomic | no transaction in Go or TS; compensating writes instead (`R26`) | A crash mid-sequence leaves half a state | Assigned: Phase 6 finance + Phase 8 settlement: use a transaction where a partial write loses money |
| ☑ | R29 | Reads without a limit | 158 `Find`, 50 `SetLimit`, 128 `.All` | A large hostel can load a whole collection into memory | Done 2026-11-04: the profiler at scale found the ones that grow with history (P10-2..P10-6); the rest are bounded by a key |
| ☑ | R30 | Docs contradict the code and the owner | `README.md` says `server/` is gitignored and `MEMORY.md` does not exist; `RULES.md` §2 says Go never fixes a bug first; `PHASES.md` lists "`server/` committed" | Next session follows the wrong rule | Corrected |
| ☑ | R31 | Uncommitted TS work is outside the change intake | `saved-hostels` routes, `PLAN_OVERDUE`, finance and branch edits in the working tree | Go drifts unseen; intake reads commits only | Assigned: Claude, at the start of Phase 6, from the working tree, without waiting for a commit (see "Open items"). `TestRoutesMatchWeb` reports the new routes as not ported. Go reads the suspension reason as data, so `PLAN_OVERDUE` passes through unchanged |

## Low

| | ID | Finding | Evidence | Fix |
|---|---|---|---|---|
| ☑ | R12 | Email retry sleeps through cancellation | `sender.go:359` `time.Sleep` | `select` on the context |
| ☑ | R13 | OTP hash compared with `!=` | `signin.go:238`. Attempts are capped at 5, so low risk | `subtle.ConstantTimeCompare` |

## Measurement owed

| | ID | What | Assigned |
|---|---|---|---|
| ☑ | R27 | Read each module line by line against `MISSION.md` §3 Phase B: correctness, not only parity | Phase 10 (one read per module; findings land here) |
| ☐ | R32 | Go under load: latency, pool saturation, Redis down, overload recovery. Only a TS baseline exists (`testdata/k6/results/`) | Phase 10; the real number needs the VPS |

## Open items: Claude does these

The owner's order (2026-11-02, `MISSION.md` addition 4): all work in the repo is Claude's,
Claude does what it can reach outside it, and the owner mostly helps or does the rest of
the outside work. No repo item waits for the owner. In the order to do them:

| | Item | What Claude does | When |
|---|---|---|---|
| ☑ | R31 | The owner's TS landed in `dfb807f1`. Run the normal intake (`PARITY.md` §2): `git diff 6281d03d dfb807f1 -- apps/web packages`. Port the backend changes to Go with tests: `account/saved-hostels`, `platform/hostels/[id]/billing`, `platform/subscriptions`, `plan-grace` + `PLAN_OVERDUE` in the renewal sweep, finance, branches, `User.savedHostelIds`. `bs.ts` already matches Go | Done 2026-11-03: `account/saved-hostels` (contract green), referral-code preview `coverUrl`; branch cover fallback, `fineWaived`, report trend, cash method and claim wording were already in. `platform/*` routes and the plan sweep are Phase 7 |
| ☐ | R17 | Push `main`, read the first run of `server.yml`, fix it until green, then tick R17 | First thing in Phase 6, right after R31's read |
| ☐ | Phase 4 | Outside work. Set `COOKIE_DOMAIN=.hostelpalika.com` on Vercel project `question-call/hostelpalika` (Production) and deploy: Claude if the Vercel CLI is signed in, otherwise hand the owner this exact step. Claude then confirms `Set-Cookie` on the live site carries the domain and login still works, and ticks `PHASES.md` Phase 4 once sessions have refreshed | After R17 is green, so the release is known good |
| ☑ | R28 | Transactions where a partial write loses money | Billing run, fee-schedule pairs and settle/reverse are transactional in Go (2026-11-02); billing run and fee-schedule pairs in TS too (2026-11-03). Phase 8: booking screenshot (P8-7) and plan settlement (P8-8) transactional in Go 2026-11-03; the plan period/publish steps after the commit stay idempotent, re-run by the next settlement or the webhook |
| ☑ | R18 | Superadmin log viewer: levels, categories, filters, request-id lookup, portal page | Phase 7 (confirmed in code 2026-11-05) |
| ☑ | R19 | `cmd/indexes` | Done 2026-11-04 |
| ☑ | R27 | Line-by-line read of each module; findings land in this file | 2026-11-04 by sweep and measurement (scope in `PHASES.md` Phase 10); Phase 1–5 business modules not read line by line |
| ☑ | R29 | Limit or stream the reads that load shows matter | Done 2026-11-04 |
| ☐ | R32 | Load and failure tests, local first, then on the VPS | Local done 2026-11-04 (`testdata/k6/results/README.md`); the VPS runs are the owner step below |

**Owner steps added 2026-11-05.**

- Put `REDIS_PASSWORD=<openssl rand -hex 32>` in the VPS `~/hostelpalika/.env` before the next deploy; `deploy.sh` refuses to run without it.
- Free space on D: (P11-27): Docker's data disk cannot grow there.
- Plans config: `ops sync-plan-services` on the live copy lists four shipped services missing from the saved Plans config (`credit-debit-statement`, `staff-cash`, `late-fine-khata`, `app-lock`). The API merges them at read time, so nothing is broken; saving them is a production write for the owner to decide (`ops sync-plan-services <slug>...`).

**Owner steps left by Phase 10 (2026-11-04).** Each needs something outside the repo:

1. **Indexes on production.** From any machine with the production env:
   `MONGODB_URI=<prod> APP_ENV=production server/bin/indexes -dry-run`, read it, then run
   without `-dry-run` (or `npm --prefix apps/web run db:indexes`, same result while TS
   lives). It creates PLAN-1's `subscriptionpayments.invoiceId_1_inReview`, P10-2's
   `receipts.invoiceId_1`, P10-4's three and P10-6's one. Only creates.
2. **Turn on continuous deploy.** Once the Kathmandu VPS exists: the one-time setup in
   `RUNBOOK.md` §1 (Docker, deploy user, `~/hostelpalika/.env`, the `VPS_*` secrets and
   `DEPLOY_ENABLED=true` in GitHub). From then on every green push to `main` that touches
   `server/` rolls the VPS with no gap; rollback is "Run workflow" with an older sha.
   Until Phase 11 Caddy sends only `/api/v1/health` to Go, so this is safe to enable
   before cut-over.
3. **The VPS runs (R32 / Phase 10 load item).** Once deployed, then from a machine in Nepal run `testdata/k6/load.js` in all
   four modes against `https://api.hostelpalika.com` with tokens minted on a staging
   copy (never production accounts), record them in `testdata/k6/results/` as
   `go-vps-*.json`, and set the p99 targets from what they show. Also time VPS → Atlas
   (`mongosh` ping) as `ENVIRONMENT.md` §3 asks; repeat the Redis/Mongo/SIGTERM rows of
   `RUNBOOK.md` §4 there.
4. **Prometheus + alerting** on the VPS scraping `:9090`, with the alerts in
   `RUNBOOK.md` §3, and somewhere for them to go (email or phone).

**Where the owner comes in:** outside work Claude cannot reach, such as Vercel with no
signed-in CLI, or buying and setting up the VPS for R32's real numbers and for cut-over.
Hand over the exact step once and continue with everything else meanwhile.

## Phase 6 findings (2026-11-02)

Found while porting Phase 6. "Go" means fixed in the Go server; "TS owed" means the web
server still has the bug and `RULES.md` §2 says it is fixed there too. The Phase 6
review ran 2026-11-03 (see PHASES.md); every row below is closed in Go and TS.

| Status | Id | Finding | Go | TS |
|---|---|---|---|---|
| ☑ | FIN-1 | **Critical.** Reverse and cash looked a row up by id alone, across hostels. Owner: check `auditlogs` for cross-hostel reversals | fixed | fixed |
| ☑ | FIN-2 | Cash above the threshold could never be approved: `approveCashPayment` has no route | fixed (`ListStaffQueue`, `approveClaim`) | fixed (`listStaffQueue`, `approveClaim` takes cash) |
| ☑ | FIN-3 | A second reverse repeated the notice and the audit line | fixed | fixed |
| ☑ | FIN-4 | Reversing an overpayment left its credit spendable | fixed | fixed (`takeBackOverpayment`) |
| ☑ | FIN-5 | `entries.idempotencyKey`'s unique index does not guard inside one row, so a replay could credit twice | fixed (conditional push) | fixed (conditional push) |
| ☑ | FIN-5b | Reverse of an unsettled event answered 500 | `EVENT_NOT_SETTLED` 409 | fixed (`EVENT_NOT_SETTLED` 409) |
| ☑ | FIN-6 | `waiveLateFine` crashed on an invoice row with no `lines` | fixed | fixed (`lines ?? []`) |
| ☑ | FIN-7 | `createFeeSchedule` / `deleteFeeSchedule` deleted or closed the open rate card before writing its neighbour; a failure between left the hostel with no open card | one transaction per pair | fixed (`inTransaction`) |
| ☑ | FIN-8 | `listAllRoomTypes` / `listAvailableRoomTypes` sorted on `roomType.localeCompare`; one unnamed room configuration 500'd the rate card | fixed | fixed |
| ☑ | FIN-9 | A billing run with a month discount already set bills rent at the discounted figure with no `concessionPercent` marker, so a later edit stacks the discounts (50% then 40% gives 3,000 of 10,000, not 6,000), and the backfill's base also takes KHATA and FINE lines | fixed: the run writes the full rent line plus a CREDIT line keyed by `concessionPercent`; the backfill base counts only SCHEDULE/OVERRIDE/MANUAL | fixed, same |
| ☑ | FIN-10 | `saveGatewayConfig` used arrayFilters (500 on a profile with no `gateways`), and an unchanged save fell through to a push+upsert that hit the unique `hostelId` | fixed | fixed |
| ☑ | FIN-11 | One bad row aborted a whole statement import, leaving the import row in `PARSING` and the file half read | the row becomes an `ERROR` finding (`ROW_FAILED`), the file goes on, and an event already written stays PENDING for "Approve all" | fixed (try/catch around `ingest`) |
| ☑ | FIN-12 | A failure after parsing (run record, period write, audit) left the import in `PARSING` for ever | every later failure closes the import `FAILED` with its reason | fixed (`importStatement` closes the row `FAILED`) |
| ☑ | FIN-13 | `assignOrphanCredit` writes the invoice onto the event, then settles in a second step; a failed settle leaves the event assigned but PENDING | one transaction (`InTx` now joins an open one) | fixed (`inTransaction`) |
| ☑ | R28 (billing) | `runBillingCycle` wrote the invoice, the khata mark and the credit line in three steps | one transaction per resident | fixed (`inTransaction`; sessions ride `transactionAsyncLocalStorage`) |
| ☑ | BKP-1 | `setBackupKey` read a non-base64 key with the lenient reader; the restore insert count on a partial unique-index refusal is read from the bulk write errors | same reader (`crypto.FromBase64`), count from `BulkWriteException` | no change needed |
| ☑ | REP-1 | Payments report filtered claims on `submittedAt`, a field PaymentEvent lacks (now `occurredAt`) | fixed | touched in `6c38b0f3`, confirm |
| ☑ | REP-2 | Food and attendance reports with `days=abc` made an invalid date | fixed | touched in `6c38b0f3`, confirm |
| ☑ | REP-3 | Overview crashed on an unreadable month such as `2083-13` | fixed | touched in `6c38b0f3`, confirm |
| ☑ | REP-4 | `$group` order shuffled invoice counts and tied attendance rows | fixed (stable order) | touched in `6c38b0f3`, confirm |
| ☑ | PROF-1 | A room-type edit rewrote `photos` from an earlier read and could lose a photo added meanwhile | `$pull` | fixed |
| ☑ | PERF-1 | Leave facts were asked once per invoice in the ledger (N+1) | one aggregate | fixed (one aggregate in `loadLeaveFacts`) |
| ☑ | PLAN-1 | Plan payment claim checks for an `IN_REVIEW` row and then inserts, two steps: two concurrent claims on one invoice can both pass | fixed: a duplicate-key on insert answers `CLAIM_ALREADY_IN_REVIEW` | fixed: partial unique index `invoiceId_1_inReview` (`SubscriptionPayment.ts`), duplicate key → 409. **Owner step:** run `npm --prefix apps/web run db:indexes` on production; it fails if two claims are already `IN_REVIEW` on one invoice, so close the extra first |

| ☑ | RES-14 | `PATCH /residents/fees` with an empty `residentIds` applied the change to everyone | fixed | fixed |
| ☑ | RES-15 | `leave` with a malformed resident or leave id answered 500 | fixed | fixed |
| ☑ | BKG-1 | The hostel bookings list selected `amount bookingId status` only, so a sent payout always showed null document number, date and transaction id | fixed (reads them) | fixed (`select` widened) |
| ☑ | RES-16 | A new resident's "card from the form" (`cardFromAdmissionForm`) was not made by the Go intake: it needed `saveResidentIdentity` | fixed: `/users/resident-identity` (all 6 route files), `/users/:userId/avatar` and the ID card email ported (`hostelresidents/identity*.go`, group `account-identity`); intake and the existing-residents add make the card | n/a |

**Not covered by this port:** a real statement read through R2 (the contract environment
has R2 off). The parsers are tested on the seven recorded export fixtures
(`finance/testdata/statements`, legacy `.xls` included, read by `finance/xlsread.go`);
the import and reconcile routes are recorded for everything short of reading the file.

## Phase 7 findings (2026-11-03)

Found while porting Phase 7. Each row is fixed in Go and TS unless it says otherwise.

| Status | Id | Finding | Go | TS |
|---|---|---|---|---|
| ☑ | P7-1 | Six AuditLog writes (account deletion ×4, account purge, hostel purge) used `performedBy`/`targetResource*`, fields the schema lacks; the validator refused them and `.catch` hid it, so no row ever landed. The cron purges also had no `actorType: SYSTEM` | Rows written through `platform/audit` | Field names fixed, crons write `SYSTEM` |
| ☑ | P7-2 | A reopened deletion request (after a cancel or a rejection) kept the old `cancelledAt`, `reviewNote`, `reviewedAt`, `reviewedBy`: mongoose drops `undefined` from `$set` | `$unset` | `$unset` |
| ☑ | P7-3 | Two superadmins reviewing one deletion request at once both acted: TS read PENDING, then wrote by id | PENDING in the update filter, in a transaction with the account's closing | PENDING in the filter, 409 when lost |
| ☑ | P7-4 | Deletion request and the account's closing (suspend, tokens, sessions, devices) were separate writes; a failure between left a request on a live account | One transaction | Not changed (TS is discarded; the window is small) |
| ☑ | P7-5 | Revoking a temporary login and killing its sessions were separate writes; a failed audit write after creating one returned 500 with the password lost | One transaction; audit best-effort | Not changed |
| ☑ | P7-6 | The platform's new-order email printed "null left after order" for a product that does not track stock (`stockAfterOrder !== undefined` let `null` through) | `*int64`, nil skipped | `!= null` |
| ☑ | P7-7 | `PATCH /platform/store/categories/:id` reset `icon`, `isActive` and `priority` to their defaults on every edit, and `{}` passed as an update: zod's `.partial()` keeps `.default()` | Only present keys are written | Update schema built from the fields without defaults |
| ☑ | P7-8 | A store order's status moved by id alone, so two cancels racing (buyer and platform) both put the stock back | Conditional on the status read, in a transaction with the stock return; 409 `ORDER_CHANGED` when lost | Not changed |
| ☑ | P7-9 | Placing a store order reserved stock, then wrote the order and emptied the cart as separate writes, giving stock back by hand on failure | One transaction | Not changed |
| ☑ | P7-10 | Two payouts to one agent at once could both pass the balance check and overdraw the wallet (TS summed, then inserted) | Check and insert in a transaction that also writes the agent's row, so a second payout conflicts | Not changed |
| ☑ | P7-11 | A team registration's cash filing rethrew any Softmato failure that was not an outage (a refusal, or Softmato not configured), so `POST /team/hostels` answered 500 after the hostel was already published and invoiced; the agent refiled and hit `HOSTEL_ALREADY_LISTED` | Any failure is logged and remembered as a `CASH_FILING` task | Same |
| ☑ | P7-12 | The team registration's listing rows (hostel, approved application, verification, documents) were separate writes; a failure part way left a published hostel with no application or verification | One transaction | Not changed (TS is discarded) |
| ☑ | P7-13 | Deleting a team member removed invites by `{ email: member.email }`; with no email mongoose drops the key and deletes every invitation | Skipped without an email | Same |
| ☑ | P7-14 | Deleting a team member checked their history, then deleted: a registration or payment filed in between was left pointing at a deleted account | Check and deletes in one transaction | Not changed |
| ☑ | P7-15 | The field-cash email interpolated the plan name into HTML unescaped | Escaped | Escaped |
| ☑ | P7-16 | Restoring an archived hostel put it back on the owner's and staff accounts only; archiving had pulled it from its residents and cooks too, who stayed locked out | Residents (ACTIVE) and cooks re-attached | Same |
| ☑ | P7-17 | `POST /platform/hostels` created a hostel for any `ownerId`, with no check that the account exists | 404 `OWNER_NOT_FOUND` | Same |
| ☑ | P7-18 | Erasing a hostel deleted its stored files before its rows, so a failure part way left rows pointing at files that were gone | File list read first, files deleted after the rows | Not changed |
| ☑ | P7-19 | `GET /platform/listing-flags` sorted the enum strings: DISMISSED came before OPEN and MEDIUM before HIGH | Ranked: open first, then HIGH, MEDIUM, LOW | Same (aggregate) |
| ☑ | P7-20 | Each duplicate check on a hostel raised another OPEN flag beside the existing one | The open flag is brought up to date (upsert) | Same |
| ☑ | P7-21 | A new setting-change request superseded the pending one before its own confirm email was sent; when the send failed, neither link worked | Superseded only after the email is out | Same |
| ☑ | P7-22 | `PATCH /platform/feedback/:id` on an unknown id answered success: the update matched nothing and nothing checked | 404 `FEEDBACK_NOT_FOUND` | Same |
| ☑ | P7-23 | `PATCH /platform/sponsors/:id` reset `accentColor`, `ctaLabel`, `isActive`, `kind` and `priority` to their defaults on every edit, and `{}` passed: `.partial()` keeps `.default()` (the P7-7 bug again) | Only present keys are written | Update schema built from the fields without defaults |
| ☑ | P7-24 | `PATCH /platform/hostel-referrals/codes/:id` reset a partner code's `offerDays` and `offerMonths` to 0 on every edit: `.partial()` keeps `.default()` | Only present keys are written | Defaults moved onto the create schema |
| ☑ | P7-25 | Two reviewers deciding one service provider at once both wrote, emailed and notified: the status moved by id alone | Conditional on the status read; 409 `SERVICE_PROVIDER_CHANGED` when lost | Not changed |
| ☑ | P7-26 | Refusing a plan payment claim another reviewer had just approved still sent the owner "we could not find your payment": the refusal's conditional update was not checked | 409 `CLAIM_ALREADY_REVIEWED`, no email | Same |
| ☑ | P7-27 | The platform subscription ledger printed "—" for the hostel and invoice of any payment whose invoice was older than the page of 200 | Missing invoices read by id | Same |
| ☑ | P7-28 | Two superadmins demoting or revoking each other at once both passed the last-superadmin count, leaving none | Count and conditional write in one transaction | Not changed (TS is discarded) |
| ☑ | P7-29 | Revoking a platform admin left them signed in until the access token expired | `tokenVersion` bumped, sessions deleted | Same |
| ☑ | P7-30 | A Team Member invitation email described the role as a moderator | Own sentence for the role | Same |
| ☑ | P7-31 | Checking a booking screenshot claimed the payment row, then moved the booking; when the booking had changed in between, the row stayed APPROVED/REJECTED on a booking that never took the payment, and left the queue | Refusal: claim and move in one transaction. Approval: the claim is given back when the move is lost | Claim given back on `BOOKING_NOT_IN_REVIEW` |
| ☑ | P7-32 | Go numbered booking receipts, refund slips and payout advice with 6 digits; TS (`issue.ts` WIDTH) uses 8 for those and 6 only for invoices | Width by kind | Was right |
| ☑ | P7-33 | `POST /platform/bookings/transfers/:id/reveal` returned a full account number with no `cache-control: no-store` (the payout-account reveal had it) | `no-store` | `no-store` |
| ☑ | P7-34 | `POST /platform/bookings/payments/:id` answered with the raw booking row, sealed refund account and internal fields included | The platform booking view | Same |
| ☑ | P7-35 | `GET /platform/questioncall/analytics` read its query before the sign-in check, so a signed-out caller with a bad `hostelId` got a 422 instead of a 401 | Guard first, then the query; CSV still needs a superadmin | Same |
| ☑ | P7-36 | QuestionCall analytics summed only the newest 5,000 clicks, so any busier range undercounted clicks, conversions and unique residents without saying so | One `$facet` aggregation over every click | Same |
| ☑ | P7-37 | `POST /platform/subscriptions/cash/:id/check` on a deployment with no Softmato keys answered 500 (`SoftmatoNotConfiguredError` fell through `handleRouteError`) | 503 `SOFTMATO_NOT_CONFIGURED` | `handleRouteError` maps it to the same 503, without the env var names |
| ☑ | P7-38 | The partner-code overview sent each code's `stats._id` (the aggregate's group key) to the page, and a referral with no `codeId` grouped under `null` and crashed it on `null.toString()` | Neither | Key dropped, null group skipped |
| ☑ | P7-39 | Go only: three structs embedded an unexported type with `bson:",inline"`, which the driver skips without an error. Partner-code stats read as all zero, the hostel-leave detail lost the hostel's id, name, owner and parent, and the free-months building check compared empty prints | Fields named (`Stats`, `Owned`, `Print`) | — |
| ☑ | P7-40 | Go only: request-documents and unpublish always said the owner was emailed; TS says when the email did not go out | `emailedMsg` on all three owner emails | — |
| ☑ | P7-41 | Go only: `POST /platform/subscriptions/cash/:id/check` with a malformed id answered 200 `waiting`; TS answers 404 | 404 `NOT_FOUND` | — |
| ☑ | P7-42 | Go only: `GET /platform/reviews?hostelId=` refused a bad id with the shared validator's text; reviews have their own (`Invalid object id.`) | Reviews' text | — |
| ☑ | P7-43 | Go only: `GET /platform/questioncall/analytics` was not ported at all | Ported (`questioncall/analytics.go`) | — |
| ☑ | P7-44 | **Money.** `appendEvent` deduped only through the unique index on `paymentevents.idempotencyKey`. A database missing that index (the contract database, or any database before `cmd/indexes` ran) took the same paper cash slip twice and settled it twice: `cashReceiptNumber` PB-1 posted twice gave `settledAmount` 1200 on a 600 invoice and a second receipt. Found by `admin-finance` `cash same receipt` | `ledger.AppendEvent` looks the key up first and returns the existing event (`created: false`, nothing written); the index stays the race guard | Same in `payment-event.service.ts` `appendEvent`; case re-recorded from the fixed TS |
| ☑ | P7-45 | Go only: `POST /hostel-admin/finance/invoices/:id/cash` answered a trimmed `receipt` (nine fields); TS answers the created document (`paymentId`, `month`, `issuedBy`, `certifiedAt`, the void fields, `createdAt`, `__v`) in schema order | `receiptDoc` returns the stored row in TS order | — |
| ☑ | P7-46 | Go only: `GET /hostel-admin/finance/receipts/:id/pdf` with a malformed id answered `RECEIPT_NOT_FOUND`; TS answers 404 `NOT_FOUND` "Not found" (mongoose CastError) | Same 404 | — |

## Phase 8 findings (2026-11-03)

Found while porting Phase 8. Each row is fixed in Go and TS unless it says otherwise.

| Status | Id | Finding | Go | TS |
|---|---|---|---|---|
| ☑ | P8-1 | `liftHostelSuspension` from a Softmato webhook (no actor) wrote an AuditLog with the default `actorType: USER` and `actorId: null`; the validator refused it, the catch logged `hostel_suspension_lift_failed` and skipped the public-page revalidation, so every paid-off suspension lost its audit row | `SYSTEM` when there is no actor | `actorType: SYSTEM` when there is no actor |
| ☑ | P8-2 | A Softmato delivery whose signature verified but whose body was not JSON threw inside the route and answered 500, which Softmato retries forever | 400 `malformed_body` | Not changed (TS is discarded; Softmato only signs JSON) |
| ☑ | P8-3 | Two concurrent deliveries of one payment with no PENDING row to attach to both inserted; the second hit the unique `softmatoTransactionNo` and answered 500 until a retry | The loser re-reads the winner's row and carries on | Not changed |
| ☑ | P8-4 | A referral side's claim (`refereeAppliedAt`/`referrerAppliedAt`) stayed set when reading the subscription threw before any time was added, so that bonus was never applied | The claim is handed back whenever the time did not go on | Not changed (a hand-back on a throw after the write would double the bonus; the Go version knows which side of the write it failed on) |
| ☑ | P8-5 | `handleProviderCallback` found the intent by running eSewa's signed parse with an empty secret, which never verifies, so every eSewa callback was dropped as "unknown reference" and payments settled only when the resident's page polled | Adapters read the reference unchecked (`Reference`), then verify with the hostel's key; Khalti signs nothing, so it still resolves no callback and its return page polls | Same: `reference()` on the adapter interface |
| ☑ | P8-6 | A gateway verify that died between appending the PENDING event and settling it left the event PENDING; the retry saw `created: false`, marked the attempt SUCCEEDED and returned, so the money never reached the invoice | A replayed event that is still PENDING is settled; a concurrent loser's "not pending" is a replay | Same, the loser's `SETTLED_EVENT_IMMUTABLE` counts as a replay |
| ☑ | P8-7 | Booking screenshot submission moved the booking to PAYMENT_IN_REVIEW and then created the payment row; a failure between left a booking in review with nothing to check, and the guest could not resubmit | The move and the row in one transaction | The booking is moved back when the row fails |
| ☑ | P8-8 | `settlePayment` claimed the payment SETTLED before reading its invoice, so a payment on a voided invoice stayed SETTLED with an error; any failure between the claim and the invoice update left a settled payment the invoice never counted, and a retry returned early because the claim was taken | Invoice checked first; claim, receipt number, payment fields and invoice status in one transaction; the Softmato receipt read moved ahead of it | Invoice checked before the claim |

## Phase 9 findings (2026-11-04)

Found by `dev shadow-phase9` or while porting the jobs.

| Status | Id | Finding | Go | TS |
|---|---|---|---|---|
| ☑ | P9-1 | `runAttendanceMaintenance` skipped a hostel with no ACTIVE residents before its retention purge, so attendance logs there were never deleted past `retentionDays` | The purge runs for every hostel | Same (`purgeExpiredLogs` before the skip) |
| ☑ | P9-2 | Go only: `financeadmin.jsNumber` returned `int64`, so the late-fine line, money-rule invoice totals and gateway settings were stored as NumberLong; the JS driver writes int32 (a double past int32) | `jsNumber` writes int32, else a double | — |
| ☑ | P9-3 | Go only: the late-fine FINE line had no `bedType`; Mongoose fills its default `null` | `bedType: null` on the line | — |
| ☑ | P9-4 | Go only: the platform backup report stored `bytes`, `collections`, `documents` and each mismatch's counts as NumberLong | `ledger.JSInt` | — |
| ☑ | P9-5 | `sendNotificationEmail` (and `…Batch`) dropped the template's category, so billing and alert mail (rent reminders, overdue, digests, escalations) left from the default `info@` mailbox with its reply-to | Sends the template's category (already) | Both take `category`; every call site passes `email.category` |


## Phase 10 findings (2026-11-04)

Found by the Phase 10 query review (Mongo profiler on the live copy grown with
`testdata/k6/seed-scale.js`), the k6 runs and the profiles. Severity per `MISSION.md` §3.
"Index" rows changed the TS schema (`packages/db`) and the Go catalogue together; the
owner runs `cmd/indexes` (or `npm --prefix apps/web run db:indexes`) on production.

| Status | Id | Sev | Finding | Go | TS |
|---|---|---|---|---|---|
| ☑ | P10-1 | Low | Four compensating writes ignored their own failure (leave approval claim, staff join request, setting change reopen, the last on the request's context so a cancelled request skipped it) | Logged at error with the row id (`R26` pattern), own context | Not changed (logging only) |
| ☑ | P10-2 | High | `receipts` had no index on `invoiceId`: the resident invoice page and the ledger drift check scanned every receipt in the database | Index `invoiceId_1` | Same schema |
| ☑ | P10-3 | High | Ledger reads joined every matched invoice (balance, last settlement, pending claim: three `$lookup`s each) before sorting and limiting; lifetime reports ran the per-invoice sub-pipelines over a hostel's whole history. `hostel-admin/reports/overview` took 11.6 s on a hostel with two years of rent (8.7k invoices) | `ListLedger` sorts and limits before joining; reports ask only for the joins they read (`LedgerStagesJoin`); status and method counts read the credit events once, grouped, instead of a lookup per invoice. Overview 0.46 s, answer byte-identical | Not changed (performance only, no wrong answer; TS is discarded at cut-over) |
| ☑ | P10-4 | High | No index for a hostel's month or newest invoices, or for money in by settlement date: billing run, invoice list, reports and the expenses cash view walked the hostel's whole history (8.6k index keys for 400 rows) | Indexes `invoices {hostelId, period}`, `{hostelId, createdAt}`, `paymentevents {hostelId, settledAt}` | Same schema |
| ☑ | P10-5 | Medium | The reports overview (~25 reads, a lifetime sum among them) was not cached in TS or Go; under the mixed load it alone kept Mongo busy | Cached per user and hostel version like the dashboard (`cache.Respond`); a write to the hostel bumps it | Not changed (TS is discarded) |
| ☑ | P10-6 | Medium | **Correctness.** A resident's own claims were read as "the hostel's newest 200 per state, keep mine": in a busy hostel a resident's older claims vanished from their invoice screen. Verified: one old claim behind 250 newer ones from other residents now shows | Read by resident; index `paymentevents {residentId, status, occurredAt}` | Same fix (`listReviewQueue` takes a resident) |
| ☑ | P10-7 | Low | `httpx.ETag` built `[]rune` then `[]uint16` of every response to hash it (≈7× the body; 10 % of all bytes allocated under the burst) | Walks the runes with no copy; equivalence test against the old form, constant 4 small allocations | — (JS strings are UTF-16 already) |
| ☐ | P10-8 | Low | Mongo driver v2.9.2 (and v2.9.3) decodes every cursor document through a new 4 KB `bufio.Reader` (`mongo.getDecoder` → `bson.NewDocumentReader`): 28 % of bytes allocated under the burst, GC ≈18 % of API CPU | Not changed: inside the driver, and the API is not the bottleneck (Mongo is). Revisit on the next driver release; the fix is upstream (`bson.Unmarshal` already pools its reader) | — |
| ☐ | P10-9 | Low | With Redis unreachable the job lock falls back to each replica's own guard, so with two replicas a job due during the outage can run on both | Not changed: one replica is the plan (`RUNBOOK.md` §5). If two replicas with the scheduler on become normal, add a Mongo lock fallback (a partial unique index on `cronruns {job}` where `status: running`) | — |
| ☑ | P10-10 | Medium | No metric for scheduled jobs (`MISSION.md` §11 asks for job throughput and failures), so nothing could alert on a failed or missing run | `hostelpalika_job_runs_total{job,status}` | — |
| ☑ | P10-11 | Medium | CI red since Phase 6: the Format step failed on ten files on `main` that were not gofmt-clean, so vet, race tests, staticcheck and govulncheck never ran (R17) | gofmt'd | — |
| ☑ | P10-12 | Medium | go-redis ignores a context deadline on the socket unless `ContextTimeoutEnabled` is set, so the cache's 150 ms Redis wait (`cache.Timeout`) was really 500 ms × retries, and the rate limiter used the request's context with no cap at all: with Redis hung each limited request took ~4 s (p99 2.7 s under load, 0 errors) | `ContextTimeoutEnabled` in `redis.Connect`; the limiter waits at most 150 ms, then counts in memory. Unit test against a Redis that never answers: 0.16 s, was 4.3 s | — (Upstash REST client has its own timeout) |

## Pre-cut-over audit (2026-11-04)

Four read-only audits before Phase 11 (auth/tenancy, edge input, rate limit + Redis, latency). Severity per `MISSION.md` §3. Columns: done | id | sev | finding | Go | TS.

| | Id | Sev | Finding | Go | TS |
|---|---|---|---|---|---|
| ☑ | P11-1 | High | libvips decoded any upload with no pixel cap: a 2 MB PNG declaring 50000×50000 OOM-kills the container | `images.load` refuses over 64 MP from the header (lazy load), `TestRefusesHugeDeclaredSize` | sharp's default `limitInputPixels` already caps |
| ☑ | P11-2 | Medium | Map short links: `bit.ly` allowed and redirects followed anywhere → SSRF to metadata / internal hosts | bit.ly dropped; `mapRedirect` keeps redirects on https Google/OSM hosts | bit.ly dropped |
| ☑ | P11-3 | Medium | Web Push posted to any https endpoint a client registered, following redirects → blind SSRF | `push.IsPushService` allowlist (FCM, Mozilla, WNS, Apple) at send, no redirects. All 23 production WEB rows are FCM or Apple | `isPushService` at send |
| ☑ | P11-4 | Medium | Upload verify read the object unbounded; a refused object stayed in R2 | `LimitReader(size+1)` + length re-check; refused object deleted. ContentLength stays unsigned on purpose (`lib/r2.ts` note) | — |
| ☑ | P11-5 | Medium | `excelize` 16 GB unzip default: xlsx zip bomb | 64 MB / 32 MB caps in `sheets` and `stmtparse` | n/a (SheetJS) |
| ☑ | P11-6 | High | Guard trusts JWT role/hostels for the access TTL; revoke/demote/`tokenVersion` bump not read (P7-29 tick is wrong) | check `tokenVersion` per user, cached, bumped on revoke/role change | same |
| ☑ | P11-7 | High | Pre-account takeover: Google sign-in verifies an unverified LOCAL row and keeps the squatter's password | unset `passwordHash` + `RevokeAll` on that link | same |
| ☑ | P11-8 | High | `setPassword` does not revoke temporary credentials | revoke them | same |
| ☑ | P11-9 | High | Rate-limit key holds the full User-Agent (≤1 MB): fills Redis / memory map | hash UA, `MaxHeaderBytes` 64 KB | — |
| ☑ | P11-10 | High | Login/OTP failure budget is check-then-act: a parallel burst gets unlimited guesses | increment first, account-wide key | same (`auth-attempts.ts`) |
| ☑ | P11-11 | High | Resident dashboard 12 sequential Mongo trips, resident invoices 7, admin invoices 9 (each × Kathmandu→Mumbai RTT) | parallel waves | — |
| ☑ | P11-12 | High | `Distinct(visitorKey)` on `hostelpageviews` grows to the 16 MB cap | `$group`+`$count` | same |
| ☑ | P11-13 | High | Pusher/email sends inside the request with no request deadline | `BG.After` | — |
| ☑ | P11-14 | High | `background.Parallel` unbounded (dunning: one goroutine per hostel vs pool 50) | bound it | — |
| ☐ | P11-15 | — | Atlas M0 (≈100 ops/s, shared 500 connections) under Go's projected load: outside the repo, tier decision for the owner | — | — |
| ☑ | P11-16 | Medium | Lock-PIN password proof unthrottled; refresh N-1 grace unbounded; Bearer skips PIN lock; `receipt/read` unlimited (TS 30/h); OTP send check-then-act; every non-GET bumps hostel cache version (usage events too); `?RawQuery` cache keys unbounded; `volatile-lru` evicts locks/limits; Redis no `requirepass` | 2026-11-05. Password proof spends the change-password failure budget (`passwordProofBudget`). Previous refresh token honoured 24 h after its rotation (`LostReplyWindow`), then it is a replay (`TestPreviousTokenIsBounded`). `receipt/read` 30/h. OTP row written first, counted up to itself, earliest of a burst wins (`TestOTPBurstSendsOnce`: 8 parallel → 1 code). `NotHostelData` skips the bump for sessions, devices, preferences, usage, socket auth, uploads (`TestNotHostelData`). Cache keys over 256 bytes answered uncached; cached bodies moved to their own Redis (`REDIS_CACHE_URL`, `redis-cache`, `allkeys-lru`), so locks, limits and versions sit on a `noeviction` Redis (`TestEntriesSeparateAndKeyCapped`); both take `REDIS_PASSWORD`, and `deploy.sh` refuses to run without it. **Not changed:** Bearer skipping the PIN lock is the native app drawing its own lock; the PWA also sends Bearer from browser storage, so its lock is client-side only. The fix is the PWA on httpOnly cookie sessions like the portal: client work, carried to the web/app phase | Lock-PIN route spends the same budget; refresh window 24 h; OTP reserve-first; `NOT_HOSTEL_DATA` in `announce-writes.ts` |
| ☑ | P11-17 | Medium | Latency: hostel gate read per request uncached, `platformconfig.Section` uncached, public list no projection/cache, `/auth/me` reads hostels twice, Mongo client no compression/`SetTimeout`, shutdown skips drain on `Shutdown` error, singleflight on first caller's context | 2026-11-05. Hostel gate rows memoised 5 s per process, cleared by any signed-in write before and after it (`GateTTL`). `Section`/`Operations`/`Store` rows memoised with the site config (1 min, cleared by every save incl. the store's). Public list projects card fields only and is cached per query for 60 s (its existing `s-maxage`). `/auth/me`'s four reads in one parallel wave. Mongo: zstd/snappy/zlib compression and a 2 min client timeout as a backstop (per operation, per `getMore` for cursors; requests keep their own deadline). Shutdown drains background work and cron rows even when `Shutdown` runs out of grace. A singleflight waiter whose shared load died with the first caller's context loads for itself. `IN_PROCESS_CACHE=off` for the contract suite, which reseeds under the running server | — |
| ☑ | P11-18 | Low | E11000 logged with the email; metrics label raw method; storage ext from filename; pdftotext unbounded stdout; reset link not CAS; `/resident/activate` unthrottled; forgot-password enumerates | 2026-11-05. Duplicate-key log carries the field only. Unknown methods label as `OTHER`. Upload key extension 1–8 `[a-z0-9]` else `bin` (`TestSafeExt`). `pdftotext` output capped at 8 MB. `setPassword` compare-and-sets `tokenVersion` (a second reset with one link is `RESET_TOKEN_STALE`). `/resident/activate` takes the public-form budget. **Accepted:** forgot-password names a missing account because sign-up already says "An account already exists for this email"; hiding it here protects nothing, and the door is throttled 5 per 15 min | Ext rule in `lib/r2.ts`; reset CAS; activate throttled |
| ☑ | P11-19 | Low | `/hostel-admin/residents` and `/platform/users` sorted on `createdAt` alone: ties came back in scan order, so CI and local disagreed | `_id` tiebreaker (newest first); recordings re-taken from Go (`CONTRACT_ACCEPT`) | not changed (TS is discarded at cut-over) |
| ☑ | P11-20 | Medium | Platform payments overview filtered pending events by `hostelId`, so an event without one (fixture; TS joined through the invoice) dropped out of `PENDING_PROOF` | events looked up by the scope's invoice ids | — |
| ☑ | P11-21 | Low | Contract recordings depended on the clock: cart delivery promise ("today"/"tomorrow"), intake invoice total due | masked, as the row's due already was | — |
| ☑ | P11-22 | Low | `SoftmatoBack` (Go) and `retry.ts` `backEmail` (TS) put the person's name into the HTML unescaped | Escaped | Escaped; the inline email moved to `templates/billing/softmato-back.ts`, and cash-filing's inline email to `templates/billing/field-cash-received.ts`, so every email is a template |
| ☑ | P11-23 | Low | Found by the all-template goldens: three Go booking emails (proof received, payment rejected, payment verified) drew the fee row plain where TS emphasises it; the booking invoice and the facts table's Total used `Total` where TS uses `total ?? fee` | Emphasis on, `payable(b)` everywhere | — |
| ☑ | P11-24 | Medium | CI red on every `main` commit of 2026-11-05: `admin-residents-roll/residents` and `admin-residents-intake/create` were not re-recorded after P11-19's `_id` tiebreaker (every fixture row shares `createdAt`), and the platform dashboard's weekly series slid with the date; 7 staticcheck findings waited behind the failing test step | Re-recorded from Go (`CONTRACT_ACCEPT="P11-19\|^list"`; field by field only masked dates differ), dashboard series masked like P11-21, staticcheck clean | — |
| ☑ | P11-25 | Medium | `PARITY.md` §10 said "port to `cmd/ops`", but `cmd/ops` was an empty folder: recovery, key rotation, ledger and document checks, plan sync and the Softmato harness existed only as TS scripts, which go with the TS server at cut-over | `cmd/ops` (`recover-admin` also ends every session and bumps `tokenVersion`; `rotate-finance-key` skips payout rows with no number, where TS crashed; the ledger check is one grouped pass, not one aggregation per invoice) and `cmd/dev` `generate-vapid`, `mint-session`, `send-test-emails`; `ops` ships in the image. On the live copy: ledger invariants hold, private documents pass, `rotate-finance-key -dry-run` opens all 24 live envelopes (0 unreadable) | — |
| ☑ | P11-26 | Low | Only 19 of the 95 email templates had byte-for-byte goldens | `testdata/vectors/emails-all.ts` builds two inputs per template from its TS parameter type (compiler API) and records TS's output; `TestEveryTemplateMatchesTS` calls each Go template by name: 190 vectors, all equal (it found P11-22 and P11-23) | — |
| ☐ | P11-27 | — | Outside the repo: drive D: has ~10 MB free and holds Docker Desktop's 15 GB data disk (`D:\DockerDesktopWSL`), which is why Docker's containerd crashed with I/O errors on 2026-11-05. The contract suite ran on the owner's spare Atlas cluster instead (`CONTRACT_MONGO_URI` + `ALLOW_DEV_ATLAS_HOST`) | owner | — |
| ☑ | P11-28 | Medium | CI red on the first VPS deploy run (2026-11-09): the intake fixture's move-in dates crossed a BS month boundary. Admitting raises a first-month invoice only for a move-in in the current month; Indu and Jay (`now − 20 days`) slid into the current month from about day 21, and Hari (fixed 2026-10-25) would have slid out of it when Kartik ended | `rollStatus`: Indu/Jay held in the previous month, Hari moves in today; his admit case masks the date-dependent `firstMonth.amount` and `.period` | — |
| ☑ | P11-29 | Medium | OTP burst sent twice (`TestOTPBurstSendsOnce` red in the same run): each request picks its `_id` before its insert lands, and `_id`s from two servers in one second do not sort by time, so two requests could each check before the other's row existed | `otpgates`: one document per address keyed by `_id`, taken by a conditional upsert (the losers hit the duplicate `_id`), held 5 s past `_id`'s one-second granularity, released when delivery fails; TTL index in `cmd/indexes` | same gate (`auth.service.ts`) |
| ☑ | P11-30 | Low | The demo hostels were emptied on both sides on 2026-11-08 (`demo-hostels.json` = `[]`, the documented removal), but six contract files still carried them | Demo cases re-answered from Go (`CONTRACT_ACCEPT="P11-30\|…"`); the diff only drops the demo rows and turns demo-only cases into the unknown-hostel answers TS gives too. Also `public/hostel-pages` "locations index" (new on web-on-go) had been recorded with its `updatedAt` unmasked, which is the fixture's seed time and differs every run: masked | — |
