import type { Metadata } from "next";

import { ServiceProviderRegistrationPage } from "@/app/_components/service-provider-registration-page";
import { staticPageMetadata } from "@/lib/seo-config";
import { serverApi } from "@/lib/server-api";

export function generateMetadata(): Promise<Metadata> {
  return staticPageMetadata("serviceProviders");
}

type Stats = { areaCount: number; medianApprovalDays: number | null; totalProviders: number };

/**
 * The public provider surface is the registration funnel, not a browsable
 * directory (PHASES.md §6.1 — the marketplace lives in the app, and hostel
 * admins reach providers from their own portal rather than a public listing).
 *
 * The hero's three numbers are read on the server so they are in the first
 * paint and the page stays crawlable. A failure here is not worth a 500 on a
 * marketing page: the hero drops whichever stat it has no number for.
 */
export default async function ServiceProvidersPage() {
  const stats = await serverApi<{ stats: Stats }>("/api/v1/public/service-providers/stats")
    .then((data) => data.stats)
    .catch(() => undefined);

  return <ServiceProviderRegistrationPage stats={stats} />;
}
