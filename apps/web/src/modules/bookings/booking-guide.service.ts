import "server-only";

import { getBookingConfig } from "@/modules/bookings/booking-config";
import { bookingGuideIntro, bookingGuideSections } from "@/modules/bookings/booking-guide";
import type { PolicySection } from "@/modules/bookings/booking-policy";
import type { BookingGuide } from "@/lib/bookings/booking.types";
export type { BookingGuide } from "@/lib/bookings/booking.types";

export async function getBookingGuide(): Promise<BookingGuide> {
  const config = await getBookingConfig();

  return {
    enabled: config.enabled,
    intro: bookingGuideIntro(),
    sections: bookingGuideSections(config),
  };
}
