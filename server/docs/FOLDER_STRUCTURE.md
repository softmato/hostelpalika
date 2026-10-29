# FOLDER_STRUCTURE.md — Layout of `server/`

```
server/
├── go.mod / go.sum
├── cmd/
│   ├── api/            main.go — boot config, clients, router, scheduler; graceful shutdown
│   ├── indexes/        builds Mongo indexes (takes over from `db:indexes` at cut-over)
│   ├── ops/            recover-admin, rotate-finance-key, verify-finance-ledger, check-private-documents, …
│   └── dev/            generate-vapid, mint-session, send-test-emails
├── internal/
│   ├── platform/       cross-cutting, no business rules
│   │   ├── config/     typed env, validated at boot
│   │   ├── httpx/      envelope, errors, validation shaping, ETag, Server-Timing, streaming/NDJSON
│   │   ├── auth/       JWT, refresh rotation, purpose tokens, cookies, bcrypt, PIN
│   │   ├── authz/      principal, roles, capabilities, guards (Gin middleware), hostel scope
│   │   ├── mongo/      client, transactions helper, common filters
│   │   ├── cache/      Redis read cache, version bump, singleflight
│   │   ├── ratelimit/
│   │   ├── background/ tracked goroutines + shutdown drain (`afterResponse`)
│   │   ├── bs/         Bikram Sambat calendar, hostel day, night window
│   │   ├── money/
│   │   ├── crypto/     personal data, finance secrets, sealed archives
│   │   ├── storage/    R2 (public + private), presign, upload verification
│   │   ├── email/      Resend sender, identity, opt-out, daily cap, templates/
│   │   ├── push/       Expo + Web Push fan-out, receipts
│   │   ├── realtime/   Pusher publish + channel auth, topics
│   │   ├── docs/       images (govips), PDF out/in, xlsx, csv, zip, qr, ID cards
│   │   ├── llm/        provider pools, search quota
│   │   ├── maps/       geocoding, nearby places, routing, upstream politeness
│   │   └── log/        slog setup, redaction
│   ├── modules/        one folder per TS module, same names
│   │   ├── auth/
│   │   ├── residents/
│   │   ├── finance/
│   │   └── …           (37 — PARITY.md §4)
│   ├── jobs/           the 19 scheduled jobs + scheduler wiring
│   └── router/         every route registered, grouped like PARITY.md §6
├── testdata/
│   ├── contract/       recorded TS request/response pairs, per route
│   ├── vectors/        BS calendar, money, crypto vectors generated from TS
│   └── golden/         email, PDF, image outputs
├── deploy/
│   ├── Dockerfile
│   ├── compose.yaml
│   ├── compose.local.yaml  overlay: local Mongo replica set, Caddy on localhost, ports for go test
│   ├── copy-live-db.ps1    read-only dump of live Atlas → local `hostelpalika_dev` (no seeds)
│   ├── Caddyfile
│   └── redis.conf
└── docs/               this folder
```

## Inside a module

```
internal/modules/notices/
├── handler.go      Gin handlers: bind → guard already applied → service → httpx.OK
├── service.go      business rules; the only place that calls repo + side effects
├── repo.go         Mongo queries for this module's collections
├── model.go        bson structs + defaults/hooks (DATABASE.md §3)
├── dto.go          request/response shapes with json tags matching TS
├── routes.go       Register(r *gin.RouterGroup, deps) — paths identical to TS
└── *_test.go
```

Split a file only when it outgrows one screen of purpose (e.g. `finance/` will
have `invoice_service.go`, `receipt_service.go`, …) — mirroring the TS module's
own files is the default.

## Ownership

- `internal/platform/*` never imports `internal/modules/*`.
- A module may import another module's **service** (as TS modules do), never its
  repo.
- `router/` is the only place that knows every path.
