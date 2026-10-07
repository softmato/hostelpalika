import type { Metadata } from "next";

import { PlanCheckoutPage } from "@/app/_components/plan-checkout-page";
import { NOINDEX } from "@/lib/seo";

export const metadata: Metadata = { robots: NOINDEX, title: "Pay for your hostel" };

/** "Get plan" for a hostel already on the platform. Per person, so drawn in the browser. */
export default async function PlanCheckoutRoute({
  searchParams,
}: {
  searchParams: Promise<{ cycle?: string; lifetime?: string; plan?: string }>;
}) {
  const query = await searchParams;

  return (
    <PlanCheckoutPage
      cycle={query.cycle ?? "annual"}
      lifetime={query.lifetime === "1"}
      planId={query.plan ?? ""}
    />
  );
}
