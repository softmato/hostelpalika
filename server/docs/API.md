# API.md — Wire contract

The per-endpoint contract is the TypeScript server at the `PARITY.md` baseline,
with the route list in `PARITY.md` §6 and descriptions in the root
`docs/API.md`. This file fixes the rules every endpoint shares, so the Go server
produces the same bytes.

## 1. Base URL

| Environment | Base |
|---|---|
| Production | `https://api.hostelpalika.com` |
| Local | `http://localhost:8080` (direct) or `https://localhost` (through Caddy) |

All paths keep their current form: `/api/v1/...`.

## 2. Response envelope

Success:

```json
{ "success": true, "message": "Notices loaded", "data": { } }
```

Error:

```json
{ "success": false, "message": "Validation failed", "errorCode": "VALIDATION_ERROR", "details": { } }
```

- `message` defaults to `"Request successful"` when a route gives none.
- `details` is **absent** (not `null`) when there are none.
- Messages are the TS messages, word for word — the apps show some of them.

## 3. Validation errors

`422`, `errorCode: "VALIDATION_ERROR"`, `message: "Validation failed"`, and
`details` in zod's `flatten()` shape plus the issue list:

```json
{
  "formErrors": [],
  "fieldErrors": { "title": ["Title is required"] },
  "issues": [{ "message": "Title is required", "path": "profile.title" }]
}
```

`fieldErrors` buckets by **top-level** key only (zod's behaviour); `issues[].path`
is the full **dot-joined** path. Both are needed — the clients use each.

Go validators must produce the same field keys and the same messages; the
recorded contract tests include at least one invalid body per route that takes
a body.

## 4. Error codes and statuses

Errors carry `status` + `errorCode` (+ optional `details`) exactly as TS throws
them. Anything unrecognised is `500` with the generic message; the reason goes
to the log, never the body. `SoftmatoApiError` passes Softmato's status and
message through, as TS does.

`423` carries several meanings that clients branch on by `errorCode`:
`LOCK_PIN_REQUIRED` (a cookie session whose app-lock PIN hasn't been typed),
`KYC_REQUIRED` (a KYC-frozen write), and the suspended-hostel block. Grep
`423` across `lib/` and `modules/` before porting a guard.

## 5. Authentication

| Client | Sends |
|---|---|
| Browser (web) | cookies `hostelpalika_access_token`, `hostelpalika_refresh`, `hostelpalika_unlock` (legacy `hostelhub_*` read as fallbacks), `credentials: "include"` |
| App / PWA | `Authorization: Bearer <access>`, `x-hostelhub-client`, `x-hostel-id` when acting in a hostel |
| Cron / internal | `x-cron-secret` |
| Webhooks | provider signature headers |

Refresh rotates: `POST /api/v1/auth/refresh` returns a new access **and** refresh
token and revokes the old refresh token.

## 6. Caching headers

- Routes marked `etag` in `PARITY.md` §6 send `ETag` and answer
  `If-None-Match` with `304` and no body.
- Routes marked `redis` serve from the read cache for up to 60 s, invalidated
  immediately by any write to the same hostel.
- Private responses send `Cache-Control: private, no-cache` (revalidate every
  time; the ETag makes that cheap). Public, non-personal reads may send
  `s-maxage` for Vercel's cache when the TS route does.

## 7. Rate limits

Public forms and auth attempts are limited per namespace (`PUBLIC_FORM_RATE_LIMIT_*`,
`OTP_RATE_LIMIT_*`). Over the limit: `429` with the TS error body. In Go the
counters live in Redis, so the limit holds across instances.

## 8. CORS

- Allowed origins: `https://hostelpalika.com`, `https://www.hostelpalika.com`,
  Vercel preview origins if needed, `http://localhost:3000` in dev only.
- `Access-Control-Allow-Credentials: true`; allowed headers include
  `Authorization`, `Content-Type`, `If-None-Match`, `x-hostelhub-client`,
  `x-hostel-id`.
- Preflight cached (`Access-Control-Max-Age`) so browsers don't repeat it.

## 9. Timing header

Every response carries `Server-Timing: app;dur=<ms>, db;dur=<ms>, redis;dur=<ms>`.
It is the measure for DESIGN.md §2.

## 10. Uploads and downloads

- Uploads: presigned R2 PUT → client uploads → API call to confirm.
- Progress responses (`progressResponse` in `lib/api-response.ts`): when the
  caller asks for it, the route streams `application/x-ndjson` — one JSON line
  per step as it *starts*, ending with the result (copy the exact line format
  from `progressResponse` and `browserApi`'s reader). In Go:
  write + `Flush()` per line; Caddy must not buffer that path.
- Downloads (PDF, CSV, xlsx, zip): streamed with `Content-Disposition`, no
  buffering of the whole file in memory.
