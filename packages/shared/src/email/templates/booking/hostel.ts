import { roomTypeLabel } from "../../../constants/room-types";
import { PLATFORM_NAME } from "../../../brand/brand";
import {
  ctaButton,
  detailsTable,
  emailLayout,
  escapeHtml,
  greeting,
  paragraph,
  smallPrint,
  type EmailContent,
} from "../layout";
import { hoursWord, rupees } from "./parts";

/**
 * Mail to a hostel's admins about bookings on their hostel.
 *
 * The fee is paid to HostelPalika, so these never ask the hostel to collect
 * anything. They say who booked, which room, by when to answer, and what the
 * hostel's share will be — the facts an owner needs to say yes or no from a
 * phone.
 */

type HostelBase = {
  bookingsUrl: string;
  code: string;
  guestName: string;
  hostelName: string;
  name?: string | null;
  roomType: string;
};

export type HostelBookingClosedCause =
  | "CANCELLED_BEFORE_CONFIRMATION"
  | "CANCELLED_BY_USER"
  | "CANCELLED_BY_PLATFORM"
  | "DECLINED"
  | "HOSTEL_NO_RESPONSE"
  | "NO_SHOW";

const CLOSED_COPY: Record<HostelBookingClosedCause, { heading: string; line: string }> = {
  CANCELLED_BEFORE_CONFIRMATION: {
    heading: "Booking cancelled by the guest",
    line: "The guest cancelled before you answered. You do not need to do anything.",
  },
  CANCELLED_BY_PLATFORM: {
    heading: `Booking cancelled by ${PLATFORM_NAME}`,
    line: `${PLATFORM_NAME} cancelled this booking and refunded the guest.`,
  },
  DECLINED: {
    heading: "You said no to a booking",
    line: `You said no to this booking. ${PLATFORM_NAME} gives the guest all the money back. You do not need to do anything.`,
  },
  CANCELLED_BY_USER: {
    heading: "Booking cancelled by the guest",
    line: "The guest cancelled. The bed is free again.",
  },
  HOSTEL_NO_RESPONSE: {
    heading: "Booking missed",
    line: "Nobody answered this booking in time. The guest gets all the money back. This counts as a missed booking for your hostel.",
  },
  NO_SHOW: {
    heading: "Guest did not move in",
    line: "The guest did not move in on time. The bed is free again.",
  },
};

/** A booking on the hostel that ended without the hostel doing it. */
export function bookingClosedForHostelEmail(
  input: HostelBase & {
    cause: HostelBookingClosedCause;
    hostelShare: number;
    reason?: string | null;
  },
): EmailContent {
  const copy = CLOSED_COPY[input.cause];

  return {
    category: "billing",
    subject: `${copy.heading} — ${input.guestName}, ${roomTypeLabel(input.roomType)}`,
    html: emailLayout({
      bodyHtml: [
        greeting(input.name),
        paragraph(copy.line),
        detailsTable([
          { label: "Booking", value: input.code },
          { label: "Guest", value: input.guestName },
          { label: "Room type", value: input.roomType },
          { label: "Reason", value: input.reason ?? "" },
          {
            emphasis: input.hostelShare > 0,
            label: "Your share",
            value: input.hostelShare > 0 ? rupees(input.hostelShare) : "",
          },
        ]),
        ctaButton(input.bookingsUrl, "Open bookings"),
      ].join(""),
      eyebrow: "Bookings",
      heading: copy.heading,
      preheader: `${input.code} at ${input.hostelName}: ${copy.line}`,
    }),
  };
}

/** The hostel's share of a booking fee has left our account. */
export function bookingPayoutSentEmail(input: {
  amount: number;
  bookingsUrl: string;
  code: string;
  documentNumber?: string | null;
  guestName: string;
  hostelName: string;
  name?: string | null;
  paidTo: string;
  roomType: string;
  sentOn: string;
  transactionId: string;
}): EmailContent {
  return {
    category: "billing",
    subject: `We sent you ${rupees(input.amount)} for booking ${input.code}`,
    html: emailLayout({
      bodyHtml: [
        greeting(input.name),
        paragraph(`${PLATFORM_NAME} sent ${escapeHtml(input.hostelName)} its part of a booking fee.`),
        detailsTable([
          { emphasis: true, label: "Amount", value: rupees(input.amount) },
          { label: "Paid to", value: input.paidTo },
          { label: "Sent on", value: input.sentOn },
          { label: "Transaction ID", value: input.transactionId },
          { label: "Payment slip", value: input.documentNumber ?? "" },
          { label: "Booking", value: input.code },
          { label: "Guest", value: input.guestName },
          { label: "Room type", value: input.roomType },
        ]),
        ctaButton(input.bookingsUrl, "Open bookings"),
      ].join(""),
      eyebrow: "Payment",
      heading: "We sent your money",
      preheader: `${rupees(input.amount)} sent to ${input.paidTo}. Transaction ${input.transactionId}.`,
    }),
  };
}

/** A paid booking still unanswered as the window closes. */
export function bookingAnswerReminderEmail(
  input: HostelBase & {
    answerBy: string;
    guestPhone?: string | null;
    hostelShare: number;
    hoursLeft: number;
  },
): EmailContent {
  return {
    category: "billing",
    subject: `Please answer ${input.guestName}'s booking — only ${hoursWord(input.hoursLeft)} left`,
    html: emailLayout({
      bodyHtml: [
        greeting(input.name),
        paragraph(`<strong>${escapeHtml(input.guestName)}</strong> is still waiting for your answer.`),
        detailsTable([
          { label: "Booking", value: input.code },
          { label: "Guest", value: input.guestName },
          { label: "Phone", value: input.guestPhone ?? "" },
          { label: "Room type", value: input.roomType },
          { emphasis: true, label: "Answer by", value: input.answerBy },
          { label: "You get after they move in", value: rupees(input.hostelShare) },
        ]),
        ctaButton(input.bookingsUrl, "Say yes or no"),
        smallPrint(
          `If you do not answer by ${escapeHtml(input.answerBy)}, the booking is cancelled, the guest gets all the money back, and it counts as a missed booking.`,
        ),
      ].join(""),
      eyebrow: "Reminder",
      heading: "Please answer this booking",
      preheader: `${input.guestName} is waiting. Answer by ${input.answerBy}.`,
      urgent: true,
    }),
  };
}

/** Too many missed or cancelled bookings: the Book button is off until we turn it back on. */
export function bookingsPausedEmail(input: {
  bookingsUrl: string;
  hostelName: string;
  name?: string | null;
  strikes: number;
  windowDays: number;
}): EmailContent {
  return {
    category: "billing",
    subject: `Bookings are stopped for ${input.hostelName}`,
    html: emailLayout({
      bodyHtml: [
        greeting(input.name),
        paragraph(
          `${escapeHtml(input.hostelName)} missed or cancelled ${input.strikes} bookings in ${input.windowDays} days. So people cannot book it now.`,
        ),
        paragraph(
          `Bookings you already said yes to stay the same. Contact ${PLATFORM_NAME} to turn bookings on again.`,
        ),
        ctaButton(input.bookingsUrl, "Open bookings"),
      ].join(""),
      eyebrow: "Bookings",
      heading: "Bookings are stopped",
      preheader: `${input.strikes} missed or cancelled bookings in ${input.windowDays} days.`,
      urgent: true,
    }),
  };
}

/** A paid booking waiting for the hostel's answer. */
export function bookingRequestEmail(
  input: HostelBase & {
    answerBy: string;
    answerHours: number;
    guestPhone?: string | null;
    holdDays: number;
    hostelShare: number;
  },
): EmailContent {
  return {
    category: "billing",
    subject: `New booking from ${input.guestName} — please answer by ${input.answerBy}`,
    html: emailLayout({
      bodyHtml: [
        greeting(input.name),
        paragraph(
          `<strong>${escapeHtml(input.guestName)}</strong> booked a <strong>${escapeHtml(input.roomType)}</strong> at ${escapeHtml(input.hostelName)} and paid the booking fee to ${PLATFORM_NAME}.`,
        ),
        detailsTable([
          { label: "Booking", value: input.code },
          { label: "Guest", value: input.guestName },
          { label: "Phone", value: input.guestPhone ?? "" },
          { label: "Room type", value: input.roomType },
          { emphasis: true, label: "Answer by", value: input.answerBy },
          { label: "You get after they move in", value: rupees(input.hostelShare) },
        ]),
        paragraph(
          `Say yes to keep one bed for ${input.holdDays} days. They move in when you scan their ${PLATFORM_NAME} ID card.`,
        ),
        ctaButton(input.bookingsUrl, "Say yes or no"),
        smallPrint(
          `If you do not answer in ${input.answerHours} hours, the booking is cancelled, the guest gets all the money back, and it counts as a missed booking.`,
        ),
      ].join(""),
      eyebrow: "New booking",
      heading: "You have a new booking",
      preheader: `${input.guestName} booked a ${roomTypeLabel(input.roomType)}. Answer by ${input.answerBy}.`,
    }),
  };
}
