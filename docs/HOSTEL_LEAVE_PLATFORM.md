# Leave the platform (hostel off-boarding)

Tracker for the 2026-10-21 request. Work one item at a time: code → verify →
flip `☐` to `☑` (`◐` + a note for partial).

## What the owner asked for

- A hostel that wants to leave fills a **Leave HostelPalika** form. Before it can
  be sent we check its plan bills are cleared; it cannot be sent while anything
  is owed.
- On submit, our team gets it by **email** and in the **portal** (bell + a queue
  in the superadmin portal).
- The owner chooses how long we **hold their data** after deletion: between a
  minimum (default 7 days) and a maximum (default 15 days). Both bounds are set
  by the superadmin.
- Superadmin **approves the deletion**. Before approving they tick which data is
  emailed to the owner — everything from the hostel's first day to today.
- Deleting **only strips the hostel portal from the owner's account**. Within
  the hold window the owner can sign in and **claim the hostel back**; after it,
  the existing purge cron erases it.

## Decisions (defaults taken — change any of them by saying so)

1. **The hold starts at approval**, not at submission: `purgeScheduledAt =
   approvedAt + holdDays`. It rides the existing archive (`isDeleted`) and
   `hostel-purge` cron, so the hold is the archive's grace period, shortened.
2. **Only the owner** can send or cancel the request (wardens cannot). The owner
   can cancel while it is still waiting for review.
3. **"Bills cleared"** = nothing owed for time already used (`owedOnPlan`): an
   unpaid setup fee always counts; plan bills count only once the plan has lapsed
   (`PAST_DUE`, or its paid period over). While the plan is paid ahead, an open
   bill — an early renewal, an upgrade, a lifetime checkout — is an offer, not a
   debt, and does not block (fixed 2026-10-21 after Education Light was blocked
   by an untaken Rs 24,999 lifetime checkout). A plan claim in review on an owed
   bill, and any supply-store order not delivered and paid, also block.
   Re-checked at approval.
4. **A main hostel leaves with its branches.** A branch can leave on its own;
   its bills are its main hostel's.
5. **Claiming back is self-service** for the owner while the hold runs: the
   hostel comes back exactly as it was (archive's restore), the owner's portal
   role returns. After the hold it cannot be claimed.
6. **The data goes as two attached files** (rebuilt 2026-10-21 for reuse): an
   Excel workbook — an About sheet (hostel, period covered, what each sheet
   holds, how they link), then one sheet per ticked section with a header filter
   — and the same rows as JSON (snake_case keys) for other software. Dates are
   `YYYY-MM-DD` in Nepal's day with a `(BS)` twin beside each main date, months
   are BS periods, money is whole rupees, statuses are words, and Resident / Bill
   / Payment IDs join the sheets. Sections now include receipts, the food menu
   and a files list. If the email fails, approval stops — nothing is deleted
   until the data has left.
7. Residents, staff and cooks are signed out the moment it is approved. **The
   owner is not** (changed 2026-10-21): their role drops to PUBLIC and the next
   token refresh carries it, so they stay signed in on the public site with the
   Claim hostel button. A claim-back restores everyone.

## A. Server

- ☑ **A1 Model + settings.** `HostelLeaveRequest` (one open request per hostel);
  operations `leaveHoldMinDays` (7) / `leaveHoldMaxDays` (15), min ≤ max;
  `HostelLeaveRequest` in the purge's retained list (it is the record the owner
  asked and who approved).
- ☑ **A2 Eligibility.** `GET /api/v1/hostel-admin/leave` → blockers, hold bounds,
  branches that go with it, the open request. Open while suspended / after the
  trial.
- ☑ **A3 Submit / cancel.** `POST` (reason, hold days, confirm) re-checks bills;
  platform email + bell to superadmins, confirmation email to the owner.
  `DELETE` cancels a pending one.
- ☑ **A4 Data export.** Per-section CSV builder from the hostel's first day to
  today (residents, rooms, bills, payments, deposits, khata, expenses, stock,
  complaints, repairs, attendance, notices).
- ☑ **A5 Review.** `GET /api/v1/platform/hostel-leaves` (queue) + `/[id]`;
  `POST /[id]/approve` {sections} → bills re-checked → export emailed → archive
  with the chosen hold (branches too) → owner's portal role dropped → request
  APPROVED + email; `POST /[id]/reject` {note} → owner emailed.
- ☑ **A6 Claim back.** `GET /api/v1/account/hostel-leave` lists the caller's held
  hostels; `POST` {requestId} restores them (branches too) and gives the portal
  role back. Refused once the hold has run out.
- ☑ **A7 Original files** (agreement point 9, 2026-10-21). While the hold runs,
  the signed-in owner gets every uploaded file of the hostel and its branches,
  their choice of how: **all at once** as a streamed ZIP
  (`/account/hostel-leave/{id}/files/zip?part=N`, folders by kind, parts of
  ≤ 200 MB, a `missing-files.txt` for any object R2 cannot read) or **one by
  one** (`/files/{fileId}` → 15-minute presigned link; `?link=1` returns it as
  JSON for the app). No lasting URL to a private file ever exists. Store-only ZIP
  writer in `lib/zip-stream.ts` (checked with Python's `zipfile`). Web: the
  claim-back page's "Your files"; app: "All files" / "Choose files" on the held
  card. The approval email says where to get them.
- ☑ **A8 Files for 30 days after leaving** (point 9). Approval records
  `filesUntil` = leaving + 30 days, or the hold if longer (`LEAVE_FILES_DAYS`,
  a fact of the agreement, not a setting) and the owner (`ownerId`). If the hold
  ends first, the purge still erases the hostel but **keeps the originals** in
  storage and lists them on the request (`keptFiles`; thumbnails are not kept);
  downloads then serve from that list. The `hostel-purge` cron's
  `runLeaveFilesSweep` deletes them at `filesUntil` and empties the list. After
  the hold the owner sees a files-only card ("can no longer be claimed back ·
  files until …"); the header's Claim hostel button counts claimable ones only.
  The approval email gives the files date.
- ☑ **A9 Records with the files, grouped, capped** (2026-10-21). The approval's
  workbook + JSON are kept privately (`exportFiles`, our own
  `hostel-leave/{requestId}/` keys; built on first look for requests approved
  before this) and come first — a **Records** folder in the ZIP, the top group of
  the one-by-one list. Files are grouped by `leaveFileGroup` (Records, Documents,
  Photos and files, Payment proofs, Expense receipts…), the same names in the
  ZIP, web and app. Bandwidth: each ZIP part 3 downloads per 24 hours, 200
  single-file links per Nepal day (counted on the request; the page shows what
  is left). The ZIP fetches 6 files ahead while one streams. Skeletons while the
  hostels and files load. The sweep deletes `exportFiles` with `keptFiles`.
- ☑ **A10 Records up front.** The kept records are three files — the Excel
  workbook, a **CSV pack** (one CSV per section, in a ZIP) and the JSON — shown
  as their own **Your records** block above the uploaded files (web and app),
  each a direct download; the pick-one-by-one list holds only uploads. Records
  approved before the CSV pack are rebuilt on first look while the hostel exists,
  and the superseded copies are deleted from storage.
  Each section's CSV is also kept on its own ("Or one CSV at a time":
  Residents, Rooms and beds, Rent bills, Payments, Receipts… in workbook order),
  so an owner can take just the residents or just the payments. The big ZIP's
  Records folder holds the workbook, JSON and section CSVs, never the CSV pack
  as well.

## B. Web

- ☑ **B1** Hostel portal: Settings → Leave HostelPalika screen (`leave`): bill
  check, form, pending state with cancel.
- ☑ **B2** Superadmin: Hostel leaves queue + review (section checkboxes, approve
  / reject), in portal-nav; Operations gets the two hold bounds.
- ☑ **B3** Claim-back card for a signed-in owner with a held hostel.
- ☑ **B4** The deleted portal's own address shows its owner "Your portal has been
  deleted" with a live countdown ring (drains over the hold, red in the last day),
  Claim hostel back and Go home — not a 404 (anyone else still gets the 404). The
  public header shows a **Claim hostel** button beside the account menu while the
  account has a held hostel; it opens the same countdown + claim in a modal.
  Shared in `app/_components/held-hostel-claim.tsx`, which `/hostel-leave` uses too.
- ☑ **B5** "Your data stays yours" (`hostelLeavePromise` in
  `packages/shared/src/constants/hostel-leave.ts`, hold days from the public site
  config's `leaveHold`): on the public Plans & Pricing page (plus a FAQ answer),
  portal Plan billing (with "How to leave"), and the KYC page + its "once
  approved you get" list. Same card in the app: Pricing, manage/billing,
  manage/kyc.
- ☑ **B6** PIN gate fixed: the web `lockPin` claim is only minted for portal
  roles, so a public account (an owner who left) is never sent to `/unlock`.
  The app's own per-phone lock is unchanged.

## C. App

- ◐ **C1** `manage/leave` screen from admin Settings (owner-only row); push link `/hostel-admin/leave` → it.
- ◐ **C2** Claim-back card on the Profile tab (`HeldHostelCard`), adopts the role after.

_C1–C2: typechecked + linted; ◐ until the device pass (adb screenshots). OTA-able: no native change._

## D. Close-out

- ◐ **D1** Tests (`hostel-leave.test.ts`): blockers, hold bounds, form schemas,
  file names. Approve/claim guards are atomic DB updates, not yet covered by a
  test — they need a live database.
- ☑ **D2** API.md / DATABASE.md; `db:indexes` run on prod 2026-10-21 (4 indexes:
  HostelLeaveRequest ×3, HostelAgreementSignature ×1).
