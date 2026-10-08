import "server-only";

import { BookingModel } from "@hostel/db/models/Booking";
import { BookingTransferModel } from "@hostel/db/models/BookingTransfer";
import type { EmailAttachment } from "@hostel/shared/email/sender";

import { connectToDatabase } from "@/lib/db";
import { softmatoDocument } from "@/modules/billing/documents/deliver";
import { downloadReceiptFile } from "@/modules/billing/softmato/documents";
import { documentFileName, loadIssuer } from "@/modules/billing/documents/issue";
import {
  BOOKING_DOCUMENT_KINDS,
  bookingDocumentLayout,
  renderBookingDocument,
  type BookingDocumentKind,
} from "@/modules/bookings/booking-document";
import type { BookingRecord, TransferRecord } from "@/modules/bookings/booking-views";

/**
 * Who may download which booking paper.
 *
 * The scope is chosen by the route the request landed on and passed in
 * explicitly, the way the plan documents do it: the guest reads their invoice,
 * receipt and refund note; a hostel reads its payout advice and nothing about
 * what the guest paid us; the platform reads all four. Anyone else gets `null`,
 * which the routes answer with the same 404 as a number that does not exist.
 */

export type BookingDocumentScope = { platform: true } | { userId: string } | { hostelIds: string[] };

function allowed(kind: BookingDocumentKind, booking: BookingRecord, scope: BookingDocumentScope) {
  if ("platform" in scope) {
    return true;
  }

  if ("userId" in scope) {
    return kind !== "payout" && String(booking.userId) === scope.userId;
  }

  return kind === "payout" && scope.hostelIds.includes(String(booking.hostelId));
}

export async function resolveBookingDocument(
  kind: string,
  documentNumber: string,
  scope: BookingDocumentScope,
) {
  if (!(BOOKING_DOCUMENT_KINDS as readonly string[]).includes(kind) || !documentNumber) {
    return null;
  }

  const paper = kind as BookingDocumentKind;

  await connectToDatabase();

  let booking: BookingRecord | null = null;
  let transfer: TransferRecord | null = null;

  if (paper === "invoice") {
    booking = await BookingModel.findOne({ invoiceNumber: documentNumber }).lean<BookingRecord | null>();
  } else if (paper === "receipt") {
    booking = await BookingModel.findOne({
      paymentVerifiedAt: { $ne: null },
      receiptNumber: documentNumber,
    }).lean<BookingRecord | null>();
  } else {
    transfer = await BookingTransferModel.findOne({
      documentNumber,
      kind: paper === "refund" ? "REFUND" : "PAYOUT",
      status: "SENT",
    }).lean<TransferRecord | null>();
    booking = transfer
      ? await BookingModel.findById(transfer.bookingId).lean<BookingRecord | null>()
      : null;
  }

  if (!booking || !allowed(paper, booking, scope)) {
    return null;
  }

  const drawOurs = async () =>
    renderBookingDocument(bookingDocumentLayout(paper, booking, transfer, await loadIssuer()));

  // Softmato's receipt, from the local copy or fetched once — redrawn only when they answer HTML.
  if (paper === "receipt" && booking.softmatoInvoiceNo) {
    return softmatoDocument("receipt", documentNumber, "1", () => downloadReceiptFile(documentNumber), drawOurs);
  }

  const bytes = await drawOurs();

  return { bytes, contentType: "application/pdf", filename: documentFileName(documentNumber) };
}

/**
 * A booking paper as an email attachment, so the invoice arrives with the mail
 * that asks for the money and the receipt with the mail that confirms it.
 *
 * The person who booked is not signed into anything at the moment they read
 * that mail, and a paper they have to come back and download is a paper most
 * of them never get. It renders from the same layout the download route uses,
 * so the file in the mailbox and the file behind the button are one document.
 *
 * Never throws, and never returns a half-answer: a render that fails costs the
 * reader an attachment, not the email telling them what happened.
 */
export async function bookingDocumentAttachment(
  kind: Extract<BookingDocumentKind, "invoice" | "receipt">,
  booking: BookingRecord,
): Promise<EmailAttachment | null> {
  const documentNumber = kind === "invoice" ? booking.invoiceNumber : booking.receiptNumber;

  // Softmato emails its own receipt; ours would be a second one.
  if (!documentNumber || (kind === "receipt" && booking.softmatoInvoiceNo)) {
    return null;
  }

  try {
    const bytes = await renderBookingDocument(
      bookingDocumentLayout(kind, booking, null, await loadIssuer()),
    );

    return { content: bytes, filename: documentFileName(documentNumber) };
  } catch (error) {
    console.warn(
      JSON.stringify({
        action: "booking_document_attachment_failed",
        code: booking.code,
        kind,
        level: "warn",
        reason: error instanceof Error ? error.message : String(error),
      }),
    );

    return null;
  }
}

/** The download itself, or the 404 that does not say whether the paper exists. */
export function bookingDocumentResponse(document: Awaited<ReturnType<typeof resolveBookingDocument>>) {
  if (!document) {
    return new Response("Not found", { status: 404 });
  }

  return new Response(new Uint8Array(document.bytes), {
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Disposition": `attachment; filename="${document.filename}"`,
      "Content-Type": document.contentType,
    },
  });
}
