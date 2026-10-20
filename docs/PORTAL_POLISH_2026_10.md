# Portal polish — 2026-10-20

The ten-point list from 2026-10-20. Work one item at a time: code → typecheck/lint → tick.
Web UI is checked by the owner in their own browser; app UI on the device.

## Bugs

- ☑ **Recharge offered a lower plan (Education Light, Max).** "Get Pro" → *Yes, it's running* reshaped the
  open Max invoice into Pro, and Pro months would have extended Max at Pro's price. `notBelowRunningPlan`
  (plan-checkout.service) renews at least the running plan; the footer's plain *Recharge* (no pick) no
  longer reshapes an open invoice (`reshape: false`). The page says "Your hostel is on Max … This renews Max."
- ☑ **Pay from localhost → 422 `return_url must be an absolute https:// URL`.** Softmato refuses
  `http://localhost`. `checkoutReturnUrl` and the team prepayment return URL use `outboundUrl()` — the
  public site — so a local checkout returns to hostelpalika.com (the webhook settles it either way).
- ☑ **Plan billing showed a due on a running plan.** An open invoice on an ACTIVE plan is paying early,
  not owing. Billing page: no "Balance due by", no Pay banner while the plan runs — the open invoice row
  carries a quiet Pay button instead. Sidebar plan card: "Rs X due" only when the plan is not running.
  Invoice rows carry the plan's mark, receipt rows a receipt mark.
- ☑ **Native dropdowns listed white on white** inside every dark page header (Reports month picker and
  others). `.dark { color-scheme: dark }` + option tokens in `globals.css`, so every native select is fixed.
- ☑ **Reports "Billed" bars were invisible** (`bg-muted`). Now a tint of the collected green with an edge.

## Layout

- ☑ **Resident portal sidebar** is the two-tier rail like admin: Home · Money · Daily · Safety · Account
  (`RESIDENT_NAV`, `TWO_TIER_AFTER` 20 → 12).

## Features

- ☑ **One date format everywhere** (web, app, CSV, PDF): `Baisakh · 2083-01-15`. `formatBsDate` /
  `formatHostelDate` / `formatHostelDateTime` in `packages/shared/src/calendar/bs.ts`; the app's `useDates()`
  is fixed to it (calendar picker removed); CSV/PDF cells format `Date`s and ISO strings through `exportCellText`.
- ☑ **PDF beside every CSV**: web `ExportMenu` (components/export-menu.tsx) on Reports, Payments, Residents,
  Transactions, Stock, platform Payments/Transactions/Users/Reports; screen lists render the PDF in the browser
  (`downloadTable`), report routes on the server (`format=pdf`). One branded table layout (`report-pdf.ts`):
  green band, summary line, filled header, stripes, sized columns, right-aligned numbers, page n of N. App
  Reports → Report tools has PDF/CSV.
- ☑ **Report range**: `months=1|3|6|12|0` on both export routes (`exportWindow`), picked in the web menu and
  the app sheet; snapshot reports (occupancy, hostels) ignore it.
- ☑ **Statement on the web**: Finance → Statement (`hostel-admin-statement-page.tsx`) — money in (settled
  invoices) and out (expenses) by day, range + direction + search, totals, PDF/CSV; same `movements()` as
  Overall, whose "Open" now lands here. **Parity check:** every other app admin/resident screen has a web
  home (roll call → Night status; money rules, late fine, month discounts → Fee schedule; join link/requests →
  Residents; push notices → Notices; kitchen stock → Stock; resident statement → Payments + Statement PDF).
  App-only by nature: the ID-scanner camera and Android share-to-app receipts.
- ☑ **Help & support**: web — the sidebar `?` opens `SupportDialog` (support email + up to two numbers with a
  note each, from Website Config → Site Identity → Help line 1/2), then *Send feedback*: Feedback / Bug /
  Improvement, one text box (first line = title), up to 4 screenshots. App — every More tab's support rows show
  the same lines, plus *Send feedback* → `app/help.tsx`. Stored as `Feedback` (`POST /api/v1/feedback`),
  read in Platform → Feedback (New / Seen / Done). **Needs `db:indexes`** for the new collection.
- ☑ **Form modals**: every `DialogContent` is wider by default (`sm:max-w-lg`), rises in, and each direct child
  of a form (or `.stagger-in`) inside a dialog or sheet fades and slides inward 45ms after the last
  (`field-in` in `globals.css`; off under reduced motion).
- ☑ **Plans & pricing**: one module at a time behind a chip — *Standard plans* / *Lifetime offer* (the chip
  only while the deal is on sale) — sliding in from its chip's side with a sliding pill; the last pick is kept in
  `localStorage` (`hostelpalika:pricing-module`). Standard shows "Every plan starts with a N-day free trial"
  from Platform → Operations `trialDays`.
- ☑ **Support numbers message first**: each help line opens a WhatsApp chat (`wa.me`, 977 added to a local
  98… number); Call is the small button beside it (web dialog and app More tabs).
- ☑ **Caching**: both apps already keep a query cache (web: per-tab session, app: on disk) and revalidate
  behind it. Now an unchanged revalidation does not re-download: 214 GET routes answer with a weak ETag and a
  bodiless 304 on a match (`lib/etag.ts`, `withEtag`); `browserApi` and the app's axios client keep the last
  body per URL + branch **in memory** and replay it on 304. `public/` images, animations and sounds cache a week
  (stale-while-revalidate); the PWA's hashed bundles are immutable; `/_next/static` already was.
