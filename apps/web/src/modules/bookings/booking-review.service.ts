import "server-only";

import { Types } from "mongoose";

import { AuditLogModel } from "@hostel/db/models/AuditLog";
import { BookingModel, type BookingStatus } from "@hostel/db/models/Booking";
import { BookingPaymentModel } from "@hostel/db/models/BookingPayment";
import { HostelModel } from "@hostel/db/models/Hostel";
import {
  bookingPaymentRejectedEmail,
  bookingPaymentVerifiedEmail,
} from "@hostel/shared/email/templates/booking/guest";
import { bookingRequestEmail } from "@hostel/shared/email/templates/booking/hostel";

import type { ApiPrincipal } from "@/lib/api-auth";
import { connectToDatabase } from "@/lib/db";
import { Role } from "@/lib/roles";
import { allocate } from "@/modules/billing/documents/issue";
import { getBookingConfig } from "@/modules/bookings/booking-config";
import { endBooking, moveBooking } from "@/modules/bookings/booking-lifecycle";
import {
  appUrl,
  bookingFacts,
  guestBookingPath,
  hostelBookingsPath,
  notifyGuest,
  notifyHostel,
  when,
} from "@/modules/bookings/booking-notify";
import { bookingDocumentAttachment } from "@/modules/bookings/booking-documents.service";
import { HOUR_MS, hostelAnswerDeadline } from "@/modules/bookings/booking-terms";
import { reviewBookingPaymentSchema } from "@/modules/bookings/booking.validation";
import { hostelShareIfCheckedIn, type BookingRecord } from "@/modules/bookings/booking-views";
import { stayDatesText } from "@/modules/bookings/short-stay";
import { BookingError } from "@/modules/bookings/booking.errors";

/**
 * The superadmin's check of a booking screenshot against money received.
 *
 * **The only path that turns a screenshot into a paid booking.** Approving
 * issues the receipt, starts the hostel's answer window and tells the hostel;
 * refusing sends the booking back to waiting for payment with the reason, so
 * the person can pay or send the right screenshot.
 */

type PaymentRecord = {
  _id: Types.ObjectId;
  amount: number;
  bookingId: Types.ObjectId;
  note?: string | null;
  proofAssetId: Types.ObjectId;
  reference?: string | null;
  status: "APPROVED" | "IN_REVIEW" | "REJECTED";
  submittedAt: Date;
};

export type BookingPaymentToCheck = {
  amount: number;
  bookingCode: string;
  bookingId: string;
  checkBy: string;
  guest: { email: string; name: string; phone: string };
  hostelName: string;
  id: string;
  note: string | null;
  /** Read through `/api/v1/files/{id}/url`, which re-authorises every open. */
  proofAssetId: string;
  reference: string | null;
  roomType: string;
  submittedAt: string;
};

/** Screenshots waiting on a person, oldest first — the queue is a promise of hours. */
export async function listBookingPaymentsToCheck(): Promise<BookingPaymentToCheck[]> {
  await connectToDatabase();

  const [payments, config] = await Promise.all([
    BookingPaymentModel.find({ status: "IN_REVIEW" })
      .sort({ submittedAt: 1 })
      .limit(200)
      .lean<PaymentRecord[]>(),
    getBookingConfig(),
  ]);

  if (payments.length === 0) {
    return [];
  }

  const bookings = await BookingModel.find({ _id: { $in: payments.map((payment) => payment.bookingId) } })
    .lean<BookingRecord[]>();
  const bookingById = new Map(bookings.map((booking) => [String(booking._id), booking]));

  return payments.flatMap((payment) => {
    const booking = bookingById.get(String(payment.bookingId));

    if (!booking) return [];

    return [
      {
        amount: payment.amount,
        bookingCode: booking.code,
        bookingId: String(booking._id),
        checkBy: new Date(payment.submittedAt.getTime() + config.paymentCheckHours * HOUR_MS).toISOString(),
        guest: {
          email: booking.guest.email ?? "",
          name: booking.guest.name,
          phone: booking.guest.phone ?? "",
        },
        hostelName: booking.hostelSnapshot.name,
        id: String(payment._id),
        note: payment.note ?? null,
        proofAssetId: String(payment.proofAssetId),
        reference: payment.reference ?? null,
        roomType: booking.roomType,
        submittedAt: payment.submittedAt.toISOString(),
      },
    ];
  });
}

export async function reviewBookingPayment(
  paymentId: string,
  rawInput: unknown,
  principal: ApiPrincipal,
) {
  if (principal.role !== Role.SUPERADMIN) {
    throw new BookingError("Only a superadmin can check booking payments.", "FORBIDDEN", 403);
  }

  const input = reviewBookingPaymentSchema.parse(rawInput);

  await connectToDatabase();

  const payment = Types.ObjectId.isValid(paymentId)
    ? await BookingPaymentModel.findById(paymentId).lean<PaymentRecord | null>()
    : null;

  if (!payment) {
    throw new BookingError("Payment not found.", "PAYMENT_NOT_FOUND", 404);
  }

  if (payment.status !== "IN_REVIEW") {
    throw new BookingError("This payment has already been checked.", "PAYMENT_ALREADY_REVIEWED", 409);
  }

  const booking = await BookingModel.findById(payment.bookingId).lean<BookingRecord | null>();

  if (!booking || booking.status !== "PAYMENT_IN_REVIEW") {
    throw new BookingError("This booking is not waiting for a payment check.", "BOOKING_NOT_IN_REVIEW", 409);
  }

  const note = input.note?.trim().slice(0, 500) || null;
  const now = new Date();

  if (!input.approve && !note) {
    throw new BookingError("Say why, so the person knows what to fix.", "VALIDATION_ERROR", 422);
  }

  // Claim the payment row first: two reviewers pressing at once, one wins.
  const claimed = await BookingPaymentModel.findOneAndUpdate(
    { _id: payment._id, status: "IN_REVIEW" },
    {
      $set: {
        reviewNote: note,
        reviewedAt: now,
        reviewedBy: principal.userId,
        status: input.approve ? "APPROVED" : "REJECTED",
      },
    },
    { new: true },
  ).lean<PaymentRecord | null>();

  if (!claimed) {
    throw new BookingError("This payment has already been checked.", "PAYMENT_ALREADY_REVIEWED", 409);
  }

  await AuditLogModel.create({
    action: input.approve ? "BOOKING_PAYMENT_APPROVED" : "BOOKING_PAYMENT_REJECTED",
    actorId: principal.userId,
    actorType: "USER",
    entityId: String(payment._id),
    entityType: "BookingPayment",
    hostelId: booking.hostelId,
    metadata: { amount: payment.amount, code: booking.code, note },
  }).catch(() => undefined);

  return input.approve
    ? markBookingPaid(booking, principal.userId, now)
    : reject(booking, note ?? "", now);
}

/**
 * The fee is in: the booking goes to the hostel to answer, and both sides hear.
 *
 * Two callers. A superadmin approving a screenshot moves it out of
 * `PAYMENT_IN_REVIEW`; Softmato settling a checkout moves it straight out of
 * `AWAITING_PAYMENT`, with no person to name (`actorId` null). The move is a
 * compare-and-set on that status, so a webhook and the return page settling
 * the same payment at once produce one paid booking and one `null`.
 */
export async function markBookingPaid(
  booking: BookingRecord,
  actorId: string | null,
  now: Date,
  from: BookingStatus = "PAYMENT_IN_REVIEW",
  /** Softmato's transaction number when it took the fee; otherwise one is allocated here. */
  softmatoReceipt: string | null = null,
) {
  const hostelAnswerBy = hostelAnswerDeadline(booking.terms, now);
  const moved = await moveBooking(booking._id, from, {
    hostelAnswerBy,
    paymentVerifiedAt: now,
    paymentVerifiedBy: actorId,
    status: "AWAITING_HOSTEL",
  });

  if (!moved) {
    throw new BookingError("This booking is not waiting for a payment check.", "BOOKING_NOT_IN_REVIEW", 409);
  }

  // Numbered only once the move is won, so a lost race never burns a receipt number.
  const receiptNumber = softmatoReceipt ?? (await allocate("BOOKING_RECEIPT", now));
  const paid = { ...moved, receiptNumber };

  await BookingModel.updateOne({ _id: moved._id }, { $set: { receiptNumber } });

  // Both papers on the one mail: the receipt for what they just paid, and the
  // invoice again beside it, so the pair lives in the mailbox and not only
  // behind a sign-in they are not standing in front of.
  const papers = (
    await Promise.all([
      bookingDocumentAttachment("receipt", paid),
      bookingDocumentAttachment("invoice", paid),
    ])
  ).filter((paper) => paper !== null);

  await notifyGuest(paid, {
    action: "booking_payment_verified",
    attachments: papers,
    body: `Payment received for ${paid.code}. ${paid.hostelSnapshot.name} answers by ${when(hostelAnswerBy)}.`,
    email: bookingPaymentVerifiedEmail({
      booking: bookingFacts(paid),
      bookingUrl: appUrl(guestBookingPath(paid)),
      hostelAnswerBy: when(hostelAnswerBy),
      name: paid.guest.name,
      paidOn: when(now),
      receiptNumber,
    }),
    title: "Booking fee received",
    type: "BOOKING_PAYMENT_VERIFIED",
  });

  // The hostel may have gone while the screenshot waited. Nobody can hold a bed
  // there now, so the money goes straight back rather than waiting a day.
  const hostel = await HostelModel.findById(paid.hostelId)
    .select("isDeleted status")
    .lean<{ isDeleted?: boolean; status?: string } | null>();

  if (!hostel || hostel.isDeleted || hostel.status !== "PUBLISHED") {
    return endBooking(paid, {
      actorId,
      from: ["AWAITING_HOSTEL"],
      now,
      reason: "The hostel is no longer listed.",
      status: "CANCELLED_BY_PLATFORM",
    });
  }

  const hostelShare = hostelShareIfCheckedIn(paid);

  await notifyHostel(paid, {
    action: "booking_request",
    body: `${paid.guest.name} booked ${paid.stay ? `${paid.stay.nights} nights (${stayDatesText(paid.stay)}) in ` : ""}a ${paid.roomType}. Answer by ${when(hostelAnswerBy)}.`,
    email: (contact) =>
      bookingRequestEmail({
        answerBy: when(hostelAnswerBy),
        answerHours: paid.terms.hostelAnswerHours,
        bookingsUrl: appUrl(hostelBookingsPath(paid)),
        code: paid.code,
        guestName: paid.guest.name,
        guestPhone: paid.guest.phone || null,
        holdDays: paid.terms.holdDays,
        hostelName: paid.hostelSnapshot.name,
        hostelShare,
        name: contact.name,
        roomType: paid.roomType,
      }),
    priority: "HIGH",
    title: "New booking to confirm",
    type: "BOOKING_REQUEST",
  });

  return paid;
}

async function reject(booking: BookingRecord, reason: string, now: Date) {
  const config = await getBookingConfig();
  const paymentDueBy = new Date(now.getTime() + config.unpaidWindowHours * HOUR_MS);

  const waiting = await moveBooking(booking._id, "PAYMENT_IN_REVIEW", {
    paymentDueBy,
    paymentRejection: { at: now, reason },
    paymentSubmittedAt: null,
    status: "AWAITING_PAYMENT",
  });

  if (!waiting) {
    throw new BookingError("This booking is not waiting for a payment check.", "BOOKING_NOT_IN_REVIEW", 409);
  }

  await notifyGuest(waiting, {
    action: "booking_payment_rejected",
    body: `We could not confirm your payment for ${waiting.code}: ${reason}`,
    email: bookingPaymentRejectedEmail({
      booking: bookingFacts(waiting),
      bookingUrl: appUrl(guestBookingPath(waiting)),
      name: waiting.guest.name,
      payBy: when(paymentDueBy),
      reason,
    }),
    title: "Payment not confirmed",
    type: "BOOKING_PAYMENT_REJECTED",
  });

  return waiting;
}
