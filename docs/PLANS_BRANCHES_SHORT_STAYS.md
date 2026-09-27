# Free months, setup fee, branches, short stays — build tracker

Work one item at a time: code it, verify it (`web:typecheck`, `web:lint`, `web:test`; mobile
`tsc` + tests), then flip `☐` to `☑`. `◐` = partial, with a note. The phases run in order: each
one builds on the billing state the one before leaves behind.

## The rules (decided with the owner, 2026-09-26)

**Billed against the hostel.** A plan, its free months and every bill belong to the hostel id,
never to the owner's email. Softmato already files the customer as `hh-hostel:<hostelId>`.

**Free months, once per hostel.** Every plan carries a free-month count and a monthly price.
The defaults are Go 6 months free then Rs 999/month, Pro 4 then Rs 1,699 and Max 3 then Rs 2,499.
All of them are superadmin settings in Website Config → Plans & Pricing. The free months start the
day the hostel goes live and need no payment. After that the hostel pays for the cycle it chose:
monthly, 6 months or annual, as today.
A building gets its free months once. If a new registration matches an earlier claim, it is billed
from day one. A match is any one of:

- the map pin within 50 m;
- the same name in the same area;
- the same PAN/VAT number;
- the same owner phone in the same area.

The claim record is kept when a hostel is archived or purged.

**Every free month says so.** Each free month opens with "Welcome — enjoy the free Go plan this
month, and N more free months after it". It appears on the dashboard (web and app) and as a bell +
push. The web adds how to recharge afterwards (Billing on the website) and the support number
(`identity.supportPhone`, to be set to 9709155982). The app shows facts only, because of the Play
payments rule.

**Team registration takes a setup fee, not the plan.** The agent still picks Go / Pro / Max and the
cycle, and shows the free-month offer. The money step collects the **setup fee** instead: Rs 500 by
default, a superadmin setting that is both the default and the ceiling. The agent may lower it but
never raise it. It is taken online (Softmato QR) or in cash. A hostel still does not publish unpaid.
The Cash tab tells the agent not to collect more than the fee. We call every hostel after
registration, and collecting more can bring legal action. The owner's welcome email states the exact
amount the agent reported, with the support number to call if they paid anything else.

**Agent commission comes from the setup fee, only.** It is no longer paid on the plan. The owner
first said 20%, then on 2026-09-27 "from 500 they can get 200". So the default is **40%**: Rs 200 of
a Rs 500 fee. It stays a percent so a fee the agent lowers earns proportionally less. It is the
existing `teamCommissionPercent` setting, edited beside the setup fee in Platform → Team →
Commission, which shows the rupee result.

**Branches are a Max feature.** A Max hostel may add up to N branches at no extra charge. N is
`maxBranches` on the plan, a superadmin setting. A branch has no subscription of its own: it rides
its main hostel's plan, and a lapse or suspension of the main one reaches every branch. Before a
branch goes live, all three of these must hold:

1. its PAN/VAT number is the main hostel's;
2. its payout account holder is the main hostel's, and the main account is verified;
3. a superadmin approves it, after calling the branch.

The dashboard shows every branch side by side. Every other tab works on one branch, chosen from a
switcher in the header. Web and app both have it.

**Short stays are an extra booking kind.** A hostel says whether it takes short stays (both
registration forms, and its settings later). It sets a daily rate per room type. The rate cannot be
below monthly ÷ 30 × (1 + minimum markup %), where the minimum markup is a superadmin setting.
We collect the booking fee and the whole stay upfront. The stay is split 30% to us and 70% to the
hostel. The hostel's share is paid out once the guest is checked in by card scan. The booking fee
keeps its own 60/40 split. Short-stay guests are never billed monthly rent.

### Short-stay rules (confirmed by the owner, 2026-09-27)

- **Stay length:** 1 to 29 nights, with the hostel setting its own minimum. Anything longer is a
  monthly resident.
- **Move-in:** within the normal 7-day hold for anyone. Advance bookings (for example from abroad)
  may pick a move-in up to 60 days ahead. That is a superadmin setting.
- **The bed is held from confirmation to move-out.** The booking fee covers the hold from today to
  move-in: one booking fee per started 7-day block of hold. A move-in inside 7 days pays one fee,
  as today.
- **Refunds:**
  - Cancelled before check-in, or declined by the hostel: the stay is refunded in full, and the
    booking fee follows the existing ladder.
  - No-show: one night is kept and the rest refunded.
  - Leaving early after check-in: nothing refunded.

## Phase A — Free months

1. ☑ **Catalogue fields.** Add `freeMonths` (0–24) to the plan tier schema, `PlanTierLike`, the
   Plans & Pricing editor and the defaults (Go 6 / Rs 999, Pro 4 / Rs 1,699, Max 3 / Rs 2,499).
   Pricing cards on the website and in the app show "N months free, then Rs X/month".
   *Done 2026-09-26. The live `plans` config keeps its stored prices and has 0 free months until a
   superadmin saves the new figures in Website Config → Plans & Pricing. The shipped defaults apply
   only to a fresh database.*
2. ☑ **Free-month claim record.** Add a `FreePlanClaim` model: hostel, plan, months, claimed at,
   and fingerprints (name key + area, pin, PAN/VAT, owner phone + area). It is kept on purge.
   Add `panNumber` to the hostel and to both registration forms, optional there. Build
   `freeMonthsFor(hostel, plan)`, which returns the plan's months, or 0 with the earlier claim
   when one matches.
   *Done 2026-09-26 as `claimFreeMonths` in `billing/free-months.ts`: idempotent per hostel, and
   the rule is `isSameBuilding` (test: `free-months.test.ts`). The claim is kept on purge.
   Hostels already live before this have no claim row, so the archive-and-re-register gap stays
   open for them. The live set is small, so no backfill was written.*
3. ☑ **Going live starts the free period.** Covers team filing and public approval.
   - The subscription snapshots `freeMonths`, sets `freeUntil` = `currentPeriodEnd` = the end of
     the last free month, and becomes ACTIVE with no invoice.
   - A public hostel is published and gets its portal at approval.
   - With 0 free months, today's flows run unchanged.
   *Public side done 2026-09-26: `startFreeMonths` in `subscription-payment.service.ts` runs at
   approval (plan already chosen) and on a plan chosen after verification
   (`hostel-registration/[hostelId]/plan`). It snapshots the offer at selection and publishes and
   opens the portal (test: `free-months-start.test.ts`). The team filing calls it from
   `fileTeamBilling` (item 7).*
4. ☑ **First bill after the free months.** A daily sweep raises the renewal invoice for any
   subscription whose period ends within the reminder window and has no open invoice. It uses the
   subscription's own plan and cycle, and the due date is the period end. This covers ordinary
   renewals too. The existing 7 / 5 / daily reminders pick it up.
   *Done 2026-09-26: `raiseDueRenewals` in `billing/plan-renewal-sweep.service.ts`, run first on
   the 07:45 `payment-reminders` cron. The first bill after the free months uses the snapshot
   price; later ones use today's catalogue. A period that ends with the bill open becomes
   PAST_DUE (test: `plan-renewal-sweep.test.ts`). On its first run after deploy, every live plan
   that has already run out gets its bill emailed and goes past due.*
5. ☑ **Welcome for each free month.** Covers the dashboard card on web and app, the bell + push on
   the day each free month begins (an automatic push row, pausable), and the recharge + support copy
   on the web billing page and the registration plan steps.

   *Done 2026-09-26. The server answers `freeMonthNow` (`freeMonthOf`) on the subscription state.
   - Web: `HostelFreeMonthCard` on the dashboard and on Billing, with the recharge line and
     `identity.supportPhone`.
   - App: `FreeMonthCard` on the admin home, facts only.
   - The automatic row `FREE_MONTH_MORNING` (08:00, pausable) sends the bell + push once per free
     month (`free-month-welcome.service.ts`).
   - The public progress page shows "N months free" on the plan cards, and the live panel explains
     free until / recharge / support.
   - The verified email gets a free-months wording.

   The team form's plan cards are done in item 7. `identity.supportPhone` must be set to
   9709155982 in Website Config.*

## Phase B — Setup fee at team registration

6. ☑ **Setup-fee invoice.** Add `kind: PLAN | SETUP_FEE` to `SubscriptionInvoice`, and add
   `teamSetupFee` (default 500) to Operations config.
   - A setup-fee invoice carries no period. Settling it never starts or extends the plan and never
     publishes anything.
   - Commission is credited only on a setup-fee invoice paid in full. The `teamCommissionPercent`
     default becomes 40.
   *Done 2026-09-26.*
   - `issueSetupFeeInvoice` issues it. Settling it returns early in `applySettlement`, and
     `findOpenInvoice`, the renewal sweep and checkout all skip `SETUP_FEE`.
   - `earnsCommission`: the setup fee earns commission. A TEAM plan invoice earns only when its
     subscription has no setup fee, which covers hostels filed before this change.
   - Setup fee + rate are edited in Platform → Team → Commission.
   - The live `teamCommissionPercent` stays 11.12 until a superadmin saves 40 there.
   - Tests are in `subscription-rules.test.ts`.
7. ☑ **Team payment step.**
   - The plan and cycle choice stay, showing the free-month offer.
   - The Payment card becomes Setup fee: an amount from 1 to the configured fee, defaulting to it.
   - Online prepayment is raised for the setup fee.
   - The Cash tab carries the don't-collect-more warning.
   - The server refuses an amount above the fee.

   *Done 2026-09-27.*
   - The form reads the fee from `GET /api/v1/team/setup-fee`.
   - `TeamPrepayment.kind` is `SETUP_FEE` for new rows. A `PLAN` row from before still publishes
     the old way.
   - The filing's money moved out of `hostel.service` into `team/team-filing-billing.ts`
     (`fileTeamBilling`; test: `team-filing-billing.test.ts`, 4 cases).
   - Cash above the fee is refused 422 `SETUP_FEE_TOO_HIGH`.
   - Not browser-checked (web UI is handed to the owner).
8. ☑ **Owner's welcome email and My desk.**
   - The email states the setup fee paid and when the free months end, with the support number.
   - My desk and the track sheet show the setup fee rather than a plan due.
   - Commission on My desk reads from setup fees.

   *Done 2026-09-27.*
   - `hostelRegisteredByTeamEmail` shows the plan and when it is free until. It carries a "setup
     fee paid" row, and small print saying that is the only amount the agent may take, with the
     support number to call.
   - `ledgerBySubscription` in `team.service.ts` keeps plan dues apart from the setup fee. The old
     price-minus-everything-paid showed a Rs 500 setup fee as part payment of a free plan.
   - My desk shows "free until …" and the setup fee, marked "not confirmed yet" while the cash is
     with Softmato.
   - The wallet's "Once paid" is a percent of setup fees.
   - The track sheet carries no money, so it had nothing to change.
   - Full web suite: 3,100 tests pass. `seo.test` now expects the new cheapest price, Rs 999.

## Phase C — Branches (Max)

9. ☑ **Branch model.** Add `Hostel.parentHostelId`, and `maxBranches` on the plan tier (Max 3,
   others 0).
   - A billing resolver maps a branch to its main hostel's subscription. Plan state, plan limits
     and suspension all read through it.
   - A plan lower than Max cannot be bought while branches exist.
   *Done 2026-09-27.*
   - `billing/billing-hostel.ts` holds `billingHostelId` and `assertBranchesFit`. The resolver is
     used by `getOrCreateSubscription`, `getSubscriptionState`, `invoiceIdFor`,
     `getBillingHistory` and `assertPlanRoom`. Each branch counts its own seats against the main
     hostel's caps.
   - Suspension: starting it on a branch is refused (`BRANCH_FOLLOWS_MAIN`). Starting or lifting
     it on the main hostel copies the result onto its branches, so every existing
     `Hostel.suspension` guard covers them.
   - A plan with fewer branches than the hostel has is refused on renewal and on the checkout's
     plan change. Pending branches count toward the cap.
   - Branches are also added to the Plans & Pricing editor.
   - Test: `billing-hostel.test.ts`.
10. ☑ **Branch request.** The owner of a Max hostel files a branch from the portal (web + app):
    name, location, rooms and rate card, photos, PAN/VAT number and payout account. The server
    refuses it if:
    - the PAN is not the main hostel's;
    - the payout holder is not the main hostel's, or the main account is unverified;
    - the cap is reached.

    The branch waits as `PENDING_APPROVAL`.
    *Done 2026-09-27.*
    - `hostels/hostel-branch.service.ts` (`requestBranch`, `listBranches`) and route
      `hostel-admin/branches` (owner only). Test: `hostel-branch.test.ts`, 6 cases.
    - The main hostel's PAN is set once: the web Hostel Profile, or the app's Branches screen when
      it is missing. The profile service ignores a second PAN.
    - `HostelApplication.source` gained `BRANCH`.
    - Web: Hostel admin → Branches. App: More → Branches (`manage/branches.tsx`).
11. ☑ **Superadmin approval.** A branch queue in Platform → Listings shows the branch phone to call
    and approves or rejects the branch. On approval the branch is published, its owner gets
    HOSTEL_ADMIN on it, the cook login is created and the owner is emailed.
    *Done 2026-09-27.*
    - `approvePlatformHostel` refuses a branch to anyone but a SUPERADMIN
      (`BRANCH_NEEDS_SUPERADMIN`). It then publishes the branch, runs `grantHostelOwnerAccess`
      (the branch joins the owner's hostels, gets a cook login and the approved email) and seeds
      the rate card. No free months are given.
    - The review page shows a "Branch of X" panel: the phone to call, both PANs, and the payout
      holder. The queue marks branches with a BRANCH badge.
    - Test: `approval-cook-credentials.test.ts` +2.
12. ☑ **Switcher and dashboard.**
    - The web header switcher moves between the `/{slug}/admin` of each branch. The app switcher
      sets the active hostel for every admin screen.
    - The dashboard gains a per-branch summary: residents, occupancy, collected this month, open
      complaints.

    *Done 2026-09-27.*
    - Server: `requireApiPrincipal` narrows a staff member with several hostels to the one named
      in `x-hostel-id` (an id or a slug), defaulting to the first (the main hostel). It keeps
      `allHostelIds`. Every `hostelIds[0]` / `$in` service therefore works on one hostel
      unchanged. Test: `api-auth.test.ts` +2.
    - Web: `browserApi` sends the `/{slug}/admin` slug. The portal cache is keyed by workspace.
      The header has a `<select>` switcher (`HostelWorkspaceSwitcher`, shown only with 2+
      hostels). The dashboard has a "Your hostels" card (`branches/summary`: residents,
      occupancy, this BS month collected/due, open complaints).
    - App: `lib/active-hostel.ts` (persisted, cleared on sign-out), sent by the API client. The
      Home chip plus bottom sheet switches hostel and clears the query cache. The admin tabs are
      keyed on the active hostel so everything remounts. There is also a "Your hostels" card.
    - The older `/hostel-admin/...` web routes send no slug and so work on the main hostel.
    - Checked: full web suite 3,112 pass, mobile 1,455 pass. Not checked on a device or in a
      browser.

## Phase D — Short stays

13. ☑ **Settings and rates.** Add `shortStays` to the booking config (min markup %, platform share
    30, max nights, max advance days) and short-stay fields to the hostel (on/off, minimum nights).
    Add a daily rate per room type on the rate card, floored on save.
    *Done 2026-09-27.*
    - Booking config gained four flat keys, edited on Platform → Bookings → Settings and confirmed
      by email like the rest: `shortStayMinMarkupPercent` 20, `shortStayHostelSharePercent` 70,
      `shortStayMaxNights` 29, `shortStayMaxAdvanceDays` 60.
    - The daily rates live on `Hostel.shortStays` (`enabled`, `minNights`, `rates[]`), **not** on
      the rate card. The rate card only changes from a future month because it bills residents. A
      short stay freezes its own rate on the booking, so it needs no versioning.
    - The floor is `dailyFloor` in `bookings/short-stay.ts`: monthly ÷ 30 × (1 + markup), rounded
      up. A rate below it is refused on save, not raised.
    - Route `hostel-admin/bookings/short-stays` (GET/PUT). Web: Bookings → Settings → Short stays.
      App: Manage → Bookings → Settings. Test: `short-stay.test.ts`, 3 cases.
14. ☑ **Registration forms.** "Do you offer short stays?" with daily rates and minimum nights, on
    the team form and the public form.
    *Done 2026-09-27.*
    - `shortStays` (on/off, fewest nights, a daily rate per room type) is on
      `hostel-registration.validation.ts`. `registrationShortStays` checks each rate against the
      floor worked out from the same form's monthly rent. It runs before anything is written, on
      both the public and the team paths.
    - One shared web block, `registration-short-stays.tsx`, sits on both web forms and is saved in
      both drafts. The app form (`register-hostel/apply.tsx`) has the same thing in a "Short stays"
      accordion. The app form also gained the optional PAN/VAT field it lacked.
    - The floor markup reaches the forms through `GET /bookings/policy` (`policy.shortStay`).
    - Test: `mobile-registration-contract.test.ts` +1.
15. ☑ **Booking kind `SHORT_STAY`.**
    - Move-in and move-out dates, nights, daily rate, stay amount and hold blocks.
    - Quote and create check availability, and one payment covers fee + stay.
    - Split and refund math sit beside the existing terms, frozen on the booking.
    *Done 2026-09-27.*
    - `Booking.kind` + `Booking.stay` (dates, nights, daily rate, amount, hold blocks, the hostel's
      share, all frozen). `fee` = booking fee × hold blocks. The guest pays `amountDue` = fee +
      nights, used for pay instructions, payment rows, the Softmato invoice (the nights are their
      own line), documents and emails.
    - `bookings/short-stay.ts` holds the pure maths: `quoteStay`, `holdBlocks`, `stayRefund`,
      `stayCheckInBy` (end of the day after move-in), `stayEndsAt` and `amountDue`.
      `settleBooking` settles the nights beside the fee: 70/30 kept, and totals are written with
      `stayKept` / `stayRefund`.
    - A cancel on or after the move-in day keeps one night, the same as a no-show. Otherwise
      cancelling would be a free way round the no-show rule.
    - Quote: `GET /bookings/quote?moveIn&moveOut` returns `shortStay` (limits, night price, priced
      quote or the date error). Create takes `kind`, `moveIn` and `moveOut`. A confirmed short
      stay holds its bed until `stayCheckInBy`, and the existing sweep ends a missed one as a
      no-show.
    - The refund policy page has a "Short stays" section. Test: `short-stay.test.ts`, 7 cases.
16. ☑ **Check-in, stay end, payout.**
    - A card scan admits the guest as a short-stay resident with an end date, and no monthly fee is
      ever raised for them.
    - The stay's end releases the bed.
    - The hostel's 70% goes onto the payout transfer at check-in.
    *Done 2026-09-27.* A card scan on a short-stay booking writes `Resident.stayEndsAt` (the end of
    the move-out day). It skips the joining invoice and the first-month invoice, and
    `findBillableResidents` excludes the guest, so no rent is ever billed. `endShortStays` runs in
    the every-minute booking sweep: it moves the guest out and frees the bed. The payout at
    check-in already carries 70% of the nights, through `settleBooking`.
17. ☑ **Book flow on web and app.** A Monthly / Short stay switch, a date range, and a live quote
    showing fee + stay. Advance dates are allowed up to the configured limit.

    *Done 2026-09-27.* The web checkout (`booking-checkout-page.tsx`) and the app (`book/[slug].tsx`)
    have a Monthly / Short stay switch. It shows only when the room takes short stays. Web uses
    native date inputs; the app uses the intake's YYYY-MM-DD fields. Each date change re-quotes, and
    Book stays disabled until the dates are priced. My bookings (web) and the app's booking screen
    show the stay, the nights and the total. Checked: web 3,120 tests and mobile 1,455 pass,
    typecheck clean, lint 0 errors. Not checked in a browser or on a device.

## Phase E — Superadmin deep search (after A–D)

Asked 2026-09-27: the superadmin search bar should find fields *inside* screens — a tab's own
fields and options, not just page names. Searching "setup fee" should land on Platform → Team →
Commission with the field focused. `portal-nav.ts` is the nav and search source of truth today.

**Design for the next session (worked out 2026-09-27; no code yet):**
- Most settings are raw `<label>Text<input>`, not a shared field component. So:
  - Extract the fields from the platform config sources: `label="…"`, `<label …>Text`, and
    `{ key, label }` arrays such as `NUMBER_FIELDS` on the bookings page.
  - The tab is the enclosing declaration's name, mapped per file. For example `PricingTab` →
    `pricing`, and `NUMBER_FIELDS`/`SettingsForm` → `settings`.
  - `<option>` texts become synonyms of the field before them.
  - Write the result to `lib/platform-field-index.generated.ts` with a small script run by `jiti`.
    A vitest re-extracts it and fails when it is stale.
- The deep link is `?tab=…&field=<slug of label>`. `PortalSearch.openEntry` (and a mount check for
  pasted links) polls for about 3 s for a `[data-field]` or a `<label>` whose slugged text starts
  with the field. It then scrolls to it, focuses the input and flashes a ring.
- The bookings page already honours `?tab`. The plans page (`useState("catalogue")`, line 86)
  must read it with `useSearchParams`.
- Moderators must not see superadmin-only pages: filter the entries through
  `isSuperadminOnlyHref`.
- Matching on a setting's current value is skipped until someone asks for it.

18. ☑ **Field index.** Every superadmin config field gets a search entry: label, synonyms, the
    page, the tab and a field anchor. It lives beside `portal-nav.ts` and is typed so a renamed
    field breaks the build.
    *Done 2026-09-27:* `lib/platform-field-index.generated.ts` (175 fields), written and checked
    by `platform-field-index.test.ts` (`npx vitest run src/lib/platform-field-index.test.ts -u`
    regenerates it). `SOURCES.decls` maps each declaration on a tabbed page to its tab, or to
    `null` to leave it out; an unmapped one fails the test. A shared editor (`PageEditor`) gets
    one entry per card it sits under. Fields ride on their page's palette entry, so a moderator
    loses them with the page. Left out: `platform-settings-page` (the admin roster, not config)
    and `plans/[service]` (per-service URL).
19. ☑ **Deep links.** A result opens its page, switches to its tab and scrolls to and focuses the
    field (`?tab=…&field=…`), on every config screen that has tabs.
    *Done 2026-09-27:* `revealField` in `portal-search.tsx` (the palette, plus a mount check in
    `PortalShell` for pasted links) waits for the URL to land, finds the text after the
    `?in=<section>` heading, focuses the control and flashes a ring. The plans page now reads
    `?tab`; bookings already did.
20. ☑ **Ranking and UI.** Results are grouped by page, show the tab › field path, match on synonyms
    and the setting's current value, and are keyboard-first.
    *Done 2026-09-27, without current-value matching:* it is dropped until someone asks for it.
    Hits are grouped by page under a page heading, and each row shows its tab › section path.
    ⌘K and the arrow keys work as before.
