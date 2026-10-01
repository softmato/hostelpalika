# Existing residents — tracker

A hostel that joins HostelPalika already has people living in it. The normal
"Add resident" flow is for someone moving in **today**: it charges the admission
fee and deposit, bills the move-in month and sends a welcome bill. Run for a
resident who has lived there eight months, every one of those is wrong.

This feature brings those residents in with **what is true today**, not their
whole payment history. History stays in the hostel's own book.

Markers: ☐ not started · ◐ partly done (note says what is left) · ☑ done and checked.

## Words we use on screen

Plain English that eSewa, Khalti and Nepali banks already use. No US finance words
(no "ledger", "arrears", "opening balance", "cutover", "import", "batch").

| On screen | Means |
|---|---|
| Existing residents | People already living in the hostel before joining us |
| Add existing residents | The entry button |
| Download Excel file | The blank template |
| Upload filled file | Send the template back |
| Add one by one | Type rows in the app or web instead |
| Rent: Paid this month / 2 months due | Whether this month is paid, or how many months are not. Stored as the month rent is paid till |
| Old dues | Any other money the resident still owes from before |
| Deposit paid | Security deposit the hostel is holding |
| Check list | Show problems before saving |
| Add all 43 residents | Save everyone, bill what is due, tell each resident |

## Columns in the file

| Column | Needed | Notes |
|---|---|---|
| Full name | Yes | First and last name |
| Phone | Yes | |
| Room type | Yes | Must match one of the hostel's room types |
| Monthly rent (Rs) | No | Blank = the hostel's normal rate for that room |
| Deposit paid (Rs) | No | Blank = 0 |
| Months due | Yes | `0` = this month is paid. `1` = only this month is not paid. `2` = this month and last month. (A `Rent paid till` month column is still read.) |
| Old dues (Rs) | No | Blank = 0 |
| Joined date | No | Only for the profile; never billed |
| Email | No | Used to connect their app account if they have one |

## Rules

- **The warden answers "paid this month, or how many months due".** It is saved as
  the month rent is paid till, at the moment it is typed or uploaded — so a list
  filled on Aswin 30 and added on Kartik 2 still bills Kartik.
- **Months already paid are never billed.** Billing skips them for good.
- **Months due are billed** at the resident's rent when the list is added. At most
  12 months; older money goes in Old dues.
- **Old dues** become one bill named "Old dues (before HostelPalika)" with no month.
- **No admission fee, no deposit bill, no referral.**
- **Each resident added is told once**, by email and in the app if they have it:
  - paid: "Your rent is paid till Aswin 2083. Nothing to pay now. Your next bill is
    for Kartik 2083."
  - due: each month due and the old dues on its own line with its code, one total,
    "Please pay by Aswin 31, 2083".
  - every email says congratulations, that paying in the app or on the web gives a
    certified receipt and keeps them in the Resident Offer Program (gifts coming,
    given at random), and that bills, notices, meals and complaints are in the app.
  - no app account yet: a "Set up my account" activation link in the same email.
  - an account already has that email: its bell says "Confirm your hostel". It is
    **not** linked yet — see the next rule.
  - no email at all: the staff summary says "N with no email — tell them yourself".
- **An account is never linked on the hostel's word alone.** The email came from
  a spreadsheet, so the person confirms it. When a signed-in public account with a
  verified email (Google, or a code sent to it) matches a resident nobody is linked
  to, the web shows a dialog and the app a bottom sheet: "Education Light added you
  as a resident · Room type · Rent all clear till Aswin / Rs 26,500 due" with
  **Continue to my dashboard**, **This is not me**, **Not now**.
  - Continue: account becomes a resident, fresh session, lands on the dashboard.
  - This is not me: never asked again for that email; staff get "Check Ram Thapa's
    email". Changing the email on the record asks again.
  - Clicking "Set up my account" in the email counts as yes.
  - The desk intake (person standing there, card scanned) still links at once.
- **Staff get one summary** in the bell: "43 existing residents added · 12 bills
  made · 31 emailed".
- **Deposit paid** is saved on the resident as money the hostel is holding.
- **Monthly rent** that differs from the hostel rate is saved as that resident's
  own rent, with the reason "Rent agreed before joining HostelPalika".
- **One list per hostel.** The field team and the owner see and edit the same list,
  so the team can start it and the owner can finish it.
- **Nothing is saved as a resident until "Add all".** A half-filled list is never billed.
- Adding is safe to press twice or retry after a failure: each row remembers the
  resident it created and is skipped next time.

## Where it appears

- **Team registration (web):** after "Publish the hostel", the agent lands on the
  hostel's existing-residents page, downloads the file, fills it with the owner and
  uploads it. The desk has an "Add residents" link on every hostel row.
- **Hostel admin (web):** Residents page → "Add existing residents".
- **Hostel admin (app):** Residents tab → "Add existing residents".

## Items

1. ☑ **Data.** `ExistingResidentList` model (one open list per hostel: rows, lock, result).
   Resident gets `paidTill` (BS month key) and `existingListId`.
2. ☑ **Billing guard.** `planBillingCycle` skips a resident for any month on or before
   their `paidTill`, with skip reason `PAID_BEFORE_JOINING`. Test. The Payments matrix
   reads the same rule (`finance/paid-till.ts`) so a skipped month says why.
3. ☑ **File in and out.** Excel template (Residents sheet + "How to fill" sheet with
   the hostel's room types and month names). Reader for `.xlsx`, `.xls`, `.csv`
   that turns rows into list rows, reading months as `Bhadra 2083`, `2083-05`,
   `2083/5`. Tests.
4. ☑ **Check.** Per-row problems in plain words: missing name/phone, bad phone,
   unknown room type, bad month, month too far back, duplicate inside the list,
   phone/email already used in this hostel, lives in another hostel, not enough
   free beds for a room type, no rent known for a room. Tests.
5. ☑ **Add all.** Lock, create residents (ACTIVE, `paidTill`, rent override,
   deposit), take beds, connect app accounts by email with no email sent, bill
   unpaid months, raise Old dues bills, record result, audit. Tests.
6. ☑ **API.** Hostel side under `/api/v1/hostel-admin/residents/existing` and team
   side under `/api/v1/team/hostels/{id}/existing-residents` (agent must be the one
   who filed the hostel). GET list+check, PUT rows, POST file, GET template,
   POST add, DELETE list.
7. ☑ **Web screen.** One shared component used by the hostel admin screen
   `existing-residents` and the team page `/team/hostels/{id}/residents`.
8. ☑ **Team flow.** Publish redirects to the residents page; desk rows link to it.
9. ◐ **App screen.** `manage/existing-residents`: download, upload, add one by one
   in a bottom sheet, rows with problems tinted, "Add all". Entry from Residents tab.
   Built; typecheck, lint and helper tests clean. Left: the device pass.
10. ☑ **Docs.** `docs/API.md` routes.
11. ☑ **Tell residents.** `existing-resident-notify.ts` + email template
    `existing-resident-added.ts`: one email per resident (paid till / dues with codes /
    activation link), in-app + push when linked, staff summary. Activation code
    issuing split out as `issueActivationCode` so a field agent's add can make links.
    Tests.
13. ☑ **Confirm it is you.** `residency-invite.service.ts` + `/api/v1/account/residency-invite`
    (GET, `/{residentId}/accept`, `/{residentId}/decline`). "Add all" no longer links
    accounts. `Resident.accountLinkDeclinedAt/By`, cleared when the email is edited.
    Web `ResidencyInvitePrompt` in the root layout; app `ResidencyInviteHost` at the
    root, re-asked when the app comes to the front. Tests.
12. ◐ **Rent as "paid / months due".** Excel column "Months due"; web select and app
    sheet offer "Paid this month", "1–12 months due", "Paid ahead till …". Built and
    tested; left: the device pass, same as item 9.

## Join link — residents add themselves

The list and the scan desk both need staff to type or scan every person. The join
link turns it round: staff share one link (WhatsApp group, one person, a printed QR),
each resident opens it with their **ID card**, picks their room and says what rent is
paid, and staff only check and press **Add**.

| On screen | Means |
|---|---|
| Join link | The hostel's one link + QR |
| Allow up to | How many requests the link takes (default: free beds + 6) |
| Pause link / Turn link on | Stop or start new requests |
| New link | New address; every copy of the old one stops working |
| Join requests · 3 waiting | Requests for staff to check |
| Add as existing resident | Adds them — asks "are you sure" first |
| Send back | Returns it with what to fix; they fix it on the same link |
| Paid part of Aswin rent already? | Part paid — comes off the oldest month due as its own bill line |

Rules:

- **Name, phone and photo are the ID card's**, read when the request is sent. The
  person types only room type, rent paid / months due, part paid, deposit paid,
  moved-in day and a note. A private card must be shared first; no card, make one.
- **One request per person per hostel.** A new request uses one place on the link
  (atomically, so the last place cannot be taken twice). An edit while waiting, or a
  fix after "Send back", is the same request and never uses another place.
- **Staff are told** (bell + push) when a request arrives and when a sent-back one
  is fixed — never for an edit to one they have not opened.
- **The person is told** when it is sent back (bell + push + email, linking to the
  same form) and when they are added (the existing "added" email with what is due,
  plus a "Welcome to {hostel}" bell that moves the app into the resident home).
- **Add is the scan desk's path** (`addScannedExistingResident`): same bills, same
  part-paid line, same check (a full room type stops Add until Rooms is changed),
  and the card's account is linked at once.
- Someone living in another hostel cannot send; someone already added sees "You are
  a resident here".

## Join link items

14. ☑ **Part paid at the scan desk.** `partPaid` on the list row, checked (must be
    below the first month due, and only when one is due), billed as a negative
    `CREDIT` line "Already paid at the hostel (before HostelPalika)" on the oldest
    month's bill. Scan desk shows Paid + 1–6 months due as chips and the full list
    (12 months, paid ahead) as a select. Not in the Excel file or the web sheet.
15. ☑ **Data.** `ResidentJoinLink` (one per hostel: token, enabled, cap, used) and
    `ResidentApplication` (one per person per hostel: PENDING / REJECTED / ADDED).
    Both on the hostel purge list. Indexes built on prod with `db:indexes`
    2026-10-01 (only these two collections were missing any).
16. ☑ **API.** Staff `join-link` (GET/PATCH), `join-requests` (GET), `join-requests/{id}`
    (POST add / reject); public `/api/v1/public/join/{token}` (GET/POST). Tests.
17. ☑ **Web.** Public page `/join/{token}` (sign in → ID card → room and rent → status
    / fix); Residents page "Join link" dialog (QR, WhatsApp, copy, download, cap,
    pause, new link) and "Join requests" panel (card photo, bill preview, Add with
    confirm, Send back with reason).
18. ◐ **App.** `manage/join-link`, `manage/join-requests`, the waiting banner and
    "Join link" row on the Residents tab, resident-side `join/[token]`, login returns
    to a join link, "sent back" bell opens the form. Typecheck, lint, tests clean.
    `/join/` app link added 2026-10-01: Android `intentFilters` in `app.json` (moves the
    fingerprint — takes effect from the next native build; OTAs after this commit
    reach only that build) and `/join/*` in the iOS association file. Until that
    build is installed, WhatsApp links open the web page, which has an "Open in the
    app" link. Left: the device pass.

## Later (not in this pass — needs a yes)

- Resident sees "Rent paid till / Old dues / Deposit paid" on first sign-in and can
  press **Correct** or **Not correct**; "Not correct" pauses reminders on the Old
  dues bill until the hostel answers.
- "Your new bill is ready" when the monthly billing run makes a bill. Today the
  billing run tells nobody; the first message a resident gets about a month's bill
  is the reminder a week before it is due. This would change every hostel.

## Session log

| Date | Item | Note |
|---|---|---|
| 2026-10-01 | 14–18 | Join link and part paid. Web 3151 tests, mobile lib 1444, typecheck and lint clean on both. Not run live or on a device. Also put `/api/v1/hostel-admin/kyc/**` on the pdf-lib tracing list (the guard test was failing on main). |
| 2026-09-14 | 3 | Excel that is not activated opens the template read-only. Web: "Fill in sheet" opens a full-screen Excel-style grid (`existing-residents-sheet.tsx`, logic in `existing-residents-sheet-model.ts`) — arrow keys/Enter move, rows paste from any sheet, joined date typed as a Nepali date, saves straight to the list. The page list is now read-only: problems on one line under the row, click a line to fix it in the sheet. Cell readers moved to `existing-residents-cells.ts` so the browser uses the same reading as the file. Tests. |
| 2026-09-14 | 13 | Confirm step on web and app; congratulations email with certified receipts and the Resident Offer Program. Web 1591 + 70 route tests, app 35, typecheck and lint clean. Not run live. |
| 2026-09-14 | 11–12 | Residents are told on add; rent asked as paid / months due. Web 1547 tests, app 7 helper tests, typecheck and lint clean on both. |
| 2026-09-14 | 1–10 | Built in one pass. Web: 1540 tests pass across residents/finance/team, typecheck and lint clean. Mobile: typecheck, lint, 32 tests clean. Not yet run against a live database or on a device. `ui_inspiration_folder/` is not in the repo, so the app screen follows `docs/DESIGN.md` and existing `manage/` screens. |
