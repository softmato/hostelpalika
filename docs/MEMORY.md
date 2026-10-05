# MEMORY.md — Running Project Memory

This file is the project's working memory across coding sessions. Update it every time meaningful work happens — don't let it go stale. An AI assistant picking up this project should read this file first, before PHASES.md, before touching code.

---

## Completed Work

- **2026-10-05 — Mobile owner Overall workspace:** Added an Overall entry above the branch list in the Home switcher for owners with multiple hostels. The separate read-only screen groups every branch by summary, people (residents, wardens, cooks), money (resident invoices, lifetime totals, statement, expenses, shared plan billing), operations (night status, attendance, complaints, maintenance, inquiries, bookings, notices), and reports (performance, food, attendance). Branch cards retain their identity and expose direct navigation to the existing branch-specific screens for actions. The client sends an explicit `x-hostel-id` on every underlying read; the server still validates ownership and narrows each request. A failed field stays visibly failed rather than showing a false zero. Plan billing is labeled as shared with the main hostel. Validation: mobile typecheck, full Expo lint (0 errors; existing warnings elsewhere), focused scope/failure tests, and the PWA export pass. The screen has not yet had an authenticated visual acceptance pass on a device.

- **2026-10-04 — PWA room-type import fix:** The standalone Expo app cannot resolve root-workspace `@hostel/shared/constants/room-types` during Metro export. Mobile consumers now use `@hostel/constants/room-types`, with matching Metro resolver/watch folder, TypeScript paths and Vitest alias. Keep new shared imports aligned across these three configs; Next build and typecheck alone do not verify the PWA deployment stage. Verified with a clean `node apps/mobile/scripts/export-pwa.mjs` export (4,255 modules), mobile typecheck, and 31 registration tests.

- **2026-10-04 — Attached bathrooms and form fees:** Added a shared room-type catalogue with independent attached-bathroom variants to public/team/branch web registration and web/mobile room editors and mobile registration/branches. Added distinct optional form fees across registration, branch setup, rate-card editing, listings and intake/invoices; fees persist through listing projection and rate-card revisions, with referral discounts still admission-only. KYC links to rooms and fees on web/mobile; mobile Settings Pricing routes to the authoritative rate card. Validation: 147 focused web tests and 44 mobile tests pass, with no lint errors in changed files.

- **2026-10-04 — Full branch setup and compact mobile switching:** Replaced the short web branch form with five guided steps covering hostel identity, map/address, floors/capacity and room mix/pricing, short stays, amenities/food/rules/photos, documents/payment and review. Name defaults to the main hostel; approved document/PAN reuse is explicit and owner-scoped, with fresh review per branch. Shared client/API branch validation guards capacity and vacancy arithmetic. Fixed dropped totalFloors persistence and added establishment year/short-stay persistence. Mobile admin Home now has a compact branch dropdown in the fixed header instead of a separate dashboard row; its brand text adapts to the extra control. Branch menus identify same-name locations; room deposits are retained in registration details. Validation: 36 targeted tests pass, targeted web/mobile lint passes, and the production build completed with existing OG-route file-tracing warnings.

- **2026-07-14** — Full `docs/` set created: README, PRD, ARCHITECTURE, DATABASE (MongoDB+Mongoose), EMAIL_SYSTEM, FOLDER_STRUCTURE, PHASES, RULES, DESIGN, CODING_STANDARDS, ENVIRONMENT, TESTING, MEMORY, CHANGELOG. No code written yet.
- **2026-07-14 (Late)** — Documentation updated with 7 major new features: Cook Portal, Community Feature, Location Tracking/Auto-Attendance, QuestionCall Integration, Advanced Notifications, Configuration System, Privacy Policy. All features integrated into DATABASE.md, API.md, PHASES.md, ARCHITECTURE.md, RULES.md, PRIVACY_POLICY.md.
- **2026-07-20 — Phase 1 alignment session (IMPORTANT CONTEXT):** Contrary to the older note above, a large codebase ALREADY EXISTED in `apps/web` (built under the deleted `sprints.md` spec: 60+ models, 18 service modules, all portals, `/api/v1/*` routes, OTP-based auth). This session aligned it to `docs/`:
  1. **Monorepo scaffold** — root `package.json` with npm workspaces (`apps/web`, `packages/db`, `packages/shared`) + `turbo.json` + turbo devDependency. **Deviation:** npm workspaces instead of pnpm — settled 2026-08-02, npm is the package manager, not a temporary workaround. `packages/database` and `packages/ui` were obsolete empty placeholders; both are gone (`packages/` now holds only `db` and `shared`).
  2. **packages/db** — all 61 Mongoose models moved from `apps/web/src/models` (git mv, history preserved), `connection.ts`, `seed.ts` (SUPERADMIN, run via `npm run db:seed`), `migrate-roles.ts` (one-shot legacy→canonical role migration; NOT yet run against the dev DB). `apps/web` imports via `@hostel/db/models/*`; `@/lib/db` is a thin re-export.
  3. **packages/shared** — canonical `Role` enum + `LEGACY_ROLE_MAP`, all DATABASE.md enums, auth Zod schemas, `sendEmail()` (Resend REST; logs + no-throw when unconfigured), 7 Phase 1 email templates (**deviation:** plain `.ts` HTML-string templates, not React Email `.tsx`).
  4. **Role alignment** — `PLATFORM_OWNER→SUPERADMIN`, `HOSTEL_OWNER→HOSTEL_ADMIN` (merged), `PUBLIC_USER→PUBLIC`, `SERVICE_PROVIDER` role removed (directory only), added `PLATFORM_MODERATOR` + `COOK`. Updated route-access, permissions, seed/demo scripts. **Existing dev-DB users still carry legacy role strings until `migrate-roles.ts` is run.**
  5. **User model** — added `emailVerified`, `authProvider`, `googleId`, `mustChangePassword`, `tokenVersion` per DATABASE.md (kept richer `status` enum + soft-delete fields).
  6. **Auth flows (ARCHITECTURE §3)** — new `/api/auth/*` routes: signup (email verification link, JWT purpose token, 24 h), verify-email (+ `/verify-email` page), resend-verification, login (EMAIL_NOT_VERIFIED gate, `redirectPath`, `mustChangePassword`, rate-limited 5/15 min), google (ID-token POST — **deviation** from docs' GET redirect flow; server-side verification per §3.1), refresh, logout, me, change-password, forgot-password, reset-password (tokenVersion-stale check, revokes all sessions). Legacy `/api/v1/auth/*` (incl. OTP flow) kept working — frontend still calls v1.
  7. **Account upgrade (§3.2)** — `registerOrUpgradeUserByEmail()` in `apps/web/src/modules/users/user.service.ts`: create-with-temp-password / upgrade-PUBLIC-in-place / same-role-idempotent / 409 EMAIL_ALREADY_HAS_ROLE; AuditLog entries; credentials-issued or account-upgraded emails. 6 unit tests. **Gap:** §3.2's email-confirmation step before HOSTEL_ADMIN/SUPERADMIN upgrades is NOT implemented (upgrade applies immediately on approval).
  8. **Hostel flow emails** — submission-received on public registration (owner now created as PUBLIC, upgraded at approval), hostel-approved (with temp credentials when owner never had a password), hostel-rejected with reason.
  9. **Tests/quality** — all 91 vitest tests pass (fixed 10 pre-existing failures: stale mocks in `auth.service.test.ts` + `phase2-hostel-routes.test.ts`), `tsc --noEmit` clean, ESLint 0 errors, `.env.example` + README rewritten.

---

## New Features Added (14 July 2026)

**1. Cook Portal (Phase 3):**
- Mobile-only portal for cooks, "Food Ready" notifications, device fingerprint tracking, food timing analytics

**2. Community Feature (Phase 4):**
- Resident social feed with PUBLIC/HOSTEL_ONLY visibility, reactions, comments, moderation, anonymous posting

**3. Location Tracking & Auto-Attendance (Phase 4):**
- Privacy-first (no GPS storage), zone-based tracking (INSIDE/NEARBY/OUTSIDE), 3x daily pings, attendance alerts, 600-day auto-deletion

**4. QuestionCall Integration (Phase 5):**
- Study platform button for STUDENT residents, click tracking, conversion analytics, superadmin dashboard

**5. Advanced Notifications (Phase 5):**
- Priority levels, categories, targeted delivery, scheduled notifications, delivery stats, read receipts

**6. Configuration System (Phase 5):**
- Two-level hierarchy (Platform → Hostel), admin-configurable tracking times/geofence/retention, superadmin overrides

**7. Privacy & Compliance:**
- Consent logging, 60-day grace period for account deletion, GDPR-style rights, PRIVACY_POLICY.md created

**Database Impact:**
- 14 new models added: Notification, NotificationReceipt, FoodReadyLog, AttendanceLog, AttendanceAlert, CommunityPost, CommunityComment, CommunityReaction, QuestionCallClick, HostelSettings, PlatformConfig, ConsentLog, AccountDeletionRequest, (plus Cook role in User)

---

## Current Progress

- **Phase:** Phases 1-5 closed out (2026-08-01). All code-side deliverables for Phases 1-5 are done; what remains in each is external infra, a Lighthouse/contrast audit, or a seeded-DB acceptance pass. **Phase 6 (mobile) is next.**
- **Status (2026-08-01, Phase 5):** build green, typecheck + lint clean, **338/338** unit tests across
  50 files. Same pattern as Phase 4 — most of the surface existed, and the gaps that mattered were
  defects or missing halves rather than blank files:
  1. **Referrals never converted.** `Referral.converted` — the metric §5.1 is built around — was
     written by nothing at all, and there was no way to attach a walk-in registration to a referrer.
     Both closed; and `confirmReferralJoined` was double-counting `joinedCount` on every call.
  2. **`PLATFORM_MODERATOR` was a superadmin.** The code described it as "acting superadmin" with the
     whole platform portal including website config, which is the opposite of what §5.1 specifies.
     Config, fee plans, settings, report exports and platform broadcasts are now superadmin-only at
     the route rule and at every API guard.
  3. **Platform ceilings were decorative.** `HostelSettings.attendance` maxima existed in the schema,
     but `updateAttendanceSettings` never checked them against platform config — so a hostel could
     set a wider geofence and, more importantly, keep raw location rows longer than the platform
     allows. Now enforced, with tests.
  4. **20 inputs had no accessible name**, including both login fields and the OTP boxes.
  5. **Three user-supplied search strings reached `new RegExp()` unescaped.**
  Built from scratch: the public service-provider directory, the whole QuestionCall integration,
  notification campaigns (authoring, targeting, scheduling, dispatch cron, delivery stats), the
  hostel settings page, food + attendance analytics, and CSV export for both report surfaces.
- **Phase 5 remaining (not code):** the §5.2 acceptance pass against a seeded DB, a Lighthouse run,
  a WCAG colour-contrast audit, Playwright E2E (needs the same seeded DB), one cron-job.org entry
  for `/api/v1/cron/notification-dispatch`, and the Vercel/R2/Resend/Sentry deployment steps.
  Deliberately **not built** in Phase 5: subscription billing (outside the pilot schema), community
  engagement analytics, and cancelling a scheduled notification campaign.
- **Status (2026-08-01, Phase 4):** build green, typecheck + lint clean, **302/302** unit tests pass.
  As expected from the resume note, most of the Phase 4 surface already existed and the work was
  closing gaps in it — but three of those gaps were defects rather than omissions:
  1. **An SOS notified nobody.** `triggerSOS` only wrote rows. Now fans out urgent email + in-app
     notifications to admins, wardens and linked guardians, **awaited** (a serverless function stops
     on response, so a fire-and-forget send would never have run).
  2. **Guardian login could demote a real account** — it upserted `User` on `phone` alone and forced
     `role: GUARDIAN`, so a resident sharing a family phone would lose their own portal. Now 409s.
  3. **Guardian permissions defaulted open** when the permission document was missing. Now
     default-deny per field, and each dashboard section is gated at the *query*, so an unshared
     field never leaves the database.
  Also: complaints got config-driven SLA + notifications + a breach cron; guardians got a
  resident-driven email invitation flow (7-day token, upgrade via `registerOrUpgradeUserByEmail`);
  notices got `targetAudience`; ratings expanded to all seven categories and the public page stopped
  inventing its star distribution; the notification bell became real; and the location/attendance and
  community-feed server surfaces were built from scratch.
- **Phase 4 remaining (not code):** §4.2 acceptance pass against a seeded DB, and two cron-job.org
  entries — `/api/v1/cron/complaint-sla` and `/api/v1/cron/attendance-maintenance`. Deliberately
  deferred inside Phase 4, marked ⏳ in PHASES.md §4.1: the mobile background location service and
  push notifications (Phase 6), a global floating SOS button (Phase 6 shell), video/audio in
  community posts, and attendance/community *analytics* (folded into the Phase 5 reports work).

### Location tracking — the privacy invariant (built 2026-08-01)

`POST /api/v1/resident/location/ping` accepts `{ lat, lng }`, computes the distance to the hostel
pin, derives a zone, and **throws the coordinates away**. They are never written to any collection —
`AttendanceLog` stores a zone and a rounded distance, nothing else. `attendance-zone.test.ts` asserts
this by serializing the Mongo update and checking the raw latitude/longitude do not appear in it.
Keep that test passing; it is the only thing standing between this feature and a location database.

Two more rules that look like details and are not:
- **No hostel pin → `UNKNOWN`, never a guess.** Marking someone INSIDE because we cannot tell would
  be inventing attendance.
- **Consent is read fresh on every ping** (latest `ConsentLog` row wins), so withdrawal takes effect
  immediately rather than at the next token refresh — same trade as the warden capability lookup.
- **Status (2026-08-01):** build green, typecheck + lint clean (0 errors, 0 warnings), **247/247** unit tests pass. This session was defect closure rather than new surface:
  1. **Auth surfaces unified.** `/api/auth/*` and `/api/v1/auth/*` had both been live since the Phase 1 alignment. The clients call `/api/v1`, and that copy was the one **without the login rate limit** — so the §1.1 "5 attempts / 15 min" control existed only on the path nobody used. Everything is now `/api/v1/auth/*`, limit restored and locked with a test; cookie writes go through `applySessionCookies()` instead of four drifting copies. The duplicate tree is deleted.
  2. **Password reset actually works.** `/reset-password` had been a static mockup calling nothing. Rebuilt as a real request-link → set-password flow against the endpoints that already existed.
  3. **Home page no longer fabricates hostels.** It rendered `MOCK_HOSTELS` — invented names, ratings and "125 hostels" counts, links that 404'd. Now server-rendered from `listPublicHostels()`, counts derived, empty states per row. Verified: two real hostels rendered, both detail links 200.
  4. **Docs reconciled with code**, not the reverse — API.md (envelope, error codes, §1.5 paths, ⏳/↔ flags) and DATABASE.md (`HostelMember`, `PlatformSetting`, `roomConfigurations`).
  5. `FoodMenu` → repeating weekly `FoodRoutine`.
- **Not verified in-browser:** client-side runtime behaviour of the public pages. The Browser pane was not compositing this session (empty a11y tree, `innerText` blank), so filter/search/compare interactivity was not exercised. Server rendering, API responses, build, types, lint and tests all were.
- **Status (2026-07-23):** build green, typecheck + lint clean, **131/131** unit tests pass. Like Phase 2, this was gap completion on an already-built surface. Delivered: QR image generation + activation email with config-driven expiry (`operations` platform setting), payment proofs that carry an amount/method/reference so a month can settle PARTIAL, sequential `RCP-YYYY-MM-#####` receipts, the 7 Phase 3 email templates, a payment reminder/overdue cron, notice fan-out (in-app + email), `Resident.residentType` + `monthlyFee` with an idempotent monthly fee run, and cook-portal setup with `/api/v1/cook/food-ready`. See CHANGELOG `[0.5.0]`.
- **Phase 3 remaining (not code):** §3.2 acceptance pass against a seeded DB, live Resend delivery test, an R2 bucket for QR images (local-disk fallback covers dev), and a cron-job.org entry for `/api/v1/cron/payment-reminders` with `CRON_SECRET` set. Cook *mobile* screens are Phase 6 by design; the server side they call is done.
- **Prior — Phase 2 (2026-07-22):** public discovery + hostel core.
- **Status (2026-07-22):** typecheck + lint clean, **103/103** unit tests pass. Session of 2026-07-22 filled the Phase 2 gaps on the already-built public/hostel-admin surface: Warden Management (service+API+UI+tests), public SEO (dynamic metadata + `sitemap.ts` + `robots.ts`), TanStack Query + Zustand foundation (wired into listing/compare/residents/wardens), and the full Maps integration (Leaflet + Google embed fallback, provider detection, Nominatim geocoding w/ coarse fallback, Overpass nearby-places caching, refresh cron, "Near my college" filter). Also relocated the in-progress owner-application routes out of a `[id]` vs `[slug]` Next.js route conflict. See CHANGELOG `[0.4.0]`.
- **Phase 2 remaining (not code):** §2.2 acceptance tests + 375px pass + Lighthouse ≥80 (browser QA), and infra — live R2, `CRON_SECRET` on deploy, optional `GOOGLE_MAPS_API_KEY`/`NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY`. Public Overpass rate-limits bursts, so nearby-places fill in over cron runs.
- **Prior — Phase 1 (2026-07-21):** Production build GREEN, audit log viewer, §3.2 safeguard, `phase*` files renamed.

### Warden permissions — how enforcement works (built 2026-07-23)

The 11 `WARDEN_PERMISSION_KEYS` flags (`warden.validation.ts`) live on `HostelMember.permissions`
and **are enforced at request time** by `requireHostelCapability(request, key)` in `lib/api-auth.ts`.
(They were display-only until this date — anything written before then is stale.)

**The mechanism, which is the part to understand before changing anything:** the gate does not
merely allow/deny. For a WARDEN it **narrows `principal.hostelIds`** to only those hostels where the
flag is granted, then hands that principal to the service. Because every service already scopes its
queries by `principal.hostelIds`, the restriction propagates for free — no service needed changing,
and a multi-hostel warden is correctly limited per hostel. No grant anywhere → 403 `CAPABILITY_DENIED`.

- HOSTEL_ADMIN holds every capability implicitly and skips the lookup entirely.
- Permissions are read **per request from the DB**, not carried in the JWT, so revoking a capability
  takes effect immediately rather than at the next token refresh. That is a deliberate trade of one
  indexed lookup for correctness.
- **Reads stay open to all staff; writes are gated.** `GET /residents`, `GET /residents/[id]` and
  `GET /profile` use `requireHostelStaffPrincipal`; their POST/PATCH counterparts use a capability.
- **Uncovered by the 11 keys** (still plain staff gates, by design — no flag exists for them):
  inquiries, referrals, reports, service-providers, sos-alerts. Add a key first if these ever need
  to be restricted.
- Covered by `lib/warden-capability.test.ts`. WARDEN remains ~98% of HOSTEL_ADMIN *when every flag
  is granted*; Warden Management itself stays HOSTEL_ADMIN-only via `requireHostelAdminPrincipal`.

### Cook credentials — locked decisions (2026-07-23)

- **One shared cook login per hostel**, not one per cook. Client decision, for simplicity. The
  registration form collects `cookCount`, but it is deliberately **not** used to provision accounts —
  per-announcement attribution comes from `FoodReadyLog.deviceInfo` instead (PHASES.md §3.1).
  `cookCount` currently survives only as free text inside `ownerNote`; make it a structured
  `HostelSettings` field if this is ever revisited.
- **Issued at superadmin approval**, not on an admin toggle, and delivered in the approval email.
  `provisionCookAccount()` in `modules/food/cook.service.ts` is the single path — approval and the
  Food-page toggle/rotate all call it, and every call mints a fresh password.
- **Emailed password is a hand-off credential only.** The cook account is created with
  `mustChangePassword: true`, so the first cook to sign in must choose a new password; because the
  account is shared, that password becomes the kitchen's, and `changePassword()` revokes all
  sessions so the other cooks simply sign in again with it. No new code was needed for this — the
  existing `/api/auth/change-password` flow already skips the current-password check when
  `mustChangePassword` is set.
- **Only the bcrypt hash is stored — never plaintext.** So the dashboard shows the login address,
  `credentialIssuedAt`, and an `initialPasswordPending` status, plus the password *once* right after
  issuing. After a cook sets their own, nobody (including the admin) can read it back; recovery is
  "Rotate Cook Password", which mints a fresh hand-off password. Do not "improve" this by storing
  the plaintext.
- **The shared credential will leak** (kitchen turnover, written on a wall). Accepted, and bounded
  rather than prevented: COOK can reach exactly one endpoint (`/api/v1/cook/food-ready`), has no
  portal landing path, and cannot pass any staff/resident/guardian gate — locked by
  `lib/cook-role-containment.test.ts`. The only abusable action, announcement spam, is capped by
  `operations.foodReadyCooldownMinutes` (default 120). Recovery is "Rotate Cook Password" on the
  Food page. **Do not widen COOK's API surface without re-reading this.**
- **Wardens are NOT provisioned at approval — confirmed client decision, do not re-litigate.**
  Two reasons. Practical: the application form collects no warden identity (no name, no email), so
  there is nothing to create an account from. Security: unlike a cook, a warden can see residents,
  payments and complaints, so a shared or auto-generated warden login turns a leaked password into a
  real data-privacy incident rather than notification spam. Wardens stay admin-created via Phase 2
  Warden Management, where each gets their own real mailbox and the §3.2 upgrade path applies.
  Form copy was corrected to stop promising otherwise.

### 2026-08-01 session — Phase 5, decisions worth keeping

**Referral conversion belongs to the payment path, not a cron.** `markReferralConverted` is called
from `approvePaymentProof` after the money is credited, filtered on `converted: { $ne: true }` so it
is idempotent, and it swallows its own errors. A referral bookkeeping failure must never turn a
verified payment into a failed request.

**A campaign and its receipts, not a campaign with a counter.** The drafted `Notification` carried a
`deliveryStats` object. Counting the per-recipient rows instead cannot drift, and stays correct when
someone opens a months-old notification. This is also why `NotificationReceipt` was not built — the
`Notification` row already *is* the receipt.

**Guardian audiences resolve through `GuardianAccess`, not `Guardian`.** A `Guardian` row is a
contact detail the hostel holds; `GuardianAccess` with `status: ACTIVE` and a `userId` is somebody
with a login who can actually receive something.

**Exports are aggregates, never row dumps.** A CSV of every resident would put names and phone
numbers in a downloaded file for no reporting benefit, so each report groups first. Every cell is
also formula-injection-neutralised (`=`, `+`, `-`, `@` get a leading apostrophe) because hostel names
and complaint titles are user-supplied and Excel executes them on open.

**No CSP, deliberately.** Next's hydration needs a per-request nonce or `'unsafe-inline'`, and a
policy containing `'unsafe-inline'` provides no protection while looking like it does. The reasoning
is recorded in `next.config.ts` next to the five headers that *are* set. XSS is currently held off by
React escaping — verified: `dangerouslySetInnerHTML` appears nowhere in the app.

**Food "delay" is measured against the hostel's own routine.** A 19:00 dinner is late in one hostel
and early in another, so the analytics compare `FoodReadyLog.announcedAt` to
`FoodRoutine.timings[meal]`. A meal with no published timing reports its announcement count and *no*
delay figure rather than an invented one. Attribution is per **device**, not per person — cook
credentials are shared kitchen-wide by design (see the 2026-07-23 note below).

**"Present" includes NEARBY.** In attendance analytics a resident at the gate is not absent, so the
rate counts INSIDE + NEARBY over total readings.

### 2026-07-23 session — Phase 3, what was done
1. **Operations config** — new `PlatformSetting` key `operations` (`modules/platform-config/operations-config.ts`): `qrActivationExpiryDays`, `paymentReminderDaysBefore`, `sendNoticeEmails`, `sendPaymentEmails`, `receiptNumberPrefix`. Deliberately kept separate from the public site-config sections so a website edit can never change activation/payment behaviour. Reads never throw — bad or missing document → shipped defaults.
2. **QR activation** — added `qrcode`; `generateActivationCode` now renders the activation link as a QR PNG, stores it via the new `lib/public-upload.ts` (R2 when `R2_PUBLIC_URL` is configured, else `public/uploads/activation-qr/`), and emails the resident. Expiry defaults from config instead of a client-supplied `expiresInHours`. `/resident-activation` prefills `?code=` (wrapped in Suspense).
3. **Payments** — `PaymentProof` gained `amount`/`paymentMethod`/`referenceNote`; approval now adds that amount to `paidAmount` and settles `PAID` **or** `PARTIAL`. Receipts moved to sequential `RCP-YYYY-MM-#####` with duplicate-key retry (the `receiptNumber` unique index is the arbiter); one receipt per payment, amount refreshed on re-verification. Emails on proof upload (to admins), verify, and reject.
4. **Fee management** — `Resident.monthlyFee`, bulk `PATCH …/residents/fees`, and `POST …/payments/generate` (idempotent: skips residents already billed for the month and those with no fee); "Monthly Fee Run" panel on the admin payments page.
5. **Cron** — `POST /api/v1/cron/payment-reminders`. Reminds on the *exact* day offset, not every day inside the window, and chases overdue on day 1/3/then weekly, so a stale record can't email someone every morning. Documented in `docs/CRON.md` (which also gained the previously undocumented nearby-places job).
6. **Notices** — publishing fans out in-app `Notification`s to active residents plus emails when `sendNoticeEmails` is on.
7. **Resident type** — `residentType` (STUDENT default) end to end, with an admin list filter.
8. **Cook portal** — `HostelSettings` + `FoodReadyLog` models, `modules/food/cook.service.ts`, `GET/PATCH /api/v1/hostel-admin/cook-portal` and `GET/POST /api/v1/cook/food-ready`. Cook logins are generated (`cook@<slug>.hostelhub.local`) with no real mailbox, so credentials are emailed to the hostel admin and rotate on every re-enable; disabling suspends the account.
9. **Robustness** — every notification side-effect is wrapped: a failed email or contact lookup can never fail an activation, verification, or notice publish that has already been persisted.
10. **Tests** — 23 new unit tests (5 files); suite is 131/131. Pre-existing tests updated for the new proof `amount` and the receipt format.

### 2026-07-21 session — what was done
1. **Build green** — re-ran `npm --prefix apps/web run build` after the prior `useSearchParams()`→Suspense fixes; exit 0, no further prerender errors.
2. **Typecheck fix** — `user.service.test.ts` mock was missing `mustChangePassword` (TS2339); added it. Suite + tsc now clean.
3. **Audit log viewer (read-only)** — PHASES.md §1.1 deliverable. New `apps/web/src/modules/audit/audit.service.ts` (`listPlatformAuditLogs`, actor/hostel labels resolved, capped, newest-first) + `audit.validation.ts`, `GET /api/v1/platform/audit-logs` (SUPERADMIN-gated), `/platform/audit-logs` page + `platform-audit-logs-page.tsx`, nav item, 3 service tests.
4. **§3.2 high-privilege upgrade safeguard** — `registerOrUpgradeUserByEmail` now rotates a PUBLIC→HOSTEL_ADMIN/SUPERADMIN upgrade to a fresh emailed temporary password + `mustChangePassword`, so the elevated role can't be exercised with an un-verified pre-existing password (mailbox-proof). Lower-trust roles (RESIDENT/WARDEN/GUARDIAN) keep credentials. `HIGH_PRIVILEGE_ROLES` set added; 1 new test.
5. **Index audit** — verified the Phase 1 model set (User, Hostel, Room, Bed, HostelDocument, HostelMember, Session, HostelApplication, HostelVerification, AuditLog) already satisfies DATABASE.md "Indexing Strategy Summary" (hostelId compound indexes, unique email/googleId, session TTL). No changes needed.
6. **Production naming** — renamed `phase5-shared.tsx`→`portal-shared.tsx` (8 importers updated), `phase2-hostel-routes.test.ts`→`platform-hostel-routes.test.ts`, `phase5-routes.test.ts`→`growth-routes.test.ts` (via `git mv`, history preserved; `describe()` labels updated). No `phase*`-named source files remain.

---

## RESUME POINT (next session starts here)

**Phases 1–5 are code-complete on the server side.** A 2026-08-02 docs-vs-code
audit found the remaining gaps and opened `TODO.md` at the repo root as the
tracker — read that before starting anything. The short version: pagination is
specified in API.md §1.4 and implemented nowhere, three events notify nobody
(public inquiry, hostel-pending, service-provider status), account deletion is
specified in four documents and built in none, and there is no multi-tenant
isolation test suite despite it being the highest-priority item in TESTING.md.

**`apps/mobile` is NOT a stub — that claim was wrong.** Verified 2026-08-02:
17 screens (~2,200 lines), a 32-function typed API client, secure token store,
React Navigation stack, and **working QR camera activation** via `expo-camera`.
`npm run mobile:typecheck` is clean. See `MOBILE_STATUS.md`, which is now the
authoritative file for mobile state.

What Phase 6 actually still needs: push notification **receipt** on device
(`expo-notifications` is not installed) and **delivery** from the server (Track
C1 — via the Expo push service, so no Firebase Admin SDK), the background
location service (`expo-location` + `expo-task-manager`), guardian and cook
screens, a global floating SOS button, and real Google sign-in.

Phase 6 inherits several things deferred on purpose, all already server-ready:
- The **background location ping** service — `POST /api/v1/resident/location/ping` is live and the
  zone maths is tested; only the device side is missing.
- **Push notifications** — `DeviceToken` and the notification fan-out exist; FCM/APNS delivery does
  not. Every "sends push" line in Phases 3–5 means "wrote an in-app Notification" today.
- **Cook mobile screens** — `/api/v1/cook/food-ready` works and the analytics read its output.
- **Scanning a resident-ID QR** during registration — the lookup endpoint already parses a scanned
  URL; the web path uses manual entry because there is no camera dependency yet.
- A **global floating SOS button**, which needs the mobile shell.

Phase 5 leftovers are external: the §5.2 acceptance pass against a seeded DB, a Lighthouse run, a
WCAG contrast audit, Playwright E2E (same seeded-DB blocker), one cron-job.org entry for
`/api/v1/cron/notification-dispatch` (every 15 min), and the deployment steps in §5.1.

Phase 4 leftovers are external: the §4.2 acceptance pass against a seeded DB, and cron-job.org
entries for `/api/v1/cron/complaint-sla` (daily) and `/api/v1/cron/attendance-maintenance` (daily).

Phase 3 leftovers are all external: seeded-DB acceptance pass (§3.2), live Resend delivery, an R2 bucket so QR images get a public CDN URL instead of the local-disk fallback, and a cron-job.org entry for `/api/v1/cron/payment-reminders`.

**Payment testing is deliberately deferred to after every phase is built** — client decision
(2026-08-01), on the grounds that the money path is too sensitive to sign off piecemeal. Do not
treat the unticked payment items in §3.2 as forgotten.

The older Phase 1 infra list below is still open and still **external/infra or deliberately deferred** — full list in `TODO.md`:

1. **External infra (needs the user):**
   - Cloudflare R2 bucket + `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME` in `.env` (upload helper + validation already coded).
   - Live `RESEND_API_KEY` + verified sender to test the 7 Phase 1 email templates end-to-end.
   - Role migration against the dev DB: `node --experimental-transform-types packages/db/src/migrate-roles.ts` (PLATFORM_OWNER→SUPERADMIN etc.), then `npm run db:seed`.
   - Manual acceptance-test pass (PHASES.md §1.2) against a running instance once the above are provisioned; unit coverage exists for auth/upgrade/§3.2.
2. **Deliberately deferred (not part of a clean Phase 1):**
   - ~~App-wide response-envelope migration~~ — **resolved 2026-08-01 the other way**: the shipped envelope was already consistent across all 152 route files, so `docs/API.md` §1.1/§1.2 were corrected to describe it instead of migrating 152 routes to match a document. No migration pending.
   - Dedicated `packages/db/src/repositories/` layer — tenant scoping is functionally covered by `apps/web/src/modules/*` services + `lib/tenant.ts`.
   - Field-level alignment of all ~60 models + Phase 3–5 model creation — phase discipline defers future-phase work.
3. **Known deviations from docs (decided 2026-07-20, revisit deliberately, don't "fix" casually):**
   - **npm workspaces + turbo, not pnpm.** No longer treated as a deviation to
     revisit — npm is the package manager, `package-lock.json` is the lockfile,
     and every doc was corrected to match on 2026-08-02. Do not "switch back".
   - API is under `/api/v1/*` throughout ("platform" naming instead of docs' "superadmin", "wardens" instead of "staff"). **The `/api/auth/*` duplicate surface was removed 2026-08-01** — keeping both had left the live login without a rate limit. One surface only; recorded in API.md §1.5.
   - Response envelope is `{ success, message, data }` / `{ success, message, errorCode, details? }`, and API.md now documents exactly that (updated 2026-08-01).
   - Email templates are `.ts` HTML-string functions, not React Email `.tsx`.
   - Google auth = Google Identity Services ID-token POST (server-verified), not GET redirect+callback (no GOOGLE_CLIENT_SECRET in env).
   - Hostel model keeps old shape (slug/location object, `PENDING_APPROVAL`/`PUBLISHED` statuses) vs DATABASE.md — reconcile in Phase 2 public-discovery work.
   - ~~`packages/database` + `packages/ui` are dead placeholder dirs~~ — deleted; verified gone 2026-08-02.

---

## Pending Tasks (Immediate Next Steps)

- [ ] Re-confirm the real project end date with client — original brief said 5 weeks from 22 June 2026; as of 14 July 2026, ~3 weeks have elapsed. Get updated timeline agreement.
- [ ] **Provision infrastructure:**
  - [ ] MongoDB Atlas account + create database
  - [ ] Cloudflare R2 bucket for file storage
  - [ ] Resend account for transactional emails
  - [ ] Google Cloud project (optional for Maps fallback - billing-enabled if client wants Google Maps)
  - [ ] Vercel account for deployment
- [ ] **Phase 1 Kickoff:**
  - [ ] Scaffold Turborepo monorepo per FOLDER_STRUCTURE.md
  - [ ] Set up `apps/web` (Next.js 14 App Router)
  - [ ] Set up `packages/db` with Mongoose connection
  - [ ] Set up `packages/shared` for Zod schemas, types, email templates
  - [ ] Write Mongoose models per DATABASE.md
  - [ ] Create seed script (`packages/db/seed.ts`) that creates the initial SUPERADMIN account
  - [ ] Build unified auth system (ARCHITECTURE.md §3): email/password + Google OAuth + account upgrade logic
  - [ ] Implement email sending infrastructure (EMAIL_SYSTEM.md)
  - [ ] Create hostel registration form (public)
  - [ ] Create superadmin hostel approval portal

---

## Important Decisions (Locked - Don't Re-Litigate)

| Decision | Choice | Where Documented |
|---|---|---|
| Database | **MongoDB + Mongoose** | ARCHITECTURE.md §1, DATABASE.md |
| Backend architecture | **Next.js 14+ App Router** (full-stack, no separate backend) | ARCHITECTURE.md §1 |
| UI library | **shadcn/ui + Tailwind + lucide-react** | ARCHITECTURE.md §1, DESIGN.md |
| State management | **TanStack Query** (server) + **Zustand** (client) | ARCHITECTURE.md §1 |
| Auth | **Custom JWT + Google OAuth**, unified login gateway, admin-issued accounts with email-based account upgrade | ARCHITECTURE.md §3, PRD.md §8 |
| Email | **Resend** with template system (30+ scenarios documented) | EMAIL_SYSTEM.md |
| File storage | **Cloudflare R2** (S3-compatible) | ARCHITECTURE.md §1 |
| Maps | **OpenStreetMap + Leaflet** (default) with runtime fallback to **Google Maps Platform** if env configured | ARCHITECTURE.md §4 |
| Mobile timing | **Phase 6** (post web-launch, ~2-3 weeks after Phase 5) | PHASES.md, PRD.md §6 |
| Payments (v1) | **Manual proof upload + admin verification only**, no live gateway | ARCHITECTURE.md §6, PRD.md §5 |
| Monorepo | **Turborepo + npm workspaces** | FOLDER_STRUCTURE.md |
| Timeline | **5 weeks for web** (Phases 1-5) + **2-3 weeks for mobile** (Phase 6) = ~7-8 weeks total | PRD.md, PHASES.md |

---

## Tech Stack Summary (Quick Reference)

**Core:**
- MongoDB Atlas (database)
- Mongoose (ODM)
- Next.js 14+ App Router (full-stack framework)
- TypeScript (strict mode)
- Turborepo + npm workspaces (monorepo)

**Frontend:**
- React 18+
- shadcn/ui (components)
- Tailwind CSS (styling)
- lucide-react (icons)
- TanStack Query (server state)
- Zustand (client UI state)
- Axios (HTTP client)
- Zod (validation)
- react-hook-form (forms)

**Backend/API:**
- Next.js API Route Handlers
- Mongoose repositories (tenant-scoped queries)
- Custom JWT + Google OAuth 2.0
- Resend (email with templates)

**Infrastructure:**
- Vercel (hosting)
- Cloudflare R2 (file storage)
- OpenStreetMap + Leaflet (maps, default)
- Google Maps Platform (maps, optional runtime fallback)
- Firebase Cloud Messaging (Phase 6, mobile push)

**Mobile (Phase 6):**
- React Native + Expo
- Same REST API as web
- Expo SecureStore (token storage)
- FCM push notifications

---

## Bugs & Fixes

_(None yet — log here as they're found and fixed, with a one-line root cause, once code exists)_

---

## Context Needed for Future Chats

### Critical Architecture Patterns

**1. Account Upgrade Mechanism (ARCHITECTURE.md §3.2)**
This is the single most important piece of custom logic in this app. When a hostel admin registers a new resident/warden/guardian by email:
- System checks if that email already exists as a PUBLIC account
- If YES → upgrade the existing account in place (change role, link profile, keep existing credentials)
- If NO → create new account with temporary password, send credentials
- Never create duplicate User documents for the same email

**2. Multi-Tenancy Enforcement (ARCHITECTURE.md §2, RULES.md §3)**
Every hostel-scoped query MUST filter by `hostelId` from the session, never from client input:
```typescript
// WRONG - client controls hostelId
const rooms = await RoomModel.find({ hostelId: req.body.hostelId });

// RIGHT - session controls hostelId
const rooms = await RoomModel.find({ hostelId: session.hostelId });
```
Use repository functions in `packages/db/src/repositories/` to enforce this pattern.

**3. Privacy Rules (PRD.md §10, RULES.md §5)**
- Night status is COARSE (`Inside/Outside/Not Verified/SOS`) — never GPS coordinates or timestamps visible to guardians
- Guardian access is field-level opt-in, enforced server-side by filtering response fields before sending
- Complaint content is NEVER visible to guardians unless resident explicitly enables it

**4. PlatformConfig Pattern (ARCHITECTURE.md §5)**
- Singleton document in MongoDB (`_id: 'default'`)
- Loaded at server boot → cached in memory → background revalidation
- Client-side: cached via TanStack Query, served from cache immediately, background refetch
- Used for runtime-configurable values (SLA timers, fee reminders, feature flags, pricing)

**5. Email System (EMAIL_SYSTEM.md)**
- All 30+ email scenarios must be implemented as features are built
- Templates live in `packages/shared/email-templates/`
- Sent via Resend using `sendEmail()` helper
- Guardian emails respect opt-in permissions
- SOS emails are highest priority and cannot be disabled

**6. Maps Provider Fallback (ARCHITECTURE.md §4)**
- Default: OpenStreetMap + Leaflet (free, no API key)
- Fallback: Google Maps (if `GOOGLE_MAPS_API_KEY` env var set and valid)
- System auto-detects at runtime which provider to use
- Never expose server API key to client

---

## Open Questions / Risks

1. **Timeline Baseline:** Original 5-week window started 22 June 2026; as of 14 July, ~3 weeks have passed. Need to re-baseline the actual end date with the client so PHASES.md dates are realistic.

2. **Google Maps Billing:** If client wants Google Maps fallback (richer POI data), they need a billing-enabled Google Cloud project. This is client-payable (PRD.md §5). Confirm if they want this or if free OpenStreetMap-only is acceptable.

3. **Automated Payment Gateway:** eSewa/Khalti/connectIPS integration is explicitly deferred (ARCHITECTURE.md §6, PRD.md §5). v1 ships with manual proof upload only. Confirm client understands this limitation.

4. **Mobile App Scope:** Original brief may have implied mobile in the 5-week window. Docs now treat mobile as Phase 6 (post web-launch). Confirm client is aligned with this split.

---

## Performance & Optimization Notes

_(Log here as optimizations are identified during development)_

- MongoDB indexes are defined in DATABASE.md — ensure they're created during first migration
- PlatformConfig caching reduces DB queries for frequently-accessed config values
- TanStack Query caching reduces redundant API calls
- R2 file URLs are pre-signed with short expiry for private files (payment proofs, documents)

---

## Known Limitations (v1 Scope)

Per PRD.md §5, the following are explicitly OUT OF SCOPE for v1:
- Automated payment gateway integration
- SMS/WhatsApp/email provider costs (client-payable)
- Domain, hosting, Play Store fees (client-payable)
- Government certification/legal verification claims
- Long-term maintenance beyond agreed free-support window

---

_End of MEMORY.md — Update this file continuously as work progresses_

## 2026-10-01 — KYC visual design review
- User requested simpler, minimal-text KYC mockups before implementation. Twelve generated design images and a review gallery are in docs/kyc-redesign/screens/simple-v2/. Eight main steps plus payout edit, food edit/copy, and finish. Implementation remains paused pending design approval; no application source changed in this design pass. Preserve the existing user modification in apps/mobile/src/lib/admin-manage-api.ts.


## 2026-10-01 — App Hostel KYC built to the simple-v2 mockups (uncommitted)
- `apps/mobile/src/app/manage/kyc.tsx` is the approved simple-v2 wizard: step dots joined by connector lines, an "All steps" sheet, one footer (Next / Save & next / Save & finish + Skip), and a finish screen with a step-icon grid that plays `success.lottie` once, only when the last step is actually finished.
- **Steps hold drafts; the wizard saves them.** A step calls `useKycDraft({ dirty, busy, save })` (`components/manage/kyc-draft.tsx`). The footer saves every dirty draft, and leaving a dirty step (Back, Skip, a dot, All steps, Android back, header back) opens Save & go / Keep editing / Discard. `busy` means an upload or save is running and is the only thing that locks navigation; loading a step's data does not. Exits go through `allowLeave`, otherwise a discarded draft that still reads dirty gets stopped again by `usePreventRemove`.
- Browser close in the PWA uses `useUnloadGuard` (`src/lib/unload-guard.ts`, a no-op on the phone; `web/unload-guard.ts` is the stand-in). No `Platform.OS` branch in `src/`.
- Food: `FoodWeekEditor` (`components/manage/food-week-editor.tsx`) is now the only week editor, shared by KYC and `manage/food.tsx`. It has a Day/Week view, a meal row that opens in place, dish chips, copy a day or one meal to picked days, meal times and the month-end meal. Draft maths is in `lib/food-draft.ts` and tested in `food-draft.test.ts`. `dirty` compares the payload that would be sent. The old `FoodWeekDays`/`MealSheet` are gone.
- `geocodeHostelLocation` now flattens the server's `{ coordinates, label, address }` into `GeocodeHit`. Before this, Settings → Location and the KYC map search read `hit.lat` off a shape the server never sent.
- `useResource().refresh()` returns void, so `await refresh()` does not wait. The food save writes the routine locally first so the menu does not flash back to the old one.
- Device pass still to do. Web `/hostel-admin/kyc` still links out to the full editors.

## 2026-10-01 (later) — KYC second pass: lighter header, photos, documents, accounts, food times, map (uncommitted)
- **Header:** the eight step circles are replaced by "Step N of 8 · X done" and one thin segmented bar. "All steps" still opens the step list.
- **Photos:** the "N of 3 added" card is gone. At the top, a small card shows each photo type (Outside, Inside, each room type) with a bar and "count/limit", and a tick when that type is full. Every add tile now offers **Camera** or **Upload** (`addPhotos(target, used, source)`), on Rooms as well as KYC.
- **Documents:** each file gets a full-width row with a 200px preview. PDFs are drawn by pdf.js. `receipt-preview.tsx` now exports `PdfPreview({ read, allPages })` and `readRemotePdf`, which gets the signed URL with `files/[id]/url?format=json` and fetches it without a token. The asset viewer draws every page of a PDF instead of saying "use Save". Uploading offers Camera or a file (`lib/document-picker.ts`, which loads `expo-document-picker` lazily).
- **Multiple accounts:** new `HostelPaymentProfile.extraAccounts` (`[{ kind: BANK|ESEWA|KHALTI, bankName, accountName, number }]`, max 6). They go out on the resident pay instructions, count as payee identifiers (`hostelPayeeIdentity`) and count towards "usable". The KYC payments tick now uses `isPaymentProfileUsable`. Editors: app KYC + Finance → Payment setup (`ExtraAccountRows` / `ExtraAccountSheet`), and web Payment profile → "More accounts". `methodKey` is now unique per account in both apps, because "BANK" alone collided once a hostel had two banks. **Needs the web deploy**: until then the server drops the field.
- **Logos:** bank/eSewa/Khalti rows use `WalletMark`. `BankNameField` (`components/manage/bank-name-field.tsx`) lets the owner type a bank or tap one from `BANK_NAMES` (with logos). It is used in payout, payment setup and KYC.
- **Food:** meal times are set first, once, with one-tap preset slots or typed text. The day view drops the per-meal times and shows a dot on days that still have an empty meal. The week grid shows each meal's time under its icon. Month-end is its own row. Editing stays inline (user decision).
- **Map:** `PinPickerModal` in `hostel-pin-picker.tsx` is a full-screen Leaflet map that you pan under a fixed centre pin. It also has search (place, map link, lat,lng) and "my location". The old inline search crashed because of the geocode shape mismatch; that was fixed earlier the same day.


## 2026-10-02 — Shared receipts and session recovery

- PWA share target stages one image/PDF locally (20 MB limit, one-hour expiry, at most five pending files); the app routes hostel staff to an expense draft and residents to invoice selection and the existing proof/OCR flow. No automatic expense save or payment settlement. Android SEND handling and Expo sharing plugin configured; native receipt receiving requires a new binary. iOS share extension requires its normal native build/signing validation. Browser share-target support varies.
- Expense receipt read endpoint uses recordExpenses permission and existing owner/hostel/kind/completed-upload validation, with a 30/hour rate limit. OCR only suggests fields; user reviews and saves.
- App/PWA auth uses explicit body refresh tokens independent of website cookies. Mobile login/register/Google/change-password responses no longer create competing cookie copies. Logout targets the explicit app session. Proxy skips bearer/mobile API calls. PWA rotations serialize across windows with Web Locks; token pairs are stored atomically with migration of previous storage keys.
- Network errors, timeouts and server refresh failures preserve credentials; definitive refresh rejection still ends the session. Website guard offers retry; protected navigation answers temporary 503 rather than redirecting to login on refresh infrastructure failures.

Validation: focused session/refresh, auth-route, expense-tenant and share-worker tests pass; web and mobile TypeScript checks pass; targeted lint passes; Expo PWA export succeeds. Real-device share sheets and native iOS extension signing were not exercised, and no deployment was made.

## 2026-10-03 — Standalone shared expense receipt sheets

- Fixed generic/absent PDF MIME handling, provider size metadata, and retry reuse of a failed promise; removed duplicate Expo sharing plugin configuration.
- Added standalone Android share activity and iOS share extension UI with receipt-reading animation, editable fields, Save/Cancel, and opt-in auto-save reversible from Expenses. Native processing does not load the main React Native app. Auto-save requires a complete successful outgoing receipt and is scoped per user/hostel/device.
- Added lightweight PWA share page, generic-PDF service-worker support, and an Import payment receipt fallback for iOS PWA. PWA cannot show its sheet inside the banking app. Native expense sheets are staff-only; existing PWA resident shares still route to invoice selection.
- Shared native session vault (Android Keystore / iOS shared Keychain), serialized refresh, bounded streamed uploads, and receipt-hash idempotency keys protect retries/repeated shares. Details: `docs/RECEIPT_SHARE.md`.
- Validation: 48 focused tests; web/mobile TypeScript; targeted lint; Android receipt Kotlin compilation, bundled assets and application manifest merge; PWA production export. iOS extension generation/entitlements tested, but Swift compilation/signing and real-device behavior/performance still require macOS/Xcode/devices. No deployment or store build submitted; a new native binary is required.


### Receipt save notifications (2026-10-03)
Shared receipt saves now create a recorder-only confirmation in the existing bell/native/Web Push pipeline, linking to Expenses. Manual and automatic saves both opt in through sharedReceipt; ordinary expenses stay quiet. Idempotent retries return before notification creation. Delivery failures do not fail a committed Save; push delivery runs after the response through the existing dispatcher and respects permissions/preferences. Receipt/expense regression tests passed (33). Native binaries must be rebuilt to bundle the updated sheet. iOS PWA direct incoming sharing remains unsupported; a separately implemented, securely paired Apple Shortcut could receive files and upload them without opening the PWA. That Shortcut is not implemented.


## 2026-10-04 - Branch creation and switching

Signed-in owners can submit additional branches under their existing Max allowance without another email registration. Removed matching-PAN, matching-payout-holder and first-hostel payout-verification prerequisites; documents/PAN/payout can be added later. Web/PWA and native forms use three steps, and the first hostel appears alongside additional branches with equal labels. Web header switcher supports single-hostel accounts and links to branch management; switching opens the selected dashboard. Native switcher offers branch management and clears cache before remounting; stale in-flight responses cannot refill the new branch cache. Existing platform approval, owner authorization, independent payout verification and tenant isolation remain in force. Tests cover different PAN/accounts, multiple branches under one owner, optional-input validation, ownership/plan denial, and stale cache responses. No deployment or live-data migration performed.

Validation: 26 focused web tests and 28 mobile cache tests passed; web and mobile TypeScript checks passed. Targeted ESLint checks passed. Device/browser interaction and live approval/payment flows were not exercised in this session.


## 2026-10-04 - Preserve caches across branch switches

Follow-up replaces cache-clearing switches with branch-scoped caches. Native read/write/subscription/in-flight keys include the selected branch, and late responses are stored only under the initiating branch. Cache scope is restored before screens mount; sign-out still clears all branches. Legacy snapshots without branch scope are ignored. Web/PWA uses client navigation and slug-keyed workspace remounts under the existing app-wide QueryClient; query headers capture the same slug as their cache keys. Fresh resources are reused for two minutes, with fifteen-minute in-memory retention, manual refresh and event invalidation. The native disk cache retains its existing restore policy (restored data is stale and revalidated). Branch switches reset component/form state without discarding server data.

Cache follow-up validation: 32 native cache tests, 7 native API/session tests (including delayed requests retaining their original branch), and 2 web cache tests passed. No live browser/device interaction was performed.


## 2026-10-04 - Per-branch KYC and public branch links

Confirmed KYC and photos are already hostel-scoped: documents, payout, resident payment setup and photo completion are read for the selected hostel only. Added a regression test proving one branch's completed steps do not complete another's. Public discovery already lists branches independently. Added public-only otherBranches detail data and reciprocal branch cards on web/PWA and native hostel pages, plus a count near the listing title. Cards show each branch's own cover image and location; unverified, unpublished, suspended, deleted and unrelated hostels are excluded. No live listings were published or changed.

Public-branch validation: 15 focused tests passed; web and native TypeScript checks passed. Browser/device visual testing and live publication were not performed.
