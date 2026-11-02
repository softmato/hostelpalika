# Phase 6 — `residents` slice (group 1)

Mount: `internal/router/admin_residents.go`. Cases: `testdata/contract/admin-residents/`. Fixture rows: `internal/contract/fixture/admin_residents.go`
(ids `gid(1, n)`, legend in its header comment).

## Routes done

| Routes | Package | State |
|---|---|---|
| `rooms` GET/POST, `rooms/:roomId` PATCH/DELETE, `rooms/order`, `rooms/tracking`, `rooms/requests` GET, `rooms/requests/:requestId`, `room-types`, `residents/:id/room` | `internal/modules/hostelrooms` | written; contract `rooms.json` recorded when the TS lock allowed — see "Verified" |
| `inquiries` GET, `inquiries/:id/status`, `inquiries/:id/notes` | `internal/modules/inquiries` | written, not yet mounted/recorded |
| `move-events` | `internal/modules/movechecklist/events.go` | written, not yet mounted/recorded |

## Routes left

Everything else in the slice (residents CRUD and sub-routes, existing/join/admission forms, fees, intake quote,
leaving-today, move-in/out, write-off, leave, resident-lookup, resident-scan, bookings). Updated below as they land.

## Bugs fixed (TS and Go)

None logged yet.

## Decisions

- `hostelrooms.Capacity` is the one owner of `Hostel.roomConfigurations`. `Claim` is an atomic `$inc` on the matched row
  (TS read-modify-wrote the whole array, so two admins admitting at once could both take the last bed); `Release`/`Move`/`Write`
  keep TS's array rewrite, then publish `rooms` + `residents` once.
- Bounded reads: floor plan 5000 rooms, live residents 20000, move ledger 20000 residents, room-change queue 1000.
- `localeCompare(numeric)` for room numbers is approximated (`util.go` `numericCompare`): digit runs numeric, letters case-insensitive.

## Gotchas

- Go build failing with `package internal/trace/tracev2 is not in std` is a stale module index: `export GODEBUG=goindex=0`.
- Room-change request, resident-side routes already live in `residentportal`; this slice only has the staff queue.

## Not verified

See the end of the file once the contract runs are done.
