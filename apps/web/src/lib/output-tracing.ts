/**
 * Which routes are allowed to carry the two heavy document libraries.
 *
 * 365 route handlers means 365 function bundles, and `pdf-lib` (22 MB) was in
 * every one of them: `modules/finance/evidence.ts` and `receipt-pdf.ts` are
 * imported by `finance-notify`, `payment-event.service` and `booking.service`,
 * which most of the authed surface reaches. 135 routes could actually render a
 * document; the other 230 were paying 22 MB for nothing, against a Functions
 * Storage limit that blocks deploys when it is hit.
 *
 * `next.config.ts` excludes both packages everywhere and hands them back only
 * to the prefixes below. **An entry that is too narrow is a production 500** —
 * a route reaching `pdf-lib` without the files 500s the first time somebody
 * asks it for a PDF, and the build stays green. `output-tracing.test.ts` walks
 * the real import graph and fails when a reaching route is not covered here, so
 * the list cannot silently fall behind the code.
 *
 * **Dynamic segments are `*`, never `[id]`.** These are globs, and in a glob
 * `[id]` is a character class matching one letter. `[id]` entries match nothing
 * and match it silently — the same trap `next.config.ts` documents for the
 * canvas includes.
 */

export const PDF_LIB_PACKAGE = [
  "../../node_modules/pdf-lib/**/*",
  "./node_modules/pdf-lib/**/*",
];

export const XLSX_PACKAGE = [
  "../../node_modules/xlsx/**/*",
  "./node_modules/xlsx/**/*",
];

/** Routes that reach `pdf-lib` — invoices, receipts, statements, booking papers. */
export const PDF_LIB_ROUTES = [
  "/api/v1/account/residency-invite/**",
  "/api/v1/bookings/**",
  "/api/v1/cron/billing-cycle/**",
  "/api/v1/cron/gateway-expiry-sweep/**",
  "/api/v1/cron/gateway-health/**",
  "/api/v1/cron/gateway-settlement-recon/**",
  "/api/v1/cron/hostel-purge/**",
  "/api/v1/cron/ledger-drift/**",
  // Plan-due reminders render the invoice PDF, and they run from the push
  // schedule now — the dispatch cron and the Push tab's own routes reach them.
  "/api/v1/cron/notification-dispatch/**",
  // The admins' payments summary lives in `finance-notify`, beside receipts.
  "/api/v1/cron/payment-reminders/**",
  "/api/v1/cron/platform-push/**",
  "/api/v1/files/*/complete/**",
  "/api/v1/files/upload/**",
  "/api/v1/hostel-admin/billing/**",
  "/api/v1/hostel-admin/branches/**",
  "/api/v1/hostel-admin/bookings/**",
  "/api/v1/hostel-admin/finance/**",
  "/api/v1/hostel-admin/inquiries/**",
  "/api/v1/hostel-admin/kyc/**",
  "/api/v1/hostel-admin/payout-account/**",
  "/api/v1/hostel-admin/profile/**",
  "/api/v1/hostel-admin/reports/**",
  "/api/v1/hostel-admin/residents/**",
  "/api/v1/hostel-admin/room-types/**",
  "/api/v1/hostel-admin/subscription/**",
  "/api/v1/hostel-admin/wardens/**",
  "/api/v1/hostel-registration/**",
  "/api/v1/platform/bookings/**",
  "/api/v1/platform/hostels/**",
  "/api/v1/platform/offer-program/**",
  "/api/v1/platform/payments/**",
  "/api/v1/platform/push/**",
  "/api/v1/platform/reports/**",
  "/api/v1/platform/subscriptions/cash/**",
  "/api/v1/platform/subscriptions/claims/**",
  "/api/v1/platform/subscriptions/documents/**",
  "/api/v1/public/hostel-applications/**",
  "/api/v1/public/hostels/**",
  // A resident's join request reaches the existing-residents add path.
  "/api/v1/public/join/**",
  "/api/v1/public/plan-checkout/**",
  "/api/v1/resident/finance/checkout/**",
  "/api/v1/resident/finance/evidence/**",
  "/api/v1/resident/finance/invoices/**",
  "/api/v1/resident/finance/receipts/**",
  "/api/v1/resident/finance/statement/**",
  "/api/v1/resident/offer-program/**",
  "/api/v1/team/email-check/**",
  "/api/v1/team/hostels/**",
  "/api/v1/team/prepayments/**",
  "/api/v1/webhooks/**",
] as const;

/** Routes that reach `xlsx` — the statement importer and the existing-resident sheet. */
export const XLSX_ROUTES = [
  "/api/v1/hostel-admin/finance/statements/**",
  "/api/v1/hostel-admin/residents/existing/**",
  // The join link adds through the same service, which carries the sheet reader.
  "/api/v1/hostel-admin/residents/join-link/**",
  "/api/v1/hostel-admin/residents/join-requests/**",
  "/api/v1/public/join/**",
  "/api/v1/team/hostels/*/existing-residents/**",
] as const;
