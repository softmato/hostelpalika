import { PUBLIC_CACHE, handleRouteError, successResponse } from "@/lib/api-response";
import { listPublicHostelLocations } from "@/modules/hostels/hostel.service";

export const runtime = "nodejs";

/** Published hostels counted by city, area and type — the `/hostels/in` pages' index (PARITY §9). */
export async function GET() {
  try {
    return successResponse({ locations: await listPublicHostelLocations() }, "Hostel locations loaded", PUBLIC_CACHE);
  } catch (error) {
    return handleRouteError(error);
  }
}
