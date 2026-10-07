import { handleRouteError, successResponse } from "@/lib/api-response";
import { getLifetimeAvailability } from "@/modules/billing/lifetime";

export const runtime = "nodejs";

/**
 * The lifetime deal as it stands right now: whether it is on sale today, and
 * each tier's price with its seats sold and left. Counts only — no hostel is
 * named — so it is public. Read by the pricing page, the team form and the
 * superadmin tab, which therefore always agree.
 *
 * Cached for a few seconds at the CDN, not a minute: "3 seats left" is the one
 * number on the pricing page a visitor acts on.
 */
export async function GET() {
  try {
    const lifetime = await getLifetimeAvailability();

    return successResponse({ lifetime }, "Lifetime deal loaded", {
      headers: { "Cache-Control": "public, s-maxage=10, stale-while-revalidate=60" },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
