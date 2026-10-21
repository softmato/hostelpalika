import { PUBLIC_CACHE, handleRouteError, successResponse } from "@/lib/api-response";
import { getPublicOfferPerks } from "@/modules/offer-program/offer-program.service";

export const runtime = "nodejs";

/** This quarter's active Resident Offer Program perks, for the public explainer. */
export async function GET() {
  try {
    return successResponse(await getPublicOfferPerks(), "Offer perks loaded", PUBLIC_CACHE);
  } catch (error) {
    return handleRouteError(error);
  }
}
