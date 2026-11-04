# k6 results

**A local number is never production capacity** (`MISSION.md` §12, §19). These runs
show behaviour (errors, recovery, what saturates first) and catch regressions; the
capacity numbers come from the Kathmandu VPS run (`review_fixes_needed.md`, Open items).

| File | What |
|---|---|
| `ts-prod-2026-10-29.json` | TS on Vercel, read-only baseline from this machine (`baseline.js`) |
| `go-local-{cold,warm,sustained,burst}.json` | Go, Phase 10 mixed workload (`load.js`), 2026-11-04 |

## Workload (derived before testing)

From `usagedailies` on the live copy (2026-11-04): a hostel admin averages ≈170 actions
a day (131 views + 40 uses), a resident ≈19; each action is ≈3 API calls. The busiest
hour in `usageevents` carries ≈16 % of a day. Planning point: 500 hostels × 40
residents → ≈1.45 M requests a day → **≈64 req/s at the peak hour**, ≈200 req/s for a
short burst. `load.js` mixes residents ≈60 %, admins ≈20 %, public ≈20 %.

## Environment (every Go run below)

Windows 11 dev box shared with other sessions: 8 logical CPUs, 7.4 GB RAM with ~0 GB
free and ~90 % CPU used by other processes before the runs started. Go `api.exe`
(sonic), Mongo 8.0 single-node replica set in Docker (3.5 GB VM), Redis 7 and k6 all on
that one host. Database `hp_p10_load` = live copy + `seed-scale.js`: one hostel grown to
385 residents with 24 months of paid rent (8.7k invoices, events, balances, receipts),
23k attendance logs, 300 notifications. One admin token and one resident token.

## Go, after the Phase 10 fixes (2026-11-04)

| Mode | Target | Requests | Throughput | Errors | p50 / p95 / p99 ms |
|---|---|---|---|---|---|
| cold (Redis flushed) | ramp to 40/s, 60 s | 1,229 | 20.5/s | 0 | 10 / 39 / 57 |
| warm | 40/s, 60 s | 2,502 | 38.5/s | 0 | 10 / 48 / 103 |
| sustained | 70/s, 180 s | 12,847 | 67.6/s | 0 | 19 / 330 / 1,102 |
| burst | 70 → 250 → 70/s | 23,015 | 134/s avg | 0 | 18 / 409 / 1,768 |

Resources: RSS 57 MB after sustained, 76 MB after burst; goroutines back to 20 after
each run (no leak); Mongo pool checked-out back to 0; cache hit rate 98.8 % on cached
routes. k6 dropped 107 (sustained) and 239 (burst) iterations: the generator itself ran
out of VUs on the starved host, not the API refusing.

What saturates first: **Mongo**. During the pre-fix runs Mongo held all 8 cores
(`docker stats` 800 %) while the Go process used ~1.6 cores, most of it scheduler waits.
Scaling the API does not help there; see the multi-instance note in `docs/RUNBOOK.md`.

## Before the fixes (same box, same data)

`hostel-admin/reports/overview` took **11.6 s** alone; a sustained 70/s run reached
p50 4.8 s / p95 21 s with 2.2 % errors as Mongo saturated. Fixed by P10-2..P10-6
(`review_fixes_needed.md`): overview 0.46 s uncached, cached per user after.
