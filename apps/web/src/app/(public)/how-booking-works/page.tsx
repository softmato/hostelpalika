import type { Metadata } from "next";

import { PublicBookingGuidePage } from "@/app/_components/public-booking-guide-page";
import { staticPageMetadata } from "@/lib/seo-config";
import { serverApi } from "@/lib/server-api";

// Every hour and percentage on it is a superadmin setting; applying a change
// revalidates on demand (setting-change.service), so the window can be long.
export const revalidate = 21600;

export function generateMetadata(): Promise<Metadata> {
  return staticPageMetadata("howBookingWorks");
}

export default async function HowBookingWorksPage() {
  return <PublicBookingGuidePage guide={(await serverApi<{ guide: Parameters<typeof PublicBookingGuidePage>[0]["guide"] }>("/api/v1/bookings/guide", { revalidate: 21600 })).guide} />;
}
