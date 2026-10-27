# Field review — 2026-10-27

Sources: three days of using the app and web, written up in an 8-page notebook
(page numbers = photo order), the backup note
(`HostelPalika_Backup_Architecture_and_Implementation_Plan.md`), and two asks from
chat: SQLite so every screen opens instantly, and a resident move-out notice.

Work item by item: code → verify → flip ☐ to ☑ before the next.

## Order

1. **Phase 1** has no dependencies. **I1 (platform backup)** runs beside it: prod is
   Atlas M0 and has no backup of any kind today.
2. **Phase 2** starts after A1 lands (one source for room counts).
3. **Phase 3**: E5 waits on Q1. E4 and K1 are written last, from shipped behaviour.
4. **Phase 6** adds `expo-sqlite`, a native module → new native build, no OTA.
   Any other native addition (I4's key generation) rides the same build. Proved on a
   real Redmi, not on lint.
5. **Phase 8** (customer Drive backup) after I1–I2, and after I4's crypto design is
   reviewed.

## Phase 1 — Wrong numbers and hidden dialogs

☐ **A1 Room totals disagree between modes** (p2). Education Light main: floor-wise
18 rooms · 38 beds · 33 free; by type 38 rooms · 98 beds · 52 free.
Cause: `rooms-floors-editor.tsx:102` — floor mode sums the real `Room` rows, type mode
sums `hostel.roomConfigurations` (counts typed at KYC/listing), which nothing updates
when rooms are added, retyped or filled.
Build: while a hostel tracks rooms, the server rewrites `roomConfigurations` (rooms,
vacant beds per type) from the `Room` rows on every room create/update/delete and
every assign/move-out; one repair script for existing hostels; web Rooms reads the same.
**Done in code 2026-10-27** — `deriveTypeCounts` (`hostel-rooms.service.ts`) is the one
derivation: room changes and the tracking switch write it, and the layout returns
`totals` both modes draw. No script: a floor-wise hostel heals the first time its Rooms
screen loads. Test: `hostel-rooms.service.test.ts`. Open: web deploy, then a device
look at Education Light.

☐ **A2 Confirm dialog opens behind sheets — app-wide** (p7).
Cause: `ConfirmDialogHost` is mounted in `RootShell`, inside `BottomSheetModalProvider`
(`app/_layout.tsx:624`, `:668`). gorhom portals every sheet after its children, so an
open sheet covers the dialog. `ToastHost` had the same bug and was moved out (`:635`).
Build: mount the confirm host (and suspension/trial hosts) after the provider, still a
sibling after the blur target so the frosted backdrop keeps working. One change, every screen.
**Done in code 2026-10-27** — `OverlayHosts` in `_layout.tsx`, after the provider and
before `ToastHost`. Open: device check (a confirm from inside any sheet). OTA-able.

☐ **A3 Green top-card balance = the hostel's balance** (p3). `admin-home.tsx` reads the
same figure from the same endpoint as Money, per active hostel/branch, and refetches on
every payment, expense, transfer and khata event.
Cause found: the headline was "everything collected, ever"; the Statement's figure is
the balance (opening + received − spent). **Done in code 2026-10-27** — the card shows
`statementCredits(ledger)[0].runningTotal`, the Statement's own arithmetic on the same
ledger query (falls back to collections when the ledger is refused or truncated); expense
create / staff-cash answer / void now publish `PAYMENTS`, which they never did, so both
repaint. Open: web deploy, device check.

## Phase 2 — Rooms screen (p1–p4)

☑ **B1 Names**: Single Sitter Room · Double Sharing Room · Triple Sharing Room · Four
Sharing Room. One label map in `packages/shared`, used by app, web, public listing, PDFs.
**Done in code 2026-10-27** — `roomTypeLabel()` in `constants/room-types.ts` maps at
display; stored values stay the key (rate card, capacity, photos match on them, and old
bookings/receipts carry them). Wired into every screen that prints a type (app, web
portals, public listing/compare/JSON-LD, booking PDF, booking + resident emails and
notices, room-type pickers); `BED_TYPE_LABELS` (invoices) says the same names. A
type the owner typed passes through. Open: web deploy, device look.
☑ **B2** Room types button at the top.
**Done in code 2026-10-27** — top of `RoomsFloorsEditor` (so Rooms and the KYC step both
have it); the old row at the bottom of `manage/floors.tsx` is gone.
☑ **B3 Floors as tiles**: a vector floor glyph (new, in our icon set); Ground is one
tile, each added floor adds one.
**Done in code 2026-10-27** — `floor` glyph (line + solid) in `glyphs.ts`; floors are an
`ActionTiles` picker ("Ground / 6 rooms" … plus an Add floor tile), the picked one solid;
only the picked floor's rooms show below. Open: device look.
☑ **B4 Adding rooms without +/− counters**: pick a room-type chip first; + adds one
room of that type on that floor, − removes the last empty one. Tapping the selected chip
again (the note's "double click") or another chip clears/switches it. Rooms added or
removed in this pass look different from the rest and fade in / out.
**Done in code 2026-10-27** — the per-floor stepper and tap-to-paint are gone. A chip
arms a −/count/+ strip; each tap shows at once (draft keyed by room number) and saves in
order behind it, the server's layout replacing the draft when the last save lands (a
refusal rereads). Added rooms keep a dashed brand edge until the screen is left; tiles
fade in/out (reanimated, honours reduce-motion). Open: device look on a real Redmi.
☑ **B5 Room box → sheet** lists who lives there (photo, name, since, dues badge) and the
free beds. Sheet polished.
**Done in code 2026-10-27** — the layout's residents now carry `photo` (account picture,
else admission photo), `since` and `due` (`outstandingByResident`, one aggregate per
layout). The sheet: a mark per bed (taken filled, free in green), each resident with
face, "Since …" and a Paid up / Rs … due badge, opening their record; types that cannot
seat everyone are greyed. Open: web deploy (older servers send names only — the sheet
copes), device look.
☑ **B6 Room-type change guard**: allowed when empty; when occupied only if the new
type's beds ≥ residents in the room, else blocked with the reason. Enforced on the
server room update, not only in the sheet.
**Done in code 2026-10-27** — `updateRoom` no longer refuses every occupied retype:
`typeChangeRefusal` 409s only when the new type's beds < people living there ("3 people
live in Room 101; a Double Sharing Room has 2 beds. Move 1 person out first."). The beds
follow the type unless sent; the residents in the room take the new `roomType` +
`bedType` (rent follows from the next bill), then the type counts re-derive. A move
between rooms now also writes `bedType`. Test: `hostel-rooms.service.test.ts`. Web and
app both go through it. Open: web deploy.
☑ **B7 Not-floor-wise mode** stays simple: per resident, one room type, nothing else (p1).
**Checked 2026-10-27** — it is already only a room count per type (`TypeCounts`); none of
B2–B5 reaches it. Names now go through B1.
☑ **B8 Room assignment** snappy: optimistic move, no full reload, short transitions.
**Done in code 2026-10-27** — Rooms → "No room yet" and the resident's Floor & room
sheet both shut at once and show the new room from a local edit of the cached layout /
record (both Rooms screens share the cache key, so they move together); the request
runs behind it and only a refusal rereads. Open: device look.

## Phase 3 — Billing, moving out, demo material (p5, p6, p8, chat)

How billing works today (from code): bills are per Bikram Sambat month; the first month
is prorated from move-in to month end (`resident-intake.service.ts` `firstMonth`, same
arithmetic as the billing run); the last month is FULL_MONTH or TILL_DAY
(`Resident.lastMonthCharge`); late fine and khata add lines; due reminders already go
out automatically.

☑ **E1** Resident add form: one line under the email — "This email becomes their
login." Then prove it end to end: registering creates that login and sends the invite (p6).
**Done in code 2026-10-27** — the line sits under Email on web (`hostel-admin-residents-page.tsx`)
and app (`applicant-form.tsx`, staff side only). Proved: `createResident` →
`findAccountForIntake` finds no account → `openResidentLogin` makes a PUBLIC login (no
password) → `linkResidentAccount` promotes it to RESIDENT → the welcome mail goes out as
`NEW_ACCOUNT` ("Log in with Google, or Forgot password"). An address that already has an
account is promoted instead. Test: `resident.service.test.ts` "makes the typed email
their login…". Open: one real registration with a fresh Gmail after deploy.
☑ **E2 Billing choice on the last registration step** (p5):
- Calendar month — move-in day to end of the BS month, then monthly (today; default).
- Same day each month — move-in day to the same day next month, and on.

Server: `Resident.billingCycle`; the billing run bills same-day residents on their day;
the invoice stores covered dates and keeps a BS month key (month the cycle starts) so
month-keyed screens keep working; due date, late fine, reminders follow the invoice due
date. Shown on the resident page (web + app) and invoice: "Bills on the 20th".
**Done in code 2026-10-27** — `Resident.billingCycle` (default CALENDAR_MONTH);
`bsCycleBounds`/`bsCyclePeriodOf` (shared BS module) and `residentPeriodBounds`/
`residentPeriodOf` (`fee-schedule.service`) are the one span rule, used by the billing run,
the intake quote, move-out money, days away, the unbilled projection and receipts. A
same-day bill (e.g. Bhadra 20 – Aswin 19) is keyed by the month it opens in, stores
`coversFrom`/`coversTo`, is issued on its day (the daily cron skips it as `NOT_YET_DUE`
until then; the first one is raised at registration), and falls due on its last day — or
grace days from its first day when a late fine is on. Line reads "Monthly rent — Bhadra 20
– Aswin 19 · bills on the 20th". Choice: web "Billing" select, app segmented control under
"Moving in on"; resident pages show `billsOn`. Test: `billing-cycle.test.ts`. Open: web
deploy, an app device pass, one real same-day registration. Khata on a same-day bill takes
entries given before the 1st (marked `ponytail:`).
☑ **E3** Confirm the automatic reminders cover same-day bills.
**Confirmed in code 2026-10-27** — `sendFeeDueReminders` and `accrueLateFines` read only
an open invoice's `dueDate` and balance, never its period or the calendar, and E2 gives a
same-day bill its own due date. So reminders (7·5 days, then twice daily from 3) and the
late fine follow the bill's day with no change. The push names the month the bill opened in.
☑ **E5 Move-out notice** (p8 + chat):
- Resident (app + web): "I'm leaving" → date, optional reason. No approval step.
- Admin + wardens notified at once; resident can change or cancel until the day.
- **Move-out notice days** is a hostel setting, editable on the Finance screen (web +
  app). The date picker only allows today + notice days or later; the server rejects
  anything earlier. Fee stops on the chosen date — last bill prorated to it (Q1).
- Day before and on the day: push to resident and warden.
- On the day the warden's home shows "Leaving today" → Move out opens the existing
  move-out checklist with the date filled. Not done → reminder repeats.
- Move-out already demotes the login to public; keep it.
**Done in code 2026-10-27** — `leaving-notice.service.ts` + `/api/v1/resident/leaving`
(GET/PUT/DELETE). Notice sets `Resident.leavingOn` and `moveOutDate` + `TILL_DAY`, so the
billing run prorates the leaving bill to the day and skips later ones; cancel clears all
three. `moveOutNoticeDays` in Money rules (web panel + app Finance → Money rules), checked
on the server (`LEAVING_TOO_SOON`). Admin + wardens get a bell + push at once (and on
change/cancel). The payment-reminders cron (twice a day) pushes resident and staff the day
before and on the day, and keeps reminding staff after it until they are moved out. App
Home shows "Leaving today · name" → `/manage/resident/{id}?panel=moveOut`, the existing
sheet starting on the notice day; completing it clears the notice; the demotion is
unchanged. Resident: app More → Moving out, web Profile → Moving out card. Test:
`leaving-notice.test.ts`. Open: web deploy, device pass; web staff dashboard has no
"Leaving today" card (the resident detail shows "Leaving on"); a bill raised before notice
is cut by the move-out sheet, not at notice time.

☑ **E4 Billing explained**: join → first bill → monthly bill → reminders → fine →
move-out bill, one worked example in BS dates. `docs/BILLING_EXPLAINED.md` for the demo
script; the short version on the web billing page and in the app.
**Done 2026-10-27** — `docs/BILLING_EXPLAINED.md` (Bhadra 20 joiner on both cycles, rent
6,200: 2,400 first bill, Kartik 10 leaver 2,067). Short version: "How bills work" card under
Money rules on the web Rates page and on app Finance.
☑ **K1 Features by category** (p5): Resident management (explore → book or walk in →
register → portal → billing choice → reminders), Rooms, Money, Stock, Food, Attendance,
Complaints, Staff… taken from the code, for demo videos.
**Done 2026-10-27** — `docs/FEATURES_BY_CATEGORY.md`.

## Phase 4 — Finance screens

☑ **C1 Payment sheet** shows the whole flow: month rent, discount only when present,
fine/khata lines, total, paid, left (p7). App: Money tab cash sheet → `BillBreakdown`
(`components/bill-extras.tsx`) over `billRows()` in `lib/admin-money.ts` (tested).
Web: the resident payment-track sheet's months now carry `lines` from the ledger
read and print the same rows. Open: device look.
☑ **C2 Statement PDF** in the report PDF's format: date, particulars, Dr, Cr, running
balance, opening and closing balance (p3). App and web Statement PDF buttons now
download Reports' bank-style statement (`reports/statement/pdf`) for the months on
screen (`pdfMonths`), CSV unchanged; that PDF now starts from the hostel's opening
bank balance, so its balance is the app's `statementCredits` running total (tested).
Overall keeps its all-branches PDF. Open: device look at a downloaded PDF.
☑ **C3 Expense screen**: the quick buttons change the "Rice 25 kg" label to match;
payment methods show real eSewa, Khalti, Bank, Cash marks as vectors (`wallet-mark.tsx`
first) (p8). Hint follows the tapped tile (`EXPENSE_WHAT_EXAMPLE`, shared, app + web);
Paid by = four `WalletMark` tiles. eSewa/Khalti are the owner's PNG marks, Bank/Cash
our vector glyphs — true SVG brand marks need vector files from the owner. Open: device look.

## Phase 5 — Stock (p3, p6)

☑ **D1** Stock screens animate on one rhythm (H2). Every stock screen's body column is
a `<Stagger>` (`ui/layout.tsx`): the header mounts with the screen, then each block
rises `MOTION.stagger` apart; Home's category groups are steps of their own, History
months too, and a month still loading is a skeleton, not "Loading…". Open: seen on a phone.
☑ **D2 Stock report**: numbers, not sentences. Per item bought / used / left for this
month, 3 months, year, plus expected next-month spend from that range. PDF + CSV through
the global downloader. `GET /hostel-admin/stock/report?range=month|quarter|year`
(`&format=csv|pdf`); next month = (used + wasted) per day over the range × next month's
days × today's average cost (`reportFigures`, tested). App: `/stock/reports` rebuilt;
web: Stock report card. Both downloaders now send the switcher's building. Open: device +
browser look; numbers against real data.
☑ **D3 Buy screen item card**: more items, each with an icon — water jar, gas cylinder,
rice, dal, oil, sugar, tea, vegetables… (new glyphs). 11 kitchen glyphs in `glyphs.ts`
(water-jar, gas-cylinder, rice-sack, dal-bowl, oil-bottle, sugar, tea, vegetables, salt,
milk, flour); `ItemAvatar` draws glyphs, not emoji; Buy's chips add 12 starters
(`STOCK_STARTERS`, with units) the hostel has not bought yet. Open: glyph look on a phone.
☑ **D4 Count → "Stock check"**: renamed, with one hint line — count the shelf, the app
corrects "left" (Q3). Labels only (tile, screen title + hint, Save, History filter, entry
kind, web menu); routes and `COUNT` stay.

## Phase 6 — Instant screens and offline (p7, chat)

☐ **G1 SQLite cache**: today `lib/query-cache-persist.ts` stores the whole cache as one
AsyncStorage JSON string and parses all of it before first paint. Move to `expo-sqlite`,
one row per cache key, read per screen: every screen paints from disk on mount, then
refreshes. Native build.
☐ **G2 Offline PIN**: after any successful online PIN check or set, keep a salted slow
hash in SecureStore; offline, unlock checks it locally with an attempt limit; online the
server stays the authority and a PIN changed elsewhere replaces the local copy.
☐ **G3 Offline set** ("60% offline"): home, residents, rooms, money summary, invoices,
statement, stock, notifications, ID card, menu open from SQLite with "Updated hh:mm".
Queue only safe writes (night status already queues; add stock use/count, complaint,
expense draft). Payments never offline.
☐ **G4** One SQLite file per account; cleared on sign-out, account switch, role change.
☐ **G5** PWA keeps its web stand-in in `apps/mobile/web/` (IndexedDB); web portals unchanged.
☐ **F1 Notifications** open from SQLite instantly and fetch only newer ones (p7).
☐ **F2** Notification rows: icon by kind, title, one line, time.
☐ **F3** Every notification opens its exact screen; audit every kind, route the ones
with no target.

## Phase 7 — Feel (p1, p3)

☐ **H1 Icon arrangement**: menus audited against the references (tile grids, one size,
aligned).
☐ **H2 One entrance choreography per screen**: header, then cards staggered on one
interval, nothing on its own clock; Stock first. Continues `MOTION_AND_ICONS.md`.
☐ **H3 Our own usage watcher** (p1, Q2): per user — app opens, time on each screen,
features used — so we see which screens need work and what is used most.
- App + web: screen enter/leave from the router, app foreground; events queued in
  SQLite (G1) and sent in batches; never blocks a screen.
- Server: `UsageEvent` with a TTL plus daily roll-ups per user, role, hostel, screen.
- Superadmin portal → **Analytics** tab: opens per user, top screens by time, feature
  use, by role/hostel, drill into one user.
- External: Play Console Data safety must declare "App activity → App interactions",
  and the privacy policy (site config `content`) says so, before the build ships.

## Phase 8 — Backup and recovery (backup note)

Three separate systems: platform recovery copy, customer encrypted Drive backup,
on-device cache (Phase 6). None stands in for another.

☐ **I1 Platform backup**: scheduled `mongodump` of prod outside Vercel (GitHub Actions
schedule; the repo is public, so the job logs counts only), encrypted, into the private
R2 bucket, versioned with retention; never delete the last verified copy. Status row +
alert in the superadmin portal.
**Done in code 2026-10-27** — `.github/workflows/db-backup.yml` + `docs/BACKUP.md`:
nightly 02:00 Nepal, dump piped straight into age (public key only in GitHub, private
key offline), backups-only bucket with its own token, `daily/` + `monthly/` + manifest
with per-collection counts, fails under 20 collections. Alert = GitHub's failed-run email.
Open: owner setup (BACKUP.md steps 1–5) and a first green run. The superadmin status
row moves to I2, where there is a *verified* result to show.
☐ **I2 Restore drill**: script restores an archive into a separate database (an M0 in a
second Atlas project) and compares counts per collection. Nothing says "backed up"
before this passes.
☐ **I3 Tenant export**: every `hostelId` collection mapped — residents, finance, staff,
stock, branches and the rest, all of it; export filtered server-side by the authorised
hostel (branches included); a test proves one hostel's export holds nothing of another's.
Drive backup is offered from the **Pro plan up** (Q4), gated server-side.
☐ **I4 Customer key**: the owner's phone generates a key pair; the private key stays on
the phone (SecureStore) and in a printed recovery kit (words + QR); only the public key
reaches the server. Each backup gets a fresh AES-256-GCM key sealed to it (libsodium /
age format), so the server can back up on schedule and still cannot read the archive.
Security review before any "end-to-end encrypted" wording.
☐ **I5 Google Drive `appDataFolder`**: OAuth `drive.appdata` scope, refresh token
encrypted server-side, scheduled upload, reconnect on revoke, quota errors shown.
External: Google's OAuth consent-screen verification for the scope — check in the
Cloud console first.
☐ **I6 Backup screen** (web + app, owner only): Drive status, last backup + integrity
check, history, download (ciphertext), recovery-kit status. Honest wording only
("Last backup 23 Oct, 02:00 · checked").
☐ **I7 Restore**: download → recovery kit → verify → decrypt on device → preview → confirm
→ import with audit log; refuses another hostel's archive.
☐ **I8 Drills**: lost DB, deleted rows, revoked Drive, lost kit, tampered archive,
cross-tenant restore.

## Open questions

Answered 2026-10-27:

- **Q1** Move-out: hostel sets notice days on Finance; resident picks ≥ today + notice
  days; fee stops on that date → E5.
- **Q2** "Track like a warden" = our own per-user usage watcher, viewed in the
  superadmin Analytics tab → H3.
- **Q3** Count → renamed "Stock check" → D4.
- **Q4** Drive backup from the Pro plan up, every hostel's data → I3.
