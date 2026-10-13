# Quick sign-up, compulsory KYC, free trial

Tracker for the 2026-10-11 change to how a hostel joins. Work one item at a
time: code → verify → flip `☐` to `☑` (`◐` + a note for partial).

## What the owner asked for

- Any signed-in user opens **Register your hostel** from the top of the Profile
  tab and fills **one screen**: owner name, phone, hostel name. That opens the
  hostel portal on their account straight away, so they can explore.
- Everything else the old form asked for moves into **KYC**. KYC is compulsory:
  until our team approves it, the portal runs with the advanced features
  **frozen** (ice overlay + lock; tapping says "Please complete KYC").
- KYC screen: a ring at the top fills per finished section; tapping it lists
  done / to-do. Finished sections never auto-open — the screen opens on the
  first unfinished one. **Submit** asks first: "Our team will verify this within
  24 hours — please make sure everything is correct." While in review the owner
  can still edit. Approval → email + push "KYC verified — explore the full app".
- **Verified** on the public page means KYC approved by our team.
- Every new hostel gets a **trial** (15 days, superadmin-configurable), then pays
  monthly or the lifetime deal. Plans no longer carry free months.
- Portal opened → congratulations on screen once ("You got N days — enjoy and
  explore") + push. A push asks them to complete KYC.

## Decisions (owner, 2026-10-11)

1. **Listing hidden until KYC is approved.** It goes live already Verified.
2. **Basics stay open, the rest is frozen** until approval. Open: Home, Rooms &
   floors, Food, Notices, Complaints, Repairs, Settings, KYC, Billing,
   Community. Frozen: adding residents, Finance & statements, payments/claims,
   Expenses, Stock, Reports, Bookings, Attendance, Night status, Wardens, Cooks,
   Push notices, Join link & scan desk, Branches, Invite hostels. The server
   refuses the frozen writes too (423 `KYC_REQUIRED`).
3. **Every new hostel gets the trial** — app, website and field-team filings.
   Free months are removed for new plan choices.
4. **The website's /register-hostel becomes the same quick form.**

**Existing hostels are untouched.** The lock keys on `Hostel.kyc.required`,
which only the quick sign-up sets. Free months already snapshotted on a
subscription (`HostelSubscription.freeMonths`) — live or still waiting on
approval — are honoured exactly as before.

## A. Server

- ☑ **A1 Schema + setting.** `Hostel.kyc` {required, status
  DRAFT|SUBMITTED|APPROVED|REJECTED, submittedAt, reviewedAt, reviewedBy, note};
  `location.area` optional (a quick hostel fills it in KYC); suspension reason
  `TRIAL_ENDED`; `HostelSubscription.trialDays` / `trialEndsAt`; operations
  `trialDays` (default 15) in Platform → Operations.
- ☑ **A2 Free months off for new choices.** `freeMonths` is gone from the plan
  catalogue (schema strips the stored values); `pricePlan` snapshots 0; editor,
  web + app price cards and the team form now say trial.
- ☑ **A3 The trial.** A plan chosen without a free-months snapshot starts the
  trial instead (`startFreeMonths` → `trialWindow`; team filings, old-flow
  approvals); emails say "N days". A `TRIAL_ENDED` suspension warns for the last
  3 days and blocks at the end; stage is null before `startedAt`; copy per
  reason on web + app. A quick sign-up's paid-plan block (`TRIAL_ENDED`) is
  written at KYC *approval* (A7); before approval, a trial that has ended
  closes the portal down to the KYC itself (E2), so the owner can always
  finish the KYC that lets them pay.
- ☑ **A4 Quick registration.** `POST /api/v1/public/hostels/quick-register`
  (signed-in PUBLIC account with a verified email; role raised in place, no
  password rotation — `hostel-quick-registration.service.ts`): DRAFT hostel with `kyc.required`, trial,
  HOSTEL_ADMIN on the account (cook login + owner ID card wait for approval),
  one unapproved hostel per account, optional referral code; congratulations
  email + bell/push, then a "complete your KYC" push.
- ☐ **A5 Server lock.** Writes under the frozen API prefixes refused with 423
  `KYC_REQUIRED` for a hostel whose KYC is required and not approved.
  `/auth/me` carries `hostelKyc` {status, locked, note, trialEndsAt, trialDays}.
- ☑ **A6 Submit.** `POST /api/v1/hostel-admin/kyc/submit`: required sections
  done → SUBMITTED, hostel PENDING_APPROVAL (the platform queue), application
  PENDING. Editing stays open while SUBMITTED. New `details` (hostel type, area,
  city, address) and `rates` (an open rate card) sections. Required to submit:
  details, photos, rates, documents, location (`KYC_REQUIRED_STEPS`); the
  payload carries `review` {status, note, missing, canSubmit}.
- ☑ **A7 Review.** Platform Approve on a KYC hostel → APPROVED, VERIFIED,
  PUBLISHED, documents approved, pin placed, cook login + owner ID card, email
  + push. Reject / Request documents → sent back (REJECTED + note, hostel DRAFT)
  with email + push. Approval also settles referral time and schedules the
  trial-end block (`trialEndSuspension`). Branches into the existing
  `approvePlatformHostel` / `rejectPlatformHostel` / `requestPlatformHostelDocuments`.
- ☑ **A8 Trial reminders.** Email (website billing link) + push 3 days before
  the end and on the last day, once each (`trial-reminders.service.ts`, on the
  `payment-reminders` cron). Plan-less trials with KYC approved only; a trial
  with a plan is the renewal sweep's.

## B. App

- ◐ **B1** Profile tab: Register your hostel as the top tile.
- ◐ **B2** `register-hostel`: the 3-field form (+ optional referral code); on
  success the session refreshes into the admin portal. The 5-step form retires.
- ◐ **B3** Congratulations sheet on the first admin open, once per hostel per
  device, naming the trial days.
- ◐ **B4** Frozen lock: overlay on frozen rows and tiles (More, Home, Payments
  tab, Add resident); tap → "Please complete KYC" with Open KYC; a 423
  `KYC_REQUIRED` anywhere opens the same prompt.
- ◐ **B5** KYC screen: ring at the top, tap → done / to-do list; opens on the
  first unfinished section; Next goes to the next unfinished one; Submit with
  the 24-hour confirm; status line (In review — you can still edit / Sent back:
  note / Verified).
- ◐ **B6** Billing shows the trial and days left (no pay link — Play policy).

_B1–B6: built and typechecked; ◐ until the device pass (adb screenshots)._

## C. Web

- ☑ **C1** `/register-hostel` → the same quick form (sign-in first), then the portal.
- ☑ **C2** Portal: frozen nav items + page gate, KYC submit + status on the KYC page.
- ☑ **C3** Platform review page shows a quick-sign-up KYC notice; Approve/Reject/Request
  documents reuse the existing buttons (A7 branches them).

_C1–C3: typechecked + linted; the browser check is yours (no Browser-pane driving)._

## D. Close-out

- ☑ **D1** Tests: free-months snapshot, trial period, lock prefixes, submit guard.
- ☑ **D2** API.md / DATABASE.md.

## E. Owner follow-ups (2026-10-12)

- ◐ **E1 KYC always exits.** A close (✕) button beside the back arrow; both, plus a swipe or
  Android back, save the section being edited and leave — the KYC stays a draft until it is
  submitted. Only a section that cannot be saved as it stands asks once (keep editing / leave
  that change). _Device pass pending._
- ☑ **E2 Trial over, KYC not approved = portal closed.** App: our alert card over a blurred
  portal, "Your free trial has ended — please complete your KYC first", Complete KYC / Contact
  us; it steps aside on the KYC screen and its room-type and rent editors. Web: the same as a
  frosted card. API: every other hostel-admin write refused, 423 `TRIAL_ENDED_KYC`
  (`isBlockedAfterTrial`); the hostel carries `kyc.trialEndsAt` so the guard needs no extra
  read. The trial-ending reminders now go to these owners too, asking for the KYC. On approval
  after the trial: email with "Get your plan" (the pay link below) + "call us to activate",
  push facts only ("check your email"), and 3 days from approval to pay before the
  `TRIAL_ENDED` block.
- ☑ **E3 Emailed pay link.** `modules/billing/plan-pay-link.ts`: a signed link (14 days) that
  opens `/plans-pricing/checkout` on that hostel with the email-and-code step skipped — the
  email is the proof. It buys a plan checkout for one hostel; it does **not** sign anyone into
  the portal. Used by every plan email (trial ending, KYC approved, plan due, invoice issued,
  suspension, team registration). A hostel with no plan yet gets the featured plan on the
  invoice and can switch on the pay step.
- ☑ **E4 Footer.** The website footer's "Pay for your hostel" is now "Recharge your hostel"
  (same no-sign-in checkout). Not in the app: Play policy.

## Session log

- 2026-10-11 — decisions taken, tracker written.
- 2026-10-12 — A1–A8, C1–C3, D1–D2 done (web typecheck clean apart from another session's
  `existing-residents` tests; full web suite 274 files / 3361 tests green). B1–B6 built and
  typechecked, waiting on the device pass. The old 5-step form (`apply.tsx`) is deleted; the website's
  `public-hostel-registration-page.tsx` is unrouted but still on disk.
- 2026-10-12 (later) — E1–E4 from the owner's review. Web 276 files / 3368 tests, mobile 104 /
  1540, both typechecks clean.
