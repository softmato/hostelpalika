import { connectToDatabase } from "@/lib/db";
import { PlatformSettingModel } from "@hostel/db/models/PlatformSetting";
import {
  BOOKING_CONFIG_KEY,
  bookingConfigSchema,
  type BookingConfig,
  DEFAULT_BOOKING_CONFIG,
} from "@/lib/bookings/booking-config.validation";

export * from "@/lib/bookings/booking-config.validation";

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
