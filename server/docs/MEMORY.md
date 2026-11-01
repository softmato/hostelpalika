# MEMORY.md — where the Go server stands

Read this after README.md. Update it at the end of every session.

## State (2026-11-01)

- **`MISSION.md` is the owner's binding brief: read it first.** The owner's bug rule replaced "TS is the spec, even its bugs": a TS bug is fixed in Go in the best way and in TS too (`RULES.md` §2); paths and methods stay exact.
- **Phases 0–5 reviewed; `review_fixes_needed.md` is the list, ticked one by one.** Added: `httpx/guard.go` (body limit, deadline, security headers, JSON 404), `obs/metrics.go` (`METRICS_ADDR`), `background.Parallel`, IP-wide limiter budget, `TestRoutesMatchWeb`, `TestAnonymousIsRefused`, `.github/workflows/server.yml`. New route past 30 s → `routeBudgets` in `router.go`.
- **Roadmap:** Phase 6 is next. New Phase 10 = production grade (measured), Phase 11 = cut-over. Phase 7 carries the superadmin log viewer.
- Measured: 613 TS method+path pairs, 179 on Go, 0 mismatched, 434 to port (`hostel-admin` 223, `platform` 123, cron 19, `users` 18, `team` 16, `store` 16). `ROUTES_LIST=<file> go test -run TestRoutesMatchWeb ./internal/router` writes the list.
- **All repo work is Claude's; outside work Claude does what it can reach and the owner mostly helps or does the rest (`MISSION.md` addition 4).** Phase 6 starts with the "Open items" table in `review_fixes_needed.md`.
- Uncommitted TS work (`saved-hostels`, `PLAN_OVERDUE`, finance, branches, `bs.ts`) is not in the intake: Claude runs it from the working tree at the start of Phase 6. Go's `bs.FormatDate` already follows the uncommitted `bs.ts`, so TS at HEAD still prints the old date format until the owner's change lands.
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
