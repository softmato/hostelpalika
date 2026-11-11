# READINESS.md — Phase 10 readiness report (2026-11-04, re-checked 2026-11-05)

Against `MISSION.md` §21, criterion by criterion. "Met" means verified, with where;
"Not met" says what is left and whose step it is. This is not a declaration of
unconditional production readiness: the capacity numbers still have to come from the
Kathmandu VPS, and that is the one gate of Phase 10 this report cannot close.

| §21 criterion | State | Evidence / what is left |
|---|---|---|
| The Go + Gin backend builds reproducibly | Met | `deploy/Dockerfile` (pinned Go 1.27.4, Debian trixie, `-trimpath`), built for the Phase 10 multi-instance check; CI builds the image |
| Existing required functionality migrated and verified | Met, with one note | Every route on Go (`TestRoutesMatchWeb`), contract suite recorded from TS and green; 19 jobs shadow-run with zero drift (Phase 9). Note: correctness beyond parity was read per phase for Phases 6–9 and by sweep for 1–5 (`PHASES.md` R27 scope) |
| Web and mobile consume the API through stable contracts | Met for the contract; switch is Phase 11 | Same paths, methods, envelope and field order as TS. Clients still call TS until cut-over |
| Clear, maintainable module boundaries | Met | `internal/modules/*` per domain, `internal/platform/*` for infrastructure, small `cmd/*` |
| Database and Redis connections managed safely | Met | One client each, pool 50, deadlines per request, `ContextTimeoutEnabled` (P10-12); Mongo pool and Redis failures are metrics |
| Caching and rate limiting where justified | Met | Per-user, per-hostel-version cache with singleflight (98.8 % hit rate on cached routes under load); Redis limits shared across replicas, memory fallback; overview report now cached (P10-5) |
| Authentication, authorization and validation tested | Met | Contract suite incl. tenant-isolation cases, `TestAnonymousIsRefused` |
| Critical request paths have measurable performance | Met locally, VPS owed | `testdata/k6/results/`; `Server-Timing` on every response; Prometheus histograms per route |
| Concurrency and resource management tested | Met | `go test -race` over the whole suite; goroutines and memory return to idle after sustained, burst and overload runs |
| Automated tests and static checks pass | Met once CI is green | Local: race suite (see below). CI (`server.yml`) runs gofmt, vet, race tests, staticcheck, govulncheck, image build; it had been red since Phase 6 on gofmt alone (P10-11) |
| Logging, metrics and diagnostics support troubleshooting | Met | slog JSON with request id; superadmin Logs and Cron tabs; Prometheus incl. job runs (P10-10); pprof on loopback |
| Graceful shutdown and dependency failure behaviour verified | Met locally, VPS repeat owed | SIGTERM under load 0 errors; Redis hung, Mongo slow, Mongo hung, overload, hanging provider (`RUNBOOK.md` §4) |
| Production configuration and deployment documented | Met | `ENVIRONMENT.md`, `RUNBOOK.md` (deploy, rollback, alerts, secrets) |
| Multi-instance operation evaluated and tested | Met, one known gap | Two replicas behind Caddy: shared limits, no stickiness, jobs not doubled. Gap P10-9: job lock per replica while Redis is down (single replica is the plan) |
| Background processing without entangling core API logic | Met | `internal/jobs` runner, `cronruns` history, `background.Runner` bounded and drained |
| No critical security or reliability findings unresolved | Met | No Critical or High open in `review_fixes_needed.md`; open rows are Low (P10-8, P10-9) or need the VPS (R32) or CI (R17) |
| Performance claims supported by reproducible measurements | Met locally | `seed-scale.js` + `load.js` reproduce every number; the local box is not production and is never quoted as capacity |
| Documentation describes the implemented architecture | Met | This phase updated `PHASES.md`, `review_fixes_needed.md`, `ENVIRONMENT.md`, `README.md`, new `RUNBOOK.md` and results README |

## Not met, and whose step

1. **VPS numbers (Phase 10 gate).** The p95 budgets "with the Kathmandu–Mumbai round
   trip added", p99 targets and the repeat of the failure table need the VPS. Owner
   step 2 in `review_fixes_needed.md` → "Owner steps left by Phase 10".
2. **Production indexes.** Owner step 1 there: run `cmd/indexes` against Atlas.
3. **Alerting wired to someone.** Owner step 3: Prometheus on the VPS with the
   `RUNBOOK.md` §3 rules.
4. **CI green on `main` (R17).** Pushed with this phase; the run's result is read and
   fixed by Claude until it is green.

## Re-check, 2026-11-05 (owner: "don't believe the ticks, check really")

Checked in code and by running things, not from the trackers:

- **Routes:** `ROUTES_COMPLETE=1 TestRoutesMatchWeb`: TS 630, Go 642, 0 missing. No stub
  handlers, no TODOs. The two TS-only commits since the last intake are in Go.
- **Jobs 19/19, collections 146/146, email templates 95/95.** Every template now has a
  byte-for-byte golden against TS (`TestEveryTemplateMatchesTS`, 190 vectors); that test
  found P11-22 (an unescaped name, Go and TS) and P11-23 (three booking emails drawn
  differently), both fixed.
- **CI was red** on every 2026-11-05 commit (P11-24): two stale recordings and one
  clock-dependent series. Fixed; staticcheck's 7 findings fixed; govulncheck clean.
- **P11-16, P11-17, P11-18 closed** in Go and TS where shared. One carried item: the
  PWA's PIN lock is client-side only until the PWA moves to cookie sessions (client work).
- **Operator tools were never ported** (P11-25): `cmd/ops` and three `cmd/dev` tools now,
  run against the live copy (ledger invariants hold, private documents pass, all 24 live
  finance envelopes reopen under Go's scopes).

| §21 criterion | State on 2026-11-05 |
|---|---|
| Existing required functionality migrated and verified | Met: routes, jobs, collections, templates and operator tools, each checked above |
| Automated tests and static checks pass | Met locally (full suite, staticcheck, govulncheck); CI green is R17, read after the push |
| No critical security or reliability findings unresolved | Met: no Critical or High open; P11-16..18 closed |
| Caching and rate limiting where justified | Met; locks and limits no longer share an evicting Redis with cached bodies |

## Not met on 2026-11-05, and whose step

1. **VPS numbers and the failure-table repeat** (Phase 10 gate): owner, unchanged.
2. **Production indexes, alerting, `REDIS_PASSWORD` in the VPS `.env`**: owner steps in
   `review_fixes_needed.md`.
3. **CI green on `main` (R17)**: Claude, after this push.
4. **Cut-over (Phase 11)**: VPS deploy, rollback lever, OTA base URL, cron-job.org off.
   Owner approves; outward-facing.
5. **Web side (`PARITY.md` §9)** and the PWA cookie-session move: the next piece of work.
6. **Docker on this machine** (P11-27): D: is full; outside the repo.
