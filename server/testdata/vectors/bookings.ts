/**
 * Golden booking papers and ID cards, from the TypeScript code (the spec). Run
 * from the repo root:
 *
 *   node_modules/.bin/jiti server/testdata/vectors/bookings.ts
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createJiti } from "jiti";

const web = createJiti(__filename, {
  alias: {
    "@/": join(process.cwd(), "apps/web/src") + "/",
    "server-only": join(process.cwd(), "node_modules/server-only/empty.js"),
  },
});

const out = join(process.cwd(), "server/testdata/golden");

const doc = await web.import<typeof import("../../../apps/web/src/modules/bookings/booking-document")>(
  "../../../apps/web/src/modules/bookings/booking-document",
);

const issuer = {
  address: "Kathmandu", email: "billing@softmato.com", legalName: "Softmato Pvt. Ltd.", pan: "622209876", phone: "9800000000", productName: "HostelPalika", vatRegistered: false,
};
const at = new Date("2026-09-01T06:00:00.000Z");
const terms = {
  cancelSteps: [{ refundPercent: 75, throughDay: 2 }, { refundPercent: 50, throughDay: 5 }, { refundPercent: 25, throughDay: 7 }],
  feePercent: 10, holdDays: 7, hostelAnswerHours: 48, hostelSharePercent: 50, noShowRefundPercent: 0,
};
const base = {
  _id: "6b0000000000000000000099", code: "BK-7F3K2Q", createdAt: at, currency: "NPR", fee: 1500, guest: { email: "sita@example.com", name: "Sita Sharma", phone: "98" },
  hostelId: "6b0000000000000000000098", hostelSnapshot: { name: "Fixture Lakeside Hostel" }, invoiceNumber: "HH-BKI-2083-84-000012", monthlyRent: 15000, paymentDueBy: new Date("2026-09-01T18:20:00.000Z"),
  policy: { acceptedAt: at, version: "x" }, refundAccount: { holderName: "Sita", method: "ESEWA", numberLast4: "4321" }, roomType: "Double Sharing", status: "AWAITING_PAYMENT", terms, userId: "6b0000000000000000000097",
};
const paid = { ...base, paymentVerifiedAt: new Date("2026-09-02T04:05:00.000Z"), receiptNumber: "HH-BKR-2083-84-00000007", status: "AWAITING_HOSTEL" };
const stay = { amount: 3000, dailyRate: 1000, holdBlocks: 2, hostelSharePercent: 80, moveIn: new Date("2026-10-04T00:00:00.000Z"), moveOut: new Date("2026-10-07T00:00:00.000Z"), nights: 3 };
const transfer = {
  _id: "t", amount: 1125, bookingId: base._id, destination: { bankName: "", holderName: "Sita", method: "ESEWA", numberLast4: "4321" }, documentNumber: "HH-BRF-2083-84-00000003", kind: "REFUND", sentAt: at, status: "SENT", transactionId: "TX-555",
};
const papers: Array<[string, string, unknown, unknown]> = [
  ["invoice", "invoice", base, null],
  ["invoice-paid", "invoice", paid, null],
  ["invoice-stay", "invoice", { ...base, fee: 3000, kind: "SHORT_STAY", stay }, null],
  ["invoice-softmato", "invoice", { ...base, softmatoInvoiceNo: "INV-000123" }, null],
  ["receipt", "receipt", paid, null],
  ["refund", "refund", { ...paid, settlement: { refund: 1125, refundPercent: 75 }, status: "CANCELLED_BY_USER" }, transfer],
];

mkdirSync(join(out, "pdf/bookings"), { recursive: true });
for (const [name, kind, booking, sent] of papers) {
  writeFileSync(join(out, `pdf/bookings/${name}.pdf`), await doc.renderBookingDocument(doc.bookingDocumentLayout(kind as never, booking as never, sent as never, issuer)));
}
