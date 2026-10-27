import { PUBLIC_CACHE, handleRouteError, successResponse } from "@/lib/api-response";
import { getPlatformPulse } from "@/modules/reports/platform-pulse.service";

export const runtime = "nodejs";

/**
 * The few live figures the home page's top chip rotates through. Held a minute
 * in the service and at the CDN, so any number of open tabs polling it is one
 * count per minute, not one per visitor.
 */
export async function GET() {
  try {
    const pulse = await getPlatformPulse();

    return successResponse({ pulse }, "Platform pulse loaded", PUBLIC_CACHE);
  } catch (error) {
    return handleRouteError(error);
  }
}
