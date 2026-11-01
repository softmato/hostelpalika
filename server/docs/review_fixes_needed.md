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
| ☐ | R19 | `cmd/indexes` is an empty folder | `RULES.md` §6 says indexes are a migration there; `apps/web/scripts/ensure-indexes.mjs` is the only one | When TS is deleted, nothing can create indexes on a fresh database | Assigned: Phase 10 (needs every model's indexes) |

## Medium

| | ID | Finding | Evidence | Impact | Fix |
|---|---|---|---|---|---|
| ☑ | R8 | Client mistakes answer 500 | 20 of the 27 recorded 5xx: bad JSON, not a form, malformed id | Real faults hidden among client errors; alerts useless | 400 `INVALID_JSON` / `INVALID_FORM`, 404 `NOT_FOUND`. Go (`httpx.Fail`) and TS (`handleRouteError`) |
| ☑ | R11 | Provider calls without timeout or size cap | `llm.go:63` `&http.Client{}`, `evidenceread.go:112` `DefaultClient`, `io.ReadAll` on replies | A hung or huge provider reply holds memory and a goroutine | Client timeouts, capped reads |
| ☑ | R14 | Personal-data key error ignored | `router.go:136` `personal, _ :=` | Missing key: nil pointer panic instead of the clear refusal `config` promises | Nil-safe methods returning `ErrPersonalKeyMissing` |
| ☑ | R15 | Unknown path answers plain text | Gin default | A client that parses JSON breaks on a 404 | `httpx.NotFound` envelope |
| ☐ | R18 | Logs cannot be seen in the superadmin portal | stdout only | Owner's requirement (`MISSION.md`, addition 3) | Assigned: Phase 7 item in `PHASES.md` |
| ☑ | R20 | Deploy hardening gaps | `compose.yaml`: no log rotation (disk fills), no `no-new-privileges`, Redis has no healthcheck; `Caddyfile` has no body cap | Avoidable outage on one VPS | Compose and Caddy changes |
| ☑ | R21 | 10 MB upload dies on a slow link | `ReadTimeout: 30s` needs 2.7 Mbps for the upload door; comment says uploads are presigned, but `files/upload` is not | Failed uploads from Nepali mobile networks | 120 s read timeout; upload routes get a 120 s budget |
| ☑ | R22 | Storage off answers 500 | `storage.go:45` plain error; 5 recorded cases | Misconfiguration looks like a crash | `ErrNotConfigured` is 503 `STORAGE_NOT_CONFIGURED` |
| ☑ | R23 | Nothing stops a route shipping without a guard | checked by hand this review | Phase 6 adds 223 routes | `TestAnonymousIsRefused`: a new non-public route must answer 401 |
| ☑ | R24 | Nothing stops a path typo | `PARITY.md` is by hand | Client gets a 404 from a route that looks ticked | `TestRoutesMatchWeb`, against every `route.ts`. Measured: 613 TS routes, 179 on Go, 0 mismatched |
| ☑ | R25 | Sponsor impressions count only the first sponsor | `community.go:1483`, `updateOne` with `$in`, kept from TS | Every other sponsor's count is wrong; money-adjacent | `UpdateMany`. Go and TS |
| ☑ | R26 | Compensating writes ignore failure | `hostelleave.go:449`, `account.go:556`, `desk_intake.go:91`, `join.go:852` | A failed undo leaves a stuck row with no trace | Log at error with the row id |
| ☐ | R28 | Multi-document money and identity writes are not atomic | no transaction in Go or TS; compensating writes instead (`R26`) | A crash mid-sequence leaves half a state | Assigned: Phase 6 finance + Phase 8 settlement: use a transaction where a partial write loses money |
| ☐ | R29 | Reads without a limit | 158 `Find`, 50 `SetLimit`, 128 `.All` | A large hostel can load a whole collection into memory | Assigned: Phase 10 load work: limit or stream whichever load shows matter |
| ☑ | R30 | Docs contradict the code and the owner | `README.md` says `server/` is gitignored and `MEMORY.md` does not exist; `RULES.md` §2 says Go never fixes a bug first; `PHASES.md` lists "`server/` committed" | Next session follows the wrong rule | Corrected |
| ☐ | R31 | Uncommitted TS work is outside the change intake | `saved-hostels` routes, `PLAN_OVERDUE`, finance and branch edits in the working tree | Go drifts unseen; intake reads commits only | Assigned: Claude, at the start of Phase 6, from the working tree, without waiting for a commit (see "Open items"). `TestRoutesMatchWeb` reports the new routes as not ported. Go reads the suspension reason as data, so `PLAN_OVERDUE` passes through unchanged |

## Low

| | ID | Finding | Evidence | Fix |
|---|---|---|---|---|
| ☑ | R12 | Email retry sleeps through cancellation | `sender.go:359` `time.Sleep` | `select` on the context |
| ☑ | R13 | OTP hash compared with `!=` | `signin.go:238`. Attempts are capped at 5, so low risk | `subtle.ConstantTimeCompare` |

## Measurement owed

| | ID | What | Assigned |
|---|---|---|---|
| ☐ | R27 | Read each module line by line against `MISSION.md` §3 Phase B: correctness, not only parity | Phase 10 (one read per module; findings land here) |
| ☐ | R32 | Go under load: latency, pool saturation, Redis down, overload recovery. Only a TS baseline exists (`testdata/k6/results/`) | Phase 10; the real number needs the VPS |

## Open items: Claude does these

The owner's order (2026-11-02, `MISSION.md` addition 4): all work in the repo is Claude's,
Claude does what it can reach outside it, and the owner mostly helps or does the rest of
the outside work. No repo item waits for the owner. In the order to do them:

| | Item | What Claude does | When |
|---|---|---|---|
| ☐ | R31 | The owner's TS landed in `dfb807f1`. Run the normal intake (`PARITY.md` §2): `git diff 6281d03d dfb807f1 -- apps/web packages`. Port the backend changes to Go with tests: `account/saved-hostels`, `platform/hostels/[id]/billing`, `platform/subscriptions`, `plan-grace` + `PLAN_OVERDUE` in the renewal sweep, finance, branches, `User.savedHostelIds`. `bs.ts` already matches Go | First thing in Phase 6, and again before each Phase 6 module that touches those files |
| ☐ | R17 | Push `main`, read the first run of `server.yml`, fix it until green, then tick R17 | First thing in Phase 6, right after R31's read |
| ☐ | Phase 4 | Outside work. Set `COOKIE_DOMAIN=.hostelpalika.com` on Vercel project `question-call/hostelpalika` (Production) and deploy: Claude if the Vercel CLI is signed in, otherwise hand the owner this exact step. Claude then confirms `Set-Cookie` on the live site carries the domain and login still works, and ticks `PHASES.md` Phase 4 once sessions have refreshed | After R17 is green, so the release is known good |
| ☐ | R28 | Transactions where a partial write loses money | Phase 6 finance, Phase 8 settlement |
| ☐ | R18 | Superadmin log viewer: levels, categories, filters, request-id lookup, portal page | Phase 7 |
| ☐ | R19 | `cmd/indexes` | Phase 10 |
| ☐ | R27 | Line-by-line read of each module; findings land in this file | Phase 10 |
| ☐ | R29 | Limit or stream the reads that load shows matter | Phase 10 |
| ☐ | R32 | Load and failure tests, local first, then on the VPS | Phase 10 |

**Where the owner comes in:** outside work Claude cannot reach, such as Vercel with no
signed-in CLI, or buying and setting up the VPS for R32's real numbers and for cut-over.
Hand over the exact step once and continue with everything else meanwhile.
