Finish Phase 7 of the Go server ("Platform, team, store, users" in `server/docs/PHASES.md`) completely, so that every phase up to 9 can be called done. Phases 8 and 9 are already done and pushed (`bcba5ad0`). Phase 10 runs in a different session on its own branch: don't touch its work.

Read first, in order: `server/docs/MISSION.md` (binding), `server/docs/RULES.md`, Phase 7 in `server/docs/PHASES.md`, `server/docs/review_fixes_needed.md` (Phase 7 findings), then the design references listed in the repo `CLAUDE.md` before any app screen.

## Where it stands (2026-11-04)

- Every TS route is ported to Go. `TestRoutesMatchWeb` passes; the full contract suite was green apart from one date-dependent case, now masked.
- `server/docs/PARITY.md` §6: 267 stale ☐ rows were ticked, because their contract cases already exist and pass. That edit is **uncommitted** in the main checkout. Check it with `git diff server/docs/PARITY.md` and commit it.
- New contract group `admin-finance` (fixture `server/internal/contract/fixture/admin_finance.go`, group id 16; cases `server/testdata/contract/admin-finance/money.json`, 34 cases recorded against TS) is **uncommitted**. It covers the claim queue, approve, reject, bulk-approve, reverse, invoice cash and void, and the receipt PDF. Run `go test -run 'TestContract/admin-finance' ./internal/router/`. Make Go match wherever it differs: TS is the spec, and a TS bug is fixed in both (`RULES.md` §2). Then tick those PARITY rows. Last run: 31 of 34 match. Left:
  - `cash` and `cash same receipt`: Go's `receipt` object lacks fields TS returns (`__v`, `certifiedAt` and the rest of the Mongoose document). Match TS's shape and key order.
  - `receipt pdf bad id`: TS answers 404 `NOT_FOUND` "Not found"; Go answers `RECEIPT_NOT_FOUND` "Receipt was not found.". Match TS.
  - **Money bug, both servers:** `cash same receipt` posts the same `cashReceiptNumber` twice and both servers settle it again (`settledAmount` 1200 on a 600 invoice), although the schema calls the paper receipt number the idempotency key. Log it as a Phase 7 finding and fix it in TS and Go (the second post returns the first result and records nothing), then re-record that case.
- Rows in §6 that still have **no contract cases** (find them with the coverage script described below):
  - `hostel-admin/branches` (GET/POST), `branches/:branchId`, `branches/names`, `branches/summary`
  - `hostel-admin/notice-pushes` (GET/POST), `notice-pushes/:id` (DELETE/PATCH), `notice-pushes/:id/send`
  - `store/cart` DELETE, `store/cart/items/:productId` DELETE
  - `team/geocode`, `team/hostels/:id/existing-residents` (DELETE/PUT), `.../existing-residents/add`, `.../existing-residents/file`
  - the 19 `POST /cron/*` doors: record no-secret and wrong-secret refusals for each, plus one harmless real run (`purge-expired-otps`). The jobs' behaviour is already proven by `dev shadow-phase9`
  - the 5 `(non-v1)` web routes stay in Next.js by design (PARITY §6 says so). Confirm that and tick them with that note
- Phase 7 items in PHASES.md still ☐: `platform` (99), site config / SEO / page copy editors, referrals / offer program / subscriptions / manual plan-payment review (their routes are covered now, so these tick once their PARITY rows are ☑), **server logs in the superadmin portal** and **superadmin system tabs**. The web side of both is done (Logs, Process, Cron, Active users, Analytics under *System*). What's left:
  1. **Native app superadmin shell** (owner decision 2026-11-03, memory `superadmin-in-the-app`): the app sends SUPERADMIN to the browse shell today. Build a superadmin shell from `PLATFORM_NAV` (`apps/web/src/lib/portal-nav.ts`), following `admin-tabs-mirror-portal-nav` and the mobile rules in `CLAUDE.md` (black/white/green palette only, icon-tile grids, skeletons not spinners, bottom sheets, reuse `apps/mobile/src/components/ui/`). It needs native `manage` screens for Logs (filters, level and category chips, the full entry, *Whole request*, the health strip), Process, Cron (job rows, missed flag, Run now, run history, a run's error and log lines) and Active users. The other platform pages can be the shell's tiles, opening native screens where they exist.
  2. **PWA client value**: the PWA's usage beacon must send its own `client` (today it counts as `app`), so Active users splits app / PWA / web.
- **Phase 4**, outside work, owner only: `COOKIE_DOMAIN=.hostelpalika.com` on Vercel plus a deploy. Leave it ☐ and say so.

## How to work

- Recording: Docker up (`docker start hostelpalika-mongo-1`), then `bash server/testdata/contract/record-ts.sh` in the background from the repo root (TS on :3100 against the contract DB). Warm each new route with curl first (`MSYS_NO_PATHCONV=1`), because Next compiles on first hit and the recorder times out. Build `server/bin/dev.exe`, then `PATH=/c/msys64/ucrt64/bin:$PATH server/bin/dev.exe record -base http://localhost:3100 -baseline <short sha> -fixture <file.json>` from `server/`. New groups get their own fixture group id (`gid(n, …)`; 16 is taken, use 17+) through `extendGroup`, so other groups' recordings don't change. Day-dependent values (receipt numbers, prorated amounts) need a `masks` path on that case. Use `capture` to reuse ids minted by earlier cases.
- Coverage check: parse every `testdata/contract/*/*.json` case with a recorded response into a set of (method, path), with `{{…}}` treated as a path segment. A §6 row is ☑ only when every one of its methods matches a recorded case and the contract test passes.
- Go tests on this machine: `PATH=/c/msys64/ucrt64/bin:$PATH go test -p 2 -timeout 30m ./...` (the router package takes ~10 min). Never run it beside tsc or vitest (out of memory); tsc needs `NODE_OPTIONS=--max-old-space-size=8192`.
- Mobile UI is proven by an adb screenshot beside the reference on the owner's phone (memory `verify-on-device-not-lint`). Ask before using the device, because it's their daily phone. Never start `eas build`/`submit`/`update`.
- Rules: no durations in any doc or message; the codebase is never a reason something can't be done; targeted reads; commit messages carry **no** Co-Authored-By Claude line; just push (deploys are automatic).

## The full checklist: every item, nothing else is left

Work through it in order and tick each one here and in the tracker files as it is verified. When every box is ticked, Phases 0–9 are done (Phase 4's Vercel step excepted).

**A. Commit what is already done**
- [x] Check and commit the 267 PARITY §6 ticks (`git diff server/docs/PARITY.md`)

**B. Hostel-admin finance (contract group `admin-finance`, recorded, 31/34 green)**
- [x] `GET /hostel-admin/finance/events` (claim queue)
- [x] `POST /hostel-admin/finance/events/:id/approve`
- [x] `POST /hostel-admin/finance/events/:id/reject`
- [x] `POST /hostel-admin/finance/events/:id/reverse`
- [x] `POST /hostel-admin/finance/events/bulk-approve`
- [x] `POST /hostel-admin/finance/invoices/:id/cash`: match the receipt object shape
- [x] `POST /hostel-admin/finance/invoices/:id/void`
- [x] `GET /hostel-admin/finance/receipts/:id/pdf`: match TS's 404 for a bad id
- [x] Fix the duplicate cash receipt bug in TS and Go (same `cashReceiptNumber` settles twice), log it as a finding, re-record

**C. Hostel-admin branches (new contract cases)**
- [x] `GET` and `POST /hostel-admin/branches`
- [x] `GET /hostel-admin/branches/:branchId`
- [x] `GET /hostel-admin/branches/names`
- [x] `GET /hostel-admin/branches/summary`

**D. Hostel-admin notice pushes (new contract cases)**
- [x] `GET` and `POST /hostel-admin/notice-pushes`
- [x] `PATCH` and `DELETE /hostel-admin/notice-pushes/:id`
- [x] `POST /hostel-admin/notice-pushes/:id/send`

**E. Store cart (add cases to group `store`)**
- [x] `DELETE /store/cart`
- [x] `DELETE /store/cart/items/:productId`

**F. Team (add cases to group `team`)**
- [x] `GET /team/geocode` (outbound blocked or faked in the recording)
- [x] `PUT` and `DELETE /team/hostels/:id/existing-residents`
- [x] `POST /team/hostels/:id/existing-residents/add`
- [x] `POST /team/hostels/:id/existing-residents/file`

**G. The 19 cron doors (new group `cron`)**
- [x] For each of `platform-push`, `gateway-expiry-sweep`, `notification-dispatch`, `meal-call-reminders`, `night-status-prompt`, `push-receipts`, `refresh-nearby-places`, `customer-backup`, `billing-cycle`, `payment-reminders`, `purge-expired-otps`, `account-purge`, `hostel-purge`, `ledger-drift`, `complaint-sla`, `attendance-maintenance`, `gateway-health`, `gateway-settlement-recon` and `platform-backup`: record a no-secret refusal and a wrong-secret refusal
- [x] One real run with the secret (`purge-expired-otps`), and `platform-backup` with an invalid body (422)

**H. Non-v1 web routes**
- [x] `/api/apple-app-site-association`, `/api/receipt-share`, `/get-app`, `/llms.txt`, `/llms-full.txt`: tick each with the note "stays in Next.js" (PARITY §6 says so)

**I. Phase 7 items in `PHASES.md`**
- [x] `platform` (99) and the other route lines: tick once every PARITY row above is ☑
- [x] Site config, SEO config and page copy editors: tick once their routes are ☑
- [x] Referrals, offer program, subscriptions, manual plan-payment review: tick once their routes are ☑
- [x] **Native app superadmin shell**: SUPERADMIN gets its own shell from `PLATFORM_NAV` (not the browse shell)
- [x] Native **Logs** screen: filters, level and category chips with counts, full entry, *Whole request*, health strip, level per category
- [x] Native **Process** screen
- [x] Native **Cron** screen: job rows, missed flag, Run now, run history with filters, a run's error, counts and log lines
- [x] Native **Active users** screen (DAU/WAU/MAU by role and client, who was active on a day)
- [x] Native **Analytics** reachable from the shell (existing usage screen)
- [ ] Each native screen verified by an adb screenshot beside its reference (ask before using the phone) — **owner, 2026-11-04: "do code for screen, i will do ota later"**: code done, checked on device after the owner's OTA
- [ ] **PWA client value**: the PWA's usage beacon sends its own `client`, so Active users splits app / PWA / web; verified with a real PWA event in `usageevents` — code done (web stand-in `web/usage-client.ts`); the live export still sent `app` (built before the change), so this waits for the redeploy and the owner opening the PWA signed in
- [x] The two Phase 7 items (server logs, system tabs) ticked, with their "Left:" notes updated

**J. Phase 4 (owner only, leave ☐)**
- [x] State in the final report that `COOKIE_DOMAIN=.hostelpalika.com` on Vercel plus a deploy is the owner's step

**K. Close out**
- [x] `PATH=/c/msys64/ucrt64/bin:$PATH go test -p 2 -timeout 30m ./...` all green
- [x] Web `tsc` (with `NODE_OPTIONS=--max-old-space-size=8192`) and lint on touched files clean; mobile typecheck and lint clean
- [x] Findings in `review_fixes_needed.md` (Phase 7 section), the `CHANGELOG.md` Phase 7 entry marked done, `PHASES.md` and `PARITY.md` ticked
- [x] Memory updated (`go-phase7-state`, `MEMORY.md` index)
- [x] Committed (no Co-Authored-By Claude line) and pushed
- [x] Final message to the owner: a table of Phases 0–9 with each one's state, saying plainly that everything up to Phase 9 is done apart from the Phase 4 Vercel step
