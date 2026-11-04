# READINESS.md — Phase 10 readiness report (2026-11-04)

Against `MISSION.md` §21, criterion by criterion. "Met" means verified, with where;
"Not met" says what is left and whose step it is. This is not a declaration of
unconditional production readiness: the capacity numbers still have to come from the
Kathmandu VPS, and that is the one gate of Phase 10 this report cannot close.

| §21 criterion | State | Evidence / what is left |
|---|---|---|
| The Go + Gin backend builds reproducibly | Met | `deploy/Dockerfile` (pinned Go 1.27.3, Debian trixie, `-trimpath`), built for the Phase 10 multi-instance check; CI builds the image |
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
