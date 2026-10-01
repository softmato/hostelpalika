# ENVIRONMENT.md — Environment Variables & Setup

**Package manager: npm** (npm workspaces + Turborepo). Not pnpm — `corepack`/pnpm
appear nowhere in this repo, and `package-lock.json` is the committed lockfile.

`.env.example` at the repo root is the authoritative variable list; this file
explains what each group is for. If the two ever disagree, `.env.example` wins.

---

## 1. Prerequisites

- Node.js 20 LTS
- npm 10+ (ships with Node 20 — no corepack step)
- MongoDB Atlas account (or local MongoDB 7.0+)
- Cloudflare account with an R2 bucket
- Resend account for transactional email
- Google Cloud project — only if you want the optional Google Maps fallback
  (requires billing enabled); OpenStreetMap is the free default

---

## 2. Environment Variables

Create `.env` **at the repo root** — not inside `apps/web`. `next.config.ts`
calls `loadEnvConfig(repoRoot)`, and the standalone scripts under
`apps/web/scripts/` load the same root file, so one file serves every workspace.
Never commit it; `.env.example` is the tracked template.

### App

| Variable | Required | Notes |
|---|---|---|
| `NODE_ENV` | no | `development` / `production` / `test` |
| `APP_URL` | **yes** | Absolute base URL. Used for every link inside an email and for `siteUrl()`. Falls back to `http://localhost:3000`. |
| `NEXT_PUBLIC_APP_URL` | **yes** | Same value, exposed to the browser bundle. |

### Database

| Variable | Required | Notes |
|---|---|---|
| `MONGODB_URI` | **yes** | Full connection string. **Not** `DATABASE_URL` — nothing reads that name. |

### Auth / JWT

| Variable | Required | Notes |
|---|---|---|
| `JWT_ACCESS_SECRET` | **yes** | Minimum 32 characters (enforced by `lib/env.ts`). |
| `JWT_REFRESH_SECRET` | **yes** | Minimum 32 characters, different from the access secret. |
| `ACCESS_TOKEN_TTL` | no | Default `15m`. |
| `REFRESH_TOKEN_TTL` | no | Default `30d`. |

Rotating either secret invalidates every live session.

### OTP (legacy signup flow)

`OTP_TTL_MINUTES`, `OTP_RESEND_COOLDOWN_SECONDS`, `OTP_RATE_LIMIT_WINDOW_MINUTES`,
`OTP_RATE_LIMIT_MAX`, `OTP_HASH_SECRET`. All optional — sane defaults ship in
code. `OTP_HASH_SECRET` falls back to `JWT_ACCESS_SECRET` when unset.

**OTP delivery is email-only.** There is no SMS sender: no Twilio dependency, no
code path that sends one, and the `SMS_OTP_PROVIDER` / `EMAIL_OTP_PROVIDER` /
`TWILIO_*` variables that once appeared here have been removed because nothing
read them. Phone signup is handled by the mobile app.

### Google sign-in

| Variable | Required | Notes |
|---|---|---|
| `NEXT_PUBLIC_GOOGLE_CLIENT_ID` | for Google login | Client ID for Google Identity Services in the browser. |
| `GOOGLE_CLIENT_ID` | for Google login | Same value, used server-side to verify the ID token audience. |

> **There is no `GOOGLE_CLIENT_SECRET` and no OAuth redirect URI.** This project
> uses the Google Identity Services **ID-token POST** flow, verified server-side —
> not a GET redirect + callback. Earlier drafts of this document specified
> `GOOGLE_CLIENT_SECRET` and `GOOGLE_OAUTH_REDIRECT_URI`; neither is read by any
> code path. See ARCHITECTURE.md §3.1.

### Google Maps (optional runtime fallback)

| Variable | Required | Notes |
|---|---|---|
| `GOOGLE_MAPS_API_KEY` | no | Server-only: Geocoding + Places. Never exposed to the client. |
| `NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY` | no | Restrict by HTTP referrer. |

Leave both blank to run on OpenStreetMap/Leaflet + Nominatim + Overpass, which
is the default and costs nothing.

### Cloudflare R2

| Variable | Required | Notes |
|---|---|---|
| `R2_ENDPOINT` | **yes in production** | `https://<account-id>.r2.cloudflarestorage.com`. Note: the endpoint URL, not a bare `R2_ACCOUNT_ID`. |
| `R2_ACCESS_KEY_ID` | **yes in production** | Scope the token to these two buckets only, Object Read & Write. Not account-wide. |
| `R2_SECRET_ACCESS_KEY` | **yes in production** | |
| `R2_BUCKET_PUBLIC` | **yes in production** | Public access **enabled**. Hostel gallery photos, registration documents, activation QR images. |
| `R2_BUCKET_PRIVATE` | **yes in production** | Public access **disabled** — no r2.dev URL, no custom domain. Payment proofs, identity documents, statements. |
| `R2_KEY_PREFIX` | no | Folder this project owns inside buckets shared with other projects, e.g. `hostelproject`. Blank writes keys at the bucket root. |
| `R2_PUBLIC_URL` | **yes in production** | Public base URL of `R2_BUCKET_PUBLIC` **and nothing else**. |
| `R2_CORS_ORIGINS` | **yes in production** | Comma-separated browser origins allowed to upload straight to R2. Not read by the app — `node scripts/r2-cors.mjs --apply` writes it onto the buckets. |

**Why two buckets, and why the private one must stay private.** A presigned URL
carries the object key in its path. If private objects lived in a bucket with
public access enabled — which the public bucket needs, to serve gallery photos —
then anyone who was ever shown a signed link to a payment proof could strip the
`X-Amz-*` query string and re-fetch the same key unsigned, permanently. The
15-minute TTL would be decorative. Splitting the buckets removes the unsigned
form of the request entirely, which is why `R2_BUCKET_PRIVATE` having no public
base URL is a hard requirement rather than a preference.

`accessLevel` decides placement: `PUBLIC` goes to the public bucket, `PRIVATE`
and `PROTECTED` both go to the private one. `PROTECTED` means "authenticated and
authorised", not "world-readable", and that check lives in the read route — a
bucket with a public URL would make it bypassable.

Each `fileAssets` row records the bucket it was written to, so reads resolve
per-asset rather than from the environment and rows written before the split
keep working. To move an existing deployment onto the pair, see
`apps/web/scripts/migrate-r2-buckets.mjs` (`npm --prefix apps/web run
migrate:r2-buckets -- --dry-run` first).

The endpoint, key, secret and both bucket names must be set together —
`lib/public-upload.ts` treats R2 as configured only when endpoint, key, the
public bucket **and** public URL are all present. Without
them it writes to `apps/web/public/uploads/` on local disk, which is fine for
development and **will not work on Vercel** (read-only filesystem). Uploads
degrade to `null` rather than throwing, so the QR email simply arrives without
an image. Provision R2 before production.

### Email (Resend)

| Variable | Required | Notes |
|---|---|---|
| `RESEND_API_KEY` | **yes in production** | Without it `sendEmail()` logs and no-ops instead of throwing. |
| `EMAIL_DOMAIN` | recommended | The verified sending domain, e.g. `softmato.com`. Defaults to `softmato.com`. Must be verified **in Resend** — an unverified domain does not degrade, every email bounces. |
| `EMAIL_REPLY_TO` | no | Overrides the reply address configured in the admin UI. |

`EMAIL_FROM`, `RESEND_FROM_NAME` and `RESEND_FROM_EMAIL` are **gone**. They
pinned every message in the product to one sender address, and the name half of
them could contradict the site name the platform owner had configured — so the
one thing a user sees on every email was the one thing they could not change.

Everything about the sender except the domain now lives in the database, under
**Website Config → Site Content → Email Sending**: display name, reply-to, and
the local-part used for each category of message. The domain stays here because
it is not a branding choice — it has to match what Resend verified for this
deployment, and a settings form is where that gets mistyped.

Mail goes out from a different mailbox depending on what it is — `info@`,
`alert@`, `billing@`, `security@`, `support@`, `noreply@`. See
[EMAIL_SYSTEM.md §0](EMAIL_SYSTEM.md) for the routing and for which of those
also need an inbound forwarding alias.

### Seed / bootstrap

`SEED_SUPERADMIN_EMAIL`, `SEED_SUPERADMIN_NAME`, `SEED_SUPERADMIN_PASSWORD` —
read only by `npm run db:seed`. SUPERADMIN accounts are created by that script
and by an existing superadmin in the portal; never by a public endpoint.

### Cron

| Variable | Required | Notes |
|---|---|---|
| `CRON_SECRET` | **yes in production** | Protects all twelve `/api/v1/cron/*` endpoints. A missing value makes them answer `500 CRON_NOT_CONFIGURED` — they never fall open. |
| `ACTIVATION_CODE_SECRET` | no | Signs resident QR activation codes. Falls back to `CRON_SECRET`, so set it separately if you ever intend to rotate the cron secret — otherwise that rotation invalidates every unredeemed activation code. |

### Resident identity encryption

| Variable | Required | Notes |
|---|---|---|
| `PERSONAL_DATA_ENCRYPTION_KEY` | for resident profiles | 32 bytes, base64 or hex. Generate with `openssl rand -base64 32`. |

**Rotating this key makes every stored resident profile permanently
unreadable.** The resident-profile endpoints fail with a clear message when it
is absent, so the rest of the app still boots.

### Finance gateway secrets (Tier 1)

| Variable | Required | Notes |
|---|---|---|
| `FINANCE_MASTER_KEY` | **yes once any hostel enables a gateway** | 32 bytes, base64 or hex. `openssl rand -base64 32`. Wraps the per-secret data keys in `EncryptedSecret` (ADR-6). |
| `FINANCE_MASTER_KEY_PREVIOUS` | during rotation only | The outgoing key. Both are accepted while `npm run web:rotate:finance-key` rewraps. |
| `ESEWA_SANDBOX_MERCHANT_CODE` | no | Overrides eSewa's published test merchant, `EPAYTEST`, which is the built-in default. |
| `ESEWA_SANDBOX_SECRET` | no | Overrides the published test key that goes with it. |
| `KHALTI_SANDBOX_MERCHANT_CODE` | for Khalti sandbox | A placeholder; Khalti identifies the merchant by key alone. |
| `KHALTI_SANDBOX_SECRET` | for Khalti sandbox | The secret key from your own sandbox merchant at `dev.khalti.com` — there is no shared one. |
| `FONEPAY_SANDBOX_MERCHANT_CODE` | for Fonepay sandbox | Issued by the acquiring bank. Fonepay publishes no universal sandbox merchant. |
| `FONEPAY_SANDBOX_SECRET` | for Fonepay sandbox | Likewise issued by the bank. |
| `<PROVIDER>_SANDBOX_WEBHOOK_SECRET` | optional | Falls back to that provider's `_SECRET` where one key signs both ways. |

**A gateway entry chooses its own environment.** Each hostel's entry carries
`mode: LIVE | SANDBOX`; a sandbox entry resolves to the variables above, and a
live one to that hostel's own key from `EncryptedSecret`. Sandbox entries are
**hidden from residents in production** rather than shown with a warning — money
sent to a test merchant is not recoverable by explaining it afterwards.

**Unlike `PERSONAL_DATA_ENCRYPTION_KEY`, a short passphrase is rejected rather
than stretched.** That trade is defensible for a feature that merely degrades
without its key; it is not defensible for the key protecting every hostel's
payment signing secret, so an under-length value is a startup error somebody has
to fix.

**Rotation does not re-encrypt anything.** Move the current value to
`FINANCE_MASTER_KEY_PREVIOUS`, put the new one in `FINANCE_MASTER_KEY`, deploy,
run the rewrap, then drop the previous value. Ciphertexts are untouched — only
the wrapped data keys move.

**Outside production these are all that is consulted**: `getGatewayCredentials`
returns the sandbox merchant for every hostel and flags the result `sandbox:
true`, so no screen can present a test merchant as a live one. In production it
returns the hostel's own decrypted secret and **never falls back** — a live QR
signed with a test key would send a resident's money to the wrong merchant.

### Public hero search (optional)

`GEMINI_API_KEYS`, `GROQ_API_KEYS`, `OPENROUTER_API_KEYS`, `MISTRAL_API_KEYS`,
`CEREBRAS_API_KEYS` — each a **comma-separated** list, tried in order; a key
that reports a quota error is parked until the next UTC midnight.
`LLM_PROVIDER_ORDER` overrides the try order. `SEARCH_QUOTA_SECRET` signs the
per-visitor quota cookie (10 calls / 5 hours) and falls back to `CRON_SECRET`.

With none of these set, hero search stays keyword-only. It never errors — it
just stops handling freeform sentences.

### QuestionCall (optional)

`QUESTIONCALL_WEBHOOK_SECRET`. With none set the conversion callback answers
`503` rather than trusting an unauthenticated caller. The study row's label,
link and on/off switch are site config (Website Config → Site Content →
QuestionCall), not env.

### Cookies, limits, logging

`LOG_LEVEL`, `PUBLIC_FORM_RATE_LIMIT_MAX` (default 10),
`PUBLIC_FORM_RATE_LIMIT_WINDOW_SECONDS` (default 60), `UPLOAD_MAX_IMAGE_BYTES`,
`UPLOAD_MAX_DOCUMENT_BYTES`, `UPLOAD_MAX_VIDEO_BYTES`, `ALLOWED_IMAGE_MIME_TYPES`,
`ALLOWED_DOCUMENT_MIME_TYPES`, `ALLOWED_VIDEO_MIME_TYPES`. Upload defaults live in
`packages/shared/src/utils/file-assets.ts`; setting one **replaces** the default
rather than extending it, so a partial MIME list narrows what may be uploaded.

There is no `COOKIE_DOMAIN` or `COOKIE_SECURE`. Both were listed here and read by
nothing. Session cookies are host-only and set `secure` from
`NODE_ENV === "production"` directly, which needs no configuration.

### Push notifications (Phase 6)

No Firebase variables. Push goes through the Expo push service, which accepts
both Expo and raw FCM tokens, so no `FIREBASE_*` credential is read anywhere.

### App links

| Variable | Required | Notes |
|---|---|---|
| `APPLE_APP_ID_PREFIX` | for iOS universal links | `<Apple Team ID>.com.softmato.hostelpalika`, from Apple Developer → Membership. Serves `/.well-known/apple-app-site-association`; unset, that path 404s and a tapped link opens Safari. |

Android needs no variable: its half is the committed
`apps/web/public/.well-known/assetlinks.json`, which names the signing
certificate we already hold. The iOS team id does not exist until the Apple
developer account does, which is the only reason the two halves are shaped
differently — see the route handler at
`src/app/api/apple-app-site-association/route.ts`.

Both are **server state**. Adding a fingerprint or a team id reaches installed
apps without a rebuild, a release or an OTA update.


### Prerequisites
- Vercel account
- MongoDB Atlas **production** cluster (separate from dev)
- R2 bucket for production (separate from dev)
- Resend sending domain verified
- Optional: Google Cloud project with billing enabled for Maps

### Steps

1. **Push to GitHub/GitLab.**

2. **Import the project in Vercel.** It is an npm-workspaces monorepo; set the
   Root Directory to `apps/web`. Framework preset is auto-detected as Next.js.
   `next.config.ts` transpiles `@hostel/db` and `@hostel/shared` from
   `packages/`, so both must be included in the build context.

3. **Set environment variables** in Project Settings → Environment Variables.
   Add everything from `.env.example` with production values. Scope secrets to
   Production; scope preview-safe values to Production + Preview. Remember
   `APP_URL` and `NEXT_PUBLIC_APP_URL` must be the real domain — every email
   link is built from them.

   > **Set them before the build, not just for the runtime.** `siteUrl()` falls
   > back to `http://localhost:3000`, and `/privacy`, `/terms`, `/pricing`,
   > `/about` and `/resident-offer-program` are prerendered at build time. A
   > build that runs without `APP_URL` bakes `localhost` into those pages'
   > canonical URLs, `robots.txt` and `sitemap.xml` — and because the pages
   > render perfectly well, nothing fails; you find out from search results.
   > Vercel exposes environment variables to the build, so this only bites when
   > a variable is scoped to the wrong environment.

4. **Schedule the cron jobs on [cron-job.org](https://cron-job.org).**

   > **This project does not use Vercel Cron and has no `vercel.json`.** An
   > earlier draft of this document told you to create one with four
   > `/api/cron/*` paths. Those paths do not exist. The real endpoints are the
   > twelve below, and `docs/CRON.md` is the authoritative reference for what
   > each one does and why its schedule is what it is.

   Every job: method `POST`, no query parameters, and a header
   `x-cron-secret: <CRON_SECRET>` (cron-job.org → job → *Advanced* → *Headers*).
   A secret in a URL leaks into access logs, so the query-param form is not
   accepted.

   **`billing-cycle` is the one that must not be skipped.** It is the single
   path that issues each month's invoices — without it the finance module has
   nothing to reconcile, chase or receipt, and the failure is silent: no error,
   simply no invoice, first noticed when residents are not billed.

   | Endpoint | Suggested schedule |
   |---|---|
   | `POST /api/v1/cron/billing-cycle` | monthly, 1st — `0 1 1 * *` |
   | `POST /api/v1/cron/purge-expired-otps` | daily — `0 3 * * *` |
   | `POST /api/v1/cron/payment-reminders` | daily — `0 2 * * *` |
   | `POST /api/v1/cron/complaint-sla` | daily — `0 4 * * *` |
   | `POST /api/v1/cron/attendance-maintenance` | daily — `0 5 * * *` |
   | `POST /api/v1/cron/refresh-nearby-places` | hourly — `0 * * * *` |
   | `POST /api/v1/cron/notification-dispatch` | every 15 min — `*/15 * * * *` |
   | `POST /api/v1/cron/account-purge` | daily — `0 3 * * *` |
   | `POST /api/v1/cron/ledger-drift` | nightly — `0 3 * * *` |
   | `POST /api/v1/cron/gateway-expiry-sweep` | every 5 min — `*/5 * * * *` |
   | `POST /api/v1/cron/gateway-health` | daily — `30 6 * * *` |
   | `POST /api/v1/cron/gateway-settlement-recon` | weekly, Mon — `0 4 * * 1` |

   The last four are only meaningful once a hostel has enabled an online
   gateway or uploaded a statement, but schedule them now regardless — each is
   a no-op until there is something to do, and a reconciliation job added after
   the fact starts with a blind spot behind it.

   `gateway-expiry-sweep` wants every 5 minutes; confirm your cron-job.org tier
   allows that cadence. Every 15 minutes still works and only leaves stale
   checkout attempts on a resident's screen longer.

5. **Deploy.** Vercel builds on push to `main`; PRs get preview deployments.

### Post-Deployment Checks

- [ ] Homepage loads and lists real published hostels
- [ ] A PUBLIC account can sign up and verify its email
- [ ] The seeded SUPERADMIN can log in
- [ ] Hostel registration submits and appears in the approval queue
- [ ] File uploads reach R2 (not the local-disk fallback)
- [ ] Emails deliver — check the Resend dashboard
- [ ] Each cron job returns 200 with the secret and 401 without it — all twelve
- [ ] `sitemap.xml` and `robots.txt` show the real domain, not `localhost`
- [ ] A payment proof's URL, with its `X-Amz-*` query string removed, returns 404
- [ ] MongoDB connection stable — check Atlas metrics

---

## 7. Database Migrations (Mongoose)

Mongoose has no formal migration system. What this project does:

- New fields rely on schema defaults — existing documents pick them up on read.
- Breaking changes (renames, type changes) get a one-off script in
  `apps/web/scripts/` or `packages/db/src/`, run manually **before** deploying
  the code that depends on them. Existing examples:
  `migrate-roles.ts`, `migrate-rooms-to-counts.mjs`,
  `backfill-resident-accounts.mjs`, `repair-archived-residents.mjs`.
- Removing a field means stopping the code from writing it; old data stays until
  a cleanup script removes it.

Indexes are declared on the models themselves, so they are created by Mongoose
on first connection — there is no separate index migration step. Verify them in
Atlas after the first production deploy.

---

## 8. Monitoring & Logging

**Errors:** Sentry is not currently wired up. Adding it is a tracked task
(`TODO.md`, Track B8). Until then, Vercel's function logs are the only trace.

**Logging:** server code uses structured single-line JSON via `console.log` /
`console.warn` / `console.error`, captured by Vercel:

```json
{ "level": "warn", "action": "public_asset_store_failed", "message": "...", "prefix": "activation-qr" }
```

Never log a password (hashed or plain), a JWT, a Google ID token, or a full
user document — `userId` only. See RULES.md §13.

**Performance:** Vercel Analytics (free tier). MongoDB Atlas has built-in
monitoring — set alerts for slow queries, high CPU and connection limits.

---

## 9. Phase 6 (Mobile) Additional Setup

`apps/mobile` is an Expo app; `npm run mobile:start` runs it.

**Push notifications** are delivered through the **Expo push service**
(`https://exp.host/--/api/v2/push/send`), which accepts both Expo push tokens
and raw FCM tokens. That means the server needs **no Firebase Admin SDK and no
`FIREBASE_PRIVATE_KEY`** — the `FIREBASE_*` variables in `.env.example` are
reserved and currently unused. Device tokens are stored in the `DeviceToken`
collection via `POST /api/v1/mobile/device-token`.

For Android builds you still need `google-services.json` from a Firebase
project (gitignored, placed in `apps/mobile/`), because the Expo push service
delivers through FCM underneath.

**EAS Build:** `npm install -g eas-cli`, `eas login`, configure
`apps/mobile/eas.json`, then
`eas build --platform android --profile preview`.

**Store accounts:** Google Play Console (one-time $25) and Apple Developer
($99/yr) are client-payable and out of scope per PRD.md §5.

---

## 10. Troubleshooting

**Cannot connect to MongoDB** — check `MONGODB_URI`, confirm your IP is
whitelisted in Atlas, check Network Access settings.

**Google sign-in not working** — confirm `NEXT_PUBLIC_GOOGLE_CLIENT_ID` and
`GOOGLE_CLIENT_ID` hold the *same* client ID, and that your origin is listed
under *Authorized JavaScript origins*. There is no redirect URI in this flow, so
a redirect-URI mismatch is never the cause.

**Emails not sending** — check `RESEND_API_KEY`, verify the sending domain,
check the Resend dashboard. With no key configured `sendEmail()` logs and
returns without throwing, so the feature that triggered it will look like it
succeeded.

**R2 uploads failing** — the endpoint, key, secret and **both** bucket names
must be present or the code falls back to local disk, which does not survive a
Vercel deploy. Check that both bucket names match.

**Upload blocked by CORS policy: "No 'Access-Control-Allow-Origin' header"** —
the bucket has no CORS rules for this origin. A presigned upload is sent by the
browser *directly* to R2, so R2 answers the preflight and nothing in this app
can supply that header. Add the origin to `R2_CORS_ORIGINS` and run:

```bash
node scripts/r2-cors.mjs --apply
```

Run it with no flag first to print what each bucket currently has. It merges
rather than overwrites, because the buckets are shared with other projects.

A Vercel *preview* deployment gets a fresh hostname on every build, so preview
uploads cannot be covered by a literal origin. Each entry may contain one `*`,
and every preview hostname — both the per-deploy hash form and the
`-git-<branch>-` alias — is prefixed with the Vercel project name, so one
wildcard entry covers them all:

```
https://hostel-management-software-web-*.vercel.app
```

That matches this project's previews and nothing else: an unrelated
`https://some-other-project.vercel.app` still gets a `403` on the preflight.

**A private document opens without signing in** — `R2_PUBLIC_URL` is pointing at
the private bucket, or the private bucket has public access enabled. Either
re-creates the hole the split was built to close.

**Cron returns `500 CRON_NOT_CONFIGURED`** — `CRON_SECRET` is not set in the
deployed environment.

**Cron returns `401 UNAUTHORIZED`** — the `x-cron-secret` header value does not
match, or the job is using a query parameter instead of a header, or it is
pointed at the wrong domain. Confirm the method is `POST`.

**Map not loading** — with Google Maps, check the browser key's referrer
restriction; with OpenStreetMap, check that the Leaflet CSS is imported and look
at the browser console.

**Resident profile endpoints failing** — `PERSONAL_DATA_ENCRYPTION_KEY` is
missing or not a valid 32-byte base64/hex value.

---

## 11. Location Tracking Defaults

Platform-level defaults live in the `PlatformSetting` document keyed
`operations`; per-hostel values live on `HostelSettings.attendance`. They are
**not** environment variables — they are edited in the platform portal so they
can change without a deploy. See docs/CRON.md and ARCHITECTURE.md §8.4.

Shipped defaults: inside zone 50 m, nearby zone 200 m, tracking at 08:00 /
18:00 / 22:00, retention 600 days (platform maximum 1095), absence alert at 14
consecutive days.

---

_End of ENVIRONMENT.md_
