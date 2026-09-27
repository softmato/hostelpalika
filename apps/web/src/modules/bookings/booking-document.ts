import { PDFDocument } from "pdf-lib";

import { amountInWords } from "@/modules/billing/documents/amount-in-words";
import {
  documentAdDate,
  documentAmount,
  documentBsDate,
  documentInstant,
  drawFooter,
  drawIssuer,
  drawTaxNote,
  loadInk,
  type Issuer,
} from "@/modules/billing/documents/document-parts";
import { Cursor } from "@/modules/billing/documents/layout";
import { COLORS, MARGIN, PAGE, SIZE, SPACE } from "@/modules/billing/documents/theme";
import { policyRows, settlementFor } from "@/modules/bookings/booking-terms";
import { amountDue, stayDatesText } from "@/modules/bookings/short-stay";
import {
  BOOKING_STATUS_LABELS,
  destinationText,
  type BookingRecord,
  type TransferRecord,
} from "@/modules/bookings/booking-views";

/**
 * The four booking papers: invoice, receipt, refund note, payout advice.
 *
 * One layout, the receipt's: a single amount centred, everything else
 * provenance for it. Built from the rows at the moment of download, so a paper
 * always prints what the records say — and the booking's own frozen terms, not
 * today's settings. Plain ASCII punctuation throughout: these are printed and
 * photocopied, and a glyph the font lacks is a hole in a money document.
 */

export const BOOKING_DOCUMENT_KINDS = ["invoice", "receipt", "refund", "payout"] as const;

export type BookingDocumentKind = (typeof BOOKING_DOCUMENT_KINDS)[number];

export type BookingDocumentInput = {
  against: { label: string; value: string } | null;
  amount: number;
  amountLabel: string;
  currency: string;
  date: Date;
  dateLabel: string;
  fields: Array<{ label: string; value: string }>;
  footerNote: string;
  issuer: Issuer;
  notes: string[];
  number: string;
  numberLabel: string;
  party: { detail: string; eyebrow: string; name: string };
  title: string;
};

function refundPolicyNotes(booking: BookingRecord, money: (amount: number) => string) {
  const { fee, terms } = booking;

  return [
    "Refund policy for this booking:",
    `- Full refund (${money(fee)}) if cancelled before the hostel confirms, or if the hostel`,
    `  declines, does not answer within ${terms.hostelAnswerHours} hours, or cancels.`,
    ...policyRows(terms, fee).map(
      (row) =>
        `- Cancelled on day${row.fromDay === row.throughDay ? ` ${row.fromDay}` : `s ${row.fromDay}-${row.throughDay}`} after confirmation: ${row.refundPercent}% (${money(row.refund)}).`,
    ),
    `- Not moved in within ${terms.holdDays} days of confirmation: ${terms.noShowRefundPercent}% (${money(settlementFor(fee, terms.noShowRefundPercent, terms).refund)}).`,
    "The booking fee does not count towards rent, admission fee or deposit.",
  ];
}

/** What goes on the page. Pure, so a test can read a paper without parsing a PDF. */
export function bookingDocumentLayout(
  kind: BookingDocumentKind,
  booking: BookingRecord,
  transfer: TransferRecord | null,
  issuer: Issuer,
): BookingDocumentInput {
  const currency = booking.currency ?? "NPR";
  const money = (amount: number) => `${currency} ${documentAmount(amount)}`;
  const forLine = `Booking fee - ${booking.roomType}, ${booking.hostelSnapshot.name}`;
  const guestParty = (eyebrow: string, detail = booking.guest.email ?? "") => ({
    detail,
    eyebrow,
    name: booking.guest.name,
  });

  // Softmato issues the invoice and receipt for the fee; ours is the booking itself.
  if (kind === "invoice" && booking.softmatoInvoiceNo) {
    const paid = Boolean(booking.paymentVerifiedAt);

    return {
      against: { label: "Invoice (Softmato)", value: booking.softmatoInvoiceNo },
      amount: amountDue(booking),
      amountLabel: paid ? "Booking fee paid" : "Booking fee due",
      currency,
      date: booking.createdAt,
      dateLabel: "Booked on",
      fields: [
        { label: "Hostel", value: booking.hostelSnapshot.name },
        { label: "Room", value: booking.roomType },
        { label: "Monthly rent", value: money(booking.monthlyRent) },
        ...(booking.stay
          ? [{ label: "Stay", value: `${booking.stay.nights} nights, ${stayDatesText(booking.stay)} (${money(booking.stay.amount)})` }]
          : []),
        {
          label: "Status",
          value: paid
            ? `Paid - Softmato receipt ${booking.receiptNumber ?? ""}`.trim()
            : `Unpaid - pay by ${documentInstant(booking.paymentDueBy)}`,
        },
      ],
      footerNote: "Booking confirmation. The invoice and receipt for the fee are issued by Softmato.",
      issuer,
      notes: refundPolicyNotes(booking, money),
      number: booking.code,
      numberLabel: "Booking",
      party: guestParty("Booked by"),
      title: "Booking Confirmation",
    };
  }

  if (kind === "invoice") {
    const paid = Boolean(booking.paymentVerifiedAt);

    return {
      against: null,
      amount: amountDue(booking),
      amountLabel: paid ? "Amount paid" : "Amount due",
      currency,
      date: booking.createdAt,
      dateLabel: "Invoice Date",
      fields: [
        { label: "For", value: forLine },
        { label: "Booking code", value: booking.code },
        { label: "Monthly rent", value: money(booking.monthlyRent) },
        ...(booking.stay
          ? [{ label: "Stay", value: `${booking.stay.nights} nights, ${stayDatesText(booking.stay)} (${money(booking.stay.amount)})` }]
          : []),
        { label: "Fee rate", value: `${booking.terms.feePercent}% of one month's rent` },
        {
          label: "Status",
          value: paid
            ? `Paid - receipt ${booking.receiptNumber ?? ""}`.trim()
            : `Unpaid - pay by ${documentInstant(booking.paymentDueBy)}`,
        },
      ],
      footerNote: "Computer-generated invoice. No signature required.",
      issuer,
      notes: refundPolicyNotes(booking, money),
      number: booking.invoiceNumber,
      numberLabel: "Invoice No.",
      party: guestParty("Billed to"),
      title: "Booking Invoice",
    };
  }

  if (kind === "receipt") {
    return {
      against: { label: "Against Invoice", value: booking.invoiceNumber },
      amount: amountDue(booking),
      amountLabel: "Amount received",
      currency,
      date: booking.paymentVerifiedAt ?? booking.createdAt,
      dateLabel: "Receipt Date",
      fields: [
        { label: "For", value: forLine },
        { label: "Booking code", value: booking.code },
        { label: "Checked at", value: booking.paymentVerifiedAt ? documentInstant(booking.paymentVerifiedAt) : "" },
      ],
      footerNote: "Computer-generated receipt. No signature required.",
      issuer,
      notes: [
        `${issuer.legalName} holds this fee until the booking ends, then refunds it or pays the`,
        "hostel its share, under the refund policy printed on the invoice.",
      ],
      number: booking.receiptNumber ?? "",
      numberLabel: "Receipt No.",
      party: guestParty("Received from"),
      title: "Booking Fee Receipt",
    };
  }

  const sent = transfer!;
  const settlement = booking.settlement;
  const shared = [
    { label: "Transaction ID", value: sent.transactionId ?? "" },
    { label: "Sent at", value: sent.sentAt ? documentInstant(sent.sentAt) : "" },
  ];

  if (kind === "refund") {
    return {
      against: booking.receiptNumber ? { label: "Against Receipt", value: booking.receiptNumber } : null,
      amount: sent.amount,
      amountLabel: "Amount refunded",
      currency,
      date: sent.sentAt ?? new Date(),
      dateLabel: "Refund Date",
      fields: [
        { label: "Booking code", value: booking.code },
        { label: "Paid", value: money(amountDue(booking)) },
        {
          label: "Refund rate",
          value: typeof settlement?.refundPercent === "number" ? `${settlement.refundPercent}%` : "",
        },
        { label: "Reason", value: BOOKING_STATUS_LABELS[booking.status] },
        ...shared,
      ],
      footerNote: "Computer-generated refund note. No signature required.",
      issuer,
      notes: [],
      number: sent.documentNumber ?? "",
      numberLabel: "Refund Note No.",
      party: guestParty("Refunded to", destinationText(sent.destination)),
      title: "Refund Note",
    };
  }

  return {
    against: { label: "Booking", value: booking.code },
    amount: sent.amount,
    amountLabel: "Amount paid out",
    currency,
    date: sent.sentAt ?? new Date(),
    dateLabel: "Advice Date",
    fields: [
      { label: "Guest", value: booking.guest.name },
      { label: "Room type", value: booking.roomType },
      { label: "Booking fee", value: money(booking.fee) },
      { label: "Refunded to guest", value: money(settlement?.refund ?? 0) },
      { label: "Kept", value: money(settlement?.kept ?? 0) },
      {
        label: "Hostel share",
        value: booking.stay
          ? `${booking.terms.hostelSharePercent}% of the fee kept, ${booking.stay.hostelSharePercent}% of the nights kept`
          : `${booking.terms.hostelSharePercent}% of kept`,
      },
      ...shared,
    ],
    footerNote: "Computer-generated payout advice. No signature required.",
    issuer,
    notes: [],
    number: sent.documentNumber ?? "",
    numberLabel: "Advice No.",
    party: { detail: destinationText(sent.destination), eyebrow: "Paid to", name: booking.hostelSnapshot.name },
    title: "Payout Advice",
  };
}

export async function renderBookingDocument(input: BookingDocumentInput): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([PAGE.width, PAGE.height]);
  const ink = await loadInk(pdf);
  const cursor = new Cursor(page, ink);

  pdf.setTitle(`${input.title} ${input.number}`);
  pdf.setProducer(input.issuer.legalName);
  pdf.setCreator(input.issuer.productName || input.issuer.legalName);

  drawIssuer(cursor, input.issuer, { compact: true });
  cursor.down(SPACE.tight);
  cursor.ruleStrong();
  cursor.down(SPACE.tight);
  cursor.title("center", input.title);
  cursor.down(SPACE.tight);

  cursor.field(input.numberLabel, input.number, { valueColor: COLORS.accent });
  cursor.field(input.dateLabel, documentBsDate(input.date), { suffix: `(${documentAdDate(input.date)})` });

  if (input.against) {
    cursor.field(input.against.label, input.against.value);
  }

  cursor.down(SPACE.tight);
  cursor.rule();

  cursor.eyebrow(MARGIN.left, input.party.eyebrow);
  cursor.line(MARGIN.left, input.party.name, { font: ink.bold, size: SIZE.partyName });

  if (input.party.detail) {
    cursor.line(MARGIN.left, input.party.detail, { color: COLORS.accent, size: SIZE.label });
  }

  cursor.down(SPACE.tight);
  cursor.rule();

  // The same gaps as the receipt: the figure's ascenders climb into a tight gap.
  cursor.down(SPACE.tight);
  cursor.eyebrow("center", input.amountLabel);
  cursor.down(SPACE.block);
  cursor.line("center", `${input.currency} ${documentAmount(input.amount)}`, {
    font: ink.monoBold,
    size: SIZE.amount,
  });
  cursor.down(4);
  cursor.line("center", amountInWords(input.amount), { color: COLORS.accent, size: SIZE.label });
  cursor.down(SPACE.block);
  cursor.rule();

  for (const field of input.fields) {
    if (field.value.trim()) {
      cursor.field(field.label, field.value, { valueFont: ink.regular });
    }
  }

  cursor.down(SPACE.tight);
  cursor.rule();

  for (const note of input.notes) {
    cursor.line(MARGIN.left, note, { color: COLORS.accent, size: SIZE.footnote });
  }

  if (input.notes.length > 0) {
    cursor.down(SPACE.tight);
  }

  drawTaxNote(cursor, input.issuer, "document");
  drawFooter(cursor, { note: input.footerNote, reference: input.number });

  return pdf.save();
}
