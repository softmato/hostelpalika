import { PLATFORM_NAME } from "../../../brand/brand";
import {
  ctaButton,
  detailsTable,
  emailLayout,
  escapeHtml,
  greeting,
  paragraph,
  smallPrint,
  textLink,
  type EmailContent,
} from "../layout";
import {
  bookingFactsTable,
  hoursWord,
  payable,
  refundLadderTable,
  rupees,
  type BookingFacts,
  type RefundLadderRow,
} from "./parts";

/**
 * Mail to the person who booked a room.
 *
 * Every message states the booking back — code, hostel, room, fee — so it can
 * be checked by the one person who can catch a wrong figure, and ends with one
 * button to the booking page, which always shows the live state. Nothing here
 * promises what the platform cannot keep: times are exact and in Nepal time.
 */

type GuestBase = {
  booking: BookingFacts;
  bookingUrl: string;
  name?: string | null;
};

/** Sent when the booking is created: the invoice and how to pay it. */
export function bookingInvoiceEmail(
  input: GuestBase & {
    hostelAnswerHours: number;
    invoiceNumber: string;
    noShowRefund: number;
    payBy: string;
    paymentCheckHours: number;
    policyUrl: string;
    refundRows: RefundLadderRow[];
  },
): EmailContent {
  return {
    category: "billing",
    subject: `Please pay ${rupees(payable(input.booking))} to book your bed — ${input.booking.hostelName}`,
    html: emailLayout({
      bodyHtml: [
        greeting(input.name),
        paragraph(
          `Please pay to book your bed at <strong>${escapeHtml(input.booking.hostelName)}</strong>.`,
        ),
        bookingFactsTable(input.booking, [
          { label: "Bill no.", value: input.invoiceNumber },
          { label: "Pay by", value: input.payBy },
        ]),
        paragraph(
          `Open your booking and scan the ${PLATFORM_NAME} QR. Pay <strong>${rupees(payable(input.booking))}</strong> and write <strong>${escapeHtml(input.booking.code)}</strong> in the remarks. Then send us the payment screenshot.`,
        ),
        ctaButton(input.bookingUrl, "Pay booking fee"),
        paragraph(
          `We check it in ${input.paymentCheckHours} hours. Then the hostel has ${input.hostelAnswerHours} hours to say yes to your bed.`,
        ),
        paragraph("<strong>Refunds</strong>"),
        refundLadderTable({
          fee: payable(input.booking),
          stay: input.booking.stay
            ? { amount: input.booking.stay.amount, oneNight: Math.round(input.booking.stay.amount / input.booking.stay.nights) }
            : null,
          noShowRefund: input.noShowRefund,
          rows: input.refundRows,
        }),
        smallPrint(`Refund rules: ${textLink(input.policyUrl, "read here")}.`),
      ].join(""),
      eyebrow: "Bill",
      heading: "Please pay your booking fee",
      preheader: `Pay ${rupees(payable(input.booking))} with code ${input.booking.code} to book ${input.booking.roomType} at ${input.booking.hostelName}.`,
    }),
  };
}

/** Sent when the screenshot arrives. Nothing is confirmed yet. */
export function bookingProofReceivedEmail(
  input: GuestBase & { checkBy: string; reference?: string | null },
): EmailContent {
  return {
    category: "billing",
    subject: `We got your payment screenshot — booking ${input.booking.code}`,
    html: emailLayout({
      bodyHtml: [
        greeting(input.name),
        paragraph("We got your payment screenshot. We are checking it now."),
        bookingFactsTable(input.booking, [
          { label: "Your reference", value: input.reference ?? "" },
          { label: "We check by", value: input.checkBy },
        ]),
        paragraph("We will email you when it is checked."),
        ctaButton(input.bookingUrl, "View booking"),
      ].join(""),
      eyebrow: "Payment",
      heading: "We got your screenshot",
      preheader: `We are checking your ${rupees(payable(input.booking))} payment for booking ${input.booking.code}.`,
    }),
  };
}

/** Sent when a screenshot could not be matched. The booking waits for another. */
export function bookingPaymentRejectedEmail(
  input: GuestBase & { payBy: string; reason: string },
): EmailContent {
  return {
    category: "billing",
    subject: `We could not find your payment — booking ${input.booking.code}`,
    html: emailLayout({
      bodyHtml: [
        greeting(input.name),
        paragraph("We did not get the money shown in your screenshot."),
        detailsTable([{ label: "Reason", value: input.reason }]),
        bookingFactsTable(input.booking, [{ label: "Send again by", value: input.payBy }]),
        paragraph(
          "If you have paid, send the screenshot from your banking app again. If you have not, pay first.",
        ),
        ctaButton(input.bookingUrl, "Send screenshot again"),
      ].join(""),
      eyebrow: "Please check",
      heading: "We could not find your payment",
      preheader: `Booking ${input.booking.code}: ${input.reason}`,
      urgent: true,
    }),
  };
}

/** Sent when the hostel confirms: the bed is held, where to go, what cancelling costs from here. */
export function bookingConfirmedEmail(
  input: GuestBase & {
    address?: string | null;
    directionsUrl?: string | null;
    holdEndsAt: string;
    hostelPhone?: string | null;
    landmark?: string | null;
    noShowRefund: number;
    schedule: Array<{ refund: number; refundPercent: number; until: string }>;
  },
): EmailContent {
  return {
    category: "billing",
    subject: `Your bed is booked at ${input.booking.hostelName} — move in by ${input.holdEndsAt}`,
    html: emailLayout({
      bodyHtml: [
        greeting(input.name),
        paragraph(
          `<strong>${escapeHtml(input.booking.hostelName)}</strong> said yes. One ${escapeHtml(input.booking.roomType)} bed is kept for you until <strong>${escapeHtml(input.holdEndsAt)}</strong>.`,
        ),
        detailsTable([
          { label: "Booking", value: input.booking.code },
          { label: "Room type", value: input.booking.roomType },
          { label: "Monthly rent", value: rupees(input.booking.monthlyRent) },
          { emphasis: true, label: "Move in by", value: input.holdEndsAt },
          { label: "Address", value: input.address ?? "" },
          { label: "Landmark", value: input.landmark ?? "" },
          { label: "Hostel phone", value: input.hostelPhone ?? "" },
        ]),
        input.directionsUrl ? ctaButton(input.directionsUrl, "Get directions") : "",
        paragraph(
          `At the hostel, show your ${PLATFORM_NAME} ID card. The hostel scans it and you can move in.`,
        ),
        paragraph("<strong>If you cancel</strong>"),
        detailsTable([
          ...input.schedule.map((step) => ({
            label: `Cancel before ${step.until}`,
            value: `${rupees(step.refund)} back (${step.refundPercent}%)`,
          })),
          { label: `Not moved in by ${input.holdEndsAt}`, value: `${rupees(input.noShowRefund)} back` },
        ]),
        smallPrint(
          `The booking fee is not part of your rent, admission fee or deposit. You pay those to the hostel. ${textLink(input.bookingUrl, "View booking")}.`,
        ),
      ].join(""),
      eyebrow: "Booked",
      heading: "Your bed is booked",
      preheader: `One ${input.booking.roomType} bed at ${input.booking.hostelName} is kept for you until ${input.holdEndsAt}.`,
    }),
  };
}

/** The hold is running out and nobody has scanned the person's card yet. */
export function bookingMoveInReminderEmail(
  input: GuestBase & {
    address?: string | null;
    directionsUrl?: string | null;
    holdEndsAt: string;
    hostelPhone?: string | null;
    hoursLeft: number;
    noShowRefund: number;
  },
): EmailContent {
  return {
    category: "billing",
    subject: `Move in by ${input.holdEndsAt} — booking ${input.booking.code}`,
    html: emailLayout({
      bodyHtml: [
        greeting(input.name),
        paragraph(
          `Your bed at <strong>${escapeHtml(input.booking.hostelName)}</strong> is kept until <strong>${escapeHtml(input.holdEndsAt)}</strong>. Only ${hoursWord(input.hoursLeft)} left.`,
        ),
        detailsTable([
          { label: "Booking", value: input.booking.code },
          { label: "Room type", value: input.booking.roomType },
          { emphasis: true, label: "Move in by", value: input.holdEndsAt },
          { label: "Address", value: input.address ?? "" },
          { label: "Hostel phone", value: input.hostelPhone ?? "" },
        ]),
        ctaButton(input.directionsUrl || input.bookingUrl, input.directionsUrl ? "Get directions" : "View booking"),
        paragraph(
          `Show your ${PLATFORM_NAME} ID card at the hostel. If you do not move in by then, you lose the bed and ${
            input.noShowRefund > 0
              ? `you get back ${rupees(input.noShowRefund)} of the booking fee`
              : "you do not get the booking fee back"
          }.`,
        ),
        smallPrint(`Not coming? Cancel early to get more money back. ${textLink(input.bookingUrl, "View booking")}.`),
      ].join(""),
      eyebrow: "Reminder",
      heading: "Time to move in",
      preheader: `Move in at ${input.booking.hostelName} by ${input.holdEndsAt}.`,
      urgent: true,
    }),
  };
}

/** The refund has left our account. */
export function bookingRefundSentEmail(
  input: GuestBase & {
    amount: number;
    documentNumber?: string | null;
    refundTo: string;
    sentOn: string;
    transactionId: string;
  },
): EmailContent {
  return {
    category: "billing",
    subject: `We sent your money back — ${rupees(input.amount)}`,
    html: emailLayout({
      bodyHtml: [
        greeting(input.name),
        paragraph("We sent your money back."),
        detailsTable([
          { emphasis: true, label: "Refund", value: rupees(input.amount) },
          { label: "Sent to", value: input.refundTo },
          { label: "Sent on", value: input.sentOn },
          { label: "Transaction ID", value: input.transactionId },
          { label: "Refund slip", value: input.documentNumber ?? "" },
          { label: "Booking", value: input.booking.code },
          { label: "Hostel", value: input.booking.hostelName },
        ]),
        paragraph(
          "It can take some time to show in your bank or wallet. Not there? Contact us with the transaction ID.",
        ),
        ctaButton(input.bookingUrl, "View booking"),
      ].join(""),
      eyebrow: "Refund",
      heading: "We sent your money back",
      preheader: `${rupees(input.amount)} sent to ${input.refundTo}. Transaction ${input.transactionId}.`,
    }),
  };
}

/** How a booking ended, as the person who booked is told it. */
export type BookingEndCause =
  | "CANCELLED_BEFORE_CONFIRMATION"
  | "CANCELLED_BY_USER"
  | "DECLINED"
  | "HOSTEL_NO_RESPONSE"
  | "CANCELLED_BY_HOSTEL"
  | "CANCELLED_BY_PLATFORM"
  | "NO_SHOW"
  | "EXPIRED";

const ENDED_COPY: Record<BookingEndCause, { heading: string; line: (hostel: string) => string }> = {
  CANCELLED_BEFORE_CONFIRMATION: {
    heading: "Booking cancelled",
    line: () => "You cancelled this booking before the hostel said yes.",
  },
  CANCELLED_BY_HOSTEL: {
    heading: "The hostel cancelled your booking",
    line: (hostel) => `${hostel} cancelled your booking.`,
  },
  CANCELLED_BY_PLATFORM: {
    heading: `Booking cancelled by ${PLATFORM_NAME}`,
    line: () => `${PLATFORM_NAME} cancelled this booking.`,
  },
  CANCELLED_BY_USER: {
    heading: "Booking cancelled",
    line: () => "You cancelled this booking. The bed is no longer kept for you.",
  },
  DECLINED: {
    heading: "The hostel said no",
    line: (hostel) => `${hostel} said no to your booking.`,
  },
  EXPIRED: {
    heading: "Booking closed",
    line: () => "We did not get your payment screenshot in time, so this booking is closed.",
  },
  HOSTEL_NO_RESPONSE: {
    heading: "The hostel did not answer",
    line: (hostel) => `${hostel} did not answer in time, so the booking is cancelled.`,
  },
  NO_SHOW: {
    heading: "Your booking has ended",
    line: () => "You did not move in on time, so the bed is no longer kept for you.",
  },
};

/** Sent on every ending: what happened, and exactly what comes back. */
export function bookingEndedEmail(
  input: GuestBase & {
    cause: BookingEndCause;
    /** False when nothing was ever paid — there is no money to talk about. */
    paid: boolean;
    reason?: string | null;
    refund: number;
    refundPercent: number;
    /** `eSewa ••••4321 (Sita Sharma)`. */
    refundTo: string;
  },
): EmailContent {
  const copy = ENDED_COPY[input.cause];
  const hostel = escapeHtml(input.booking.hostelName);
  const money = !input.paid
    ? paragraph("You did not pay anything, so you owe nothing.")
    : input.refund > 0
      ? [
          detailsTable([
            { emphasis: true, label: "Refund", value: `${rupees(input.refund)} (${input.refundPercent}%)` },
            { label: "Refund to", value: input.refundTo },
          ]),
          paragraph(
            "We will send the money to the account above and email you the transaction ID.",
          ),
        ].join("")
      : paragraph("As per the refund rules, no money comes back.");

  return {
    category: "billing",
    subject: `${copy.heading} — booking ${input.booking.code}`,
    html: emailLayout({
      bodyHtml: [
        greeting(input.name),
        paragraph(copy.line(hostel)),
        bookingFactsTable(input.booking, [{ label: "Reason", value: input.reason ?? "" }], null),
        money,
        ctaButton(input.bookingUrl, "View booking"),
      ].join(""),
      eyebrow: input.paid && input.refund > 0 ? "Refund" : "Booking",
      heading: copy.heading,
      preheader:
        input.paid && input.refund > 0
          ? `We will send ${rupees(input.refund)} of your booking fee back to ${input.refundTo}.`
          : `Booking ${input.booking.code} at ${input.booking.hostelName} has ended.`,
    }),
  };
}

/** Sent when the payment is checked: the receipt, and the hostel's deadline. */
export function bookingPaymentVerifiedEmail(
  input: GuestBase & { hostelAnswerBy: string; paidOn: string; receiptNumber: string },
): EmailContent {
  return {
    category: "billing",
    subject: `We got your booking fee — ${input.booking.hostelName}`,
    html: emailLayout({
      bodyHtml: [
        greeting(input.name),
        paragraph(`We got your booking fee. ${PLATFORM_NAME} keeps it safe until the booking ends.`),
        bookingFactsTable(input.booking, [
          { label: "Receipt", value: input.receiptNumber },
          { label: "Paid on", value: input.paidOn },
          { label: "Hostel answers by", value: input.hostelAnswerBy },
        ]),
        paragraph(
          `Now ${escapeHtml(input.booking.hostelName)} will say yes or no. If it says no or does not answer by ${escapeHtml(input.hostelAnswerBy)}, you get all ${rupees(payable(input.booking))} back.`,
        ),
        ctaButton(input.bookingUrl, "View booking"),
      ].join(""),
      eyebrow: "Receipt",
      heading: "We got your booking fee",
      preheader: `Receipt ${input.receiptNumber}: ${rupees(payable(input.booking))} for booking ${input.booking.code}.`,
    }),
  };
}
