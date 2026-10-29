# CHANGELOG.md — server/

Newest first. One entry per closed phase gate, plus any decision that changes
these docs.

## [Unreleased]

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
