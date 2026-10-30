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

writeFileSync(join(process.cwd(), "server/testdata/vectors/emails.json"), `${JSON.stringify(vectors, undefined, 1)}\n`);
console.log(`emails.json: ${vectors.length} vectors`);
