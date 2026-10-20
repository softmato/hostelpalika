import type { Metadata } from "next";

import { PublicRefundPolicyPage } from "@/app/_components/public-refund-policy-page";
import { staticPageMetadata } from "@/lib/seo-config";
import { getRefundPolicy } from "@/modules/bookings/booking-policy.service";

// The numbers are superadmin settings; applying a change revalidates on demand.
export const revalidate = 21600;

export function generateMetadata(): Promise<Metadata> {
  return staticPageMetadata("refundPolicy");
}

export default async function RefundPolicyPage() {
  return <PublicRefundPolicyPage policy={await getRefundPolicy()} />;
}
