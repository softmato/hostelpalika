import "server-only";

import type { ComparisonRow } from "@hostel/shared/email/templates/layout";

import {
  applyBookingConfig,
  bookingConfigSchema,
  getBookingConfig,
  type BookingCancelStep,
  type BookingConfig,
} from "@/modules/bookings/booking-config";
import {
  getOperationsConfig,
  saveOperationsConfig,
} from "@/modules/platform-config/operations-config";

/**
 * Every setting that may only change after an email confirm, and how to read,
 * check, describe and write each one.
 *
 * A setting belongs here when changing it moves customers' money: how much a
 * booking refunds, which QR the money lands in. Adding one is an entry in this
 * map and nothing else — the request, confirm and cancel paths are generic.
 */
export type SettingChangeDefinition<T> = {
  apply: (value: T, actorId: string) => Promise<unknown>;
  label: string;
  load: () => Promise<T>;
  parse: (value: unknown) => T;
  /** The rows that differ, in reading order. Empty means nothing changed. */
  rows: (previous: T, proposed: T) => ComparisonRow[];
};

function row(label: string, from: string, to: string): ComparisonRow[] {
  return from === to ? [] : [{ from, label, to }];
}

const percent = (value: number) => `${value}%`;
const hours = (value: number) => `${value} ${value === 1 ? "hour" : "hours"}`;
const days = (value: number) => `${value} ${value === 1 ? "day" : "days"}`;

function hoursList(values: number[]) {
  return values.length === 0
    ? "None"
    : [...values]
        .sort((left, right) => right - left)
        .map((value) => `${value} h left`)
        .join(", ");
}

export function describeCancelSteps(steps: BookingCancelStep[]) {
  let fromDay = 1;

  return steps
    .map((step) => {
      const span = fromDay === step.throughDay ? `Day ${fromDay}` : `Day ${fromDay}–${step.throughDay}`;

      fromDay = step.throughDay + 1;

      return `${span}: ${step.refundPercent}%`;
    })
    .join(" · ");
}

const bookings: SettingChangeDefinition<BookingConfig> = {
  apply: (value, actorId) => applyBookingConfig(value, actorId),
  label: "booking terms",
  load: getBookingConfig,
  parse: (value) => bookingConfigSchema.parse(value),
  rows: (previous, next) => [
    ...row("Bookings", previous.enabled ? "On" : "Off", next.enabled ? "On" : "Off"),
    ...row("Booking fee", percent(previous.feePercent), percent(next.feePercent)),
    ...row(
      "Hostel's share of kept money",
      percent(previous.hostelSharePercent),
      percent(next.hostelSharePercent),
    ),
    ...row("Bed hold", days(previous.holdDays), days(next.holdDays)),
    ...row(
      "Hostel answer window",
      hours(previous.hostelAnswerHours),
      hours(next.hostelAnswerHours),
    ),
    ...row(
      "Payment check promise",
      hours(previous.paymentCheckHours),
      hours(next.paymentCheckHours),
    ),
    ...row(
      "Unpaid booking dropped after",
      hours(previous.unpaidWindowHours),
      hours(next.unpaidWindowHours),
    ),
    ...row(
      "Refund if the person cancels",
      describeCancelSteps(previous.cancelSteps),
      describeCancelSteps(next.cancelSteps),
    ),
    ...row(
      "Refund for a no-show",
      percent(previous.noShowRefundPercent),
      percent(next.noShowRefundPercent),
    ),
    ...row(
      "Strikes that pause a hostel",
      `${previous.strikeLimit} in ${days(previous.strikeWindowDays)}`,
      `${next.strikeLimit} in ${days(next.strikeWindowDays)}`,
    ),
    ...row(
      "Hostel reminders",
      hoursList(previous.hostelReminderHoursLeft),
      hoursList(next.hostelReminderHoursLeft),
    ),
    ...row(
      "Move-in reminders",
      hoursList(previous.moveInReminderHoursLeft),
      hoursList(next.moveInReminderHoursLeft),
    ),
    ...row(
      "Short stay: daily rate above monthly ÷ 30",
      percent(previous.shortStayMinMarkupPercent),
      percent(next.shortStayMinMarkupPercent),
    ),
    ...row(
      "Short stay: hostel's share of the nights",
      percent(previous.shortStayHostelSharePercent),
      percent(next.shortStayHostelSharePercent),
    ),
    ...row(
      "Short stay: longest stay",
      `${previous.shortStayMaxNights} nights`,
      `${next.shortStayMaxNights} nights`,
    ),
    ...row(
      "Short stay: booked up to",
      `${days(previous.shortStayMaxAdvanceDays)} ahead`,
      `${days(next.shortStayMaxAdvanceDays)} ahead`,
    ),
  ],
};

export type CollectionQr = {
  collectionQrLabel: string;
  collectionQrUrl: string;
};

const collectionQr: SettingChangeDefinition<CollectionQr> = {
  apply: (value, actorId) => saveOperationsConfig(value, actorId),
  label: "the collection QR",
  load: async () => {
    const config = await getOperationsConfig();

    return {
      collectionQrLabel: config.collectionQrLabel,
      collectionQrUrl: config.collectionQrUrl,
    };
  },
  parse: (value) => {
    const input = (typeof value === "object" && value !== null ? value : {}) as Record<
      string,
      unknown
    >;

    return {
      collectionQrLabel: String(input.collectionQrLabel ?? "").trim().slice(0, 120),
      collectionQrUrl: String(input.collectionQrUrl ?? "").trim().slice(0, 500),
    };
  },
  rows: (previous, next) => [
    ...row(
      "QR image",
      previous.collectionQrUrl ? "Current image" : "None",
      next.collectionQrUrl === previous.collectionQrUrl
        ? previous.collectionQrUrl
          ? "Current image"
          : "None"
        : next.collectionQrUrl
          ? "New image"
          : "Removed",
    ),
    ...row(
      "Name shown under the QR",
      previous.collectionQrLabel || "None",
      next.collectionQrLabel || "None",
    ),
  ],
};

export const SETTING_CHANGES = {
  bookings,
  "collection-qr": collectionQr,
} as const;

export type SettingChangeKey = keyof typeof SETTING_CHANGES;

export function isSettingChangeKey(value: string): value is SettingChangeKey {
  return Object.prototype.hasOwnProperty.call(SETTING_CHANGES, value);
}
