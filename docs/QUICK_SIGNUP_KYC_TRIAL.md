# Quick sign-up, KYC, free trial, plans

How a new hostel joins and what it is on at each step. This is the current rule;
the code is the source of truth where they disagree.

## 1. Sign-up — nothing is guessed

- One screen, app and website (`/register-hostel`): owner name, phone, hostel name
  (+ optional referral code). `POST /api/v1/public/hostels/quick-register`.
- It creates a **DRAFT** hostel with `kyc.required`, makes the account HOSTEL_ADMIN in
  place (no password rotation), and starts the trial. One unapproved hostel per account.
- **No defaults for the owner's choices.** Hostel type is not set (`hostelType` absent,
  API returns `null`); the dashboard shows "Choose hostel type", and the KYC details step
  cannot be saved until it is picked.

## 2. The free trial

- Length: Platform → Operations → `trialDays`. Every new hostel gets it — app, website,
  field-team filings.
- **What it includes:** everything up to the Max plan (`planState` → `trial`, no caps). No
  payment. After it: buy a plan, or carry on with Free. KYC approval only unlocks the
  locked features below — it does not change the plan.
- **What KYC still locks** until our team approves it (`kyc.required` and not APPROVED):
  open — Home, Rooms & floors, Food, Notices, Complaints, Repairs, Settings, KYC, Billing,
  Community. Frozen — adding residents, Finance, payments/claims, Expenses, Inventory,
  Reports, Bookings, Attendance, Night status, Wardens, Cooks, Push notices, Join link,
  Branches, Invite hostels. The server refuses frozen writes with 423 `KYC_REQUIRED`.
  The listing stays hidden until approval.
- **Welcome** (once per hostel per device, web + app) + bell/push + email say the same
  thing, from `trialTerms()` in `packages/shared/src/plans/catalog.ts`: trial end date,
  Max included, buy or stay on Free after, KYC unlocks the locked features. The guide's
  "Your plan at the start" chapter says the same.

## 3. KYC

- Required to submit: details (type, area, city), photos, rates, documents, location,
  agreement. Submit → SUBMITTED, hostel PENDING_APPROVAL; editing stays open.
- Approve → APPROVED, VERIFIED, PUBLISHED (listing goes live already Verified), cook
  login + owner ID card, email + push. Reject / request documents → back to DRAFT with a note.

## 4. After the trial — which plan

| Situation | Plan | Effect |
|---|---|---|
| Trial running | **Free trial** | everything, no caps (KYC lock aside) |
| Trial over, KYC approved, paid plan live | that plan | its caps |
| Trial over, KYC approved, no paid plan | **Free** | `plans.free` caps (default 10 residents, 1 warden, 1 cook); over them → `overLimitGraceDays`, then read-only (`PLAN_OVER_LIMIT`) |
| Trial over, KYC not approved | — | portal closed except KYC + plan (423 `TRIAL_ENDED_KYC`) until approved |

Every hostel without a live paid plan is on Free (trial over, period lapsed, chosen but
unpaid). Hostels from before trials, with no plan, stay uncapped. Free months snapshotted
on old subscriptions are still honoured.

Reminders: email + push 3 days before the trial ends and on the last day. Every plan email
carries the signed 14-day pay link (`plan-pay-link.ts`) — it pays, it never signs in.

## Open

- ☐ Device pass (adb) for the app side: Register tile, quick form, welcome sheet, frozen
  lock, KYC screen, Billing trial line, KYC ✕ exit.
- ☐ Device + browser check of the 2026-11-18 change: no default hostel type, new trial welcome.
