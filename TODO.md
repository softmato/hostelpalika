# todo.md — owner's notebook pages, 2026-11-11

Work order for the 5 handwritten pages. Work top to bottom. Tick ☐ → ☑ in this file
after each item is coded **and** verified.

## Rules for whoever does this

- Read first: `CLAUDE.md`, `docs/DESIGN.md`, `ui_inspiration_folder/app_recordings/NOTES.md`,
  `server/docs/MISSION.md` (for any backend item).
- Backend changes go in **Go (`server/`) and TS (`apps/web/src/modules`)**, same routes.
- Mobile: reuse `apps/mobile/src/components/ui/` first. Black, white, green only.
  Skeletons, not spinners. Row overflow = bottom sheet.
- Every screen: one clear main action, data before prose, no confusing text.
- Money paths (codes, score, settle) each leave one small test behind.
- Mobile UI is proved on the device (dev build), not by lint.
- Do not start `eas build`. The owner runs the Android dev build.
- No UI change on web without asking the owner first.

## Open decisions (defaults are used unless the owner says otherwise)

- **D1 Code format.** Note says `{code}_Bai_2083`. Bank and wallet remark boxes often
  reject `_`. Default: `RUP-4821-BAI83` shown, and the reader accepts `-`, `_`, space or
  nothing between the parts.
- **D2 Score after day 7.** Note says "it gets lower". Default: day 1–4 = 10,
  day 5–7 = 8, day 8–15 = 5, later = 2.
- **D3 Paying at the warden's desk — DECIDED by owner.** Cash and online at the desk
  both earn score. The score day is the day the warden records it. When the warden
  saves cash, the resident gets a "Cash collected" receipt (push + in app).
  **Certified too (owner, 2026-11-11):** any payment the resident makes and a warden /
  admin approves or records is a certified receipt — cash at the desk included.
  Only the platform's own fee-off (`OFFER_PROGRAM` source) stays uncertified.
- **D4 Score and the Offer Program.** Default: the score does not replace the Resident
  Offer Program. It ranks residents inside it (higher score = first for gifts / fee-off).

---

## A. Month code a resident can guess (backend first — everything else needs it)

Today: `apps/web/src/modules/finance/reference-code.ts` makes one random-looking code
per invoice (`RUP-4821-K`). The owner wants: one fixed code per resident, plus the BS
month and year. Same resident, next month → same code, new month part.

- ☑ A1 Give each resident one fixed personal code (hostel prefix + resident number).
  Store it on the resident. Backfill existing residents.
  → `Resident.paymentCode` = `RUP-482K` (3-symbol number + check char) from a per-hostel
  `RESIDENT_CODE` counter. Backfill is lazy: first bill or first score read sets it.
  Unique index `{hostelId, paymentCode}` needs `npm --prefix apps/web run db:indexes`.
- ☑ A2 Monthly rent invoice code = personal code + BS month short name + BS year
  (see D1). Use the shared BS calendar file for month names. One-off invoices
  (`period: null`) keep the old style code.
  → `RUP-482K-BHA83` (`BAI JES ASA SHR BHA ASW KAR MAN POU MAG FAL CHA` + YY), set in
  `runBillingCycle` via `allocateMonthCode`. Admission / old-dues keep `RUP-4821-K`.
- ☑ A3 Parser reads **both** old codes and new codes. Old open invoices must still
  match. Tolerate case, spaces, `-`, `_`.
  → `extractReferenceCodes` / `normalizeReferenceCode` read both; `_` now splits tokens.
- ☑ A4 Typo safety: the old code had a check character. Keep one inside the personal
  code, or prove with a test that a one-letter typo can never match another resident
  in the same hostel.
  → check char kept inside the personal code; test walks every one-symbol typo and swap.
- ☑ A5 Check every reader of `referenceCode`: `claim.service`, `review.service`,
  `statements/reconcile.service`, `statement-import.service`, `gateway/intent.service`,
  `receipt.service`, `receipt-pdf`, `offer-program.rules`, `finance-notify`,
  resident notify files. Fix tests that hard-code the old shape.
  → every reader goes through `extractReferenceCodes` and compares strings; no shape
  regex anywhere (web, mobile, shared). Sample code updated in Offer Program copy + preview.
- ☑ A6 Same change in Go. Shared test vectors so Go and TS make and read identical codes.
  → `server/testdata/vectors/refcodes.{ts,json}` + `ledger/refcodes_vectors_test.go`.

## B. Resident credit score (backend)

- ☑ B1 On claim approval, add points by the **day the resident submitted** (BS day of
  the bill's month), not the day the warden approved. Points per D2.
- ☑ B2 One award per invoice. Rejected claims earn nothing. Reversed payment takes the
  points back.
  → score is derived from settled events (`credit-score.rules.ts`, Go `finance/creditscore.go`):
  earliest standing payment per MONTHLY_RENT bill; claim day = sent, desk = recorded.
- ☑ B3 Count per resident: receipts shared, receipts approved. Store or derive, one place.
  → derived: `claimCounts` / `ClaimCounts`.
- ☑ B4 API: resident reads own score + counts + history; admin/warden reads it per
  resident; superadmin Offer Program list sorts by it (D4).
  → `GET /api/v1/resident/credit-score`, `GET /api/v1/hostel-admin/residents/[id]/credit-score`
  (score, approved, shared, history, rules, paymentCode); overview `eligible[].creditScore`.
- ☑ B6 Certification rule: change `qualifiesForOfferProgram`
  (`modules/offer-program/offer-program.rules.ts`, called once in `settleEvent`) so a
  warden/admin-approved claim **or** a warden/admin-recorded desk payment (cash or
  online) is certified. A desk payment is tied to the months the warden ticked, so it
  needs no typed code. Fee-off payments still never qualify. Update the rules test,
  the receipt stamp (cash at desk now prints CERTIFIED with its HP- code), and Go.
  → TS + Go; the stamp follows `certificationCode`, so desk cash prints CERTIFIED.
- ☑ B5 Go + TS, one rules file each, one test each (day 4 → 10, day 5 → 8, day 7 → 8,
  day 8 → lower, late approval of a day-2 submit → 10).
  → `credit-score.rules.test.ts`, `finance/creditscore_test.go`, `ledger/certify_test.go`.

## C. Resident payment flow (app)

Flow the owner wants: see bill → copy month code → pay in eSewa/bank with code in
remarks → share the receipt to the app (or upload a screenshot) → claim sent → warden
approves fast → score added.

- ☐ C1 Resident pay screen: this month's amount, the month code big with a Copy
  button, hostel QR / account, and two actions only: **Share receipt** and
  **Upload screenshot**. Next month's code is shown too so they learn the pattern.
  ⏳ coded + typecheck/lint clean; on-device check pending (no device attached 2026-11-11).
  → `invoice/[id]/pay.tsx`: "Month code" + "Next month: …" (`lib/month-code.ts`, tested), bottom bar
  Share receipt (steps sheet) / Upload screenshot (→ claim).
- ☐ C2 `apps/mobile/src/app/share-payment.tsx` (receipt share sheet): make it clean and
  informative. Show receipt thumbnail, amount read, code found (✓ or "code missing"),
  which month it pays, one Submit button. No scrolling for the normal case.
  ⏳ coded + typecheck/lint clean; on-device check pending (no device attached 2026-11-11).
  → thumbnail + unpaid months (oldest ticked, code under each) + one Continue; one unpaid month
  skips straight to the claim, which already shows amount read and code found / missing.
  → the sheet over eSewa / bank apps (`apps/web/public/receipt-sheet.html`, native
  `ReceiptSheetActivity`) redone for residents: thumbnail + amount, "Code found ✓ / Code missing",
  month matched by the code on the receipt first, one Send button (Cancel is a quiet link).
  Icons are our own glyphs inlined from `glyphs.ts` (header, scan, code ✓/!, PDF thumb, month,
  picker chevron, menu tick, done, method fallbacks); no text-character icons left.
  Bundled into the APK at build time — shows only after a new Android dev build.
- ☐ C3 After submit: clear "Waiting for approval" state; push when approved or rejected,
  with points earned.
  ⏳ coded + typecheck/lint clean; on-device check pending (no device attached 2026-11-11).
  → claim done screen says "Waiting for approval"; approval / desk push ends "+N points."
  (`pointsEarnedBy`, TS + Go).
- ☐ C4 Score card for resident: score, "shared N · approved M", simple rule line
  ("Pay in day 1–4: 10 points"), link to perks.
  ⏳ coded + typecheck/lint clean; on-device check pending (no device attached 2026-11-11).
  → `components/credit-score-card.tsx` on Payments, replaces the Offer Program row (taps to perks).
- ☐ C5 Approver side: new claim push opens straight to the claim with Approve / Reject.
  Check this is one tap from the notification.
  → checked in code: push → Money tab, claim cards (Approve / Reject) sit under the month strip;
  the bell row also has an inline Verify. Open point for the owner: the claim push goes to
  admins only (`adminsOnly: true`), wardens get none.

## D. Shared receipt → expense (admin, warden)

- ☑ D1 When admin/warden shares a receipt into the app, the receipt image is attached
  to the expense it creates. Check the headless Android path (`ReceiptSaveService`)
  and the sheet path both attach it. Expense detail shows the receipt.
  → no change needed: `ReceiptSaveService`, `receipt-sheet.html` and `expenses/new.tsx` all send
  `photoAssetId`; the expense list's detail sheet shows the bill photo.

## E. Collect payment sheet (app, admin + warden) — redesign

Where: `apps/mobile/src/app/(admin)/money.tsx` (collect block near line 1090).
Match web: Record payment in `apps/web/src/app/_components/hostel-admin-payments-page.tsx`.

- ☐ E1 Warden taps a resident → sheet opens with **everything still unpaid**, one row
  per month: month name, amount, and the month code in small muted text. Clean, one
  column, total on top, one main button. Same rules as web Record payment.
  ⏳ coded + typecheck/lint clean; on-device check pending (no device attached 2026-11-11).
  → `components/collect-payment.tsx` (rules in `lib/desk-collect.ts`, tested); ledger months now
  carry `referenceCode` (TS + Go).
- ☐ E2 Warden ticks one or more months; total updates. Oldest month is ticked by default.
- ☐ E3 Method row: **Cash** + only the online methods this hostel has set up
  (eSewa, Khalti, bank… each shows only if its QR / number / account is saved).
  No method set up → only Cash shows.
- ☐ E4 Cash: show nothing extra. Just "Collect Rs X".
- ☐ E5 Tap an online method: the sheet grows with an ease animation and shows that
  method's QR / number / account inside the sheet. QR and Save both visible with no
  scroll. Tap another method → content swaps, sheet height eases to fit.
  ⏳ E2–E6 coded in the same component (oldest ticked; Cash + saved methods only; QR / number
  inside the sheet with `LinearTransition`; Collect / Save posts per bill oldest first); device check pending.
- ☐ E6 On save (cash): resident gets a "Cash collected" receipt and score (D3).
  On save (online at desk): payment recorded against the ticked months, score (D3).
- ☑ E7 Backend for E6: cash-collected receipt + push to resident, score award on
  desk payments. Go + TS. One test.
  → desk cash/online settle as CASH_ENTRY: certified (B6), scored (B), push titled "Cash collected"
  for cash with "+N points". Tests: `certify_test.go`, `creditscore_test.go`, rules tests.
- ☑ E8 Web Record payment gets the month → code display too (ask owner before changing web UI).
  → owner approved 2026-11-11: each unpaid month row shows its code in small muted mono text
  (`hostel-admin-payments-page.tsx`, reads `referenceCode` from the resident ledger). Typecheck clean.

## F. App-wide fixes

- ☐ F1 Amount font: web uses Manrope + tabular numbers (`.font-amount` in
  `apps/web/src/app/globals.css`). Load Manrope in the app, apply it in
  `apps/mobile/src/components/ui/money.tsx`, then find amounts not using that
  component and move them to it.
  ⏳ coded + typecheck/lint clean; on-device check pending (no device attached 2026-11-11).
  → `@expo-google-fonts/manrope` loaded in `app/_layout.tsx`, `font-amount tabular-nums` on `Money`
  and on 31 raw amount texts.
- ☐ F2 Add expense amount bug: `apps/mobile/src/app/expenses/new.tsx` line ~466. At the
  4th digit the first digit is cut; at the 5th it comes back. Cause to check: the
  input sizes itself (`minWidth: 80`, centred) and the comma added by `groupDigits`
  lands before the width updates. Fix so no digit is ever cut from 1 to max digits.
  Check `stock/buy.tsx` and `expenses/wallet.tsx` for the same input.
  ⏳ coded + typecheck/lint clean; on-device check pending (no device attached 2026-11-11).
  → input now fills the row between the two "Rs" labels (never resizes) and steps the font down
  for 9+ / 11+ characters. `stock/buy` uses the fixed `Input`, `wallet` has no such input.
- ☐ F3 Push on time: audit scheduled notices (now / later / daily / weekly) set by
  admin or warden. Send one of each on the device and compare set time to arrival
  time. Fix any drift. List what was tested in this file.

## G. Rooms — full web parity in the app

Web: `apps/web/src/app/_components/hostel-admin-floors-panel.tsx`.
App: `apps/mobile/src/app/manage/rooms.tsx`.

- ☑ G1 List every action the web panel has (add/edit/delete floor, add/edit/delete
  room, beds, room swap, move resident, room type, anything else). Write the list here.
  Web (`hostel-admin-floors-panel.tsx`) → app (`components/manage/rooms-floors-editor.tsx`, `manage/floors.tsx`):
  | Action | Web | App |
  |---|---|---|
  | Add floor | ✓ | ✓ tile |
  | Add rooms (per type, next numbers) | ✓ | ✓ |
  | Room count per type (profile `roomConfigurations`) | ✓ | ✓ `manage/rooms.tsx` |
  | Edit room: number, type, beds | ✓ | ✓ room sheet |
  | Set type on many rooms | ✓ | ✓ "Set type" |
  | Renumber / swap (101↔102, two passes) | ✓ | ✓ "Renumber" |
  | Delete room (empty only) | ✓ | ✓ `openConfirm`, disabled while lived in |
  | Remove empty floor | ✓ | ✓ select all → Remove |
  | **Remove lived-in floor: move residents, then remove** | ✓ | ✗ server refusal only → G2 |
  | Move resident to a room | ✓ | ✓ `floors.tsx` |
  | Room tracking on / off | ✓ | ✓ |
  | Room-change requests approve / decline | ✓ | ✓ `floors.tsx` |
- ☐ G2 Build each missing one in the app. Destructive ones use `openConfirm()`.
  Actions open from a bottom sheet on the room / floor row.
  ⏳ coded + typecheck/lint clean; device check pending (no device attached 2026-11-11).
  → bin on the floor card header: empty floor → `openConfirm`; lived-in floor → `MoveOffSheet`
  (each resident picks a free bed of their type on another floor, first guess like web,
  `lib/floor-moves.ts` + test) → confirm → moves one at a time, then deletes the rooms.
- ☐ G3 Same refusals as web (e.g. floor with residents cannot be deleted) with a clear message.
  ⏳ server already refuses `ROOM_OCCUPIED` ("N people live in Room X. Move them first."), the app
  shows it as the toast; the move sheet means the owner never hits it from Remove floor.

## H. Screen redesigns (app)

Do one screen at a time. Before: adb screenshot. After: adb screenshot beside the reference.

### H0. The bar every screen must pass (read before any redesign)

The target is the calm of Claude / Anthropic products: a user understands the screen
in one glance. Layout and flow still come from our references; colour stays ours.

- **One job per screen.** One primary button. Everything else is quiet (outline / ghost / row).
- **Text budget.** Title ≤ 3 words. At most one hint line per screen, ≤ 8 words.
  No paragraphs. If a label needs a sentence to explain it, the design is wrong.
  Longer help goes behind an (i) that opens a sheet.
- **Type.** Only the scale in `docs/DESIGN.md`. Max 3 sizes and 2 weights on one
  screen. Amounts always in the amount font (F1), right-aligned in lists.
- **Icons.** Only our own glyph set, one size per context (20 in rows, 24 in tiles),
  one colour unless it carries meaning. No icon without a job.
- **Space.** 4/8 grid. 16 side gutter. Group with space first, borders second, never both.
- **Lists.** Row = icon · name · one muted fact · value. Nothing wraps to 3 lines.
- **States.** Skeleton on load, `EmptyCard` when empty, error next to the thing that failed.
- **Touch.** Targets ≥ 44. Main action in thumb reach (bottom bar).
- **Check.** Hand the screenshot to someone for 3 seconds. If they cannot say what
  the screen is for and what to tap, redo it.

### H1. KYC — `apps/mobile/src/app/manage/kyc.tsx` (full redesign)

Today: 13 steps as a two-column tile grid, a "Save changes?" sheet on every exit, one
1000-line file. Steps: details, rates, documents, facilities, food, location, payments,
payout, opening, photos, rooms, rules, agreement.

**Design guide (how the best KYC flows work):**

1. **Start easy, end heavy.** First steps are taps, not typing. Documents and the
   signature come last, when the owner is already invested.
2. **Never ask twice.** Prefill from sign-up (name, phone, hostel name). Map pin first,
   then fill city / area / address from the pin; owner only corrects.
3. **Chapters, not 13 loose steps.** New order:
   - **Your hostel** — Map pin → Details (prefilled from pin) → Facilities → Photos
   - **Rooms & price** — Room types (rent, fees) → Rooms & floors
   - **Daily life** — Food menu → House rules
   - **Money** — Rent payments → Booking money → Opening balance
   - **Verify** — Documents → Agreement (sign)
   Keep any order the server enforces (room types before rooms). Check the server's
   required list; steps it does not require get a small "Optional" tag and a Skip.
4. **Hub = a checklist, not a tile grid.** One screen: progress ring ("5 of 13"),
   chapters as headings outside the cards, each step a row (icon · name · ✓ or "To do").
   One green button: **Continue** → goes to the first step not done.
5. **Step screen = one job.** AppBar: back, step name, thin progress bar. Body: the
   fields only. Fixed bottom bar: **Save & next**. No other buttons competing.
6. **Autosave.** Save on Next and on leaving. Remove the "Save changes?" sheet.
   Coming back always resumes on the first step not done.
7. **Tap before type.** Chips for choices, steppers for counts, number pad for money,
   sensible defaults filled in. Right keyboard and autocomplete on every input.
8. **Errors are local and kind.** Shown under the field, in plain words, when the
   field loses focus or on Next. Next scrolls to the first error. Never a toast for a field error.
9. **Documents.** One document per card: a sample outline of what to shoot, Camera as
   the main action, Upload file as the quiet one, a status badge after. One line on
   why we ask ("To confirm you own this hostel").
10. **Review before send.** One screen, a small card per chapter with its key facts
    and an Edit link. Then sign. Then one button: **Send**.
11. **After send.** A status screen: Sent → In review → Approved. If something is
    rejected, that step shows the reason and opens straight to the field.
12. **Code.** One file per step under `apps/mobile/src/components/kyc/`, one line per
    prop group — no 300-character JSX lines. `kyc.tsx` keeps only hub + routing.

Tasks:
- ☑ H1a Confirm the required / optional list and any forced order from the server review payload. Write it here.
  → `KYC_REQUIRED_STEPS` (TS `hostel-kyc.service.ts`): details, photos, rates, documents, location,
  agreement. Optional: rooms, payout, payments, opening, food, rules, facilities. The server forces
  no order; the one real dependency is room types (`rates`) before rooms. Order is client-side
  (`lib/kyc-order.ts`, tested); no server change.
- ☑ H1b Split steps into files (guide 12). No behaviour change. Typecheck passes.
  → `components/kyc/{details,location,facilities,photos,rates,rules,food,documents,agreement}-step.tsx`
  + `use-managed-hostel.ts`; `kyc.tsx` is hub + routing only (999 → ~440 lines).
- ☐ H1c New hub (guide 3, 4).
- ☐ H1d Step frame: progress bar, bottom **Save & next**, autosave, resume (guide 5, 6).
- ☐ H1e Map-first prefill of city / area / address (guide 2).
  ⏳ H1c–H1e coded + typecheck/lint clean; device check pending. Hub = ring + "N of 13 done" +
  chapters (heading outside, rows icon · name · ✓ / To do / Optional / Add again), one Continue
  (→ first open step) or Review & send. Step = AppBar title, thin progress bar, one hint, footer
  Save & next (+ Skip on optional steps). Back autosaves; a step that cannot save asks
  "Leave without saving?" (the "Save changes?" sheet is gone). Map is step 1; its save fills
  city / area / address from the pin when empty, and Save & next confirms a guessed pin (no tick box).
- ☐ H1f Each step body cleaned to the H0 bar, in the new order (guide 7, 8). Tick per step:
  ☐ map ☐ details ☐ facilities ☐ photos ☐ room types ☐ rooms & floors ☐ food ☐ rules
  ☐ rent payments ☐ booking money ☐ opening balance ☐ documents ☐ agreement
  ⏳ first pass coded: map (no tick box, outline buttons), details (errors under the field, not a
  toast; autocomplete), facilities / rules (count lines gone), room types (extra caption gone),
  documents (Camera main, Upload file quiet). The others unchanged; all wait for the device.
- ☐ H1g Review screen + status screen (guide 10, 11).
  ⏳ coded: Review = a card per chapter, each step with its fact and Edit, then Send (or
  "Finish N required"). Status on the hub: Sent → In review → Approved; Sent back shows the note,
  a rejected document marks Documents "Add again".
- ☑ H1h Web KYC (`/hostel-admin/kyc`) keeps working with the same data. Ask before changing its UI.
  → no server or data change; web untouched.

### H2–H6. Other screens (each must pass H0)

- ☐ H2 Expenses — `apps/mobile/src/app/expenses/`.
- ☐ H3 Repairs — `apps/mobile/src/app/manage/maintenance.tsx`.
- ☐ H4 Referrals — `apps/mobile/src/app/manage/referrals.tsx`, `apps/mobile/src/app/referrals.tsx`.
- ☐ H5 Billing — `apps/mobile/src/app/manage/billing.tsx`.
  ⏳ H2–H5: H0 text pass only (hints / empty states cut to ≤ 8 words; no spinners found). The
  layout redesign needs the before / after adb screenshots, so it waits for the device.
- ☐ H6 Stock — `apps/mobile/src/app/stock/` (index, buy, send, use, count, usage,
  history, suppliers, reports) + `components/stock/stock-parts.tsx`. Clean fonts and
  icons: one glyph per action (Bought / Send / Got it / Count) as an icon-tile grid,
  item rows = name · unit · quantity in the amount font, low stock shown by colour not text.
  ⏳ coded: tiles one colour (Waste stays red), quantity right-aligned in the amount font, low stock
  = red number (the "Low · below" line is gone), stock hints trimmed. Device check pending.

## I. User guide content (simple words)

Short sentences. One idea per sentence. No hard words. English and नेपाली. Bump the
doc version.

- ☑ I1 Resident: "How to pay your fee" — find your month code, put it in remarks,
  share the receipt, wait for approval.
- ☑ I2 Resident: "Your month code" — it is the same every month, only the month changes. Show two examples.
- ☑ I3 Resident: "Credit score" — pay early, get more points; points are counted from
  the day you send the receipt; what points give you.
- ☑ I4 Resident: "Pay at the office" — cash or scan the warden's QR.
- ☑ I5 Warden / admin: "Collect a payment" (new sheet), "Approve a receipt",
  "Shared receipts become expenses".
- ☑ I6 Admin: "Rooms" — swap, move resident, delete floor.
- ☑ I7 Already in the app, check the guide covers it: hostel detail, food, routines,
  rules, alerts, notices.
  → English written in `packages/shared/src/guide/guide.ts` (web /guide, app Guide, llms.txt):
  resident `first-bill` → "How to pay your fee", new `month-code`, `credit-score`, `pay-at-office`;
  owner `collect-payment`, `hostel-page`, rooms steps, approve-late line, shared receipt line;
  warden `alerts` (bell + routines). Food and notices were already covered.
  ☑ नेपाली (owner OK 2026-11-11): every chapter, group, caption, the access table and troubleshooting
  in `packages/shared/src/guide/guide-ne.ts` (button names stay English, as the app shows them).
  Web /guide has an EN / नेपाली switch in the top bar (`guide-lang.tsx`), kept per browser and set
  before first paint; both languages are in the static page, CSS shows one. `guide-ne.test.ts` fails
  when a chapter changes in English without its Nepali. Search still searches English only.
  ☐ Version bump: owner sets it in Platform → Website Config → Legal Pages (the defaults file is in
  the Go site-config contract vectors, so it is not edited here).

## J. Testing

- ☐ J1 Owner runs the Android dev build so changes show live (no OTA wait).
- ☐ J2 After all items: `go test -p 2`, web typecheck + tests, mobile typecheck + tests.
  Run 2026-11-11 (before device checks): Go all ok except `TestDemoHostelsCopy` (known). Web
  typecheck clean; tests 3 fail, none from this work: `setting-change` (known), `platform-field-index`
  (`PricingTab` "Residents", committed code). Fixed on the way: `receipt-sheet` test harness (no
  `classList` / `append`, new "Waiting for approval" title) and `output-tracing` (workspaces +
  receipt verify reach pdf-lib, llms no longer does). Mobile typecheck clean; tests: only the known
  date-format failures (`calendar`, `format`, `hostel-statement`, `public-queries`).
  Re-run after the device pass.
- ☐ J3 Final review pass by Fable: verify each ☑ against the code and the device, then improve.
  Code pass 2026-11-11 (no device attached): every ☑ in A, B, D1, E7, E8, G1, H1a/b/h, I matches
  the code. Web + mobile typecheck clean, 71 web finance / offer / guide test files pass, 4 new
  mobile rule tests pass, mobile lint 0 errors, Go build + vet + touched packages pass.
  Fixed on the way: Go 1.27.3 → 1.27.4 (GO-2026-6859 in `net/http` was failing CI, so the server
  had stopped deploying); collect sheet re-reads the ledger when a later month fails to save.
  Open for the owner:
  - **Score and part payments.** The first payment on a bill sets the points, so Rs 100 on day 2
    and the rest on day 28 earns 10. Safer: points from the day the bill is fully paid.
  - **Desk cash is certified** (D3) — a hostel can record cash that never moved and it counts in
    the Offer Program. Owner's call; noted so it is a known trade.
  - **Claim push to wardens** (C5): still admins only.
  - **Re-billed month keeps its code.** Void a month and bill it again → same `RUP-482K-BHA83`.
    Matching is fine (only open bills are read). An online checkout on the new bill would reuse
    the old bill's merchant reference `…-1`; fix when gateway testing starts.
  - ☑ `db:indexes` run on prod 2026-11-11: `Resident {hostelId, paymentCode}` created.
  - ☑ Go deployed 2026-11-11 (`e5535423`): six contract fixtures re-recorded for month codes;
    TS resident list got the `_id` tie-break Go already had.
  Device pass still to do: C1–C4, E1–E6, F1–F3, G2–G3, H1c–H1g, H2–H6.

## Order

A → B → (C, D, E need A and B) → F → G → H → I (docs last, they describe what shipped) → J.
