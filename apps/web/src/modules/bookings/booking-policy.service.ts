import "server-only";

import { bookingPolicyVersion } from "@/modules/bookings/booking-code";
import { getBookingConfig } from "@/modules/bookings/booking-config";
import {
  fillPolicyText,
  policyValues,
  refundPolicyIntro,
  refundPolicySections,
} from "@/modules/bookings/booking-policy";
import { termsFromConfig } from "@/modules/bookings/booking-terms";
import { getSiteConfigSection } from "@/modules/platform-config/site-config.service";
import type { RefundPolicy } from "@/lib/bookings/booking.types";
export type { RefundPolicy } from "@/lib/bookings/booking.types";


export async function getRefundPolicy(): Promise<RefundPolicy> {
  const [config, legal] = await Promise.all([getBookingConfig(), getSiteConfigSection("legal")]);
  const body = legal.refund.body.trim();

  return {
    customBody: body ? fillPolicyText(body, policyValues(config)) : null,
    intro: refundPolicyIntro(),
    sections: refundPolicySections(config),
    shortStay: {
      hostelSharePercent: config.shortStayHostelSharePercent,
      maxAdvanceDays: config.shortStayMaxAdvanceDays,
      maxNights: config.shortStayMaxNights,
      minMarkupPercent: config.shortStayMinMarkupPercent,
    },
    updatedAt: legal.refund.updatedAt,
    version: bookingPolicyVersion(termsFromConfig(config), legal.refund),
  };
}
