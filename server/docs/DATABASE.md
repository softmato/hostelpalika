# DATABASE.md — Go on the existing MongoDB

The schema is defined by `packages/db/src/models/*.ts` (146 models) and
described in the root `docs/DATABASE.md`. Go does not own the schema until
cut-over; it reads and writes the same collections the TS server does, at the
same time.

## 1. Connection

- One `mongo.Client` per process, created at boot, closed on shutdown.
- `minPoolSize` > 0 (warm connections), `maxPoolSize` within the Atlas tier's
  connection limit **minus the TS server's share** while both run.
- Timeouts come from the request context; never `context.Background()` in a
  handler.
- Atlas region: Mumbai; the VPS is in Kathmandu, so every query crosses the
  border — Redis-first reads and parallel queries beat query micro-tuning. M0
  (shared, throttled, no backups) caps latency and is an outside constraint;
  a dedicated Atlas tier is the big DB win. Atlas stays in Mumbai — Nepal VPS
  providers offer no managed database (user, 2026-10-29).

## 2. Mapping rules

| Mongoose | Go |
|---|---|
| `_id` ObjectId | `bson.ObjectID` with `bson:"_id"`; JSON as hex string, same as TS |
| `String` | `string`; optional → `*string` when TS distinguishes absent from `""` |
| `Number` (money) | `int64` paisa |
| `Number` (other) | `int64` or `float64` matching what is actually stored — check a real document |
| `Date` | `time.Time` (UTC in the DB; Nepal time only at the edges via `internal/platform/bs`) |
| `Boolean` | `bool` / `*bool` when absent means something |
| `Mixed` / free-form | `bson.M` or `bson.Raw`; never guess a struct |
| `enum` | typed `string` constants + validation on write |
| `ref` | `bson.ObjectID`; populate is an explicit second query or `$lookup` |
| subdocument arrays | slices of structs |

Field names: `bson` tags equal the stored field names exactly; `json` tags equal
what the TS route returns (which may differ — e.g. `id` vs `_id` after
`toJSON`). Check the TS serializer for each route.

## 3. What Mongoose did for free — and Go must do by hand

Before porting a model, list these for it from its `.ts` file and reproduce each:

- ☐ `timestamps: true` → set `createdAt` on insert, `updatedAt` on every update
- ☐ `default:` values → applied in the Go constructor for that document
- ☐ `required`, `min`, `max`, `match`, `enum` → validated before write
- ☐ `pre('save')` / `pre('validate')` / `post(...)` hooks → explicit calls in the service
- ☐ virtuals and `toJSON` transforms → done in the response DTO
- ☐ `select: false` fields → never projected unless the TS code asks for them
- ☐ `lowercase` / `trim` setters → applied on write
- ☐ discriminators → explicit type field handling
- ☐ `versionKey` (`__v`) → left as Mongoose leaves it; never reset

A model is ☑ in `PARITY.md` §7 only when a document written by Go reads back
identically through Mongoose, and the reverse.

## 4. Queries

- Always project only the fields the response needs.
- No N+1: batch with `$in`, or one aggregation with `$lookup`.
- Every query used on a hot route has an index; check with `explain()` before
  ticking the route.
- Tenant filter (`hostelId` scope) is part of the query, never a post-filter.
- Multi-document money writes use transactions where TS uses them, and only there.

## 5. Indexes

`autoIndex` is off — indexes are a migration (`db:indexes`). Until cut-over the
TS script stays the source of truth. At cut-over, `cmd/indexes` takes over with
the same definitions (name, keys, options, partial filters, TTLs such as the
`OtpChallenge` TTL index).

## 6. Encrypted fields

Fields encrypted with `PERSONAL_DATA_ENCRYPTION_KEY` (e.g.
`Resident.detailsData`) and `EncryptedSecret` rows under `FINANCE_MASTER_KEY`
keep their exact byte layout (IV, auth tag, ciphertext order and encoding).
Before porting, decrypt real-format samples produced by TS in a Go test.
