import { z } from "zod";

import { connectToDatabase } from "@/lib/db";
import { PlatformSettingModel } from "@hostel/db/models/PlatformSetting";

/**
 * The commercial terms of a room booking, as the superadmin sets them.
 *
 * One `PlatformSetting` document keyed `bookings`, separate from `operations`
 * and from the website sections: these numbers decide how much of a customer's
 * money is handed back, so no other form may ever be able to write them. The
 * only write path is `applyBookingConfig`, and the only caller of that is the
 * email-confirmed settings change (docs/BOOKINGS.md item 2).
 *
 * A booking copies the terms it was created under (`termsFromConfig`), so a
 * change here never reaches a booking somebody has already paid for.
 */
export const BOOKING_CONFIG_KEY = "bookings";

const percent = z.number().int().min(0).max(100);

/**
 * One rung of the cancellation ladder.
 *
 * `throughDay` is the last day of the hold the rung covers, days counted in
 * 24-hour blocks from the hostel's confirmation: day 1 is the first 24 hours,
 * so `throughDay: 2` covers a cancellation made before the 48th hour.
 */
export const bookingCancelStepSchema = z.object({
  refundPercent: percent,
  throughDay: z.number().int().min(1).max(30),
});

export type BookingCancelStep = z.infer<typeof bookingCancelStepSchema>;

export const DEFAULT_CANCEL_STEPS: BookingCancelStep[] = [
  { refundPercent: 75, throughDay: 2 },
  { refundPercent: 50, throughDay: 5 },
  { refundPercent: 25, throughDay: 7 },
];

function uniqueNumbers(values: number[]) {
  return new Set(values).size === values.length;
}

export const bookingConfigSchema = z
  .object({
    /** The platform-wide switch. Off until the collection QR and terms are set. */
    enabled: z.boolean().default(false),
    /** The booking fee, as a whole percent of the room type's monthly rent. */
    feePercent: z.number().min(0.1).max(50).multipleOf(0.1).default(7),
    /** The hostel's part of whatever is kept. HostelPalika keeps the rest. */
    hostelSharePercent: percent.default(60),
    /** How long a confirmed bed is held for the person to move in. */
    holdDays: z.number().int().min(1).max(30).default(7),
    /** How long a hostel has, from our payment check, to confirm or decline. */
    hostelAnswerHours: z.number().int().min(1).max(168).default(24),
    /** What the person is promised about our own check of their screenshot. */
    paymentCheckHours: z.number().int().min(1).max(168).default(24),
    /** A booking with no screenshot is dropped after this long. It holds nothing. */
    unpaidWindowHours: z.number().int().min(1).max(168).default(24),
    cancelSteps: z
      .array(bookingCancelStepSchema)
      .min(1)
      .max(10)
      .default(DEFAULT_CANCEL_STEPS),
    /** What a person who never came gets back once the hold runs out. */
    noShowRefundPercent: percent.default(0),
    /** Missed answers plus hostel cancellations inside the window that pause a hostel. */
    strikeLimit: z.number().int().min(1).max(20).default(3),
    strikeWindowDays: z.number().int().min(1).max(365).default(30),
    /** Hours left on the hostel's answer window at which it is reminded. */
    hostelReminderHoursLeft: z
      .array(z.number().int().min(1).max(167))
      .max(5)
      .default([12, 2]),
    /** Hours left on the hold at which the person is reminded to move in. */
    moveInReminderHoursLeft: z
      .array(z.number().int().min(1).max(719))
      .max(5)
      .default([24]),
    /**
     * Short stays: a daily rate may not be below monthly ÷ 30 plus this much,
     * so a month of nights always costs more than a month's rent.
     */
    shortStayMinMarkupPercent: z.number().int().min(0).max(300).default(20),
    /** The hostel's part of a short stay's nights. HostelPalika keeps the rest. */
    shortStayHostelSharePercent: percent.default(70),
    /** Thirty nights or more is a monthly resident, not a short stay. */
    shortStayMaxNights: z.number().int().min(1).max(29).default(29),
    /** How far ahead a short stay's move-in may be. */
    shortStayMaxAdvanceDays: z.number().int().min(1).max(365).default(60),
  })
  .superRefine((config, context) => {
    const steps = config.cancelSteps;

    for (let index = 1; index < steps.length; index += 1) {
      if (steps[index].throughDay <= steps[index - 1].throughDay) {
        context.addIssue({
          code: "custom",
          message: "Each cancellation step must end on a later day than the one before it.",
          path: ["cancelSteps", index, "throughDay"],
        });
      }

      // A later cancellation handing back more than an earlier one would pay
      // people to hold a bed longer before letting it go.
      if (steps[index].refundPercent > steps[index - 1].refundPercent) {
        context.addIssue({
          code: "custom",
          message: "A later cancellation cannot refund more than an earlier one.",
          path: ["cancelSteps", index, "refundPercent"],
        });
      }
    }

    const last = steps[steps.length - 1];

    if (last && last.throughDay !== config.holdDays) {
      context.addIssue({
        code: "custom",
        message: `The last cancellation step must end on day ${config.holdDays}, the last day of the hold.`,
        path: ["cancelSteps", steps.length - 1, "throughDay"],
      });
    }

    // Otherwise the cheapest way out of a booking is to not turn up, and the
    // bed stays empty for the whole hold instead of being let go early.
    if (
      last &&
      config.noShowRefundPercent > 0 &&
      config.noShowRefundPercent >= last.refundPercent
    ) {
      context.addIssue({
        code: "custom",
        message: "A no-show must get back less than cancelling on the last day.",
        path: ["noShowRefundPercent"],
      });
    }

    if (!uniqueNumbers(config.hostelReminderHoursLeft)) {
      context.addIssue({
        code: "custom",
        message: "Each hostel reminder time can be listed once.",
        path: ["hostelReminderHoursLeft"],
      });
    }

    if (config.hostelReminderHoursLeft.some((hours) => hours >= config.hostelAnswerHours)) {
      context.addIssue({
        code: "custom",
        message: "A hostel reminder must fall inside the answer window.",
        path: ["hostelReminderHoursLeft"],
      });
    }

    if (!uniqueNumbers(config.moveInReminderHoursLeft)) {
      context.addIssue({
        code: "custom",
        message: "Each move-in reminder time can be listed once.",
        path: ["moveInReminderHoursLeft"],
      });
    }

    if (config.moveInReminderHoursLeft.some((hours) => hours >= config.holdDays * 24)) {
      context.addIssue({
        code: "custom",
        message: "A move-in reminder must fall inside the hold.",
        path: ["moveInReminderHoursLeft"],
      });
    }
  });

export type BookingConfig = z.infer<typeof bookingConfigSchema>;

export const DEFAULT_BOOKING_CONFIG: BookingConfig = bookingConfigSchema.parse({});

/**
 * Never throws. A missing or malformed document reads as the shipped defaults,
 * and the shipped default has bookings **switched off** — so a broken settings
 * row can stop new bookings but can never open them on terms nobody chose.
 */
export async function getBookingConfig(): Promise<BookingConfig> {
  try {
    await connectToDatabase();

    const record = (await PlatformSettingModel.findOne({
      key: BOOKING_CONFIG_KEY,
    }).lean()) as { value?: unknown } | null;

    if (!record) {
      return DEFAULT_BOOKING_CONFIG;
    }

    const parsed = bookingConfigSchema.safeParse(record.value);

    return parsed.success ? parsed.data : DEFAULT_BOOKING_CONFIG;
  } catch {
    return DEFAULT_BOOKING_CONFIG;
  }
}

/**
 * Merges a partial edit onto what is stored and validates the result as a whole.
 *
 * Throws on a bad value: the person editing has to see why, not have their
 * numbers quietly swapped for a default. Pure, so the settings form can check a
 * proposal before anything is emailed.
 */
export function mergeBookingConfig(current: BookingConfig, input: unknown): BookingConfig {
  return bookingConfigSchema.parse({
    ...current,
    ...(typeof input === "object" && input !== null ? input : {}),
  });
}

/**
 * Writes the terms. Only the email-confirmed settings change may call this.
 */
export async function applyBookingConfig(next: BookingConfig, actorId: string) {
  await connectToDatabase();

  const value = bookingConfigSchema.parse(next);

  await PlatformSettingModel.findOneAndUpdate(
    { key: BOOKING_CONFIG_KEY },
    { $set: { key: BOOKING_CONFIG_KEY, updatedBy: actorId, value } },
    { new: true, upsert: true },
  );

  return value;
}
