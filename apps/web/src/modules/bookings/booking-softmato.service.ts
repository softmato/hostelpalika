import "server-only";

import { AuditLogModel } from "@hostel/db/models/AuditLog";
import { BookingModel } from "@hostel/db/models/Booking";
import { BookingPaymentModel } from "@hostel/db/models/BookingPayment";
import { BookingTransferModel } from "@hostel/db/models/BookingTransfer";

import type { ApiPrincipal } from "@/lib/api-auth";
import { logger } from "@/lib/logger";
import { siteUrl } from "@/lib/site";
import { isSoftmatoDown } from "@/modules/billing/softmato/client";
import { rememberTask, unlessSoftmatoDown } from "@/modules/billing/softmato/outage";
import { checkoutReturnUrl } from "@/modules/billing/softmato/checkout";
import { softmato } from "@/modules/billing/softmato/client";
import { isSoftmatoConfigured } from "@/modules/billing/softmato/config";
import { fetchInvoiceDetail } from "@/modules/billing/softmato/documents";
import { rupeesToPaisa } from "@/modules/billing/softmato/money";
import { markBookingPaid } from "@/modules/bookings/booking-review.service";
import { expireUnpaidBooking, loadOwnBooking } from "@/modules/bookings/booking.service";
import type { BookingRecord } from "@/modules/bookings/booking-views";
import { amountDue, stayDatesText } from "@/modules/bookings/short-stay";
import { BookingError } from "@/modules/bookings/booking.errors";

/**
 * The booking fee on Softmato's rail — the guest pays the platform, never the
 * hostel (`booking-policy.ts` says so to them), so it is the platform's money
 * and Softmato's invoice is the right paper for it.
 *
 * ## One invoice per booking, however many times Pay is pressed
 *
 * `external_ref` is the booking's own id, unique forever. Booking *codes* are
 * short and may come round again; a reference built from one could hand a new
 * booking an old, already-paid invoice. A retry, a second tab, a crash between
 * our write and theirs — all get the same invoice back.
 *
 * ## Two settlers, one paid booking
 *
 * The webhook and the return page both call `settleBookingFromSoftmato`, and
 * the sweep asks it before expiring anything. It moves the booking with a
 * compare-and-set on `AWAITING_PAYMENT`, so whichever runs second finds the
 * work done. Money that lands after the booking already ended (a session
 * opened just before the deadline) is owed back in full, and is raised as a
 * refund in the same queue every other booking refund goes through.
 */

export async function openBookingCheckout(
  bookingId: string,
  principal: ApiPrincipal,
  step: (name: "invoice" | "session") => void = () => {},
  via?: "app",
) {
  if (!isSoftmatoConfigured()) {
    throw new BookingError("Online payment is not set up on this deployment yet.", "ONLINE_PAYMENT_UNAVAILABLE", 503);
  }

  step("invoice");
  const booking = await loadOwnBooking(bookingId, principal);
  const now = new Date();

  if (booking.status !== "AWAITING_PAYMENT") {
    throw new BookingError("This booking is not waiting for payment.", "BOOKING_NOT_AWAITING_PAYMENT", 409);
  }

  if (new Date(booking.paymentDueBy).getTime() <= now.getTime()) {
    await expireUnpaidBooking(booking, now);

    throw new BookingError(
      "The time to pay for this booking has run out. Book again if the room is still free.",
      "BOOKING_EXPIRED",
      410,
    );
  }

  return unlessSoftmatoDown(
    () => bookingTask(booking),
    async () => {
      const invoiceId = await ensureBookingInvoice(booking);

      step("session");
      const returnUrl = new URL(checkoutReturnUrl({ booking: String(booking._id) }));

      // The app's browser sheet is not signed in; it hands straight back to the app.
      if (via === "app") returnUrl.searchParams.set("via", "app");

      const session = await softmato().createCheckout({
        invoice_id: invoiceId,
        return_url: returnUrl.toString(),
      });

      return { checkoutUrl: session.checkout_url, expiresAt: session.expires_at };
    },
  );
}

const bookingTask = (booking: BookingRecord) => ({
  email: booking.guest.email || null,
  kind: "BOOKING_PAYMENT" as const,
  link: `${siteUrl()}/bookings/${String(booking._id)}`,
  name: booking.guest.name,
  ref: String(booking._id),
});

/**
 * The fee's invoice at Softmato: raised when the booking is made and reused by
 * every Pay press after (`external_ref` makes a repeat return the same one).
 */
export async function ensureBookingInvoice(booking: BookingRecord): Promise<string> {
  const invoice = await softmato().createInvoice({
    customer: {
      external_ref: `hh-guest:${String(booking.userId)}`,
      name: booking.guest.name,
      ...(booking.guest.email ? { email: booking.guest.email } : {}),
    },
    due_at: new Date(booking.paymentDueBy).toISOString(),
    external_ref: `hh-bkg:${String(booking._id)}`,
    lines: [
      {
        description: `Booking fee: ${booking.hostelSnapshot.name}, ${booking.roomType} (${booking.code})`,
        quantity: 1,
        // The fee frozen on the booking, read on the server. Never a client figure.
        unit_price_minor: rupeesToPaisa(booking.fee),
      },
      ...(booking.stay
        ? [
            {
              description: `Short stay: ${booking.stay.nights} nights, ${stayDatesText(booking.stay)}`,
              quantity: booking.stay.nights,
              unit_price_minor: rupeesToPaisa(booking.stay.dailyRate),
            },
          ]
        : []),
    ],
  });

  if (!booking.softmatoInvoiceNo) {
    await BookingModel.updateOne(
      { _id: booking._id },
      { $set: { softmatoInvoiceNo: invoice.invoice_no ?? invoice.invoice_id } },
    );
  }

  return invoice.invoice_id;
}

/** At booking time: raised now if Softmato answers, else remembered and emailed later. */
export async function raiseBookingInvoiceSoon(booking: BookingRecord): Promise<void> {
  if (!isSoftmatoConfigured()) return;

  await ensureBookingInvoice(booking).catch(async (error: unknown) => {
    if (isSoftmatoDown(error)) await rememberTask(bookingTask(booking));
    else logger.error("Booking invoice not raised.", { bookingId: String(booking._id), error: String(error) });
  });
}

export type BookingSettlement = "paid" | "unpaid" | "refund_due" | "no_document";

/** Settles a booking from Softmato's own ledger. Safe to call any number of times. */
export async function settleBookingFromSoftmato(
  booking: BookingRecord,
  step: (name: "record") => void = () => {},
): Promise<BookingSettlement> {
  if (!booking.softmatoInvoiceNo) return "no_document";
  if (booking.paymentVerifiedAt) return "paid";

  const detail = await fetchInvoiceDetail(booking.softmatoInvoiceNo);

  if (!detail) return "no_document";
  if (detail.status !== "paid") return "unpaid";

  const now = new Date();

  // The money is in whoever wins the move below, so it gets its row first —
  // one row, however many settlers run (the index on `softmatoInvoiceNo` is unique).
  await BookingPaymentModel.updateOne(
    { bookingId: booking._id, softmatoInvoiceNo: booking.softmatoInvoiceNo },
    {
      $setOnInsert: {
        amount: amountDue(booking),
        hostelId: booking.hostelId,
        reviewedAt: now,
        status: "APPROVED",
        submittedAt: now,
        userId: booking.userId,
      },
    },
    { upsert: true },
  ).catch((error: { code?: number }) => {
    if (error?.code !== 11000) throw error;
  });

  if (booking.status === "AWAITING_PAYMENT") {
    step("record");

    try {
      // Softmato's transaction number is the receipt the guest is sent.
      const paid = detail.payments?.at(-1)?.transaction_id ?? null;

      await markBookingPaid(booking, null, now, "AWAITING_PAYMENT", paid);

      return "paid";
    } catch (error) {
      if (!(error instanceof BookingError)) throw error;
    }
  }

  // Lost the move: either the other settler won, or the booking ended first.
  const current = await BookingModel.findById(booking._id).lean<BookingRecord | null>();

  if (!current || current.paymentVerifiedAt) return "paid";

  await BookingTransferModel.updateOne(
    { bookingId: current._id, kind: "REFUND" },
    {
      $setOnInsert: {
        amount: amountDue(current),
        bookingId: current._id,
        hostelId: current.hostelId,
        kind: "REFUND",
        status: "DUE",
        userId: current.userId,
      },
    },
    { upsert: true },
  );

  logger.error("Booking fee arrived after the booking ended; full refund raised.", {
    bookingId: String(current._id),
    softmatoInvoiceNo: current.softmatoInvoiceNo,
    status: current.status,
  });

  await AuditLogModel.create({
    action: "BOOKING_PAID_AFTER_END",
    actorType: "SYSTEM",
    entityId: String(current._id),
    entityType: "Booking",
    hostelId: current.hostelId,
    metadata: { code: current.code, fee: current.fee, status: current.status, total: amountDue(current) },
  }).catch(() => undefined);

  return "refund_due";
}

export type BookingReturnState =
  | { kind: "booking_paid"; code: string; hostelAnswerBy: string | null; hostelName: string }
  | { kind: "booking_refund"; code: string }
  | { kind: "unpaid" }
  | { kind: "pending_document" }
  | { kind: "unknown" };

/** What the guest who just came back from checkout should be told. */
export async function readBookingReturn(
  bookingId: string,
  principal: ApiPrincipal,
  step: (name: "confirm" | "record" | "activate") => void = () => {},
): Promise<BookingReturnState> {
  const booking = await loadOwnBooking(bookingId, principal).catch(() => null);

  if (!booking) return { kind: "unknown" };
  if (!booking.softmatoInvoiceNo && !booking.paymentVerifiedAt) return { kind: "unpaid" };

  step("confirm");
  const settled = await settleBookingFromSoftmato(booking, step).catch((error: unknown) => {
    logger.error("Booking return could not settle from Softmato.", {
      bookingId,
      error: error instanceof Error ? error.message : String(error),
    });

    return "no_document" as const;
  });

  if (settled === "unpaid") return { kind: "unpaid" };
  if (settled === "no_document") return { kind: "pending_document" };
  if (settled === "refund_due") return { code: booking.code, kind: "booking_refund" };

  step("activate");
  const paid = await BookingModel.findById(booking._id).lean<BookingRecord | null>();

  return {
    code: booking.code,
    hostelAnswerBy: paid?.hostelAnswerBy ? new Date(paid.hostelAnswerBy).toISOString() : null,
    hostelName: booking.hostelSnapshot.name,
    kind: "booking_paid",
  };
}
