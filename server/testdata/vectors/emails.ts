/**
 * Golden output for the email templates the public-write routes send, from the
 * TypeScript templates (the spec). Run from the repo root:
 *
 *   node_modules/.bin/jiti server/testdata/vectors/emails.ts
 *
 * Each entry is `{ name, input, out }`; the Go test calls the template of the
 * same name with `input` and compares `out` (category, subject, html).
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { createJiti } from "jiti";

const web = createJiti(__filename, {
  alias: {
    "@/": join(process.cwd(), "apps/web/src") + "/",
    "server-only": join(process.cwd(), "node_modules/server-only/empty.js"),
  },
});

const t = (path: string) => web.import<Record<string, (input: unknown) => unknown>>(`../../../packages/shared/src/email/templates/${path}`);

const vectors: { name: string; input: unknown; out: unknown }[] = [];

function add(name: string, fn: (input: never) => unknown, inputs: unknown[]) {
  for (const input of inputs) vectors.push({ name, input, out: fn(input as never) });
}

const inquiry = await t("hostel/inquiry-received");
add("hostelInquiryReceived", inquiry.hostelInquiryReceivedEmail as never, [
  { dashboardUrl: "https://hostelpalika.com/hostel-admin/inquiries", hostelName: "Royal <Rapti> & Co", visitorName: "Sita \"K\" Rai" },
  { dashboardUrl: "https://x.test/i", hostelName: "H", message: "Is there <b>wifi</b>?", preferredVisitDate: "2026-11-02", visitorEmail: "s@x.test", visitorName: "Sita", visitorPhone: "9800000000" },
  { dashboardUrl: "https://x.test/i", hostelName: "H", message: "", visitorName: "  ", visitorPhone: " " },
]);

const kyc = await t("hostel/hostel-kyc");
add("hostelPortalOpen", kyc.hostelPortalOpenEmail as never, [
  { hostelName: "Royal <Rapti> & Co", kycUrl: "https://hostelpalika.com/royal/admin/kyc", ownerName: "Sita \"K\" Rai", trialDays: 7, trialEndsOn: "5 Nov 2026" },
  { hostelName: "H", kycUrl: "https://x.test/k", trialDays: 0, trialEndsOn: "" },
]);

const submission = await t("hostel/submission-received");
add("hostelSubmissionReceived", submission.hostelSubmissionReceivedEmail as never, [
  { hostelName: "Fixture <Hostel>", ownerName: "Sita & Co" },
  { hostelName: "H" },
]);

const pending = await t("platform/new-hostel-pending");
add("newHostelPending", pending.newHostelPendingEmail as never, [
  { hostelName: "Fixture Hostel", queueUrl: "https://hostelpalika.com/platform/hostels" },
  { city: "Kathmandu", hostelName: "A&B", ownerEmail: "o@x.test", ownerName: "Owner <O>", queueUrl: "https://x.test/q?a=1&b=2" },
]);

const bookingGuest = await t("booking/guest");
const bookingHostel = await t("booking/hostel");
const bookingPlatform = await t("booking/platform");
const facts = { code: "BK-7F3K2Q", fee: 1500, hostelName: "Royal <Rapti> & Co", monthlyRent: 15000, roomType: "Double Sharing", stay: null, total: 1500 };
const stayFacts = { ...facts, fee: 3000, stay: { amount: 3000, dates: "4 Oct 2026 – 7 Oct 2026 (Asoj 18–21)", nights: 3 }, total: 6000 };
const rows = [{ fromDay: 1, refund: 1125, refundPercent: 75, throughDay: 2 }, { fromDay: 3, refund: 750, refundPercent: 50, throughDay: 5 }, { fromDay: 6, refund: 375, refundPercent: 25, throughDay: 6 }];
const invoice = { bookingUrl: "https://x.test/bookings/1", hostelAnswerHours: 48, invoiceNumber: "HH-BKI-2083-84-000012", name: "Sita", noShowRefund: 0, payBy: "Bhadra 16, 2083 BS (1 Sep 2026), 3:40 PM", paymentCheckHours: 12, policyUrl: "https://x.test/refund-policy", refundRows: rows };
add("bookingInvoice", bookingGuest.bookingInvoiceEmail as never, [{ ...invoice, booking: facts }, { ...invoice, booking: stayFacts, name: null }]);
const ended = { booking: facts, bookingUrl: "https://x.test/b/1", name: "Sita", refundTo: "eSewa ••••4321 (Sita)" };
add("bookingEnded", bookingGuest.bookingEndedEmail as never, [
  { ...ended, cause: "CANCELLED_BEFORE_CONFIRMATION", paid: true, refund: 1500, refundPercent: 100 },
  { ...ended, cause: "CANCELLED_BY_USER", paid: true, refund: 0, refundPercent: 0 },
  { ...ended, cause: "EXPIRED", paid: false, refund: 0, refundPercent: 0 },
  { ...ended, booking: stayFacts, cause: "HOSTEL_NO_RESPONSE", paid: true, reason: "No <answer>", refund: 6000, refundPercent: 100 },
  { ...ended, cause: "NO_SHOW", paid: true, refund: 75, refundPercent: 5.5 },
]);
const closed = { bookingsUrl: "https://x.test/h", code: "BK-7F3K2Q", guestName: "Sita", hostelName: "Royal <Rapti>", name: "Owner", roomType: "Double Sharing" };
add("bookingClosedForHostel", bookingHostel.bookingClosedForHostelEmail as never, [
  { ...closed, cause: "CANCELLED_BY_USER", hostelShare: 188 },
  { ...closed, cause: "HOSTEL_NO_RESPONSE", hostelShare: 0, name: null, reason: "Late" },
]);
add("bookingHostelFaultRefund", bookingPlatform.bookingHostelFaultRefundEmail as never, [
  { cause: "HOSTEL_NO_RESPONSE", code: "BK-7F3K2Q", guestName: "Sita", hostelName: "Royal <Rapti>", queueUrl: "https://x.test/q", refund: 1500, refundTo: "eSewa ••••4321 (Sita)", roomType: "Single" },
]);
add("bookingsPaused", bookingHostel.bookingsPausedEmail as never, [{ bookingsUrl: "https://x.test/h", hostelName: "Royal <Rapti>", name: "Owner", strikes: 3, windowDays: 30 }]);
add("hostelBookingsPaused", bookingPlatform.hostelBookingsPausedEmail as never, [{ hostelName: "Royal <Rapti>", reviewUrl: "https://x.test/r", strikes: 3, windowDays: 30 }]);

writeFileSync(join(process.cwd(), "server/testdata/vectors/emails.json"), `${JSON.stringify(vectors, undefined, 1)}\n`);
console.log(`emails.json: ${vectors.length} vectors`);
