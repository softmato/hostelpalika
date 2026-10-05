# Expenses (Money Out) — plan

**Created 2026-10-01.** The hostel side of the product records every rupee that
comes in (invoices, claims, cash, statement import) and nothing that goes out.
`FINANCE_CURRENT_STATE.md` lists `Expense` as missing; `lib/hostel-statement.ts`
says "a hostel does not *spend* through this product". This plan changes that.

This file is the tracker. Work at the first unticked box; a `[x]` means *seen
working*, not *file created*. **[server]** is `apps/web`, **[app]** is
`apps/mobile` (native + PWA), **[web]** is the Next.js hostel-admin page,
**[device]** needs a real handset.

---

## 1. Decisions already made

| Question | Decision |
|---|---|
| Main way in | **Manual add.** Not the bank/eSewa statement: an owner's statement carries personal debits too, so reading it as hostel spending would be wrong by default. |
| Who can add | Hostel admin/owner always. Warden only with the new `recordExpenses` permission. Cook only when the owner turns it on for the hostel. |
| Warden default | `recordExpenses` is **on** in the create-warden form, marked *Recommended — turn on if this warden buys things for the hostel*. Existing wardens do **not** get it; the owner turns it on in the warden's edit form. |
| What staff see | Wardens and the cook **add only**. They see their own entries and their own cash box. They never see hostel totals, In/Out/Left, or anyone else's entries. |
| Cook | Off by default. A hostel setting the owner switches on from the cook screen. |
| Petty cash | **Yes**: a cash box per staff member. |
| Cash | Cash is the default *Paid by*, because most hostel spending is cash and appears on no statement. |
| Dates | Today's **Nepali (BS) date** is filled in automatically; the user can change it. Every date in this feature is shown in BS. |
| Language | English now. Every label goes through one strings file so Nepali can be added later without touching screens. |
| Surfaces | Native app (Android/iOS), the PWA (same Expo screens through `apps/mobile/web`), and a hostel-admin page on the Next.js web app. |

---

## 2. Words (A1 English)

Use: **Money In · Money Out · Left · Spent on · Paid by · Cash left · Give cash · Return cash**.
Never: debit, credit, expense ledger, net profit, reconcile, reimbursement.

"Add expense" is acceptable on the main button: the word is widely known, and it
pairs with an icon.

---

## 3. Screens

Before writing any screen, read the design references listed in `CLAUDE.md`.
`ui_inspiration_folder/` is git-ignored, so a cloud checkout does not have it;
it has to be available before screen work starts.

### 3.1 Expenses home (owner)

- Accent header block with rounded bottom corners. A card straddles its bottom
  edge: **this month (BS)** — `Money In · Money Out · Left`.
- Big **+ Add expense** button (the primary action, reachable with a thumb).
- **Cash boxes** row: one small tile per staff member — avatar, name, `Cash left Rs 2,300`.
  Tap → that person's cash box.
- **Spent on** — category bars using `Meter`, biggest first, with "Rs X more
  than last month" on the top one.
- List of expenses, **grouped by date with the heading outside the card**,
  each row: category icon tile · what · who added it · amount. Row tap → detail
  sheet (photo, all fields, *Not right* action).
- Loading is skeletons.

### 3.2 Expenses home (warden / cook)

Same shell, no totals card. Shows **My cash left** in the header card instead,
then **+ Add expense**, then their own list.

### 3.3 Add expense

One screen, top to bottom, nothing hidden behind steps:

1. **Amount**: big number field, numeric keypad opens by itself.
2. **Spent on**: icon-tile grid (`ActionGrid` / `Grid`):
   Groceries · Vegetables & meat · Gas (LPG) · Electricity · Water · Internet ·
   Salary · Building rent · Repair · Cleaning · Other.
   **Salary** opens a person picker (wardens, cook roster, plus *Someone else*).
3. **What**: one short text line ("Rice 25 kg"). Optional when a category is
   picked.
4. **Date**: today in BS, shown as text with a *Change* link that opens the BS
   picker.
5. **Paid by**: `Segmented` — **Cash** (default) · eSewa · Khalti · Bank.
   For a warden/cook, **Cash** means *from my cash box*.
6. **Photo**: optional, camera or gallery. The existing receipt reader
   (`evidence-receipt.ts`) fills in amount and date from it when it can, and
   never overwrites a field the user already typed.
7. **Save**. Success state, then back to the list with the new row on top.

Owners can add their own categories; they appear after the built-in tiles.

### 3.4 Cash box (per staff member)

- Header card: `Cash left Rs 2,300`.
- Owner actions: **Give cash** · **Take back cash**.
- History, grouped by date: cash given (+), spent (−, links to the expense),
  returned (−).
- A cash box may go below zero (the warden paid from their own pocket). It
  then reads **Hostel owes Hari Rs 400**, which is the reimbursement case
  without needing the word.

### 3.5 Web page (Next.js)

`/hostel-admin/expenses`: the owner's view of 3.1 + 3.4 at desktop width
(totals and cash boxes on the left, list on the right) plus an **Export month**
button (CSV/PDF) for an accountant. The add form is the same fields as 3.3.

---

## 4. Data

### `Expense`

```
hostelId, amount (whole NPR, integer > 0), spentAt (Date, BS shown in UI),
category (built-in key or HostelExpenseCategory id), what (string),
salaryFor (userId | name, only for Salary), paidBy (CASH|ESEWA|KHALTI|BANK),
cashBoxId (when paid from a staff cash box), photoAssetId,
recordedBy (userId), recordedByRole (OWNER|ADMIN|WARDEN|COOK),
source (MANUAL|PAYMENT_NUDGE|MAINTENANCE|DEPOSIT_REFUND),
status (RECORDED|VOID), voidReason, voidedBy, voidedAt
```

- Kept **apart from `PaymentEvent`**. That collection is the residents' invoice
  ledger and its conservation rule (`balance == settled credit − settled debit`)
  must not see hostel spending.
- **No delete.** Mistakes are voided with a reason (same principle as payment
  reversals, target §9.3). A void on a cash-box expense returns the money to the
  box.
- Every create/void writes an `AuditLog` row.

### `CashBox` and `CashMovement`

One `CashBox` per staff member per hostel. `CashMovement` is append-only:
`GIVE (+) | SPEND (−) | RETURN (−) | VOID_REFUND (+)`. **Cash left** is the sum,
never a stored number that can drift.

### `HostelExpenseCategory`

Owner-added categories (name + icon). Built-in categories live in
`packages/shared` so app and web read one list.

### Permissions

- New warden key `recordExpenses` in `WARDEN_PERMISSION_KEYS`, added to
  `DEFAULT_WARDEN_PERMISSIONS` so new wardens get it pre-ticked. No migration:
  existing rows simply do not have it.
- `HostelSettings.cookCanRecordExpenses` (default `false`). Cook entries are
  attributed to the cook account and say so (the cook login can be a shared
  phone, `cook_app_portal.md` §0).
- Reads of totals, other people's entries and cash boxes are **owner/admin
  only**, enforced on the server, not by hiding a button.

---

## 5. Payment nudge ("you just paid, is this a hostel expense?")

### What is possible

| Platform | Possible? | Why |
|---|---|---|
| iPhone | **No** | iOS gives no app access to other apps' notifications or to SMS. |
| PWA / web | **No** | A browser cannot see other apps or SMS. |
| Android, read SMS | **Avoid** | `READ_SMS` is a restricted Play permission. "SMS-based money management" is an allowed use, but only when it is the app's *core* function and declared in Play Console. Hostel management is our core function, so a rejection is likely and would block app updates. |
| Android, notification access | **Yes** | The owner turns on *Notification access* for HostelPalika in Android settings. The app then sees notifications from eSewa, Khalti, bank apps **and the SMS app** (bank debit SMS arrive as notifications), so no SMS permission is needed. |

### How it works (Android)

1. A new native module `modules/hostelhub-pay-watch`, beside the existing
   `hostelhub-night-prompt` (which already posts notifications with action
   buttons from Kotlin). It contains a `NotificationListenerService` and an Expo
   config plugin that declares it in the manifest.
2. The service **ignores every notification except an allowlist of payment
   apps** (eSewa, Khalti, the hostel's bank apps, the default SMS app filtered to
   bank sender IDs).
3. On-device parsing reads *amount*, *paid to* and *was this money going out*.
   Money coming in is ignored. A notification it cannot read is ignored;
   a missed nudge costs nothing, a wrong one costs trust.
4. It posts our own notification:
   **"Rs 2,400 paid to Ram Kirana. Hostel expense?"** with **[Add]** and
   **[Not hostel]**.
   *Add* opens Add expense with amount, payee, date and *Paid by* filled in.
5. **Nothing leaves the phone** unless the user taps *Add* and saves.
   Notification text is never uploaded or logged.
6. Learning: after a *Not hostel*, the next nudge for the same payee offers
   **Always ignore Sita**; after two *Add*s for the same payee it offers
   **Always ask for Ram Kirana**.

### Rules from outside our control

- **Google Play:** an in-app disclosure screen (what we read, why, that it stays
  on the phone) must come *before* sending the user to the settings switch. The
  Data safety form must declare it. The spyware policy forbids taking
  notification content off the device without that disclosure. We do neither.
- **Android 15+** hides OTP notifications from apps like ours. We do not need
  them.
- **Xiaomi/Redmi** battery settings can stop the listener. The setup screen
  must walk the user through *Autostart* and *No restrictions*, same as any
  background feature on those phones.
- **Android 13+ "restricted settings"** blocks this switch for apps installed
  outside a store. Play installs are fine; a sideloaded test APK needs the
  manual *Allow restricted settings* step.
- It only works on the phone that made the payment, and only if that phone has
  HostelPalika signed in as someone allowed to add expenses.
- **Parsers need real notifications.** Each payment app's wording has to come
  from real notifications collected on real phones, not invented samples. The
  statement parsers learned this the hard way (`FINANCE_IMPLEMENTATION_PLAN.md`,
  eSewa `@1`).

### For iPhone, PWA and web

- **Share to HostelPalika:** on eSewa/Khalti's success screen, *Share* → HostelPalika
  → Add expense, prefilled by the receipt reader. Android share intent and an
  iOS share extension (native target).
- **Evening reminder:** a push at a time the person chooses: *"Spent money
  today? Add it now."*, sent only on days with no expense recorded.

---

## 6. Order of work

Each step is usable on its own. A step starts only when the one before it works.

### Step 1: record and see [server] [app] [web]
- [x] `Expense` and `HostelExpenseCategory` models; built-in categories and input parsing in `packages/shared/src/expenses/` (2026-10-01, `expense.test.ts`). `CashBox`/`CashMovement` move to step 2 with the screens that use them.
- [x] `recordExpenses` warden key, pre-ticked for new wardens only; `HostelSettings.cookCanRecordExpenses` + owner-only `PUT /hostel-admin/expenses/cook` (2026-10-01)
- [x] API: `GET/POST /hostel-admin/expenses`, `POST …/[id]/void`, `POST/PATCH …/categories`, cook mirror at `/cook/expenses` (2026-10-01, 23 tests)
- [x] Money In = settled credits − settled debits by the Nepal day they settled, binned to the BS month (2026-10-01, tested across the 18:15 UTC day edge)
- [ ] **[device]** Add expense screen (3.3), owner home (3.1), staff home (3.2) — built in `apps/mobile/src/app/expenses/`, typecheck/lint/tests clean, not yet seen on a handset
- [ ] **[device]** Entry points — owner Home shortcut row + Manage grid + More row; cook Today row + More section (only when switched on); owner switch on Cooks — built, not yet seen
- [ ] **[device]** Warden create form: *Add expenses* row with *Recommended*, on by default; edit sheet badge — built, not yet seen
- [ ] **[browser]** Web page (3.5) at `/{slug}/admin/expenses`, nav under Finance — built, not yet seen in a browser
- Not built in step 1: owner push when staff add something; monthly export (step 3)

### Step 2: cash boxes [server] [app] [web]
Built 2026-10-05 — typecheck, lint and tests clean (server 79, app 1509); not yet seen on a handset or in a browser.
- [x] **[server]** *Give cash* is the owner-only `STAFF_CASH` category ("Cash to warden"), picked to a warden of *this* branch who holds `recordExpenses`; the warden answers **Got it / Not received** (`POST …/expenses/[id]/cash`). Only `ACCEPTED` fills the box. (`expense.test.ts`)
- [x] **[server]** Cash box = confirmed handovers − every expense the warden added, derived per hostel (so per branch), never stored; below zero is *Hostel owes*. `GET …/expenses/wallet`. Handovers are **not** spending: left out of Money Out, the category bars and the statement balance — printed as transfer lines instead, with a per-warden *Staff cash* table on the statement PDF. (`statement-pdf.test.ts`, `hostel-statement.test.ts`)
- [x] **[server]** Bill photo required for warden and cook expenses; the owner waives it per warden (`expenseWithoutProof`, shown inverted as *Bill photo needed*, on by default for new and existing wardens).
- [x] **[server]** Performance report PDF (owner copy) gains Money out pages: by category, each warden's box, every line.
- [ ] **[device]** App: owner's *Staff cash* tile row + cash box screen (`expenses/wallet.tsx`); warden's *Cash left* header, *Cash for you* cards, Home *My cash* row; warden form switch
- [ ] **[browser]** Web: *Staff cash* card, warden's *Cash for you* list, *Cash to warden* tile, warden form checkbox
- Not built: *Take back cash* (the owner can cancel a handover with a reason); rent cash a warden collects going into their box (§7.2).

### Step 3: photo fill + reports [server] [app] [web]
- [ ] Receipt reader prefills amount/date from the photo
- [ ] Export month (CSV/PDF)
- [ ] Repair close → *Cost* → expense (`MaintenanceRequest`); deposit refunds listed under Money Out

### Step 4: payment nudge (Android) [app] [device]
- [ ] Collect real notification samples from eSewa, Khalti and the banks our owners use
- [ ] `hostelhub-pay-watch` module + config plugin + disclosure/setup screen (incl. Redmi autostart)
- [ ] Per-app parsers with tests against the real samples
- [ ] Nudge notification with Add / Not hostel, prefilled Add expense, ignore/always rules
- [ ] Play Console: Data safety + review notes

### Step 5: share-to-app and evening reminder [app] [device]
- [ ] Android share intent → Add expense
- [ ] iOS share extension
- [ ] Evening reminder push

---

## 7. Decided after the first draft

1. **Staff entries count straight away.** The owner gets a *New from staff* list
   and can mark one *Not right* (void with reason), which also returns cash to
   the box. A warden or the cook may also cancel **their own** row (a typo), with
   a reason the owner sees; never anyone else's.
2. **Rent cash a warden collects goes into the warden's cash box.** Flow:
   Payments → tap the resident → **Got cash**. The amount still owed is already
   filled in, so it is one tap to Save. That records the resident's payment
   (existing `recordCash` path) **and** adds the same amount to the warden's box.
   The owner then sees it under the warden's *Cash left*, and **Hand over cash**
   moves it to the owner.
3. **Online payments are added by sharing the receipt.** From the eSewa /
   Khalti / bank success screen: *Share* → HostelPalika → Add expense, filled in
   by the existing receipt reader (amount, date, paid to, transaction ID, app).
   - Android app: share intent. iPhone app: share extension (native target).
     Android PWA: Web Share Target in the manifest (Chrome, installed PWA).
     iPhone PWA and desktop web cannot receive shares, so they pick or drop
     the screenshot on the Add expense photo field, which runs the same reader.
   - The reader must see **money going out** (`evidence-direction.ts`). A
     receipt for money coming in is refused, as it is for resident claims.
   - The transaction ID blocks the same receipt being added twice.
   - **Who shared it decides how it is recorded.** Owner/admin: a hostel
     expense paid online. Warden/cook: their expense paid from their own wallet,
     so their balance shows **Hostel owes Hari Rs X** until the owner pays it back.
   - The category is suggested from the payee (Ram Kirana → Groceries, learned
     from earlier entries). The user checks it and taps Save. Nothing is saved
     without that tap.
