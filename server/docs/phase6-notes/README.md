# Phase 6 — brief for the parallel sessions

The lead session (Opus) ports finance itself and verifies everything at the end. The
owner is asleep: nobody will answer a question. Make the decision, write it in your notes
file, keep going. You can message the lead only for a real blocker.

Read `server/docs/RULES.md` and the "How to work here" and "Known gaps" sections of
`server/docs/MEMORY.md`. Skip the rest of `docs/`, including `MISSION.md`'s long brief.
Its rules that bind you are below.

**Do not waste tokens, and do the work properly.** No narration, no recaps, no subagents, no
broad searches. Read the TS route, then the service it calls, then the model, once each;
read a big file by section. Copy the idiom of the nearest ported module. Patch with targeted
edits; never re-read a file you just wrote. Run the smallest check that proves the thing.

## The job

Port every route of your slice from `apps/web/src/app/api/v1/hostel-admin/` to Go. TS at
`HEAD` is the spec, not `PARITY.md`'s older baseline. For each route, in this order:

1. Read route + service + model. Note every side effect: rows, notifications, pushes,
   emails, realtime, cache bumps, audit entries, their order.
2. Write cases in `server/testdata/contract/admin-<slice>/<file>.json`: happy path, no
   token, wrong role, a hostel outside the caller's scope (404, not 403), invalid body,
   edge cases from the code. After a write, add a GET case that reads the row back, because
   the suite diffs responses only. See `testdata/contract/resident/` for the format.
3. Record from the TS server. Then write the Go, then replay until green.
4. Mount it in `internal/router/admin_<slice>.go`, your own file. `s *shared` has every
   service `mountAPI` built. Use `s.Guards`, same guard as the TS route.

**The bug rule (`RULES.md` §2).** Never copy a TS bug because it is the spec. Fix it in Go
in the best way and in TS with the smallest edit that stops the harm, correct the contract
case by hand with its `corrected` field set to your finding id, and check `apps/web` and
`apps/mobile` before changing a status or field. Think about correctness as you read, not
just parity: wrong scope, lost writes, money rounding, races, a missing bump.

**Production grade while porting:** bounded reads (`SetLimit` or stream; never an unbounded
`.All` on a hostel's whole collection), `background.Runner` and never a bare `go`, no ignored
write in a critical path, a transaction where a partial write would lose money, every query
on hostel data filtered by the caller's scope (`RULES.md` §3), never log personal data. A
route past 30 s gets a `routeBudgets` line in `router.go`. Paths and methods stay exact.

**Docs:** do not edit `PARITY.md`, `PHASES.md`, `MEMORY.md`, `CHANGELOG.md` or
`review_fixes_needed.md`. Write only `server/docs/phase6-notes/<slice>.md`: routes done,
routes left and why, bugs fixed (id `<slice>-1`, file:line, what was wrong, Go and TS fix),
decisions, gotchas, what is not verified. Keep it short. No durations anywhere.

## Sharing one checkout: these rules keep five sessions from breaking each other

- **Never** run `git add`, `commit`, `stash`, `checkout`, `reset`, `clean`, `restore`, push, or
  anything that changes the index or the tree. The lead commits.
- **Own only your files.** You own your slice's packages below. To use something from
  another slice's package that does not exist yet, add it in a new file there named
  `<slice>_<what>.go`, add-only, and list it in your notes. Never edit their existing files.
- **The package must compile after every file you save.** Write bottom-up, callees first,
  `Register` and mount last. Run `go build ./internal/modules/<pkg>` after each file. All
  sessions link into the router test, so a broken package stops all of them.
- If the router test will not build because of another slice's package, do not touch it. Do
  other work and retry.
- `go mod tidy` and new dependencies: do not. If you truly need one, write why in your notes
  and message the lead.
- Only `gofmt -w` your own files.

**This machine has 7.7 GB of RAM and little disk.** Never run `tsc`, `eslint`, `next build`,
`go test ./...`, `go vet ./...`, or `-race`. The lead runs those. Focused `vitest` on one file
is fine after a TS fix. If the linker says "cannot open file", check the disk: run
`go clean -cache` only if C: has under 3 GB free.

## Commands

Git Bash. `<slice>` is yours, e.g. `residents`.

```bash
cd /d/hostel-management-software/server
export PATH="/c/Program Files/Go/bin:/c/msys64/ucrt64/bin:$PATH" GOFLAGS=-p=2 GIN_MODE=release CONTRACT_DB=hostelpalika_contract_<slice>
go build ./internal/modules/<pkg>
go run ./cmd/dev record -base http://localhost:3100 -baseline "$(git rev-parse --short HEAD)" -fixture testdata/contract/admin-<slice>/<file>.json
go test -tags=sonic -run 'TestContract/admin-<slice>' ./internal/router
go test -tags=sonic -run 'TestRoutesMatchWeb|TestAnonymousIsRefused' ./internal/router
ROUTES_LIST=/tmp/routes-<slice>.txt go test -tags=sonic -run TestRoutesMatchWeb ./internal/router
```

The last one writes every route not ported yet; `grep` it for your routes.

- **One TS server** answers on `:3100`, against the recording database, and **`-fixture` takes
  a lock**, so a recording may wait for another session's. Record whole files in one run.
  Next compiles a route on its first hit, so a first run can time out: run it again. If
  `:3100` is down, start it in the background: `bash server/testdata/contract/record-ts.sh`.
- `CONTRACT_DB` gives your replay its own database. Never point anything at the root `.env`'s
  URI: that is production.
- **Your rows:** the base fixture is shared and must not change, because a new row would alter
  what others recorded. Put yours in `internal/contract/fixture/admin_<slice>.go`:

```go
func init() {
	groupSeeds["admin-<slice>"] = func(ctx context.Context, db *mongo.Database, now time.Time) error {
		return insertAll(ctx, db, map[string][]any{"rooms": {bson.D{{Key: "_id", Value: gid(N, 1)}, ...}}})
	}
}
```

Group numbers for `gid(N, n)`: residents 1, ops 2, stock 3, setup 4, finance 5. The base
fixture's hostels, users and helpers are all usable; read `fixture/fixture.go` and
`resident.go` once. TS in-memory rate limits survive between recordings: give a limited
route's cases a fresh `user-agent`.

## Slices

| Slice | Routes under `hostel-admin/` | Owns |
|---|---|---|
| `residents` (52) | `residents` 30, `rooms` 8, `room-types`, `resident-lookup`, `resident-scan` 2, `move-events`, `inquiries` 3, `bookings` 6. Plus `tenant-isolation.test.ts` resident cases | `residents`, `arrivals`, `bookings`, new packages you make |
| `ops` (43) | `maintenance` 6, `attendance` 6, `notice-pushes` 5, `notices` 3, `food` 3, `complaints` 3, `sos-alerts` 2, `night-status` 2, `community` 4, `cooks` 5, `cook-portal` 2, `notifications` 2. Plus the notices, complaints (incl. summary aggregate) and maintenance tenant cases | `notices`, `complaints`, `safety`, `attendance`, `food`, `community`, `kitchen`, new packages |
| `stock` (47) | `stock` 15, `reports` 12, `expenses` 9, `wardens` 4, `service-providers` 2, `referrals` 3, `hostel-referrals` 2. Exports live with reports | `stock`, `reports`, `expenses`, `serviceproviders`, `referrals`, `hostelreferrals`, new packages |
| `setup` (40) | `kyc` 6, `leave` 3, `backup` 9 (Drive OAuth callback), `settings` 2, `profile` 6, `branches` 5, `billing` 6, `subscription`, `payout-account` 2 | `hostels`, `hostelleave`, `billing`, new packages |
| `finance` (41) | `finance` 41. **The lead's own** | `finance`, `residentfinance`, `khata` |

`notifications`, `platformconfig`, `users`, `email` and `platform/*` are shared: add-only, in a
`<slice>_<what>.go` file, for what no other file has yet.

`tenant-isolation.test.ts` is in `apps/web/src`; port your cases as Go tests against the fixture.

Owner's recent TS changes to catch where they meet an existing Go file (`git diff 6281d03d
dfb807f1 -- <path>`): `stock` slice `modules/reports/report.service.ts` and
`modules/hostel-referrals/hostel-referral.service.ts`; `setup` slice
`modules/hostels/hostel-branch.service.ts`. The lead handles finance, guardian, suspension and
saved-hostels.

## When you are done

Done means every route of your slice is mounted and green in `TestContract/admin-<slice>`,
with `TestRoutesMatchWeb` and `TestAnonymousIsRefused` green and your notes file written. Then
end your turn with a short report: routes done, routes left and why, bugs fixed. Report what you
actually ran, and call out anything not verified.
