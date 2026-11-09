# RUNBOOK.md — Operating the Go API

For whoever is on call. Setup and env vars are in `ENVIRONMENT.md`; this file is what
to do, what to watch and what to do when it breaks. Every behaviour below was checked
on the local stack in Phase 10 (`PHASES.md`) unless it says "VPS: not yet run".

## 1. Deploy

The stack is `deploy/compose.yaml` on the Kathmandu VPS: Caddy, `api` (one or more
replicas), Redis. Mongo is Atlas.

**Automatic: a push to `main` that touches `server/` deploys itself.**
`.github/workflows/server.yml` runs three jobs:

1. **test** — gofmt, vet, race tests with Mongo + Redis (a skipped contract suite
   fails), staticcheck, govulncheck, shellcheck on `deploy/deploy.sh`.
2. **image** — builds `deploy/Dockerfile` once (layer + Go caches kept between runs),
   boots it exactly as production runs it (read-only root, tmpfs `/tmp`, no
   capabilities) against a throwaway Mongo + Redis, checks deep health, the logged
   `revision`, `pdftotext` and `indexes -dry-run`, then pushes
   `ghcr.io/softmato/hostelpalika-api:<sha>` and `:latest`. The VPS never compiles.
3. **deploy** — only when the repo variable `DEPLOY_ENABLED` is `true`. Copies
   `server/deploy/` to the VPS, logs Docker in to GHCR with the job's own short-lived
   token, and runs `deploy.sh <sha>`, which:
   - writes changed config in place (same inode, so Caddy's bind mount sees it);
   - pulls the image, starts Redis;
   - runs `indexes` (create-only and idempotent; a unique index the data breaks stops
     the deploy with the old release still serving — fix the rows, re-run the job);
   - starts the new replicas **beside** the old (`--no-recreate --scale`), waits for
     Docker health, then stops the old ones (SIGTERM drains in-flight work; Caddy
     re-resolves `api` every 5 s and retries a refused connection on another replica,
     so nothing is lost). A replica that never turns healthy is removed and the old
     release keeps serving;
   - starts or reloads Caddy, checks `/api/v1/health?deep=1` through Caddy;
   - records the sha in `~/hostelpalika/deployed.txt` and keeps only the current and
     previous images on disk.

`API_REPLICAS` (default 1) in the VPS shell or `.env` sets the replica count.

**The VPS:** LD Cloud instance `production`, Ubuntu 24.04, 2 vCPU / 4 GB, public IP
`163.128.128.52` NATed into its VPC (private `10.1.1.5`). Outside the box: LD Cloud's
security group allows inbound TCP 22, 80, 443 and UDP 443; Cloudflare DNS has
`api.hostelpalika.com` A → that IP, **DNS only** (grey cloud), because Caddy gets its
own certificate and is the one proxy `TRUSTED_PROXIES` trusts.

**Access.** Two SSH keys, no passwords once set up:
- *admin*: the provider's account (`lduser`) with a key from the operator's machine,
  passwordless sudo. Installed once with the provider password (the only time it is used).
- *deploy*: user `deploy` (docker group), whose key exists only in the GitHub secret
  `VPS_SSH_KEY`. CI logs in as it; nothing else does.

**One-time setup**, in order:
1. Admin key into `lduser`'s `~/.ssh/authorized_keys`.
2. `sudo bash vps-setup.sh '<deploy public key>'` (`deploy/vps-setup.sh`, re-runnable):
   Docker + compose, the `deploy` user and `~deploy/hostelpalika/`, SSH keys-only and no
   root, ufw 22/80/443, overcommit for Redis, unattended security upgrades.
3. `~deploy/hostelpalika/.env` (mode 600, owner `deploy`): production values from
   `ENVIRONMENT.md`, `REDIS_PASSWORD` (`openssl rand -hex 32`), `GO_PATHS` (paths Caddy
   sends to Go; `/api/*` once the web reads Go) and `SCHEDULER_ENABLED` (`true` since
   2026-11-09, when the cron-job.org jobs were disabled — with both on, every job runs
   twice). Shared values
   come from the root `.env`, whose secrets equal the Vercel project's
   (`.env.vercel.import`), so sessions move between Go and the TS standby.
   `CORS_ORIGINS` carries `http://localhost:3000` only while the web is tested locally
   against production; drop it at the web cut-over. Written 2026-11-09.
4. GitHub → Settings → Secrets and variables → Actions: secrets `VPS_HOST`,
   `VPS_USER=deploy`, `VPS_SSH_KEY`, `VPS_KNOWN_HOSTS` (`ssh-keyscan <host>`), optional
   `VPS_PORT`; variable `DEPLOY_ENABLED=true`. Optionally add required reviewers to the
   `production` environment to approve each deploy.

**A branch before it is on main:** Actions → Go server → Run workflow on that branch,
sha empty: test, image and deploy run for it. Push to `main` takes over again after.

**By hand** (same steps, from the VPS as `deploy`): `bash ~/hostelpalika/deploy/deploy.sh <sha>`
after `docker login ghcr.io`.

## 2. Rollback

- **Bad release:** GitHub → Actions → Go server → Run workflow with the previous sha
  (second line of `~/hostelpalika/deployed.txt`): test and image are skipped and that
  image is rolled out the same gapless way. Or on the VPS:
  `bash ~/hostelpalika/deploy/deploy.sh <previous-sha>`. Indexes are additive, so an
  older binary runs on a newer index set.
- **Bad Go side as a whole (before TS is deleted):** remove `GO_PATHS` from
  `~deploy/hostelpalika/.env` (only `/api/v1/health` stays on Go, everything else goes to
  `TS_UPSTREAM`) and, in `~/hostelpalika/deploy`,
  `docker compose --env-file ../.env up -d caddy`. Phase 11 replaces this with the `BACKEND` lever.
- **Bad data write:** restore from the platform backup (`POST /cron/platform-backup`
  writes it; the superadmin Backups screen restores a hostel). Restores are per hostel.

## 3. What to watch (alerts)

Metrics are Prometheus text on `METRICS_ADDR` (`:9090` inside the backend network, never
published). Scrape it from the VPS (node exporter + Prometheus, or Grafana Agent).
Thresholds come from `DESIGN.md` §2 and the Phase 10 targets; tune them once the VPS
shows its real tail.

| Alert | Expression (5 min unless noted) | Why |
|---|---|---|
| 5xx rate | `sum(rate(hostelpalika_http_requests_total{status=~"5.."}[5m])) / sum(rate(hostelpalika_http_requests_total[5m])) > 0.001` | Target: under 0.1 % excluding 4xx |
| Slow p95 | `histogram_quantile(0.95, sum by (le) (rate(hostelpalika_http_request_duration_seconds_bucket[5m]))) > 0.5` | Budget is 300 ms + the Mumbai round trips; 500 ms is the page line |
| Mongo pool exhausted | `increase(hostelpalika_mongo_pool_checkout_failures_total[5m]) > 0` | Pool is 50 per replica; failures mean Atlas or a slow query is holding sockets |
| Mongo failing | `rate(hostelpalika_mongo_command_failures_total[5m]) > 0.1` | Atlas down, network, or a bad query |
| Redis failing | `rate(hostelpalika_redis_failures_total[5m]) > 0.5` | Cache and limits fall back (see §4); not an outage, but limits become per replica |
| Cache hit rate | `sum(rate(hostelpalika_cache_lookups_total{result="hit"}[30m])) / sum(rate(hostelpalika_cache_lookups_total[30m])) < 0.8` | Target over 80 % on cached routes |
| Job failed | `increase(hostelpalika_job_runs_total{status=~"failed|timeout"}[1h]) > 0` | The Cron tab shows the error and the run's log lines |
| Job not running | `increase(hostelpalika_job_runs_total{status="ok"}[2h]) == 0` (on the hourly jobs) | Scheduler off or stuck (`SCHEDULER_ENABLED`) |
| Background backlog | `hostelpalika_background_running > 200` for 5 min | Cap is 256 per replica; above it, work queues on the request |
| Memory | `process_resident_memory_bytes > 850e6` | `GOMEMLIMIT` is 850 MiB of a 1 GB limit |
| Goroutines | `go_goroutines > 2000` for 10 min | Idle is ~20; a steady climb is a leak |
| Rate limiting | `sum by (namespace) (rate(hostelpalika_rate_limited_total[5m])) > 1` | Abuse or a client in a loop |
| Down | `up == 0` or `/api/v1/health` failing from outside for 2 min | — |

**Without Prometheus, job trouble still reaches people:** a scheduled run that fails,
times out or was missed (found at start-up) sends every active superadmin a HIGH bell
notification and a push linking to System → Cron, at most once per job per 6 h
(`jobs:alert:<job>` in Redis). Nothing outside the API can switch a job off.

The superadmin portal shows the same picture without Prometheus: System → Logs (by
level, category, request id) and System → Cron (every run, failures in red).

## 4. When something breaks

All checked on the local stack (`compose.scale.yaml`, numbers in `testdata/k6/results/README.md`); the VPS repeat is owed.

| Failure | What the API does | What to do |
|---|---|---|
| Redis down or hung | Cached reads go to Mongo after at most 150 ms (`cache.Timeout`, enforced on the socket since P10-12); rate limits wait at most 150 ms, then fall back to per-replica memory (so with two replicas a limit is twice as loose); job locks fall back to each replica's own guard (one replica: unchanged; two replicas: a job due during the outage can run on both, P10-9); `/health` 200, `/health?deep=1` 503 | Restart Redis: `docker compose restart redis`. Nothing to recover: it holds only cache, limits and locks |
| Mongo (Atlas) slow | Each request has its own deadline (30 s, longer for listed routes) and answers 504 `TIMEOUT` instead of hanging; the pool (50) caps sockets, `pool_checkout_failures` rises | Check Atlas metrics and the slow-query profiler; `explain` the query from `system.profile`. Scaling the API does **not** help: see §5 |
| Mongo down | Requests that need it fail fast with 5xx; Redis-cached reads still answer until their TTL; `/health?deep=1` 503 | Atlas status page; nothing to restart on our side. The driver reconnects by itself |
| A provider hangs (Softmato, Resend, Expo, maps, LLM, R2) | Every outbound client has a timeout (5–100 s, `review_fixes_needed.md` R11) and request-path calls also inherit the route deadline; work after the response runs in `background` with 5 min per task and 256 at once | Provider status page; nothing to restart |
| Overload | Requests queue on Mongo first; latency climbs, errors stay near zero until the 30 s deadline; after the burst the API recovers on its own (goroutines and memory return to idle) | Find the route in the p95-by-route graph; if it is one report, its cache key or an index is the fix |
| SIGTERM (deploy, `docker stop`) | Listener closes, in-flight requests finish (up to 25 s), background work and running jobs drain, then Mongo closes; compose waits 30 s before SIGKILL. Behind Caddy with two replicas no request is lost | Nothing |
| A job fails | Its `cronruns` row says `failed` or `timeout` with the error; an error line in the `jobs` category carries the run id | Cron tab → the run → its log lines; **Run now** after fixing. Jobs are idempotent per period |

## 5. Scaling

- The API is stateless: sessions are JWTs, cache/limits/locks are in Redis, jobs take a
  Redis lock per run, so any replica serves any request and two replicas do not run the
  same job while Redis is up (checked: two replicas with the scheduler on, `cronruns`
  shows one `ok` and one `skipped` per tick). While Redis is down the lock falls back
  per replica (P10-9): keep one replica with `SCHEDULER_ENABLED=true` if that matters.
- **Where adding API replicas does not help:** in every Phase 10 run the first thing to
  saturate was Mongo, not Go (Mongo at 8 cores while Go used under 2). On Atlas the
  same holds harder: each cache miss pays the Kathmandu → Mumbai round trip per query,
  and an M0/M10 tier caps connections and IOPS. More replicas only add connections.
  The levers are, in order: an index or a cache key for the slow route, fewer round
  trips per request, then a bigger Atlas tier.
- Each replica opens up to 50 Mongo connections (`maxPoolSize`); keep replicas × 50
  under the tier's connection limit.

## 6. Secrets

- The VPS holds `server/.env` (mode 600, owned by the deploy user), read by compose's
  `env_file`. It is never in git, never in the image (`.dockerignore`), never printed:
  the logger never logs tokens, cookies, keys or personal data (`RULES.md` §4).
- Rotation: change the value in `.env`, `docker compose up -d api`. JWT secrets rotate
  with a sign-out of every session (same as TS); `PERSONAL_DATA_KEY` never rotates
  without a re-encryption migration.
- Dev and test never use production Atlas: `config.Load` refuses an Atlas URI unless
  `APP_ENV=production` or the URI's host is `ALLOW_DEV_ATLAS_HOST` (the spare cluster).
- Redis: both instances (`redis` for locks and limits, `redis-cache` for cached bodies)
  require `REDIS_PASSWORD` from the VPS `.env`; `deploy.sh` reads that file for compose
  and stops if the password is missing.

## 6a. Operator tools (`ops`)

`docker compose --env-file ~/hostelpalika/.env run --rm --entrypoint ops api <command>`:
`recover-admin` (`ADMIN_RECOVERY_EMAIL`, `ADMIN_RECOVERY_PASSWORD`, `ADMIN_RECOVERY_CONFIRM=YES`;
ends every session of that account), `rotate-finance-key [-dry-run]` (new key in
`FINANCE_MASTER_KEY`, old in `FINANCE_MASTER_KEY_PREVIOUS`; dry-run first),
`verify-finance-ledger`, `check-private-documents [-strict-missing]`,
`sync-plan-services [-dry-run] slug...`, `check-softmato -api URL` (local Softmato only).

## 7. Tracing decision

Request id through logs is the tracing: Caddy sets `X-Request-Id`, every log line and
`cronruns` row carries it, and System → Logs looks it up. `Server-Timing` splits each
response into app, db and redis time. OpenTelemetry is not added: no incident so far
needed more than id + timings, and it would cost a collector on a single VPS. Add it
when one does.

## 8. Profiling

`PPROF_ADDR` (loopback only; config refuses anything else). The runtime image has no
curl, so borrow one that shares the replica's network namespace:
`docker run --rm --network container:hostelpalika-api-1 curlimages/curl -s "localhost:6060/debug/pprof/profile?seconds=30" > cpu.pprof`
then `go tool pprof`. Phase 10's findings from profiling are P10-7 and P10-8.
