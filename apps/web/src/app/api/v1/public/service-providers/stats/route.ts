import { PUBLIC_CACHE, handleRouteError, successResponse } from "@/lib/api-response";
import { getPublicServiceProviderStats } from "@/modules/service-providers/service-provider.service";

export const runtime = "nodejs";

/** The three numbers on the public Service providers page (PARITY §9: the page reads the API). */
export async function GET() {
  try {
    return successResponse({ stats: await getPublicServiceProviderStats() }, "Service provider stats loaded", PUBLIC_CACHE);
  } catch (error) {
    return handleRouteError(error);
  }
}
