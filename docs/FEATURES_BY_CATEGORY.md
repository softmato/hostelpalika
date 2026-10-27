# HostelPalika — features by category

For demo videos (field review K1). Taken from the code: the portal nav
(`apps/web/src/lib/portal-nav.ts`), the server modules (`apps/web/src/modules`) and the
app screens (`apps/mobile/src/app`). Every feature exists on the web and in the one
Android/iOS app (and the PWA at `/app`). Billing detail: `docs/BILLING_EXPLAINED.md`.

## Resident management — the main story

1. **Explore** — public listings, city / near-college pages, map, compare, saved, reviews.
2. **Book or walk in** — online booking that holds a bed (payout to the hostel), an
   inquiry, a share/QR **join link**, the **Form QR** admission form, or the desk.
3. **Register** — scan their HostelPalika ID card, or fill the admission form by hand;
   photo + ID documents; room type or numbered room; special fee with a reason; referral
   code. Existing residents of a joining hostel go in through the shared list with
   "paid till".
4. **Portal** — the email becomes their login (Google or "Forgot password"); the form
   becomes their digital ID card.
5. **Billing choice** — Calendar month or Same day each month ("Bills on the 20th").
6. **Bills and reminders** — joining bill (admission + deposit), first month, then monthly
   bills; automatic reminders; late fine; khata items on the next bill; days away off.
7. **Pay** — eSewa / Khalti in the app, bank or wallet QR with proof, cash at the desk;
   certified receipts with a QR (`/verify-receipt`).
8. **Moving out** — the resident gives notice (notice days set by the hostel), rent stops
   on the day, "Leaving today" on the warden's Home, move-out checklist: leaving month,
   deposit, write-off; the login goes back to public.

## Rooms & beds
Floors and numbered rooms or room types only; beds, vacancy; room-change requests from
residents; rate card per room type; branches.

## Money
Money tab balance (statement arithmetic), statement with opening balance, payments matrix
per BS month, claim review queue, bank/wallet statement import and matching, online
checkout (eSewa, Khalti), expenses with receipts, staff cash box ("Got it"), festival
discounts, late fine, money rules, reports and PDF exports, Overall view across branches.

## Stock
Bought / Send / Got it between main and branches, stock check, kitchen stock, the supply
store (platform catalogue, cash on delivery).

## Food
Weekly menu, food photos as proof, meal-call reminders, cook roster and Cook portal,
"food ready" log, resident food feedback.

## Attendance & safety
Night status (asked in the Android shade until answered), location attendance with no
stored coordinates, SOS in the header, guardians with their own login and permissions,
emergency contacts, incident log.

## Complaints & repairs
Complaints with updates and SLA, maintenance requests with voice notes, service providers.

## Notices & notifications
Hostel notices, scheduled/recurring push notices (e.g. Clothes Washing), bell + push +
email with per-topic opt-out, realtime updates.

## Staff
Wardens and cooks, capabilities per role, temporary access logins, app lock (PIN +
fingerprint, also gating the web portals), audit log.

## Hostel account
Quick sign-up on a trial, 8-step KYC with signed agreement, plans and plan billing on the
website, referral program, free months / setup fee, leave-the-platform with data export,
nightly encrypted backup.

## Platform (superadmin)
Hostel approvals, listings and suspension, website config (SEO, page copy), push
schedules, users, moderation, feedback inbox, analytics, offer program, supply store.
