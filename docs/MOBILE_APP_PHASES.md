# Mobile App — Build Phases

Tracker for `apps/mobile`. This is the Phase 6 deliverable from [`PHASES.md`](PHASES.md)
§6, restructured into buildable increments. It supersedes the §6.1 checklist as the
day-to-day work order; §6.1 stays the contractual scope list.

**How to use this file.** One item at a time: write the code, verify it runs, then flip
`☐` to `☑` in this file before starting the next item. Do not batch. A `☑` means the
thing was seen working, not that the file was created.

Reference implementation for stack, notification plumbing and UI feel:
`D:\Jiwan-Mijhar\app` (QuestionCall). Copy its **patterns**, not its palette — this
product is green (`#0a8a4b`), QuestionCall's chrome is incidental.

---

## 0. Decisions taken (do not re-litigate)

| Decision | Choice | Why |
|---|---|---|
| App variants | **One app, role-routed** | Six audiences (Resident, Guardian, Cook, Service Provider, Hostel Admin, Public). One Expo project, one store listing, one push pipeline, one EAS config. After login the router drops each role into its own route group. Cook and resident install the same APK. |
| Routing | `expo-router` (file-based) | Deep links from push notifications map to file paths with no manual linking config. Matches the reference app. |
| Styling | NativeWind v4 + CSS variables | The web theme is already CSS variables; the same token names port across, so a colour changes in one place. |
| State | Redux Toolkit + `redux-persist` (AsyncStorage) | Reference app's shape. Persist gives the offline cache for free (Phase M8). |
| Tokens | `expo-secure-store` | Never AsyncStorage — AsyncStorage is plain text on disk. |
| HTTP | `axios` + request/response interceptors | 401 → silent refresh → retry once → hard logout. Lifted from `lib/api.ts` in the reference. |
| Realtime | `pusher-js/react-native` | The web already publishes on four private channel scopes; mobile subscribes to the same ones. |
| Push | Expo Push API → FCM/APNS | `expo-notifications`. Requires a **new server-side sender** — see §M4. |
| Package manager | `npm` (not pnpm) | Repo-wide rule. `apps/mobile` stays **outside** the root workspaces array with its own lockfile — Metro and npm workspace hoisting fight each other. |

### Shell contract (agreed 2026-08-16)

**Signed out is the public app, not a login wall.** The mobile app is the
website. Someone with no account browses hostels, compares them and sends an
inquiry exactly as they do on the web; a hostel-hunting student has nothing to
sign in with yet, and a login form in front of the product is the fastest way to
lose them. The whole visible difference is what sits at the bottom of the screen:

| | Bottom of screen |
|---|---|
| Signed out | A **Log in** call to action (plus a "create an account" link) |
| Signed in | That role's **tabs**, accented in the role colour |

**Theme defaults to light.** Following the OS would hand a dark app to anyone
whose phone is in dark mode, and the product's identity is the white-and-green
surface the website uses. Dark is a setting people opt into, later, from
Settings — `themePreference` starts at `"light"`, not `"system"`.

**Insets are the `Screen` primitive's job, and no screen opts out.** Android has
been edge-to-edge with no opt-out since RN 0.86, so the app always draws behind
the status bar and the navigation bar.

- *Top:* the `AppBar` **extends into** the status bar and pads its own content
  clear of it, so the colour reaches the top edge and the title sits below the
  clock. Screens with no AppBar reserve `insets.top` themselves.
- *Bottom:* the edge that actually breaks. Under gesture navigation
  `insets.bottom` is a ~20dp hint bar and almost anything looks fine; switch the
  phone to **three-button navigation** and it becomes ~48dp of opaque buttons
  drawn on top of the app — an unpressable submit button, an unreadable last
  row. Exactly one of the tab bar, a sticky footer, or the scroll content
  reserves it. Never two, or the gap doubles.

**Bottom chrome hides on scroll down and returns on a small scroll up.** That
means the role tab bar *and* floating actions — the signed-out Log in pill today,
the resident SOS button later — from one shared value in `BottomChromeProvider`
at the app root. Not inside the tab navigator: the signed-out home is a plain
stack with no tabs and has to feel identical.

Thresholds are asymmetric: 16px of downward intent to hide (so a jittery thumb or
a rubber-band bounce does not flicker it), 6px upward to return (someone
scrolling back up is looking for a way out of the screen). Everything at the
bottom is absolutely positioned, so hiding never reflows the content behind it,
and the whole thing is a Reanimated worklet on the UI thread rather than JS.

`Screen` resets the state on focus — the value is app-wide, so a screen left
scrolled-and-hidden would otherwise hand the next one a missing tab bar that
cannot be scrolled back into view.

### Tab sets (agreed 2026-08-16, against the discovery mockups)

Mockups for the public/discovery side live in
[`docs/mockups/mobile/`](mockups/mobile/README.md). Three decisions came out of
them and are settled:

- **Residents keep `Home · Payments · Food · Notices · More`.** Discovery is an
  **Explore** entry inside More, not a tab. Someone who already has a bed opens
  the app to pay rent or read a notice.
- **`PUBLIC_USER` tabs are `Home · Search · Compare · Profile`.** The mockups'
  *Bookings*, *Messages* and *Saved* are **cut**: there is no booking model, no
  messaging endpoint and no favourites collection anywhere on the server, and a
  tab that opens onto a permanent empty state is the tab people stop trusting,
  not the feature.
- **Signed-out keeps the floating Log in pill and no tab bar**, per the shell
  contract above. The mockups draw a tab bar on signed-out screens; that part
  does not apply, the rest of each screen does.

### Boot contract (agreed)

The splash screen must never flash a wrong screen.

1. Splash is held (`SplashScreen.preventAutoHideAsync()`) while the root layout reads
   the session from SecureStore.
2. If a token exists, decode the role from the persisted user record and `router.replace()`
   **straight into that role's route group**. Splash hides only after that navigation
   commits. The user never sees login.
3. *Then*, in the background, `GET /api/v1/auth/me` confirms the token is still good and
   the role has not changed. If it 401s, the axios interceptor refreshes; if refresh fails,
   the store is wiped and the user lands on `(auth)/login`.
4. If no token exists, go to `(auth)/login` before hiding the splash.

The web session is independent — the mobile client sends `x-hostelhub-client: mobile`,
which is what makes `/auth/login` return `refreshToken` in the JSON body instead of a
cookie (`apps/web/src/lib/mobile-auth.ts`).

---

## 1. Server-side gaps this app depends on

These are **not** mobile work, but the mobile app cannot pass its acceptance tests until
they exist in `apps/web`. Each is tracked as an item in its phase below.

| Gap | Evidence | Blocks |
|---|---|---|
| ☑ ~~**No push sender exists.**~~ **Fixed 2026-08-16.** `push.service.ts` + `push-routing.ts` now batch active tokens to Expo, prune `DeviceNotRegistered` ones, and are called from `publishNewNotification` — the single funnel every notification already goes through, so no call site had to change. 13 tests. | `apps/web/src/modules/notifications/push.service.ts` | — |
| ☑ ~~**No mobile Google client IDs.**~~ **Fixed 2026-08-17 (yours).** An Android OAuth client now exists in project `567374505362` for `com.softmato.hostelhub`, with both the EAS keystore SHA-1 (`A8:D5:01:5D:…`) and the local debug keystore's registered, so `expo run:android` and an EAS build both work. **The server needed no change**: the client is configured with the *web* client id, so the ID token's `aud` is already the `GOOGLE_CLIENT_ID` that `verifyGoogleIdToken` checks. No iOS client yet. | `apps/web/src/app/api/v1/auth/google/route.ts` | — |
| ☑ ~~**Cook has one endpoint.**~~ **Fixed 2026-08-17.** Three cook-scoped reads now exist beside the announce route, on the same `[COOK, HOSTEL_ADMIN, WARDEN]` role list: `GET /cook/today` (today's meals, the whole weekly routine, the active-resident head count, and today's `FoodReadyLog` rows so the four buttons show what has already gone out), `GET /cook/residents` (**name and room type only** — the cook credential is shared kitchen-wide and effectively static, so this is the one list a leaked password would expose, and it is deliberately worth no more than a noticeboard), and `POST /cook/food-photos` (delegates to `uploadFoodPhoto`, which owns the audit row and the FOOD publish, with the cook's hostel resolved by `resolveCookHostelId`). The `hostel-admin/food/*` routes are untouched — `manageFood` excludes a COOK by definition, which was the whole problem. 9 tests. | `apps/web/src/modules/food/cook.service.ts` | — |
| **Provider job claim is unbuilt.** `/public/service-providers/me/jobs` returns directly-assigned work only; broadcast-and-claim does not exist server-side. **Shipped assigned-only 2026-08-17**, and the mobile app draws no "available jobs" tab — a feed that is permanently empty because the concept does not exist reads as a broken app rather than a product boundary. Still open if broadcast is ever wanted. | PHASES.md §6.1, superseded note | Provider job feed (M7) — assigned-only shipped |
| ☑ ~~**A provider could not close their own job.**~~ **Fixed 2026-08-17.** `PATCH /public/service-providers/me/jobs/{id}` accepts `CONTACTED` and `COMPLETED` and nothing else — `CANCELLED` is the hostel's decision, `SCHEDULED` carries a date a provider has no field to set, and `PENDING` would let one un-finish paid work, so `serviceProviderJobStatusSchema` is deliberately narrower than the hostel's `maintenanceStatusUpdateSchema`. Scoped through `findOwnProvider` and pinned to `providerId`, so another provider's job is a plain 404 (RULES.md §3); the write is pinned to the status it read, so two taps cannot both win; closed jobs 409 rather than rewriting a completion date. Writes `MaintenanceHistory`, an audit row tagged `source: "SERVICE_PROVIDER"`, and publishes on MAINTENANCE so the hostel's queue updates live. 9 tests. | `apps/web/src/modules/service-providers/service-provider.service.ts` | — |
| ☑ ~~**No resident-facing invoice line items.**~~ **Fixed 2026-08-17.** `ResidentPortalInvoice` now carries `lines` — description, signed amount, basis and proration basis — read from `InvoiceModel` beside `referenceCode` on the same grounds ADR-3 allows that one (the ledger facade describes *balances*; these are the invoice's own description of itself). `feeScheduleId` is stripped: it is an internal tracing handle with no route that resolves it. The admin matrix is untouched — it is one row per resident per month and would carry every line for nothing. 3 tests. | `apps/web/src/modules/finance/invoice-list.service.ts` | — |
| ☑ ~~**eSewa checkout cannot be handed off from mobile.**~~ **Fixed 2026-08-17.** `/pay/{reference}` re-derives the signed fields from the **stored intent** and serves them as a real self-submitting form. Nothing new is persisted and no intent is created: every signature input is already on the row or resolvable from it, and eSewa's `createIntent` is pure, so the rebuild is byte-identical. Reachable without a session — the phone's browser has none, which is the problem — and bounded to `CREATED`, unexpired intents; a `REDIRECT` provider is refused outright rather than wrapped in a browser. 10 tests. | `apps/web/src/modules/finance/gateway/handoff.service.ts` | — |
| **`PaymentIntent.deeplinks` is declared and populated by nothing.** `{ label, url }[]`, "deep links into wallet apps, where the provider offers them" — no adapter sets it and `PaymentIntentView` does not return it, so it never reaches a client. Mobile falls back to `Linking.openURL` on the redirect URL and lets Android App Links / iOS Universal Links find the wallet app. A named "Open in Khalti" button needs the server to fill this in; the client should not keep a table of six vendors' URL schemes in step. | `apps/web/src/modules/finance/gateway/provider.types.ts:94` | Named wallet-app buttons (M3) — OS handoff ships |
| ☑ ~~**No ratings on the public hostel list or detail.**~~ **Fixed 2026-08-17.** `ratingSummariesFor()` is now one aggregation shared by `listPublicHostels`, `getPublicHostelBySlug` and `comparePublicHostels`, and every public payload carries `ratingSummary`. One round trip per page, not one per card — the listing returns up to 60. `VISIBLE` reviews only, unrounded (rounding would have silently changed what compare has always returned), and `total` is the field that says whether a rating exists at all. 6 tests; web suite green at 1,694. | `apps/web/src/modules/hostels/hostel.service.ts` | — |
| **Gateway return URL is web-only.** The intent's `returnUrl` is `{siteUrl}/resident/payments/checkout/{reference}` with no mobile scheme, so the in-app browser never redirects to `hostelhub://`. Mobile polls instead, which is correct regardless — but a deep link would close the browser automatically. | `apps/web/src/modules/finance/gateway/intent.service.ts:152` | Auto-dismissing the checkout browser (M3) — polling ships |
| ☑ ~~**No resident-facing `nightStatus`/`complaints` on the dashboard.**~~ **Fixed 2026-08-17.** Both were literals — `{ status: "UNKNOWN" }`, which `NightStatusValue` does not contain, and `{ openCount: 0, recent: [] }`. Now `readNightStatusFor()` and `summarizeResidentComplaints()`, exported from the modules that own those serializers so "absent means `NOT_VERIFIED`" stays one fact in one place, and read in the same `Promise.all` as everything else. The **web** resident dashboard was rendering the placeholder too, so it is fixed on both clients. 2 tests. | `apps/web/src/modules/residents/resident-dashboard.service.ts` | — |
| **Night-status history is written and never read.** Every change appends a `NightStatusLog` — `previousStatus`, `nextStatus`, `source`, `changedBy` — and the only reference to that model in the whole repo is the `create` that writes it. No resident route, no admin route, no aggregation. The data is all there; it needs a `GET /resident/night-status/history` reading it back, paginated. *(Found 2026-08-17 auditing M5.)* | `apps/web/src/modules/safety/safety.service.ts:220` | Night-status history list (M5) — the setter ships |
| **Residents cannot add or remove their own emergency contacts.** `/resident/emergency-contacts` is GET-only, and the sole `EmergencyContactModel.create` in the repo sits inside admin resident creation. So the numbers a resident sees in an emergency are whoever the hostel typed in at move-in, and neither they nor the office can correct one without editing the resident record. Needs POST/DELETE on the resident route, scoped to their own contacts. *(Found 2026-08-17 auditing M5.)* | `apps/web/src/modules/safety/safety.service.ts:556`, `resident.service.ts:789` | Emergency-contact editing (M5) — read-only ships |
| ☑ ~~**The web's guardian dashboard reads three fields the serializer does not return.**~~ **Fixed 2026-08-17.** `GuardianDashboard` is now written off the serializer — `fullName`, `safety.asOf` (rendered as a **date**, never a time), a nullable `summary`, plus `permissions`, `access` and `receipts`. Both web pages were reworked to match: every section is gated on its flag and **absent** when ungranted rather than drawn empty, the dues table joins the real `receipts` list by billing month instead of showing a Download affordance with no route behind it, and `guardian.service.ts` now returns the hostel's own `contact` so the "call the hostel" buttons dial something. Four new tests pin the contract both clients render off. The original text: `daily-operations-shared.tsx`'s hand-written `GuardianDashboard` type had drifted from `getGuardianDashboard`: (1) it declares `resident.firstName`/`lastName`, but the serializer returns **`fullName`** — so `guardian-dashboard-page.tsx`'s `residentName` renders the literal **"undefined undefined"** as the ward's name and feeds "u" to the avatar; (2) it declares `safety.checkedAt`, but the serializer returns **`asOf`** (deliberately date-truncated, because §4.1 forbids showing a guardian the exact check time) — so the Safety Status card renders **"Invalid Date"**; (3) it types `summary` as non-null, but the serializer returns **`null` when `canViewPayments` is false** — so `dashboard.summary.dueAmount` **throws** for a guardian without payment permission. The type also omits `permissions`, `access` and `receipts` entirely, which is why the page cannot respect the per-guardian flags. *(Found 2026-08-17 reading the service before porting M7.)* | `apps/web/src/app/_components/daily-operations-shared.tsx:33`, `guardian.service.ts:474` | Nothing on mobile — `lib/guardian-api.ts` will be typed off the service. **The web page needs all three fixed** |
| ☑ ~~**The guardian dashboard's "Make a Payment" button does nothing.**~~ **Removed 2026-08-17**, and replaced by a line saying where payment actually happens (the resident's own portal, or the hostel office). Three more dead controls went with it while the page was open: the safety page's "Emergency Status — Normal / No active alerts" tile, which printed "Normal" whether or not an alert was live because the guardian payload carries **no SOS field at all**; the "On duty · Available" badge over a Call button that dialled nobody, now wired to the hostel's real number; and "How We Ensure Safety", which linked nowhere. The mobile port draws none of them. | `apps/web/src/app/_components/guardian-dashboard-page.tsx`, `guardian-safety-page.tsx` | — |
| **Community avatars show the viewer's own face on other people's posts.** `serializePost` returns `authorImage: User.image`, and `resident-identity.service.ts` keeps that field in step with the ID-card photo by storing **`/api/v1/users/resident-identity/photo?v=…`** — a route with *no id in the path*, which by design returns only the caller's own photo. So every author whose avatar came from their ID card renders as whoever is looking. It leaks nothing (the route cannot be pointed at anyone else) but it is wrong, and `apps/web` does it today. Needs either an id-scoped read route or an absolute URL stored on the user. *(Found 2026-08-17 building M5.8.)* | `apps/web/src/modules/community/community.service.ts:287`, `resident-identity.service.ts:402` | Nothing on mobile — `usableAvatarUrl` renders only absolute URLs and falls back to the initial |
| **A resident cannot read their own review back.** `createResidentReview` is the only resident-facing function in `review.service.ts` — there is no `GET /resident/reviews` — and `serializePublicReview` strips `residentId`, so the review cannot be matched to its author from the public list either. The web's form has the same hole and simply resets after submit. Needs a `GET` returning the caller's own row. *(Found 2026-08-17 building M5.7.)* | `apps/web/src/modules/reviews/review.service.ts:137` | Nothing — the mobile form starts empty and says the submission replaces what came before |
| **A review category cannot be cleared once scored.** The POST is `findOneAndUpdate` with `$set: { ...input }` and `upsert: true`, so it is one merging row per resident: a category the payload omits keeps its previous value, because `$set` never touches an absent key, and `starRating` has no `null` or `0` to send instead. So a 4 given to food survives every later resubmission that leaves food blank. Needs either a `$unset` for omitted keys or a nullable rating. *(Found 2026-08-17 building M5.7.)* | `apps/web/src/modules/reviews/review.service.ts:153` | Nothing — the star row does not offer a clear gesture, and the merge is stated above the form |
| **The referral link the server hands residents credits nobody.** `serializeReferralCode` builds `link: "/inquiry?ref=<code>"` and the resident portal copies it to the clipboard as its primary action — but `public-inquiry-page.tsx` reads `hostel` and `room` from the query string and **ignores `ref`**, and `/public/inquiries/with-referral` (the only endpoint that creates a `Referral`) is called by `apps/mobile` and one test and nothing else. So every referral shared through that link has been silently dropped, and the referrer loses a reward they earned. Needs the inquiry page to read `?ref=` and post to the referral endpoint when present. *(Found 2026-08-17 in M6, re-verified while building M5.6 — the mobile screen shares the **code** instead, which works via `app/ref/[code].tsx` and `linkReferralOnRegistration`.)* | `apps/web/src/app/_components/public-inquiry-page.tsx:46`, `referral.service.ts:114` | Nothing on mobile — the code path ships; the web's own referral page is still broken |
| **A resident can set their own night status to `SOS_TRIGGERED`.** `POST /resident/night-status` validates against the full `nightStatusSchema`, all five values, so `updateResidentNightStatus` will happily write the emergency status with `source: "RESIDENT"`. No `SOSAlert` row is created, `fanOutSOSAlert` never runs, and nobody is notified — the warden's roster and its summary counts simply show an active SOS that exists as a word. Conversely a resident could set `NOT_VERIFIED`, the value that means "no row exists". The resident route needs its own narrower schema (`INSIDE_HOSTEL`, `OUTSIDE_HOSTEL`, `MARKED_SAFE`); the warden override can keep the full enum. *(Found 2026-08-17 building M5.3.)* | `apps/web/src/modules/safety/safety.validation.ts:15`, `safety.service.ts:251` | Nothing — the mobile client offers only the three self-reportable values |
| **The resident complaints route parses no query.** `GET /resident/complaints` calls `listResidentComplaints(principal)` with no second argument, so the service's `{ page: 1, pageSize: MAX_PAGE_SIZE }` default always applies: the newest 100 and no way to ask for more. The service already takes a `PaginationQuery` and the response already carries `pagination` — the route just never reads `?page`. So the meta a client would page against is present and always describes page 1. Needs the two lines every other list route has. *(Found 2026-08-17 building M5.2.)* | `apps/web/src/app/api/v1/resident/complaints/route.ts:16` | Nothing yet — a resident with >100 complaints cannot reach the oldest; no pager is drawn |
| **There are no notification preferences at all.** No `notificationPreference`, `emailNotifications` or `pushEnabled` field exists on any model, so there is nothing for a Settings screen to read or write — and, more to the point, nothing for `push.service.ts` to consult before it sends. Every resident currently gets every category. Needs a preference document plus a check in the push/email funnel; a client-only toggle would be a lie, since the server would keep sending. *(Found 2026-08-17 auditing M5.)* | `apps/web/src/modules/notifications/push.service.ts` | Settings → notification preferences (M5) — theme/deletion/privacy ship |

> ☑ **Dead payment endpoints — addressed 2026-08-16.** The old client called
> `/api/v1/resident/payments` and `/resident/payments/{id}/proof`; **both are
> gone**, so that tab could never have worked. `apps/mobile/src/lib/finance-api.ts`
> is now typed against the live surface — `/resident/finance/invoices`,
> `/invoices/{id}/claims`, `/invoices/{id}/checkout`,
> `/invoices/{id}/pay-instructions`, `/receipts/{id}/pdf`, `/statement/pdf`,
> `/checkout/{reference}` — with the old paths named in its header comment so the
> mistake cannot quietly recur.

---

## M0 — Scaffold & toolchain ✅ *(2026-08-16, bar the device run)*

Goal: `npm run mobile:start` opens a green-themed screen on a device, with typecheck
and lint clean.

Landed on **Expo SDK 57** / React Native 0.86.2 / React 19.2.3 — newer than the
reference app's SDK 54, so versions were resolved by `expo install` rather than copied.

- ☑ Re-scaffold `apps/mobile` with `create-expo-app@latest` (default template, expo-router), demo screens stripped
- ☑ `apps/mobile` stays out of the root `workspaces` array, with its own `package-lock.json`
- ☑ Deps installed via `expo install` so SDK-57-compatible versions resolve
  - ☑ Router/UI: expo-router 57, expo-linking, expo-constants, expo-splash-screen, expo-system-ui, safe-area-context, screens, gesture-handler, reanimated 4.5
  - ☑ Styling: nativewind 4.2 + tailwindcss 3.4
  - ☑ State/HTTP: @reduxjs/toolkit, react-redux, redux-persist, async-storage, axios
  - ☑ Native: expo-secure-store, expo-image, expo-image-picker, expo-camera, expo-haptics, expo-linear-gradient, expo-web-browser, expo-clipboard, expo-device, expo-file-system, expo-local-authentication, expo-application
  - ☑ Notifications/realtime: expo-notifications, pusher-js
  - ☑ UX: @gorhom/bottom-sheet, react-native-toast-message, @expo/vector-icons
- ☑ `babel.config.js` (nativewind preset + `react-native-worklets/plugin` last) and `metro.config.js` (`withNativeWind`)
- ☑ `tsconfig.json` with `@/*` alias; `nativewind-env.d.ts` carries the `*.css` declaration
      — **not** `expo-env.d.ts`, which the Expo CLI regenerates and which silently
      dropped it once
- ☑ `app.json`: name **HostelHub**, slug `hostelproject`, scheme `hostelhub`,
      package `com.softmato.hostelhub`, `newArchEnabled`, EAS project id, plugin list
      with permission strings
- ☑ `eas.json` — development / preview / production, APK output
- ☑ Root scripts: `mobile:start`, `mobile:typecheck`, `mobile:test`, `mobile:lint`, `mobile:build:test`, `mobile:build:preview`
- ☑ ESLint (`eslint-config-expo`) — clean, zero warnings
- ☑ Vitest for pure logic (`vitest.config.mts`, node environment, no RN shim)
- ☑ Env contract documented in `apps/mobile/README.md`
- ☑ `npm run mobile:typecheck` clean
- ☑ `expo export --platform android` bundles (1,896 modules), which is the real
      compile check — typecheck alone misses Metro resolution errors
- ☐ App runs on a physical Android device over LAN *(yours to confirm)*

> The in-app Browser pane could not verify this visually: it runs with
> `document.hidden === true`, so React never hydrates and screenshots time out.
> Known environment behaviour, not an app fault. Device verification is the real
> check.

---

## M1 — Design system & app shell ◐ *(every tracked item built 2026-08-17; only the real logo and Bikram Sambat dates remain, both waiting on you)*

Goal: every later screen is assembled from primitives that already match the web.

- ☑ `global.css` — web tokens ported name-for-name from `apps/web/src/app/globals.css`,
      oklch → hex. Brand `--primary: #0a8a4b`. Role tokens for all six audiences
      (the web's four plus cook `#ea580c` and provider `#7c3aed`)
- ☑ Dark palette under both `@media (prefers-color-scheme: dark)` and `.dark`, so the
      in-app override wins in either direction
- ☑ `tailwind.config.js` maps every token to a utility class
- ☑ `constants/theme.ts` — the JS mirror for consumers that cannot use `className`
      (status bar, splash, notification channel colours)
- ☑ `hooks/use-app-theme.ts` — resolves preference → OS → NativeWind, so the `dark:`
      variants and the JS palette can never disagree
- ☑ Primitives: `Screen` (insets + keyboard + pull-to-refresh), `Text` (variant table),
      `Button`, `Input`, `Card`, `SectionHeader`, `LoadingState`, `EmptyState`, `ErrorState`
- ☑ Toast host wired into the root layout, with a `lib/toast.ts` facade
- ☑ Branded splash: centred mark, wordmark, **"Powered by Softmato"** below, drawn to
      match the native splash so the handover is invisible
- ☑ Placeholder brand assets generated (icon, adaptive layers, monochrome, splash,
      logo marks) with `assets/images/README.md` covering the swap
- ☑ Haptics on every button press by default, opt-out per button
- ☑ **Light by default**; `system`/`dark` remain available for the Settings screen
- ☑ `Screen` owns every inset — top strip, bottom nav bar, sticky footer, tab bar
- ☑ `AppBar` extends into the status bar rather than sitting below it
- ☑ `AnimatedTabBar` — custom (the navigator's default cannot be driven from a
      screen's scroll offset), absolutely positioned, hide-on-scroll
- ☑ Tab shells for all five signed-in roles, each in its own accent colour
- ☑ Public shell with the Login CTA where tabs would be
- ☑ Remaining primitives: ☑ `Badge`, ☑ `StatusPill`, ☑ `ListRow`, ☑ `Money`,
      ☑ `Select`, ☑ `Avatar`, ☑ `Skeleton`, ☑ `Sheet` *(last four 2026-08-17)*
  - ☑ The status→tone **table** lives in `lib/status.ts`, not in the pill. Vitest here
        is node-side with no RN shim, so anything importing `react-native` cannot be
        tested — and the table is the part that needs it. The web's `StatusBadge`
        matches substrings, and `"UNPAID".includes("PAID")` renders an unpaid invoice
        green
  - ☑ `Sheet` is `@gorhom/bottom-sheet`, whose provider had been mounted at the root
        since M1 with nothing using it. A plain `<Modal>` — what `hostel-browser.tsx`'s
        filter panel is — cannot be dragged away, and a bottom sheet with no drag reads
        as broken rather than as a different component. Wrapped declaratively (`open`
        prop, private ref) because every caller already holds the boolean
  - ☑ `Select` is that sheet, not `@react-native-picker/picker`: the picker is a
        spinner on iOS and a dropdown on Android, so one field would be two controls of
        two heights on a form that is otherwise all `Input`s. The trigger mirrors
        `Input` exactly — same height, border, label and error slots
  - ☑ `Avatar` falls back to one initial on a name-hashed tone, matching the web's
        `community-post-card.tsx` so the same person is the same colour in both
        clients. It swaps to the initial `onError` as well as on a null URL — a private
        asset that 401s returns a URL that exists and cannot be drawn. Pure half in
        `lib/avatar.ts`, 10 tests
  - ☑ `Skeleton` pulses from a Reanimated shared value, so it keeps animating while JS
        is parsing the very response it is waiting for. Never for a refresh:
        `use-resource.ts` deliberately keeps data on screen, and swapping it for grey
        blocks throws away what the user was reading
- ☑ Global upload-progress toaster *(2026-08-17)* — `lib/upload-queue.ts` +
      `components/upload-toaster.tsx`, ported from the web's `stores/upload-store.ts`
  - ☑ Every `uploadAsset` call registers itself, so a screen gets progress, a stage
        label and a failure reason without wiring anything up — the web's rule that
        call sites never build their own progress UI. `claim.tsx` lost its inline
        percentage and its failure toast to it; two notices for one event reads as
        two failures
  - ☑ **Not a Redux slice.** `redux-persist` writes to AsyncStorage on change and byte
        progress fires dozens of times a second — dozens of disk writes per photo on
        exactly the low-end handsets this targets. It is also meaningless after a
        relaunch: an upload the app died during did not happen. Plain module store read
        through `useSyncExternalStore`; 15 tests
  - ☑ **Anchored to the top edge**, unlike the web's bottom-right. This is a root
        overlay and the root cannot know what is beneath it: half the app's screens sit
        in a `<Tabs>` navigator with an absolutely-positioned bar and the rest may hold
        a sticky footer with the only submit button. Bottom anchoring would cover one
        or the other — the unpressable button §0 exists to prevent. The transient toast
        host moves down while cards are showing rather than stacking on them
  - ☑ It reports "Dismiss", not "Cancel": `expo-file-system`'s upload has no abort
        handle once in flight, and a cancel that only hides the row is a lie about
        where the bytes went
- ◐ Nepali rupee formatting + date helpers — `lib/format.ts`, 13 tests
  - ☑ `formatMoney`/`formatAmount`: hand-rolled grouping, paisa shown only when the
        amount has any. Not `Intl` — Hermes borrows the *platform's* ICU, so `en-NP`
        resolves differently per handset and an unknown locale silently becomes `en-US`
  - ☑ Dates fixed to NPT (UTC+05:45, no DST) by shifting the instant and reading the
        UTC getters, so a phone left on another timezone still shows Nepali days.
        Without it, "today's menu" serves the wrong dinner for the last 5h45m of
        every day
  - ☑ Bikram Sambat calendar — **built 2026-08-18 on the 2026-08-17 decision:
        show both, side by side**. `formatDateBs` and `formatDateBoth` in
        `lib/format.ts` render `2 Bhadra 2083 · 18 Aug 2026`; applied to invoice
        due dates first, which is where the decision's reasoning bites — the
        hostel's books run on BS and the bank's statement runs on AD, so a
        one-calendar due date makes somebody convert in their head at exactly the
        moment a mistake costs money.
        The conversion is `nepali-date-converter` (MIT), **not a hand-copied
        table**: BS month lengths vary per year and are tabulated data, so
        transcribing ~30 years of it would be inventing something authoritative
        that is wrong in one cell nobody notices for a year. Checked against five
        New Year anchors (2013-04-14, 2023-04-14, 2024-04-13, 2025-04-14,
        2026-04-14 → Baisakh 1) before adoption; 4 tests hold that. Converts on
        the **Nepal** day, so a phone left on another timezone still reads the
        date the hostel means. A year outside the table falls back to Gregorian
        rather than showing a wrong Nepali date.
        Still to do: the same treatment on `apps/web` (see `tasks.md` §7.3)
- ☐ Real logo replacing the placeholders *(waiting on you)*

---

## M2 — Auth, session & the no-flash boot ◐ *(every screen built 2026-08-17, Google sign-in included; only the device pass is outstanding)*

Goal: the boot contract in §0 works, on cold start, warm start, and after a token expiry.

- ☑ `lib/api.ts` — axios instance, API URL resolved from Metro's LAN host in dev
      (including the Android emulator `10.0.2.2` swap), `EXPO_PUBLIC_API_URL` otherwise
- ☑ Every request carries `x-hostelhub-client: mobile`, which is what makes
      `/auth/login` return `refreshToken` in the body
- ☑ Request interceptor attaches the bearer from Redux, falling back to SecureStore
- ☑ Response interceptor: 401 → **single** in-flight refresh with a waiter queue →
      retry → on failure wipe store + purge persistor + route to login. Parallel
      refreshes are the bug here: the loser writes an already-rotated token
- ☑ `publicApi` is a separate instance with no interceptors, so a wrong password
      reads as a wrong password instead of triggering a refresh-and-logout
- ☑ `store/` with `authSlice`, `uiSlice`, and a `RESET_STORE` action returning every
      slice to initial state — shared phones must not leak account A's cache to B
- ☑ `accessToken` and `isReady` stripped from the persisted payload: the token's home
      is SecureStore, and a rehydrated `isReady: true` would skip the gate entirely
- ☑ `lib/session.ts` — SecureStore read/write/clear
- ☑ `lib/auth-session.ts` — bootstrap (no network) / revalidate (after first paint) /
      start / end
- ☑ Root `_layout.tsx` — providers, splash hold, boot orchestration
- ☑ `app/index.tsx` — the gate: pure synchronous `resolveHome`, then `<Redirect>`
- ☑ `resolveHome` covered by 8 tests, including platform staff → public app and the
      approved-provider-is-a-PUBLIC-account case
- ☑ `(auth)/login.tsx` — email/phone + password, with the session-ended reason shown
- ☑ Logout: revoke, clear tokens, reset store, purge
- ☑ Unactivated resident routes to `activate` rather than a dashboard that would 404
- ☑ Suspended account (403 on refresh) surfaces its own message, not a silent failure
- ☑ `(auth)/register.tsx` — details → email OTP → verify → session *(2026-08-17)*
  - ☑ **`lib/auth-api.ts` had the OTP contract wrong**, the same way `finance-api.ts`
        did: `requestOtp` was typed `"email" | "sms"` × `"registration" |
        "password-reset"` and `register` took a `phone`. `auth.validation.ts` accepts
        `z.enum(["email"])` and `z.enum(["registration"])` and `registerSchema` has no
        phone field — so an SMS channel would have 400'd and a phone number would have
        been silently stripped, leaving an account whose owner believes it has one.
        Read the *validation schema*, not the route name
  - ☑ One screen with two steps, not two routes: Back from the code step must return
        to the details with everything still filled in, and a `challengeId` threaded
        through navigation params is a second place to lose it
  - ☑ The whole draft is validated **before** the code is requested (`lib/auth-form.ts`,
        21 tests). `/auth/otp/request` sends an email per call and allows five in
        fifteen minutes, so a password the phone could have rejected costs one of five
  - ☑ The resend button counts down 60s locally, because the server's
        `OTP_RESEND_COOLDOWN` 429 also spends an attempt
  - ☑ `ACCOUNT_ALREADY_EXISTS` is reported back on the **details** step next to the
        email. Left on the code step it reads as a bad code, and the user retypes it
        until the attempts run out
  - ☑ The account created is `PUBLIC`, so it lands in `(browse)`. Signing up is not
        how anyone becomes a resident — that is the QR code
- ☑ `(auth)/forgot-password.tsx` → reset flow *(2026-08-17)*
  - ☑ Two steps: request the link, then redeem it. The confirmation is phrased
        conditionally ("if an account exists"), matching the server — `requestPasswordReset`
        returns `{ requested: true }` either way on purpose, because an endpoint that
        says "no such user" is an account-enumeration oracle
  - ☑ **The token is pasted, not deep-linked.** The emailed link is
        `{appUrl}/reset-password?token=…` — a web URL, because the same mail goes to
        people who signed up on the website. Tapping it finishes in the browser, which
        works; the paste path exists so somebody already standing in the app is not at a
        dead end. `extractResetToken` unwraps the whole URL, since the whole URL is what
        a phone copies, and refuses a URL with no `token=` rather than spending an
        attempt on it
  - ☑ Lands on login afterwards, never a session: `resetPasswordWithToken` bumps
        `tokenVersion` and revokes everything, so there is no session to hand back
- ☑ Google sign-in on login **and** register *(2026-08-17, once you created the
      Android OAuth client)* — `lib/google-auth.ts`,
      `components/google-sign-in-button.tsx`, 7 tests
  - ☑ **`@react-native-google-signin/google-signin`, not `expo-auth-session`.**
        `configure({ webClientId })` mints a token whose `aud` is the *server's*
        client, which is the one `verifyGoogleIdToken` checks — so the server was
        not touched. The `expo-auth-session` route issues the token against the
        **Android** client instead, which would have meant widening
        `audience: GOOGLE_CLIENT_ID` to an array and adding two more env vars to
        keep in step across three files. It also gets the native account sheet
        rather than a browser round trip
  - ☑ **The Android client id is deliberately not read by any code.** It is what
        authorises this APK to reach Google — package plus signing SHA-1 — not
        what the token is addressed to. Naming it in `configure()` is the obvious
        move and yields `GOOGLE_TOKEN_INVALID` with nothing in the message
        pointing at the cause
  - ☑ **Signs out of the Google client before every attempt.** Google otherwise
        reuses the last account with no picker, so on a shared phone — the normal
        case in a hostel — the second person silently lands in the first person's
        account. Same ground as `RESET_STORE` wiping every slice on logout
  - ☑ Cancelling the account sheet reports **nothing**. An error line under the
        button after backing out reads as the app having broken, and that is the
        button people stop trusting. Same for the `IN_PROGRESS` code an impatient
        double-tap produces
  - ☑ The status-code branching lives in `lib/google-error.ts`, not beside the
        native call — Vitest here is node-side with no RN shim, so the tested half
        has to be RN-free. **The codes are injected, never hardcoded:**
        `SIGN_IN_CANCELLED` is `"12501"` on Android and `"-5"` on iOS, so a
        literal would report a cancellation as a failure on the other platform.
        One test pins exactly that
  - ☑ Play-services-missing gets its own message naming the way round it. It is
        the one failure the user can act on, and it is common on the handsets this
        product targets
  - ☑ No config plugin registered: the plugin's bare form is its *Firebase* mode
        and needs a `google-services.json` that does not exist here, and its other
        form only adds an iOS URL scheme. Android autolinks and takes everything
        from `configure()`
  - ☑ On register it skips the OTP step, correctly — Google has proved the
        address, and the server refuses a token whose `email_verified` is false.
        Labelled "Continue with", not "Sign up with": `/auth/google` links an
        existing account as readily as it creates one
  - ☐ **Needs a dev/preview build to test** (`npx expo run:android`) — native
        module, not in Expo Go. Nothing on the boot path imports it, so the rest
        of the app still runs under Expo Go
  - ☐ iOS: no OAuth client yet, so `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID` is unset and
        the plugin entry with `iosUrlScheme` is not added. Android-only for now
- ☑ `mustChangePassword` accounts (provisioned cook/warden) forced through a
      set-password step *(2026-08-17)* — `(auth)/set-password.tsx`
  - ☑ The check sits in `resolveHome` **above the role branch**, so it is a gate on
        every launch rather than a prompt with the app visible behind it. Until the
        password is replaced, the admin who issued it can still sign in as that account
        and everything it logs is deniable
  - ☑ No current-password field: `changePassword` requires one only when the flag is
        false, and asking for it would demand back the temporary password this exists
        to retire. A confirmation field instead — the password is being invented and it
        is masked, and a typo nobody catches locks the account out until an admin
        issues another
  - ☑ Sign out lives in the app bar, for the same reason it does on `activate`: the
        gate is on every launch, so without it a forgotten temporary password is a
        locked app
  - ☑ **Fixed while wiring this:** `revalidateSession`'s return value was discarded in
        `_layout.tsx`, which made "and the role has not changed" (§0 step 3) a no-op —
        a resident promoted to warden, an account newly flagged, or a QR activated on
        another device all stayed on the stale screen until the next cold start. The
        result now re-routes, and it only returns an account when something moved
- ☐ Verify on device: cold start with a valid token shows **no login flash**

**Acceptance**
- ☐ Cold start with a valid token lands on the role dashboard with **no login flash**
- ☐ Kill the app, expire the access token server-side, relaunch → silent refresh, still no flash
- ☐ Revoke the refresh token → relaunch → lands on login, store empty
- ☐ Log in as resident, log out, log in as cook → no resident data visible anywhere

---

## M3 — Resident core ◐ *(all five tabs 2026-08-16; the three server gaps closed 2026-08-17)*

The primary audience. Tabs: **Home · Payments · Food · Notices · More**.

Every tab, every payment flow, and — as of 2026-08-17 — the three things that
were blocked server-side: invoice **line items**, **eSewa checkout**, and the
dashboard's real **night status and complaints**. All that is left in this
milestone is the device pass.

Verified the same way M0 was: `typecheck` clean, `lint` clean, 205 mobile Vitest
cases, 1,734 web cases green, and `expo export --platform android` bundles —
which is the real check, since typecheck alone misses Metro resolution errors.
The in-app Browser pane still cannot render these (it runs with
`document.hidden === true`, so React never hydrates); a device run against a live
resident account is yours to confirm, and the three acceptance tests below are
the ones that need it.

- ☑ `(resident)/_layout.tsx` — bottom tabs, resident role colour *(the shell landed with
      M1's `RoleTabs`; Home · Payments · Food · Notices · More, accent `RESIDENT`)*
- ☑ **Home** — `GET /resident/dashboard`: dues summary, room/hostel, today's menu,
      latest notices, night status, quick actions
  - ☑ `hooks/use-resource.ts` — the one GET-with-four-states hook. `loading` is the
        first load only (a pull-to-refresh that swaps the list for a spinner throws
        away what the user is reading); responses are matched to the request that
        asked for them, or a slow first load overwrites a fast refresh; refocus
        revalidates silently, because paying an invoice happens on another screen
  - ☑ **One request, as of 2026-08-17.** It was two: the dashboard's `nightStatus`
        was a hardcoded `{ status: "UNKNOWN", checkedAt: null }` — a value the enum
        does not contain, written by nothing — so Home fetched
        `/resident/night-status` alongside it and ignored the dashboard's copy, and
        its `complaints: { openCount: 0, recent: [] }` literal was not rendered at
        all rather than shown as a confident zero
  - ☑ Server: the dashboard reads both properly now (§1), so the second request is
        gone and complaints render. An absent night-status row is `NOT_VERIFIED`,
        which is a real answer rather than a missing one
  - ☑ The complaints card appears **only when there is something to say**. Its
        rows were not pressable while the complaints screens did not exist — a row
        that navigates nowhere is indistinguishable from a bug — and they open
        `/complaints/[id]` as of M5.2
- ☑ `lib/finance-api.ts` — the whole finance surface typed against the live routes,
      with the dead `/resident/payments` paths named in its header so the old mistake
      cannot recur
- ☑ **Payments** — `GET /resident/finance/invoices` list + detail
  - ☑ List: total outstanding, carried credit (shown only when non-zero), open claims,
        one row per month. The **reference code is on the row**, not only behind
        "Pay now" — a resident paying from their banking app out of habit never opens
        the detail screen, and a transfer with no code is matched to a person by hand
  - ☑ `invoice/[id]` at the **root** stack, not inside `(resident)/`: a folder nested
        under a `<Tabs>` layout becomes another tab
  - ☑ Invoice detail with line items and running balance
    - ☑ Running balance — `lib/invoice-ledger.ts`, 8 tests. Receipts are re-sorted
          oldest-first (the server sends newest-first for the list) and any gap
          between `paidAmount` and the receipt total gets its **own line**. The two
          legitimately disagree — a payment can settle before its receipt is issued,
          and receipts voided with a reversed payment are excluded — and a statement
          that closes on a different number from the headline above it reads as the
          hostel's accounting being broken
    - ☑ Copyable reference code, receipts list, claims filed against this invoice
    - ☑ **Line items** *(2026-08-17, once the server exposed them — see §1)*. A
          separate **Breakdown** card above the statement, because the two answer
          different questions: the breakdown is why the total is the number it is,
          the statement is what has happened to it since. "Why is this month more
          than last?" versus "did my payment land?"
      - ☑ A credit line stays **negative and green**, matching the statement below.
            `formatMoney` on its absolute value would show a refund as a second
            charge, which is the misreading that makes a resident phone the hostel
      - ☑ `prorationBasis` leads the subtitle when there is one — `"18/31 days"`
            turns an odd number into an obviously correct one — with the bed type
            as the fallback
      - ☑ The card is absent when there are no lines. Invoices migrated from the
            old `Payment` rows have none, and an empty breakdown would appear on
            exactly the oldest months, where somebody is most likely checking
  - ☑ `GET /invoices/[id]/pay-instructions` — `invoice/[id]/pay`. One method
        expanded, the rest folded away: six panels of account numbers open at once
        is how somebody pays the right hostel from the wrong app. The server ranks
        them, so the primary is `methods[0]` and no client opinion can drift from it
    - ☑ **`finance-api.ts`'s pay-instructions and checkout types were wrong** and
          would have thrown on the first real call. They had been written from the
          route names: `PayInstructions` claimed `bankAccounts[]`/`wallets[]`/
          `qrAssetId` when the server returns one ordered discriminated `methods[]`,
          and checkout claimed `{ url, fields, method }` when it returns
          `{ handoff, reference, … }`. Rule that catches it: read the *service*
    - ☑ The static QR goes through `/files/{assetId}/url`, which authorises — so it
          needs `expo-image`'s `headers`, not a bare `<Image src>`
  - ☑ `POST /invoices/[id]/claims` — `invoice/[id]/claim`. Amount prefilled from
        what is *outstanding* (not the invoice total), method chips, optional
        transaction code, evidence picker
    - ☑ Validation mirrors `claim.validation.ts` client-side (`lib/claim-form.ts`,
          9 tests) and **there is no retry on failure**: the endpoint runs OCR over a
          full-size screenshot and allows 8 an hour, so every avoidable round trip
          spends one of a resident's eight
    - ☑ `created: false` is reported as "already submitted", not a second success —
          the server collapses a replay onto the existing claim
  - ☑ Evidence upload: `expo-image-picker` → `/files/presign` → PUT to R2 →
        `/files/[assetId]/complete` (`lib/uploads.ts`)
    - ☑ The PUT carries **no** `Authorization` header — the URL's signature is the
          credential and an extra auth header makes S3-compatible storage reject it
    - ☑ `kind: "PAYMENT_PROOF"`, because presign refuses a financial asset that is
          not tenant-scoped; and `complete` is not optional — until it runs the asset
          is a reservation the finance module will not accept as evidence
    - ☑ SDK 54 replaced `getInfoAsync`/`createUploadTask` with the `File` object;
          the old names still resolve from `expo-file-system/legacy` and typecheck
          clean from the wrong import, so this is worth knowing before the next one
    - ☑ MIME resolution lives in `lib/mime.ts` (7 tests): R2 signs `Content-Type`
          into the URL, so presign and PUT must agree or the failure is a signature
          error that mentions nothing about types
  - ☑ Gateway checkout — `checkout/[reference]`
    - ☑ **The wallet's own app takes the handoff, not a browser tab** (`lib/wallet.ts`).
          A Custom Tab / `SFSafariViewController` loads the launch URL itself and never
          hands it to a native app that claims the domain — so a resident with Khalti
          installed was typing their password into a web form while the app on the same
          phone already held the session, the balance and the biometric unlock.
          `Linking.openURL` goes through App Links / Universal Links instead, so no
          wallet scheme is hardcoded — a guessed `esewa://` is the same class of mistake
          as inventing an API shape, and Android 11+ needs a `<queries>` entry before
          `canOpenURL` answers honestly anyway. Browser only as a fallback
    - ☑ Khalti (`REDIRECT`) hands off, then the status screen polls
          `GET /checkout/{reference}` with geometric backoff, stopping on `settled`,
          a terminal status, or expiry. A failed poll is not a failed payment
    - ☑ **No `hostelhub://` deep link, deliberately.** The intent's `returnUrl` is
          built server-side as `{siteUrl}/resident/payments/checkout/{reference}` — a
          web page with no mobile scheme — so `openAuthSessionAsync` would wait
          forever. The browser closing was never evidence anyway; the provider is
    - ☑ **eSewa now goes through the server's `/pay/{reference}` relay**
          *(2026-08-17)*. Its v2 checkout is a `FORM_POST` whose signature covers
          fields positionally, and `expo-web-browser` can only open a URL — a
          `data:` URL carrying a self-submitting form is blocked from top-level
          navigation by Chrome, and re-signing client-side would ship the merchant
          secret to a phone. The relay page rebuilds the signature from the stored
          intent and serves a real form, so the phone opens a URL (the one thing it
          can do) and the *resident's* browser still arrives at eSewa — which was
          always the requirement, and the reason the server cannot simply POST on
          their behalf
      - ☑ **Only the reference travels.** The signed fields the app already holds
            are deliberately not re-sent, query-encoded or hashed into the URL: a
            signature in a URL is a signature in a browser history, a server log
            and a referrer header
      - ☑ A `REDIRECT` provider is **not** relayed — Khalti's launch URL is already
            a URL, and wrapping it would put a browser between the resident and the
            wallet app that claims that domain, which holds their session, balance
            and biometric unlock
      - ☑ The relay auto-submits **and** shows a real submit button. A page whose
            only way forward is a script is a dead end when the script does not
            run, and the dead end would be in the middle of paying rent
  - ☑ Receipts: `GET /receipts/[id]/pdf` and `GET /statement/pdf` → native share
        (`lib/documents.ts`, `expo-sharing` added). Downloaded **with** the bearer
        header, because these stream through our API: an unauthenticated open saves
        a file containing a JSON 401, which is worse than an error the resident can
        read. Cache directory, not documents — the server can always regenerate them
- ☑ **Food** — `GET /resident/food`: weekly routine, month-end special, photo gallery
  - ☑ A **day at a time**, today selected, with a day strip. The routine is a 7×4
        grid and a phone is one column wide; someone checking at 6pm wants tonight's
        dinner, not a table to scroll sideways through
  - ☑ Day arithmetic in `lib/food-week.ts` (10 tests) — the enums moved there from
        `resident-api.ts` because that module imports the axios client and therefore
        React Native, which makes a node-side test file unloadable
  - ☑ Feedback: `POST /resident/food/feedback`, per meal per day, with the anonymous
        option. The date sent is **this week's occurrence of the selected day** — a
        rating filed against today whatever day is showing blames the wrong dinner,
        and wrong analytics are worse than none because they get acted on
  - ☑ Photo upload: `POST /resident/food/photos`, meal guessed from the Nepali clock
        rather than asked. A picker between "I want to share this" and it being
        shared is where people give up
- ☑ **Notices** — `GET /resident/notices`, category filter, urgent styling,
      `PATCH /notices/[id]/read`
  - ☑ Read is marked **on expand**, not on render: marking on render clears the
        badge for a list somebody scrolled past on the way to Payments, and the water
        cut tomorrow is exactly the notice that gets scrolled past
  - ☑ Optimistic — the row un-bolds immediately, the PATCH runs behind it, and the
        server's `$setOnInsert` makes a replay a no-op. Both failure modes beat a tap
        that appears to do nothing
  - ☑ Urgent is a left border, not a red card. Two red cards on one screen and
        neither reads as urgent
- ☑ **More** — profile card, stay entries, Explore, app settings, sign out
  - ☑ **Explore lives here, not in a tab** (agreed 2026-08-16). Residents keep
        `Home · Payments · Food · Notices · More`; someone who already has a bed
        opens the app to pay rent, not to shop for another hostel
  - ☑ The two settings rows are the last that still say which release they land in.
        A row that navigates nowhere is indistinguishable from a bug; a row that
        explains itself is a roadmap. **Complaints** → `/complaints` (M5.2), **night
        status** → `/night-status` (M5.3), **profile** → `/profile` (M5.4),
        **digital ID** → `/id-card` (M5.5), **refer a friend** → `/referrals`
        (M5.6), **review your hostel** → `/review` (M5.7)
  - ☑ Theme toggle wired to `uiSlice`; sign out confirms first

**Acceptance**
- ☐ Upload a payment claim from the camera roll → it appears in the admin's review queue on web
- ☐ Complete an eSewa checkout through `/pay/{reference}` → the status screen's
      polling settles the invoice *(the browser does not return to the app — there is
      no mobile scheme in the intent's `returnUrl`, and the browser closing was never
      evidence anyway; the provider is)*
- ☐ Marking a notice read on mobile clears the unread badge on web

---

## M4 — Notifications: realtime + push

The one phase with mandatory server work.

**Server (`apps/web`)** ✅ *2026-08-16*
- ☑ `modules/notifications/push.service.ts` — batches to Expo's 100-per-request cap,
      POSTs to `https://exp.host/--/api/v2/push/send`, 10s timeout, optional
      `EXPO_ACCESS_TOKEN`
- ☑ Reads tickets positionally and marks `DeviceNotRegistered` tokens **`REVOKED`**
      (the schema's enum is `ACTIVE | REVOKED` — there is no `INACTIVE`). Not deleted:
      `account-purge` owns removal, and deleting races a re-registration in flight
- ☑ Called from `publishNewNotification` — the one funnel every notification already
      goes through, so no call site changed and none can drift
- ☑ `modules/notifications/push-routing.ts` — server-decided deep link per category,
      opening the specific invoice/complaint/notice when the payload names one, so an
      older app build still lands somewhere sensible
- ☑ `actionUrl` overrides the category default, but only for a single-leading-slash
      path — `//evil.example` is protocol-relative and must not reach a router
- ☑ Fire-and-forget from the request path: an Expo round trip must not hold up the
      complaint submission that created the notification
- ☑ Duplicate tokens de-duplicated, so one phone buzzes once
- ☑ 13 tests; full web suite green (1,653)
- ☐ Respect the account's notification preferences and quiet hours

**Mobile** ◐ *(every item built 2026-08-17; device pass outstanding)*
- ☑ `lib/push-notifications.ts` — permission, channels, Expo token,
      `POST /api/v1/mobile/device-token` on launch and on every account change
  - ☑ **Android freezes a channel's sound, importance and vibration at
        creation.** A later `setNotificationChannelAsync` with the same id only
        renames it — every other field is ignored on every install that already
        has the channel. The reference app hit this and had to ship a `calls_v2`
        id because its original `calls` channel was created with the wrong sound
        and could never be fixed in place. So `default`/`urgent`/`food` are a
        one-way door: changing what one does means a **new id**, and a matching
        change to `androidChannel()` in `push.service.ts` in the same release
  - ☑ The ids match that server function exactly. A `channelId` Android
        cannot resolve falls back to `default` silently, so a mismatch costs the
        urgent channel its MAX importance and reports nothing
  - ☑ `urgent` is MAX + lock-screen visible + best-effort `bypassDnd`; `food`
        is HIGH, not MAX — dinner is not an emergency, and a meal channel that
        behaves like one is the channel people switch off, taking the SOS alerts
        with it if the two shared an id
  - ☑ Permission is **never requested at boot**, the same rule location and
        the camera follow: on Android 13+ a second refusal sets
        `canAskAgain: false` permanently and the dialogue never appears again.
        `blocked` is reported separately from `denied`, so a caller can offer
        system settings rather than a button that cannot work
  - ☑ **No `getDevicePushTokenAsync` fallback.** A raw FCM token is not
        interchangeable with an Expo one — `push.service.ts` posts to `exp.host`,
        which rejects it — and storing one would fill `DeviceToken` with rows
        that can never be delivered to and that Expo never reports as
        `DeviceNotRegistered`, so nothing would ever prune them
  - ☑ Re-registers when the **account** changes, not once per install: the row
        is keyed to `principal.userId`, so on a shared phone person B's alerts
        would otherwise keep arriving on a token the server still attributes to
        person A
- ☑ Android notification channels (default / urgent / food)
- ☑ Foreground, background and killed-state handling
  - ☑ **The tap that cold-started the app is replayed.**
        `addNotificationResponseReceivedListener` only sees responses delivered
        after it subscribes, and the listener waits on the boot gate — so a tap
        that launched the app from killed was already delivered and dropped,
        landing the user on their home screen instead of the invoice they
        tapped. `getLastNotificationResponseAsync()` recovers it, deduplicated
        against the listener by notification identifier because both can surface
        the same response. Found in the reference app, which had this exact bug
  - ☑ Routing waits for `isReady`: pushing a route before the boot gate
        resolves its `<Redirect>` means the gate replaces the deep-linked screen
        a frame later and the notification silently does nothing
- ☑ Tap → `router.push()` on the payload path, **through `lib/push-link.ts`**
      (9 tests)
  - ☑ **This found a live bug.** Checked against `apps/mobile/src/app`, the
        server emits eleven distinct paths and **seven have no route**:
        `/community`, `/community/<id>`, and every `/(resident)/more/*`
        (complaints, profile, settings, attendance, reviews) are M5/M7 screens
        that do not exist yet. An eighth is wrong rather than absent — invoices
        are at `/invoice/<id>` on the root stack, not `/(resident)/payments/<id>`,
        because a folder under a `<Tabs>` layout becomes another tab. All eight
        would have hit `+not-found`: the phone buzzed, the notification was real,
        and the tap produces a broken screen — which is how a push notification
        teaches someone not to tap the next one
  - ☑ Fixed client-side rather than only on the server, because **only the app
        knows which routes this build has**, and the two ship on different
        clocks: a phone that has not updated in a month still receives today's
        paths. Unbuilt resident screens land on the More tab, which lists them
        with the release they arrive in; anything unplaceable goes to
        `/notifications`, never nowhere
  - ☑ The path is re-validated on arrival even though the server strips
        `//evil.example` before sending. It is network input, and a client that
        trusts a field because another service promised to sanitise it is one
        server bug away from routing wherever an attacker likes
- ☑ App-icon badge count, cleared on read
  - ☑ Written authoritatively from the server's `unreadCount` by
        `notifications.tsx`, which is what "cleared on read" means in practice.
        `use-push.ts` only increments between visits so the icon does not lie
        while the app is open — a second counter kept independently would drift
        from the server's within a day
- ☑ **`@react-native-community/netinfo` stubbed in `metro.config.js`** —
      `src/shims/netinfo.js`. `pusher-js/react-native` imports it at module load
      (`export var Network = new NetInfo()` calls `fetch()` and
      `addEventListener()` in its constructor), so the first `require` crashes
      without it. Installing netinfo for real would take the whole app out of
      Expo Go
  - ☑ Pusher reads `connectionState.type` and compares it to `"none"` — **not**
        `isConnected`, which is the field anyone would guess and which Pusher
        would treat as permanently online by accident. The shim returns
        `"unknown"`, reporting online deliberately: a wrong "offline" stops it
        trying, a wrong "online" costs one attempt it then retries
- ☑ `lib/realtime.ts` — `pusher-js/react-native`, `.Pusher` pulled off the
      required namespace (the v8 webpack bundle ends `module.exports.Pusher = r`,
      so a default import is `undefined` and `new undefined()` throws
      "constructor is not callable"). Subscribes to whatever
      `GET /realtime/config` returns
  - ☑ **A custom authorizer, not `authEndpoint`.** The web lets the browser
        attach its session cookie; a phone has a bearer token that rotates, and
        Pusher reads `auth.headers` **once, at construction** — so a token
        captured there goes stale at the first refresh and every later subscribe
        401s while the socket stays up and simply stops receiving. That is the
        hardest version of this bug to notice. Authorisation goes through `api`
        instead, which already attaches the current token and handles
        401 → refresh → retry
  - ☑ `/realtime/auth` reads `socket_id`/`channel_name` as **form fields** and
        answers with the bare `{ auth }` object rather than the success envelope,
        so the request is form-encoded and the response is read directly
- ☑ Handles `notification:new`, `notification:updated`, `resource:changed`
      (invalidate by topic) and `global:announcement`
  - ☑ `lib/resource-bus.ts` (10 tests) is the mobile answer to the web's
        `useInvalidateResources`. There is no query cache to drop here —
        `use-resource` holds data in component state — so a screen names its
        topics and re-runs the loader it already owns. Endpoint prefixes never
        enter it, which is why `TOPIC_ENDPOINTS` is deliberately not ported
  - ☑ `useResource(loader, { topics })` is the whole contract: no screen
        touches Pusher. A screen with no `topics` is simply not live, which is
        the right default — every screen refetching on every event is how a
        socket becomes a request storm
  - ☑ Unknown topics are dropped rather than forwarded (the list arrives over a
        socket, so it is untrusted input), and a listener that throws cannot stop
        the ones after it — they are unrelated screens, and one broken loader
        taking out the rest turns a small bug into a dead app
  - ☑ The refetch is **silent**: a socket event is not a gesture, and a
        pull-to-refresh spinner for something the user did not ask for reads as
        the screen having a mind of its own
- ☑ Reconnect on foreground; disconnect on logout
  - ☑ Android suspends the socket in the background and Pusher does not always
        notice on the way back — it sits in `connecting` on a backoff of tens of
        seconds, which is exactly when someone is looking at a stale screen.
        `connect()` on a live client is a no-op, so the foreground nudge is free
  - ☑ A sign-out mid-connect is handled: the config request can still be in
        flight when the account clears, and without the cancelled check the
        socket outlives the session it was opened for
- ☑ `notifications.tsx` — list, filters (All / Unread / Needs you), mark read,
      mark all read *(2026-08-17, built early with M6's home header, which needed
      a destination for its bell)*. `GET /notifications` runs
      `requireApiPrincipal` and filters on `userId` with **no role branch and no
      hostel scope**, so this is one screen for every audience — which is why it
      sits at the root of the stack rather than in a role's tab group. Read is
      marked on tap and optimistically, the same rule `(resident)/notices.tsx`
      follows. `actions[]`/`actionState` are deliberately **not** rendered as
      buttons: each is an `{ endpoint, method, payload }` the client would have
      to fire blind at a route this app has never called. `needsAction` is shown,
      and an open row says the decision can be taken in the web portal.
      **Now live** — it declares `topics: ["notifications"]`, so a notice
      published on the web updates it with no push and no polling
- ☑ Foreground realtime events surface as **in-app toasts, not local
      notifications**
  - ☑ A deliberate reading of "local notification fallback". A push arriving
        while the app is open already renders as a system banner
        (`shouldShowBanner: true`), so firing `scheduleNotificationAsync` for the
        socket copy of the same event would put two entries in the tray for one
        thing — which reads as two events, not as one delivered twice. Urgent
        and `ACTION` rows get the loud variant

**Acceptance**
- ☐ Token registers on first launch; visible in the `DeviceToken` collection
- ☐ Admin verifies a payment on web → resident's phone buzzes within seconds, killed state
- ☐ Tapping it opens the invoice, not the tab root
- ☐ Notice published on web → the bell count updates live on mobile with no push involved
- ☐ Logging out stops delivery to that device

---

## M5 — Resident extended ◐ *(all nine work items built 2026-08-17)*

**Status:** every item in this milestone is written, typechecked, linted, unit
tested and bundling — 404 tests / 30 files, Android bundle 5.9 MB. What is left is
a **device pass**, plus the sub-items marked ⛔ (blocked on the server) and the one
☐ inside M5.5 (a rasterised save-to-gallery, which needs two native modules) and
M5.8 (the community sidebar's furniture).

**No `☑` here means "seen working on a phone"** — same as M6. The in-app Browser
pane cannot render React Native, so a tick means typechecked, linted, unit
tested and bundling.

> **Four sub-items below are blocked on the server, found by auditing every
> endpoint before writing a screen.** They are marked ⛔ where they appear:
> night-status history, emergency-contact add/remove, a community anonymous
> option, and notification preferences. None of them has a route, and three have no
> model support either. See §1 for the entries.
>
> **Building the nine items surfaced five more server-side problems**, each now a §1
> row: the resident complaints route parses no query; a resident can set their own
> night status to `SOS_TRIGGERED` with nobody alerted; the referral link the server
> hands residents credits nobody; a resident cannot read their own review back, and
> a review category cannot be cleared; and community avatars render the viewer's own
> face on other people's posts. Four of the five are live defects in `apps/web` too.

- ☑ **SOS** — big red button, long-press + 3-second cancellable countdown, `POST /resident/sos` *(2026-08-17)*
  - ☑ **The countdown runs before the request, not after.** There is no
        resident-facing cancel — `sosStatusUpdateSchema` is admin-only, so only
        staff can move an alert to `FALSE_ALARM`. Those three seconds are the
        entire undo, so they have to be on the client side of the call
  - ☑ **The result is read from `notified`, never from the 201.**
        `fanOutSOSAlert` catches and swallows its own failures by design, so
        that a dead mail provider cannot stop an alert being *recorded* — which
        means a `201` proves nothing about anyone having heard it.
        `lib/sos.ts`'s `describeFanout` (10 tests) turns `{staff, guardians}`
        into what actually happened, and a pair of zeroes reads "Recorded — but
        nobody was reached. Call your emergency contacts now." A green tick over
        a zero is the worst string this app could render, so the function makes
        it unwriteable
  - ☑ Zero guardians means two different things and is reported as two: if the
        resident never asked for guardians, it is the correct outcome and goes
        unmentioned; if they did, it is a failure they are told about
  - ☑ **Two gestures.** Tap opens `/sos` (note, guardian toggle, numbers to
        ring); long press arms immediately with guardians included. A button
        that alerts a hostel on one tap alerts it from inside a pocket
  - ☑ One pipeline for both entry points (`hooks/use-sos.ts`) with a ref guard,
        because the send is kicked off from an effect and a re-run would fire a
        second hostel-wide alert that nobody can retract
  - ☑ **The phone numbers come first on `/sos`, above the alert control**, and
        are tappable. An in-app alert needs someone else's phone charged,
        unlocked and in signal; `tel:` does not
  - ⛔ Emergency-contact **add/remove** — read-only, and no Add button is drawn.
        The only `EmergencyContactModel.create` in the repo is inside admin
        resident creation (`resident.service.ts:789`); `/resident/emergency-contacts`
        is GET-only. The empty state says to ask the hostel office rather than
        offering a control the server would ignore
- ☑ SOS reachable from every resident screen (floating action, not a nav item) *(2026-08-17)*
  - ☑ Rendered once by `(resident)/_layout.tsx` *outside* the navigator, not per
        screen — five screens is five chances to forget one, and it keeps the
        countdown running across a tab change
  - ☑ Hides on scroll with the rest of the bottom chrome, per the §0 shell
        contract, which names this button specifically. Six pixels of upward
        scroll bring it back against sixteen to hide it
  - ☑ The overlay is a `Modal`, so it covers the tab bar and the app bar; a
        countdown a stray tab tap can navigate away from is not a countdown.
        Android's back button cancels it rather than dismissing it silently
- ☑ **Complaints** — list, create with attachments, thread view, confirm resolution *(2026-08-17)*
  - ☑ **No detail endpoint, and none needed.** `listResidentComplaints` runs
        `complaintChildren()` and returns every complaint with its `attachments`
        and its whole `updates` thread inline, so `complaints/[id]` reads the same
        list and finds its row. That is also what makes it deep-linkable from a
        push, which a screen fed by route params would not be
  - ☑ **A private attachment cannot be loaded by a bare `<Image>`, and the reason
        was measured rather than assumed.** `files/[assetId]/url` authorises the
        caller and 302s to a presigned R2 URL. Against the live bucket: that URL
        serves `200 image/jpeg` bare, and **the same URL with an `Authorization`
        header answers `400 InvalidRequest — Missing x-amz-content-sha256`** —
        R2 reads any `Authorization` as SigV4 and stops honouring the query
        signature. So the token must reach our route and not the redirect target.
        Every private image now goes through one `privateAssetSource()` in
        `lib/uploads.ts`, which carries that finding; `food.tsx` was inlining the
        same pattern and now shares it. **This is the first thing to check on the
        device pass** — it depends on the native loader stripping `Authorization`
        across a cross-host redirect, which nothing here has yet observed
  - ☑ **The thread is the only place a reply is shown.**
        `updateComplaintStatus` writes `adminResponse` *and* appends a
        `STATUS_CHANGE` update carrying the same message, so rendering both would
        show the newest staff reply twice. `adminResponse` is typed and
        deliberately not drawn
  - ☑ **A wordless status change still says something.** `message` on a
        `STATUS_CHANGE` is the admin's *optional* response, so the most important
        line in the thread — "marked resolved" — normally arrives empty. It is
        rendered from `nextStatus` instead of as a blank bubble with a timestamp
  - ☑ **Author is read from `actorRole`, never from `actorId`.** `actorId` is a
        `User` id and `complaint.residentId` is a `Resident` id — different
        collections, so an id comparison is always false and every one of the
        resident's own lines would be attributed to the hostel
  - ☑ Confirm is drawn only when the server would accept it — `status ===
        "RESOLVED"` and no `confirmedAt`, since the service does not guard against
        a second confirmation. The unreachable `409 COMPLAINT_NOT_RESOLVED` is
        still handled, because staff re-opening the complaint between the fetch
        and the tap is exactly how it becomes reachable
  - ☑ `note` on the confirmation is optional-but-min-2, so a blank box is sent as
        an **absent field** rather than `""`, and one character is refused on the
        phone instead of by a 422
  - ☑ Photos upload on pick, not on submit: an asset whose `complete` step never
        ran is a reservation the hostel cannot open, and four uploads inside the
        submit handler make the one tap that matters take thirty seconds.
        `kind: "GENERIC"` — the presign route refuses a financial asset it cannot
        tenant-scope. Progress renders itself through `<UploadToaster />`
  - ☑ Open complaints and anything awaiting the resident's confirmation are
        lifted above the closed ones. The server's newest-first order is right
        within a group and wrong across them — a complaint resolved this morning
        would otherwise sit above one ignored for a week
  - ☑ **No reply box.** `complaintReplySchema` exists but its only route is the
        admin one, so the thread is read-only for a resident
  - ☑ **No pager**, because the route ignores `?page` — see the new §1 row. The
        `pagination` block is typed and nothing sends a page against it
  - ☑ The push deep link works: the server emits
        `/(resident)/more/complaints[/<id>]`, which `lib/push-link.ts` now moves
        onto `/complaints[/<id>]` on the root stack. The **list** form needed its
        own match too, or the existing `/(resident)/more/` rewrite would have sent
        a complaint push to the menu that links to complaints
- ☑ **Night status** — set tonight's status *(2026-08-17)*, ⛔ history list
      *(`NightStatusLog` is written on every change and read by nothing; no
      endpoint exposes it)*
  - ☑ **Three choices, not the five the route accepts.**
        `nightStatusUpdateSchema` validates the resident's POST against the whole
        enum, so a client can set `SOS_TRIGGERED` — and **nothing happens**: no
        `SOSAlert` row, no fan-out, no notification, just the word on the warden's
        roster. That is the exact failure M5.1 built `describeFanout` to make
        unwriteable, so the client offers `INSIDE_HOSTEL`, `OUTSIDE_HOSTEL` and
        `MARKED_SAFE` only. `NOT_VERIFIED` is excluded too — it is what
        `serializeNightStatus` returns for a resident with *no row*, so offering it
        would let someone set the state that means they set nothing. New §1 row
  - ☑ **An SOS on the record is called out, and not treated as retractable.**
        `triggerSOS` writes `SOS_TRIGGERED` and `sosStatusUpdateSchema` is
        admin-only, so marking yourself safe changes the night status and leaves
        the alert `ACTIVE`. The screen says so in as many words — a resident who
        believes they have called it off is worse off than one who knows they
        cannot
  - ☑ **A night runs 17:00 → 17:00 Nepal time**, so an 11pm check-in still counts
        at 00:30. "Have I checked in tonight?" collapsed into "was this today?"
        would answer *no* on the one screen whose entire job is that question. The
        boundary is a client-side product choice — nothing in `apps/web` defines a
        night — so it changes what the screen says and never what is stored
  - ☑ A stale answer is shown but **preselects nothing**: a preselected stale
        choice is one tap from confirming a location nobody has asked about since
  - ☑ **No History section is drawn at all.** An empty heading would say the
        feature exists and is broken; its absence says nothing, which is accurate
  - ☑ The dashboard's night-status card and the More row both open it. The card
        does not offer the choices inline — a `POST` that means "where I am" should
        not be one mis-tap away on a tile next to rent
- ☑ **Profile** — personal details, room type, guardians, emergency contacts
      *(2026-08-17)* *(⛔ add/remove — see the SOS entry above; the resident route
      is GET-only)*
  - ☑ **Read-only throughout, and no Edit button anywhere.** There is no
        resident-facing write for any of it: the personal-details update in
        `resident.service.ts` is staff-only, guardians are an *invite* flow the
        hostel runs, and emergency contacts are GET-only. Each section names who
        can change it instead — the rule `app/sos.tsx` set, reusing its exact
        wording for the contacts so one gap has one explanation
  - ☑ **Room type, not room number.** `serializeAccommodation` returns only
        `roomType` because residents are placed by type; a "Bed" row would have
        nothing to put in it
  - ☑ The **deposit held** is shown here, because nothing else tells a resident
        what the hostel is holding — the finance screens are about invoices and a
        deposit is not one
  - ☑ Every phone number dials. Same reasoning as the SOS screen: a number
        somebody has to memorise and retype is a number nobody calls
  - ☑ Guardians and emergency contacts share one component. Same shape on screen
        and the same story underneath — a list the resident cannot edit — so two
        that could drift are one
  - ☑ The push deep link `/(resident)/more/profile` now resolves to `/profile`,
        ordered ahead of the generic `/(resident)/more/` rewrite that would
        otherwise swallow it
- ☑ **Digital ID card** — `GET /users/resident-identity`, front/back, the profile
      form behind it, photo, sharing toggle *(2026-08-17)*
  - ☑ **The card is drawn from the web's own template, not a new design.** Front
        and back follow `drawFront`/`drawBack` in `apps/web/src/lib/platform-id-card.ts`
        — the brand sweep, the portrait, name, letterspaced role, the hairline, the
        five rows in the order `ID NO · DOB · BLOOD · PHONE · E-MAIL`, the QR and
        `SCAN TO SHARE MY DETAILS`; then the back's `HOW THIS CARD WORKS` bullets,
        the id label, `Issued …`, the signature rule and the host. Not
        pixel-identical, because those are canvas coordinates on a fixed 640×1000
        grid and this has to survive a 320dp phone — the order, hierarchy and copy
        are what carry over
  - ☑ **It is the one component in the app that ignores the theme.** The card is a
        *document*: the web paints these same hexes onto a canvas for the preview,
        the downloaded PNG and the email attachment, and an ID card that turns dark
        because the viewer had dark mode on is not an ID card. `CARD_COLORS` in
        `lib/id-card.ts` is that palette verbatim
  - ☑ **All three variants render.** `cardType` is derived server-side from what
        the platform has approved the holder for, so a resident approved as an
        owner or provider keeps their id and is re-issued — the client renders
        whichever variant is returned, with that variant's accent, id label and
        back-face bullets, and never assumes `RESIDENT`
  - ☑ **`UNKNOWN` is never printed as a blood group.** It is the schema's
        placeholder default, and a paramedic cannot tell it from an answer. Same
        judgement as `buildIdCardData`, and pinned by a test
  - ☑ **A date of birth is read with the UTC getters, deliberately.** It is a plain
        calendar date stored as `YYYY-MM-DD`, so `new Date(...)` is midnight UTC and
        the local getters print the day before on every phone west of Greenwich.
        This is *not* the problem `lib/format.ts` solves — that one is about
        instants — so it does not use it
  - ☑ **The card does not flip by itself.** The web cycles front/back and pauses on
        hover; a phone has no hover, and the moment that matters is holding the
        screen out to a warden. Manual flip, whole card is the target
  - ☑ **`qrDataUrl` can be `null` with a 200** — the server wraps its `qrcode`
        import in a `try`. So that is a rendered state, not a loading one: the tile
        shows the typed id and reads `READ THIS ID OUT INSTEAD`, which is the
        manual-entry path the server's own comment points at
  - ☑ **Sharing off is stated on the card page, not just in the toggle.** With
        `sharingEnabled` false the QR is still a valid image that resolves to
        nothing — the one failure a resident would otherwise discover at a hostel
        counter
  - ☑ **The photo endpoint is the one private image that needs no redirect.**
        `/users/resident-identity/photo` *streams* the bytes through our origin
        (the web needed that so its canvas would not be tainted), so the bearer
        token is enough and it cannot hit the R2 `Authorization` conflict that
        `privateAssetSource` has to work around. `identityPhotoSource` is separate
        from that helper for exactly this reason, and cache-busts on
        `photoUpdatedAt` — `expo-image` keys its disk cache on the URL
  - ☑ **The profile form mirrors the web's eight sections**, their order, labels and
        hint copy, so someone who filled it in on the website recognises it. Only
        the controls are native: one column, `<select>` → sheet, textarea →
        multiline. `primaryEmail` is read-only whenever the account has one, as on
        the web — it is the sign-in address
  - ☑ **A blank optional field is omitted, not sent as `""`.** The server's
        `blankToUndefined` would coerce it, but that preprocessing was written for
        an HTML form; sending only what was filled is the payload the schema
        actually describes. 27 tests cover the form and the card
  - ☐ **Save the whole card to the camera roll.** The QR saves today, as a real PNG
        through the OS share sheet — which is where "Save to Photos" lives — reusing
        `lib/documents.ts`'s cache-then-share tail with no request, since the bytes
        arrive inline with the JSON. A *rasterised two-sided card* and a one-tap
        gallery write need `react-native-view-shot` and `expo-media-library`, both
        native modules: they mean a development build, so Expo Go could no longer
        run the app that has never yet been run on any device. Left as a deliberate
        call, not an oversight
- ☑ **Referral** — code, share sheet, referred-list with status *(2026-08-17)*
  - ☑ Structure from `resident-referral-page.tsx`: the code in large tracked type,
        the share row, the three tiles **Sent · Joined · Converted** with its exact
        hint copy, the rewards sentence, then the referred-inquiry list with a
        status badge each. Native only in the controls — "Copy link" becomes a share
        sheet, the three-column grid becomes a row
  - ☑ **The share sends the code, not the link, and that is a correctness fix.**
        The web copies `/inquiry?ref=<code>`; `public-inquiry-page.tsx` reads
        `hostel` and `room` and **ignores `ref`** (re-verified 2026-08-17), and
        `/public/inquiries/with-referral` is still called only by this app and one
        test. So a friend who follows that link files an ordinary inquiry and the
        referrer is never credited. The **code** works by two routes that do not
        touch that page — `app/ref/[code].tsx` here, and
        `linkReferralOnRegistration` when a warden types it at the desk — so that is
        what the message carries. Shipping the link as the primary action would be a
        control that silently costs the resident the reward they opened the screen
        to earn. Now a §1 row; `lib/referrals.ts` names the condition for putting the
        link back
  - ☑ The link is still **shown**, labelled "Needs a website change before it
        credits anyone", with a "Copy anyway" that says so again on copy. Hiding it
        would be its own small lie — the resident's portal shows them this link
  - ☑ **One string, not `{ message, url }`.** Android's `Share.share` ignores `url`
        entirely, so anything in that field reaches nobody on the platform this app
        ships to first
  - ☑ **Opening the screen is what mints the code** — `getResidentReferral` creates
        the `ReferralCode` inside the GET — so there is no "generate" button, and a
        resident who has never referred anyone still lands on a real code
  - ☑ `converted` is rendered as its own badge, not as a later stage of `status`:
        they are separate fields, and a `JOINED` referral may or may not have a
        verified first payment. Converted is the one that means money
  - ☑ `INQUIRY_CREATED` reads "Inquiry sent", not `humanizeEnum`'s "Inquiry
        created" — the referrer cares that their friend got in touch, not what the
        row was called when it was written. `INQUIRY_CREATED`/`JOINED`/`REWARDED`
        added to `lib/status.ts`'s tone table so they stop falling through to neutral
  - ☑ Rewards add **approved + paid** and deliberately exclude `PENDING`: an
        unapproved reward is a request, not an amount, and counting it would have
        residents chasing money nobody agreed to. 17 tests
- ☑ **Reviews** — submit hostel rating (overall + the six categories) *(2026-08-17)*
  - ☑ Field set, order and labels from `resident-reviews-page.tsx`: overall first,
        then its line "score 1 to 5 only what you want to", then Food ·
        Cleanliness · **Security** · Room · Location · Management, then the comment.
        `safetyRating` keeps the web's "Security" label — renaming it would make one
        field read as two different questions depending on which client you opened
  - ☑ **The one control that had to change is the rating input.** The web uses
        `<input type="number" min="1" max="5">`, which on a phone opens a numeric
        keyboard for a value with five possible answers and accepts "0" and "12"
        until submit. `components/ui/star-rating.tsx` is five tap targets: no
        keyboard, and an invalid value is unexpressible
  - ☑ **The profile is loaded before the form is drawn.** `createResidentReview`
        403s `REVIEW_NOT_ALLOWED` unless the resident is `ACTIVE` or `MOVED_OUT`, so
        one request up front saves a `PENDING` resident from filling in seven
        ratings and a comment before being refused — and names their hostel in the
        question. The 403 is still handled, for the case where the status changes
        between the load and the tap
  - ☑ **A resubmission merges, and the screen says so.** The POST is
        `findOneAndUpdate` with `$set: { ...input }` + `upsert`, so a category the
        payload omits keeps its earlier score — `$set` never touches an absent key
        and the schema has no `null`. Combined with there being no way to *read* the
        existing review, a resident rescoring one category would otherwise have no
        idea the rest kept last month's numbers. One sentence
        (`REVIEW_MERGE_NOTICE`) covers both. Two new §1 rows
  - ☑ Tapping the current score does **not** clear it. There is no way to un-rate a
        category server-side, so a gesture that looked like clearing would silently
        do nothing
  - ☑ `0` is the form's "unscored" and is omitted from the payload rather than
        sent — `starRating` is `min(1)`, so a zero would reject the whole review. 15
        tests
- ☑ **Community** — feed with infinite scroll + pull-to-refresh, create post (text +
      media), Public/Hostel-only toggle, 6 reactions, comment threads, report
      *(2026-08-17)*. ⛔ anonymous option
  - ☑ Ported from `community-page.tsx` + `community-post-card.tsx`. The web's
        three-column layout becomes one: the spaces rail's buttons flatten into a
        horizontal chip row **in its order** (Everything · Public · My hostel · then
        every hostel that has posted), search and new/top keep their place above the
        feed, and the composer sits between them and the first post
  - ☑ **`FlatList`, not `<Screen scroll>`** — the one screen in the app with an
        unbounded list, so rows are recycled and `onEndReached` drives paging. The
        header travels with the list so search and chips scroll away instead of
        eating a third of the viewport
  - ☑ **Page 1 goes through `useResource`; later pages are appended beside it.**
        The hook has no notion of pages, and reimplementing its four states, silent
        refocus revalidate and realtime topic would be worse. It is also what keeps
        the mount effect free of a synchronous `setState` — the rule that traces into
        the callee bit here first, and the fix was to stop hand-rolling the fetch
  - ☑ **⛔ No anonymous option.** `communityPostCreateSchema` is
        `{ body, visibility, media }`; no `isAnonymous` exists on the schema or the
        model. The milestone asked for one — there is nothing to send it to, so no
        toggle is drawn. (Complaints *do* have one; community does not)
  - ☑ **All six reactions, against the web's four.** `REACTION_TYPES` has six and
        the web leaves `LOVE`/`SUPPORT` unoffered; six emoji at 30dp fit a 320dp row,
        and shipping four of six values the API takes is a narrowing that becomes
        permanent
  - ☑ **The reaction total sits outside the row, not inside the active pill.**
        `reactionCount` is one per *user* across every type, so the web's
        `active ? reactionCount : ""` prints "12" beside a single emoji and reads as
        "12 likes" when it means "12 reactions". `nextReaction` also gets the
        arithmetic right: swapping Like for Angry moves the total by **zero**
  - ☑ **Community media uploads `PUBLIC`.** `lib/uploads.ts` hardcoded
        `accessLevel: "PRIVATE"`; it now takes the level, defaulting to `PRIVATE`.
        This mattered: a public post is read by people who are neither the asset's
        owner nor in the author's hostel, and `files/[assetId]/url` default-denies
        exactly that — so a PRIVATE upload would have posted an image only its author
        could see, with no error anywhere
  - ☑ **`authorImage` is only rendered when it is absolute.** It is `User.image`,
        which `resident-identity.service.ts` keeps in step with the ID-card photo by
        storing `/api/v1/users/resident-identity/photo?v=…` — a route with no id in
        the path that returns only the **caller's own** photo. Rendering it for
        another author paints the viewer's own face onto someone else's post, which
        is what the web does today. New §1 row; the client falls back to the initial
  - ☑ The comment tree is used **as the server flattens it** — display order with a
        `depth` per row, capped at 5. Rebuilding or re-sorting it would cut replies
        from what they answer. Indent step is 14dp rather than the web's 26dp: five
        levels of 26 is 130dp of a 320dp screen
  - ☑ Votes and reactions echo locally and reconcile on the refetch; tapping the
        arrow already chosen clears the vote, matching the server's `value: 0`.
        Flipping a downvote moves the score by two, which `nextVote` owns
  - ☑ Comments are not fetched until a thread is opened — a feed of twenty posts
        must not fetch twenty trees nobody asked for
  - ☑ **Reading works signed out** (`GET /community` uses `loadApiPrincipal`). The
        composer becomes a sign-in line, and reactions/comments/votes say so when
        tapped rather than being hidden — the controls exist, they explain themselves
  - ☑ Video is **opened in the OS player**, not played inline: `expo-video` is not a
        dependency, and a play triangle that does nothing is worse than none. The
        picker is images-only for the same reason — posting a video this client
        cannot play is not a feature
  - ☑ `/community` and `/community/<id>` were the only push paths the server already
        had right, so `lib/push-link.ts` passes them through instead of falling back
        to the notification list. `/(resident)/more/reviews` → `/review` added too
  - ☑ `lib/community-enums.ts` exists because `community-api.ts` imports the axios
        client: the reaction list is needed as a *value* by a node-side test, so it
        lives in a leaf module — the same split as `resident-api.ts` / `food-week.ts`.
        34 tests
  - ☐ **Not ported: the sponsor rail, popular hostels, trending tags and the
        guidelines card.** All four are `/community/sidebar` furniture and none is in
        this checklist. Trending tags are the one with real value — they are saved
        searches on the web — and would drop into the chip row cleanly
- ☑ **Settings** — theme, account deletion request, privacy policy *(2026-08-17)*.
      ⛔ notification preferences *(no `notificationPreference` field exists anywhere
      in `apps/web` — nothing to read, nothing to write, and no per-category opt-out
      for the push sender to consult)*
  - ☑ The privacy half is a port of `(auth)/account/privacy/page.tsx` and the
        `AccountDeletionPanel` inside it — same heading, same subtitle ("Control what
        we keep about you"), same four pathways
  - ☑ **`PATHWAY_COPY` is carried over verbatim, not paraphrased.** The web's own
        comment says why it exists — "delete my account" means four different things,
        and the copy has to tell the truth *before* the click. Two clients wording the
        same irreversible consequence differently is how one of them words it wrongly.
        `lib/account-pathways.ts` holds it with that reasoning attached
  - ☑ **`BLOCKED` is the likeliest pathway on this app and is treated as a first-class
        state, not a disabled button.** `resolvePathway` blocks any account with an
        `ACTIVE` or `PENDING` residency — i.e. most residents — and the server's own
        `blockedReason` is the sentence shown
  - ☑ **`SELF_SERVICE` ends the session.** It closes the account on the spot, so the
        token in memory is already dead; the screen calls `endSession()` and replaces
        to `(public)` rather than leaving a signed-in shell that 401s on every
        request. The other pathways change nothing about signing in and just refresh
  - ☑ **The web's guardian-pathway label is wrong and was not copied.** It calls the
        reason "optional context for the hostel", but `accountDeletionRequestSchema`
        has no branch — an empty reason is a 422 on every pathway. The mobile label
        says required, and the 10-character floor is enforced before the confirm
        dialog rather than after it
  - ☑ **⛔ Notifications state the position instead of offering a switch.** A toggle
        would turn itself back on at the next fetch while the server kept sending
        exactly what it sends now; the row says so, and points at the OS notification
        settings as the thing that does work
  - ☑ Theme is a three-way picker (light / dark / system) reading the same `uiSlice`
        the More tab's toggle writes, so the two cannot disagree. Light stays the
        default, deliberately
  - ☑ The privacy policy opens `/privacy` in the OS browser rather than a WebView —
        a legal document should show its own address. 11 tests
  - ☑ **`soon()` is gone from `(resident)/more.tsx`.** Every row there now opens a
        real screen; the placeholder helper that toasted "it lands in the next
        release" has no callers left

---

## M6 — Public discovery & QR activation ◐ *(all four work items built 2026-08-17)*

**Status:** every screen in this milestone is written, typechecked, linted, unit
tested and bundling. What is left is a **device pass** (the three acceptance
lines below), a map/list toggle on browse, and two items that are not mobile
code at all — the web's `?ref=` gap and verified app links. **No `☑` here means
"seen working on a phone"**: the in-app Browser pane cannot render React Native,
so nothing in `apps/mobile` has been run against a live account yet.

Built against the mockups in [`docs/mockups/mobile/`](mockups/mobile/README.md).
`lib/public-api.ts` is typed from `hostel.service.ts` and the two Zod query
schemas — the service, not the route names, after `finance-api.ts` showed what
guessing costs.

- ☑ `(public)/` + `(browse)/` groups for `PUBLIC_USER` accounts — the app is usable before anyone is a resident
  - ☑ Signed out: plain stack, floating **Log in** pill, no tab bar
  - ☑ Signed-in `PUBLIC_USER` tabs `Home · Search · Compare · Profile` *(2026-08-17)*.
        **Two groups, not one.** expo-router cannot switch a group between a stack
        and a tab navigator at runtime, and `resolveHome` sent both a signed-out
        visitor and a signed-in `PUBLIC_USER` to `/(public)`. So `(public)` stays
        the signed-out stack untouched and `(browse)` carries the tabs; the
        screens themselves are shared components (`components/public-home.tsx`,
        `hostel-browser.tsx`, `hostel-compare.tsx`), because two copies of the
        home screen is how the hero drifts
  - ☑ Platform staff (`SUPERADMIN`, `PLATFORM_MODERATOR`) also land on `(browse)`.
        They were being sent to the signed-out stack, which has no tab bar and no
        sign-out — its bottom edge belongs to the Log in pill — so a signed-in
        staff account had no way to see who it was or to leave. A test now
        asserts no account with a session resolves to `/(public)`
  - ☑ Profile tab is deliberately thin: account, theme, notifications, privacy,
        sign out. Saved hostels and Inquiries are honest "not yet" rows — there is
        no favourites collection and no public-account inquiry-history endpoint
- ☑ Hostel search + filters (`GET /public/hostels`)
  - ☑ **The filter sheet offers only what the server accepts.** The query schema
        takes *one* `facility` and *one* `roomType`, has no `sort` and no
        pagination, and returns the first 60 cheapest-first. The mockup draws
        facilities as a checkbox group and a Sort dropdown — both would be controls
        that silently do nothing while the user believes the list is narrowed. So
        facilities are single-select and Sort is absent until there is one
  - ☑ Filters edit a **draft** and lift on Apply, so the list behind the sheet does
        not reshuffle under a control still being used
  - ☑ Home shortcuts deep-link into the list pre-filtered (`?type=`, `?facility=`, `?q=`)
  - ☑ `Sort: nearest` chip *(2026-08-17)* — the one sort control, and an honest
        one: it re-orders rows already returned using coordinates already in the
        payload, so unlike a server-side Sort dropdown it does something. A
        toggle rather than a dropdown, because there is exactly one alternative
        to cheapest-first, and above the results rather than in the filter sheet
        so its permission dialogue is attached to a tap the user can see
  - ☐ Map/list toggle on browse — the map itself now exists (`hostel-map.tsx`)
        and the home screen uses it; a full-screen map *mode* over the filtered
        list is still unbuilt
- ☑ Hostel detail: photos, facilities, pricing, rules, room availability, nearby
  - ☑ **Every block is gated on having content.** A published hostel can have no
        rules, no nearby places and no room configurations; drawing the frame anyway
        gives a sparse listing a column of empty headings, which reads as the app
        being broken rather than the listing being thin
  - ☑ `Call hostel` renders only when there is a number — a dead call button fails
        after the tap, not before
- ☑ Compare screen (`GET /public/hostels/compare`)
  - ☑ Pinned label column, scrolling hostel columns: on a phone a real table loses
        the reader halfway across, which is the one thing a comparison must not do
  - ☑ Selection lives on the browse list (compare icon per card), capped at 3
        because the server rejects a fourth id outright
- ☑ Send inquiry (`POST /public/hostels/[slug]/inquiries`)
  - ☑ Called an **inquiry**, not a booking, in the copy and on the button. There is
        no booking model, no availability hold and no confirmation; the mockup's
        "Book a Visit" would promise a reserved bed the product cannot deliver
  - ☑ Name + phone are the only required fields (`lib/inquiry-form.ts`, 7 tests) —
        this form gets filled in on a bus
- ☑ `ratingSummary` now on every public payload, so cards show a real star
  - ☑ An unreviewed hostel shows **"New"**, never `0 ★`. Every average is `0` before
        the first review, so rendering the number puts a one-star badge on each new
        hostel — a searcher filters it out and it never earns a review
- ☑ Shared `HostelCard` in two widths (`carousel`, `list`). A second component for
      the second width is how the verified chip ends up in a different corner
- ☑ **Photos render on device** *(fixed 2026-08-17)*. `827a52c` made stored photo
      URLs **relative** (`/api/v1/files/<id>/url`) so one row works on every web
      origin — correct for a browser, which resolves against the page origin, but
      **a phone has no page origin**, so every `<Image>` failed *silently* and the
      whole app showed grey boxes. `lib/media.ts` (8 tests) resolves them against
      `API_BASE_URL` and leaves absolute URLs alone — the demo hostels carry
      `images.unsplash.com` photos, and prefixing those would break the one set
      that worked. No bearer token is needed: `files/[assetId]/url` 302-redirects
      a `PUBLIC` asset straight to R2 without loading a principal
- ☑ **Home screen brought in line with the mockup** *(2026-08-17)* — hero photo
      with a real listing floating over it, "Premium hostels" with client-side
      type pills, trust tiles, and the stats band. Three decisions taken with the
      product owner rather than copied from the drawing:
  - ☑ **The stats band shows real figures.** The mockup and
        `public-home-page.tsx` both hard-code "500+ Verified Hostels / 10,000+
        Happy Students / 50+ Cities / 4.6 ★"; nothing derives any of it and none
        of it is true yet. Mobile computed them from the payload it already had
        (`lib/home-stats.ts`, 11 tests). "Happy Students" has no honest
        equivalent — nothing counts students — so that tile was **vacant beds**.
        **Superseded the same day** — the band is gone, see the rework below;
        `home-stats.ts` and its tests were deleted with it. **The web still ships
        the invented numbers**
  - ☑ **Tabs stay four** — `Home · Search · Compare · Profile`. The mockup draws
        Bookings and Messages; there is no booking model and no messaging
        endpoint, and a tab that opens onto a permanent empty state is the tab
        people stop trusting
  - ☑ **"Services to make life easy" row skipped.** Its "Book a Room" needs a
        booking model that does not exist, and "Report an Issue" is complaints,
        which is M5. Same for the mockup's "Rent on the go" grid, and for "List
        your Hostel" — there is no hostel-registration screen on mobile to send
        anyone to
  - ☑ Hero imagery is the **best-rated verified listing that has a photo**, not
        stock art: the card over it is tappable and goes where it says
        *(superseded — the hero itself is gone, but the rule carried over to the
        showcase: photo required, verified and best-rated lead)*
  - ☑ Mockup's "Announcements / Notices" section — **cut, decided 2026-08-18**.
        No public announcements feed exists anywhere in the product: `Notice` is
        hostel-scoped and resident-only, and `notification-campaign.service.ts`
        broadcasts to signed-in accounts, not to the public. Building one means a
        new model, an authoring surface, moderation and routes — a server module
        of its own — and **the mockup only ever draws this section empty** ("No
        announcements at the moment"). That is the same call already taken on the
        hero copy, the trust tiles and the stats band in the second pass below:
        the home screen shows the catalogue, not rows that are permanently blank.
        Reopen this if a public announcement feed is ever built for the website —
        it is a missing product feature, not a missing screen.
- ☑ **Home reworked into a listings screen** *(2026-08-17, second pass)*. The
      first pass followed the mockup's marketing shape and put four screenfuls of
      copy between the fold and the first hostel. Product owner's call: the home
      screen is a property-listing screen — header, search, photographs, rows the
      catalogue fills. Palette unchanged (white / black / one green accent).
      `components/public-home.tsx` is now header → type tiles → showcase → saved
      → near you → popular → cities → premium → newly listed → facilities.
  - ☑ **The green hero card is gone**, replaced by `hostel-showcase.tsx` — an
        auto-sliding carousel of real listings at 200px, with the type pill,
        heart, price and rating the mockup draws on its cards. It filled the
        first screenful to hold *one* photo on a screen whose job is showing
        hostels. Its search field moved up into the header, where it is reachable
        without scrolling
  - ☑ **Auto-advance yields to the user permanently.** The first drag cancels the
        timer for the life of the screen; "resume after N seconds" is a race with
        how long someone spends reading, and losing it takes the card out from
        under their thumb. Also off under **Reduce Motion** (watched live, not
        read once — someone enabling it mid-session is doing it because something
        is moving), while the screen is **blurred**, and with one card
  - ☑ **New header** — `components/discovery-header.tsx`, not `AppBar`: avatar +
        greeting, a **bell with its unread count** for signed-in accounts only,
        compare, and the search field on a second row. Signed out the greeting
        becomes the wordmark and the bell is **absent rather than disabled** — a
        bell that opens "sign in first" is a worse answer than no bell. The
        avatar is deliberately not pressable: this header renders in three shells
        and only one of them has a Profile tab to open. No mic — there is no
        speech recognition in this app
  - ☑ **Favourites, on the device.** The mockup's heart was cut with the Saved
        tab because there is no favourites collection server-side, and there
        still is not. `lib/saved-hostels.ts` (9 tests) + `savedSlice` persist a
        **snapshot per hostel**, not an id: `/public/hostels` returns the first 60
        cheapest-first, so a saved hostel can be missing from the payload —
        priced out of the window or delisted — and a row built from
        `ids ∩ payload` would silently drop something the user chose to keep. The
        snapshot also makes the row work on a cold offline start, which is why it
        renders *above* the error branch. Photo URLs are stored **unresolved**:
        the base is a LAN address in dev, and persisting the resolved form bakes
        yesterday's IP onto disk. The section header says "kept on this device"
        rather than implying an account-wide list, and the tab set still stays
        four
  - ☑ **"Browse by city"** — `cityCounts` in `lib/home-sections.ts` (14 tests),
        grouped case-insensitively with an `area` fallback, deep-linking
        `?city=`. The browse screen narrows that **on the client** (`inCity`),
        because the server has no city filter: `publicHostelListQuerySchema`'s
        `area` matches `location.area` only, so a hostel in "Ghattekulo,
        Kathmandu" does not match `?area=Kathmandu`. Same trade as `Sort:
        nearest` and honest for the same reason — it changes what is on screen
        and does not claim to have narrowed the query. Both the count and the
        results come from one payload, so they agree. The "first 60" footer reads
        the *returned* rows, not the narrowed ones
  - ☑ **Removed: trust chips, "why students use HostelHub" tiles, the stats band,
        the residents callout.** The first two are hard-coded copy with no data
        behind them — `Verified` is already a chip on every card that earns it,
        which is the claim made where it can be checked. The band was real but is
        furniture on a screen for finding a room. The callout was a second
        "create an account" prompt on a screen that already floats a Log in pill
        over the bottom edge for exactly that audience
  - ☑ **"Browse by type" merged into the header row** and Premium's type pills
        dropped. The same four choices appeared twice on one screen, once
        navigating and once narrowing in place — a coin toss about what a tap
        does
  - ☐ Device pass on the redesign — typechecked, linted and 233 unit tests green,
        but the carousel timing, the snap alignment and the header's status-bar
        inset are all things only a phone can confirm
- ☑ `lib/hostel-display.ts` — 24 tests over the branches a screenshot would not
      catch: `NPR 8,000 – 8,000` for a single-price hostel, metres printed as
      `3200 km`, `0 beds vacant` hidden as if it were unknown
- ☑ **Device location → nearby hostels**, plus a map on the home screen *(2026-08-17)*
  - ☑ **Client-side haversine, no server change** (`lib/geo.ts`, 16 tests). The
        server has no `2dsphere` index and no `lat`/`lng` in the query schema, but
        `/public/hostels` already returns `coordinates` on every row and caps at
        60 — so sorting 60 points in JS is correct at this size and costs one
        pass. `haversineMeters` mirrors `apps/web/src/lib/maps/nearby.ts` so a
        distance on the phone matches the one on the web. The server query
        (`Point` mirror field + `2dsphere` + `$geoNear` + a backfill migration)
        becomes a plan item when the dataset outgrows the cap
  - ☑ **Prompted on intent, never on launch** — the "Near me" button in Home's
        *Near you* card and the `Sort: nearest` chip on browse. Nothing runs at
        boot: a dialogue before the product has shown a hostel is the one people
        decline, and on Android a "don't ask again" refusal is permanent
  - ☑ Coarse only: `ACCESS_COARSE_LOCATION` requested, `ACCESS_FINE_LOCATION` in
        `blockedPermissions`, and `Accuracy.Low` at the call site. Sorting by
        rough proximity does not need a street-level fix
  - ☑ **Coordinates are never persisted.** The position is `useState` in
        `use-nearby.ts` and dies with the screen — never dispatched to Redux,
        which `redux-persist` writes to disk. Same line `apps/web` holds
        attendance pings to
  - ☑ Every failure keeps the list usable: denied → cheapest-first with a
        reason; blocked → the chip becomes an *Open settings* link rather than
        vanishing; no fix in 8s → unsorted, never a spinner over working content.
        Last-known fix is used first so an indoor cold GPS lock is not 30s of wait
  - ☑ Un-geocoded hostels sort **last** rather than being dropped, and show no
        distance at all — `0 m away` on a hostel nobody placed is a confident lie
  - ☑ **Map is Leaflet + OSM tiles in a `react-native-webview`**, not
        `react-native-maps` (`components/hostel-map.tsx`). No Google Maps Android
        key exists, and `apps/web` already draws the same OSM tiles — one map
        provider across the product beats a second one for a single platform.
        The map is an addition to the sort and never the only route to a hostel:
        it is blank without a network, and the sorted list beside it is not
- ☑ **QR activation** — `expo-camera` scanner + manual code entry, `POST
      /resident/activate`, then straight into `(resident)` with no relaunch *(2026-08-17)*
  - ☑ **The QR does not contain the code — it contains a URL.**
        `activationUrl()` renders the PNG from
        `<app>/resident-activation?code=…` because the same image is printed for
        the web flow, so a scanner that posts the decoded string gets
        `ACTIVATION_CODE_INVALID` while the code in the picture was perfectly
        good. `lib/activation-code.ts` (13 tests) pulls the code out of the URL,
        accepts a bare code, and rejects a QR for something else — a wifi config
        or a vCard — rather than posting it as a failed attempt
  - ☑ **Activation is a sign-in.** The route runs `requireApiPrincipal` *first*,
        so the user is already signed in; it then promotes them to `RESIDENT`,
        adds the hostel to `hostelIds`, and ends with `issueSessionForUser`. The
        token in memory still names the old role, so the response goes through
        `startSession` exactly as a login would. `isResidentActivated` is then
        set locally rather than re-fetched — the call that just returned *is* the
        activation, and if that extra request failed on a flaky connection the
        boot gate would send them straight back here
  - ☑ Double-submit guarded by a **ref, not state**: `onBarcodeScanned` fires
        every frame the code is in view, several times before React re-renders,
        and each one would burn the single-use code and then 409 on itself
  - ☑ **Manual entry is the other half, not a fallback** — scanning fails on
        cracked screens, photocopied stickers and bad light. Both paths run one
        `submit`; codes are normalised (the server hashes `trim().toUpperCase()`)
  - ☑ Camera permission is **not** requested on mount, for the same reason as
        location: refused-with-don't-ask-again cannot be undone from inside the
        app. Prompt behind a button; permanent refusal offers system settings
  - ☑ A wrong QR is answered **at the camera**, as a strip over the frame; what
        the server says lands under the field holding the code it rejected
  - ☑ **Sign out is in the app bar.** The boot gate sends an unactivated resident
        here on every launch, so without it an expired code is a locked app —
        and an expired code is the normal case for anyone who left it a week
- ☑ Torch toggle for low-light scanning (`enableTorch`)
- ☑ Activation carries device + session info *(2026-08-17)* — `lib/device-info.ts`,
      from `expo-device`/`expo-application`, tagged `source: "mobile"` to mirror the
      web's `{ source: "web" }`. Per-install id only: no location, no phone number,
      no advertising id.
      **Note: nothing renders this yet.** No admin screen reads
      `QRActivation.deviceInfo` — the only `deviceInfo.fingerprint` reader in the
      repo is `operations-analytics.service.ts`, which is `FoodReadyLog`, a
      different collection. It is written because the answer to "which phone
      claimed this code" cannot be reconstructed later, not because a panel shows it
- ☑ Referral deep link `hostelhub://ref/<code>` → `app/ref/[code].tsx` *(2026-08-17)*
  - ☑ **The file name is the handler.** expo-router resolves the scheme to the
        route on a cold start and while the app is running, so there is no
        `getInitialURL`/`addEventListener` pair and no cold-start case to forget
  - ☑ **Fixed a cold-start bug this uncovered:** the splash was hidden from
        `app/index.tsx`, which a deep link never renders — so a link-launched app
        would have sat behind the splash forever. `_layout.tsx` owns the hide now,
        being the one component every route mounts under. This would have hit
        *every* future deep link, not just referrals
  - ☑ Posts to `/public/inquiries/with-referral` — a different endpoint from the
        plain hostel inquiry, and rate limited. One `InquiryFields` component,
        branching only on which function it calls
  - ☑ `lib/referral-link.ts` (12 tests) parses the app scheme **and** the
        `/inquiry?ref=<code>` web link residents actually share. Note the range
        is 4–32, *not* activation's 6–32 — one shared validator would have
        silently rejected valid four-character codes
  - ☑ **The screen cannot name the hostel, and does not pretend to.** The server
        resolves the code to `referralCode.hostelId`; no public endpoint maps a
        code to a hostel, so the copy says "a friend has referred you to their
        hostel". Guessing a name would send someone's details to the wrong place
        confidently
  - ☐ **Server/web gap found while building this: every referral shared so far has
        been dropped.** `referral.service.ts` hands residents a `/inquiry?ref=<code>`
        link, but `public-inquiry-page.tsx` reads only `hostel` and `room` and
        ignores `ref` — and nothing outside a test has ever called
        `/public/inquiries/with-referral`. The mobile screen is the product's
        first real consumer; the web page needs the same treatment. **Still true on
        2026-08-17**, so M5.6's share sends the code rather than the link — promoted
        to a §1 row now that a shipped screen has to work around it
  - ☐ An `https://` referral link still opens the browser, not the app — verified
        app links need `assetlinks.json` on the domain plus `intentFilters`
        (Android) and `associatedDomains` + AASA (iOS), none of which is
        configured. The parser already accepts that form, so it is config, not code

> **Work order, blockers and traps for the rest of M6:**
> [`MOBILE_M6_HANDOFF.md`](MOBILE_M6_HANDOFF.md).

**Acceptance**
- ☐ Fresh install → browse hostels without an account
- ☐ Register → scan QR → dashboard loads, no relaunch, no login flash
- ☐ Manual code entry reaches the same state

---

## M7 — Guardian · Cook · Provider · Admin-lite ◐ *(all four groups built 2026-08-17)*

Four small role groups sharing the M1 primitives. `components/role-tab-screen.tsx`
is **gone** — every group renders real screens, so nothing imported it any more.

Built in the order decided 2026-08-17, by how much server there was to build
against: Guardian, Admin-lite, Provider, Cook. Two server gaps were closed on
the way (§1): the cook had no reads at all, and a provider could not close their
own job.

> **Read the service, not the web's type — and it paid for itself immediately.**
> `daily-operations-shared.tsx`'s hand-written `GuardianDashboard` had drifted
> from `getGuardianDashboard` three ways, each of which rendered as broken text
> on the live web page: `firstName`/`lastName` (the serializer returns
> **`fullName`**) printed "undefined undefined" as the ward's name;
> `safety.checkedAt` (it returns **`asOf`**, a date, on purpose) printed "Invalid
> Date"; and a non-null `summary` (it returns **null** without `canViewPayments`)
> threw outright. Copying that type would have shipped all three to a second
> client. Both the type and the two web pages are fixed; `lib/guardian-api.ts` was
> written off the service.

**The one rule that shapes every Guardian screen.** The server gates each query
by its own permission flag, so a section the resident did not share comes back
as `[]` — indistinguishable from a section that is genuinely empty. "No payments
yet" shown to a guardian who was never granted payments is the app asserting
something about the ward's finances it has no basis for. So an ungranted section
is **absent**: never empty, never a lock icon over a blurred list, never a count
of zero. `lib/guardian.ts` is that rule in one tested place, and the *account*
screen — not each hidden section — is where a guardian is told what is shared,
because repeating it beside every section turns the resident's private choices
into six prompts to argue about.

**Guardian** — `(guardian)/`, amber role colour
- ☑ Dashboard (`/guardian/dashboard`), safety summary, night-status visibility.
      One request, sliced locally: `/payments`, `/notices`, `/food` and
      `/safety-summary` all call `getGuardianDashboard` server-side and return
      slices of it, so four per-tab fetches would be four identical round trips.
      `asOf` is rendered as a **date**, never a time (§4.1).
- ☑ Payments view (read-only), notices, food. Read-only is the server's shape,
      not a limitation: there is no guardian payment route anywhere, so the
      screen says where payment happens instead of drawing a dead button.
      Receipts join the dues rows by billing month and are gated by their *own*
      flag, which is why a row can show dues with no receipt beside it.
- ☑ Invitation acceptance deep link — `app/guardian-invite.tsx`, matching the
      emailed `{siteUrl}/guardian-invite?token=…` path so the https link routes
      here the day verified app links land. Accepting issues **no session**, so
      it hands off to login with the email prefilled; single-use, and the error
      copy names expiry and reuse rather than saying "something went wrong".
- ☑ Respects the per-guardian permission flags — a disabled section is absent,
      not empty. 12 tests on `lib/guardian.ts`.

**Cook** — `(cook)/`
- ☑ Today: menu + resident count — `GET /cook/today` (new; §1 gap closed)
- ☑ Four large **Food Ready** buttons (breakfast / lunch / snacks / dinner) →
      `POST /cook/food-ready`. **Success is `notifiedCount`, not `201`**: the
      route returns 201 once the log row is written, whether or not a single
      resident had an account to notify, so a zero says so plainly. All four are
      always drawn — a kitchen serving an unplanned snack still needs to call
      it — and a sent meal says "Announce again" rather than disabling, because
      the cooldown is the server's rule (429, with the wait named) and a client
      copy of it would drift the moment an admin changes it.
- ☑ Food photo upload straight from camera — camera is the primary button, the
      library the secondary; the meal type is guessed from the Kathmandu clock
      rather than asked. Posts to `POST /cook/food-photos` (new), which writes
      the same feed residents read.
- ☑ Read-only resident list and weekly menu. The roster is **name and room type
      only** — a shared, static kitchen credential is the one most likely to
      leak, so the list is worth no more than a noticeboard.
- ☑ Device fingerprint registered on first login — by way of `deviceInfo` on the
      first announcement, which is the only attribution a one-account-per-hostel
      login has, and is shown on the More tab so it is not a secret.
- ☑ *(server gap #3 closed — `GET /cook/today`, `GET /cook/residents`,
      `POST /cook/food-photos`, 9 tests)*

**Service Provider** — `(provider)/`
- ☑ Jobs feed — `GET /public/service-providers/me/jobs`, open work first, then
      by when it is due, urgency breaking ties. A date is a commitment and
      urgency within a day is a tiebreak, so Friday's URGENT does not jump ahead
      of today's LOW. 12 tests on `lib/provider-jobs.ts`.
- ☑ Job detail: hostel address + contact, tap-to-call, mark complete. Reloads
      the list and picks the row — there is no per-job GET, and doing it this
      way means a reassigned job says "no longer yours" rather than showing
      stale detail somebody might act on.
- ☑ Provider ID card with pending/approved status tag. The *platform* ID card
      already renders the `SERVICE_PROVIDER` variant (`app/id-card/`), so this
      tab shows the **application** — and the status tag matters: an unapproved
      provider gets an empty job list by design, so without it "no jobs yet" and
      "not reviewed yet" look identical.
- ☑ *(broadcast-and-claim still deferred — and the app draws no "available jobs"
      tab, because a permanently empty feed reads as a bug rather than a
      boundary)*

**Hostel Admin (lite)** — `(admin)/`, cyan role colour. Deliberately not a port of the web portal.
- ☑ Read-only dashboard: occupancy, dues, today's activity. Occupancy is
      **null, not 0%**, for a hostel that never configured its rooms — an admin
      with forty residents reading "0% occupied" stops believing the screen.
- ☑ Alert inbox: new inquiry, payment claim, complaint, SOS — merged into one
      feed ranked by *consequence of ignoring it* (SOS, overdue complaint,
      claim, inquiry), oldest first within a tier. Four separate cards would
      give a three-day-old inquiry the same weight as a live SOS.
- ☑ Quick actions only: approve/reject a payment claim, reply to a complaint,
      acknowledge an SOS. Resolving an SOS and marking one a false alarm stay on
      the web — those are judgements about whether someone is safe, made with
      the roster in front of you; what a phone is for is telling everyone a
      human has seen it.
- ☑ Everything else links out to the web portal in a browser, at the
      **tenant-scoped** `/{slug}/admin/...` (`lib/web-portal.ts` — `portal-nav.ts`
      still declares the legacy `/hostel-admin/...` hrefs and rewrites them, so
      building a link from the declared form 404s for every hostel).
- ☑ A warden's per-capability 403 is **named, not silently empty**: the four
      alert sources load independently and the inbox says which it could not
      read. Same rule as the guardian screens.

**Guardian access-code sign-in** — `(auth)/guardian-login.tsx`, added 2026-08-17
- ☑ A separate screen, not a mode on the login form: the guardian it exists for
      has **no email account** — that is why their hostel printed them a code —
      so "Email or phone" and "Password" have nothing they can type. Reached
      from a line under the login form, where someone who has just failed to
      sign in will look.
- ☑ Unlike the invitation, this **is** the sign-in: `POST /guardian/login`
      returns a full `issueSessionForUser` payload, so it hands straight to
      `startSession` and routes through `resolveHome`. The invite flow does the
      opposite — accepts, issues no session, hands off to login. Two doors, two
      behaviours.
- ☑ Codes are normalised, not shape-checked: uppercased (the server uppercases
      before it looks up) and stripped of spaces and hyphens, but the **alphabet
      is not policed** — codes issued before today came from
      `Math.random().toString(36)` and can contain `0`, `1`, `i`, `o`, so a
      client-side character check would lock out every guardian holding one.
      9 tests on `lib/guardian-login.ts`.
- ☑ `INVALID_GUARDIAN_LOGIN` gets a hint; the other two failures do not. The
      server is deliberately vague about *which* half was wrong (naming it turns
      a phone number into an oracle for enumerating codes), so the client says
      what to check without saying which failed — while expiry and the
      phone-conflict message already say what to do and are shown verbatim.

> **Three defects on `POST /guardian/login`, fixed while making it reachable
> from a phone.** Nothing in `apps/web` calls this route — only a test — so the
> mobile screen is its first real client, and it had never caught up with
> `/auth/login`. (1) **No rate limit**: a six-character code plus a phone number
> that is not a secret, unthrottled, is a guessing game whose prize is a session
> on somebody's guardian view. Now 5 per 15 minutes, the same as `/auth/login`.
> (2) **The refresh token went to every client in the JSON body**, including
> browsers — the thing `/auth/login` deliberately withholds, because a refresh
> token readable by page scripts outlives an access-token rotation and is the
> most useful thing an XSS can steal. Now gated behind the mobile client header.
> (3) **No session cookies were set**, which is why the web has never been able
> to use this route at all. 4 route tests.
>
> And the code itself was **`Math.random().toString(36).slice(2, 8)`** — a
> seeded generator whose state is recoverable from a handful of outputs, which
> is exactly what a hostel admin issuing several codes in an afternoon supplies.
> Now `randomInt` over a 32-symbol alphabet with `0`/`O` and `1`/`I` removed
> (~1.07 billion codes, and one fewer reason to phone the office). Existing
> codes are unaffected — login matches the stored string exactly. 2 tests.

**Still open in M7**
- ☐ Device pass on all four groups — none has been run on hardware

---

## M8 — Native polish & offline
- ☑ Biometric unlock gating app open — `lib/app-lock.ts` + `components/app-lock.tsx`: splash → fingerprint on every open (30 s grace for pickers), offered by sheet on each cold open, Settings → Security toggle; Gmail code (`/auth/biometric/code`) is the recovery and what turning it off needs. Cooks only when the owner turns on Cook → "Cooks lock the app with a fingerprint" (`HostelSettings.cookFingerprintLock`); `@cook.local` logins recover by password. Recents thumbnail hidden on Android 13+ (`modules/hostelhub-app-lock`). Plus "Update available" sheet (`components/update-sheet.tsx`: OTA + Play in-app update via `modules/hostelhub-app-update` + App Store lookup on iOS, needs a new native build)
- ☐ Biometric unlock (`expo-local-authentication`) gating app open, opt-in in Settings
- ☐ Offline: persisted slices render cached dashboard/payments/notices with a stale banner
- ☐ Queue payment-claim uploads made offline; flush on reconnect
- ☐ Native image viewer (pinch/pan) for food photos, community media, ID card
- ◐ Share sheet: **referral code done** in M5.6, **receipt PDF done** in M3
      (`lib/documents.ts`); hostel listing still to do
- ☐ `tel:` / `sms:` shortcuts for hostel admin and emergency contacts
- ☐ Deep-link table covering every push payload path; verify cold-start deep links
- ☐ Pull-to-refresh everywhere; optimistic updates on read/react actions
- ☐ Reanimated transitions between tab groups; no layout jump on the boot redirect
- ☐ Sentry (`@sentry/react-native`) with release tagging

---

## M9 — GPS auto-attendance *(deferred — build after the product above ships)*

Explicitly out of scope for the first release. The server side already exists
(`POST /resident/location/ping`, `/resident/consent`, `/resident/attendance`).

> **Privacy invariant, enforced by a test on the web side:** attendance pings must
> **never** persist coordinates. The server stores an inside/outside verdict only.
> Any mobile work here must keep that true — do not add a "last known location" field.

- ☐ Consent screen with the exact wording: coordinates are not stored
- ☐ `expo-location` foreground permission, then background permission as a separate ask
- ☐ `expo-task-manager` background task
- ☐ Geofence around the hostel rather than continuous tracking (battery)
- ☐ Ping at the hostel's configured times, fetched from resident settings
- ☐ Permission denied → report `UNKNOWN`, never fail silently
- ☐ Settings screen to review and revoke
- ☐ Android battery-optimisation exemption prompt with an explanation
- ☐ Verify on a physical device across a full day, screen off

---

## M10 — Release

- ☐ **Before any build: confirm the app identifiers in `apps/mobile/app.json`**
      — `android.package` and `ios.bundleIdentifier` must both read
      `com.softmato.hostelhub`. There is no `apps/mobile/android/` directory to
      check: the app uses Expo CNG, so `app.json` is the only source of truth and
      any prebuild output is regenerated from it. Once a build is published to
      the Play Store or App Store the identifier is permanent — a wrong one means
      a new listing, not an update, so verify it every time rather than assuming
      a previous build got it right.
- ☐ App icons, adaptive icon layers, splash, notification icon — all sizes
- ◐ `google-services.json` (Android FCM) and APNS key (iOS)
  - ☑ **Android, 2026-08-17.** Firebase project `softmato-e65a6` (number
        `850718271142`), app package `com.softmato.hostelhub`.
        `apps/mobile/google-services.json` is **committed** — it carries a
        client-side API key that ships inside the APK and is readable from any
        install, so it is configuration rather than a secret. `app.json` points
        at it with `android.googleServicesFile`
  - ☑ Registered with **no SHA-1**, deliberately: that field drives Firebase's
        *own* Google Sign-In and Dynamic Links, neither of which this app uses.
        The result is `oauth_client: []` in the file, which is the point — a
        SHA-1 there would have auto-created a second set of OAuth clients inside
        the Firebase project, and "which client id does sign-in use" is then a
        question with two plausible wrong answers. Sign-in reads
        `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID`, which points at the *other* project
        (`567374505362`) and is what the server verifies against
  - ☑ **This is a separate Google Cloud project from the OAuth clients**, and
        that is fine — push and sign-in share nothing. Worth knowing before
        someone "fixes" a sign-in failure by reaching for the id in
        `google-services.json`; the server would reject every token
  - ☐ The FCM V1 service account key uploaded to EAS *(yours — `eas
        credentials`; it is a real secret and never enters the repo)*
  - ☐ APNS key (iOS) — needs an Apple Developer account
- ☐ Privacy policy URL in app config (the web already serves one)
- ☐ Store listing copy + 5–6 screenshots per platform
- ☐ EAS `preview` APK distributed internally
- ☐ Physical Android device pass over every acceptance test above
- ☐ iOS simulator pass (physical device if one is available)
- ☐ **iOS "Update available" — prove it on the first App Store release.** Built
      2026-10-06 but never run: the app is not on the App Store yet, so Apple's
      lookup has nothing to answer. `components/update-sheet.tsx` →
      `appStoreUpdateUrl` in `lib/app-version.ts` asks
      `itunes.apple.com/lookup?bundleId=…&country=np|in` and opens the store page
      (Apple allows no in-app install). When the iOS app is live:
  - ☐ Its App Store countries are in the `["np", "in"]` list in `lib/app-version.ts` — a missing country answers nothing and no sheet ever shows
  - ☐ `version` in `app.json` is raised for every App Store release (the check compares it; the build number alone does not count) — together with a new build, since `version` moves the fingerprint
  - ☐ From an iPhone on the previous store version: the sheet appears (Apple's lookup can lag hours to a day after release) and "Update now" lands on the App Store page
- ☐ EAS `production` build; `expo-updates` channel configured
- ☐ `CHANGELOG.md` entry, `docs/MEMORY.md` updated, PHASES.md §6 ticked

---

## Definition of Done (mirrors PHASES.md §6.3)

- ☐ M0–M8 and M10 fully ticked (M9 tracked separately)
- ☐ Push notifications working end-to-end, killed state included
- ☐ QR scanning reliable in poor light
- ☐ Tested on a real device
- ☐ APK ready for distribution
- ☐ **Complete product delivered: web platform + mobile app**
