import { PLATFORM_NAME } from "@hostel/shared/brand/brand";

import type { BookingConfig } from "@/modules/bookings/booking-config";

/**
 * The refund policy as words, from the live booking settings.
 *
 * Pure, so the website page, the app's policy screen (through
 * `GET /api/v1/bookings/policy`) and a test all print the same sentences. It
 * speaks in percentages, not rupees: the page is not about one room. The
 * checkout and the invoice print the same steps in rupees for the fee in hand.
 */

export type PolicySection = { body: string[]; icon: string; title: string };

type PolicyTerms = Pick<
  BookingConfig,
  | "cancelSteps"
  | "feePercent"
  | "holdDays"
  | "hostelAnswerHours"
  | "noShowRefundPercent"
  | "paymentCheckHours"
  | "unpaidWindowHours"
>;

/** "1 hour" / "24 hours". Exported so the guide counts the same clock in the same words. */
export const hoursText = (value: number) => (value === 1 ? "1 hour" : `${value} hours`);
export const daysText = (value: number) => (value === 1 ? "1 day" : `${value} days`);

/** Values an owner's own policy text may name as `{feePercent}` and so on. */
export function policyValues(terms: PolicyTerms): Record<string, string> {
  return {
    feePercent: `${terms.feePercent}%`,
    holdDays: daysText(terms.holdDays),
    hostelAnswerHours: hoursText(terms.hostelAnswerHours),
    noShowRefundPercent: `${terms.noShowRefundPercent}%`,
    paymentCheckHours: hoursText(terms.paymentCheckHours),
    siteName: PLATFORM_NAME,
    unpaidWindowHours: hoursText(terms.unpaidWindowHours),
  };
}

/** Fills `{name}` tokens; an unknown token is left as written so a typo is visible. */
export function fillPolicyText(text: string, values: Record<string, string>) {
  return text.replace(/\{(\w+)\}/g, (token, name: string) => values[name] ?? token);
}

export function refundPolicyIntro(): string[] {
  return [
    `This policy covers rooms booked on ${PLATFORM_NAME}. A booking keeps the terms in force on the day it is made, and its invoice prints them.`,
  ];
}

export function refundPolicySections(terms: PolicyTerms): PolicySection[] {
  let fromDay = 1;
  const steps = terms.cancelSteps.map((step) => {
    const span = fromDay === step.throughDay ? `day ${fromDay}` : `days ${fromDay}–${step.throughDay}`;

    fromDay = step.throughDay + 1;

    return `Cancel on ${span} of the hold: ${step.refundPercent}% back.`;
  });

  return [
    {
      body: [
        `The booking fee is ${terms.feePercent}% of one month's rent for the room type, shown before you book.`,
        `You pay it to ${PLATFORM_NAME}, not to the hostel. It does not count towards rent, admission fee or deposit.`,
        `We check your payment screenshot within ${hoursText(terms.paymentCheckHours)}. A booking with no screenshot closes after ${hoursText(terms.unpaidWindowHours)} and owes nothing.`,
      ],
      icon: "credit-card",
      title: "The booking fee",
    },
    {
      body: [
        "You cancel before the hostel confirms.",
        `The hostel declines, or does not answer within ${hoursText(terms.hostelAnswerHours)} of our payment check.`,
        "The hostel cancels after confirming.",
        `${PLATFORM_NAME} cancels the booking.`,
      ],
      icon: "badge-check",
      title: "Full refund",
    },
    {
      body: [
        `One bed is held for you for ${daysText(terms.holdDays)}, counted in 24-hour blocks from the moment the hostel confirms.`,
        ...steps,
        `Not moved in when the hold ends: ${terms.noShowRefundPercent}% back.`,
        "When the hostel scans your ID card and admits you, the booking is complete and nothing is refunded.",
      ],
      icon: "alert-triangle",
      title: "After the hostel confirms",
    },
    {
      body: [
        "A short stay is a few nights, paid upfront with the booking fee. The fee is charged once for every started week between booking and move-in.",
        "Cancelled before the move-in day, declined, or not answered by the hostel: every night is refunded.",
        "Cancelled on the move-in day, or not checked in by the end of the next day: one night is kept and the rest refunded.",
        "Leaving before the move-out date: nights not stayed are not refunded.",
      ],
      icon: "calendar",
      title: "Short stays",
    },
    {
      body: [
        "Refunds go to the eSewa, Khalti or bank account you give when you book.",
        "When we send a refund, we email you the amount and the transaction ID.",
        `Whatever is not refunded is shared between the hostel and ${PLATFORM_NAME}.`,
      ],
      icon: "shield-check",
      title: "How refunds are sent",
    },
  ];
}
