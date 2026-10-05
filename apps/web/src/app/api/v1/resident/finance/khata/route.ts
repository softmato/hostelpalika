import type { NextRequest } from "next/server";

import { requireResidentPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import {
  getResidentKhata,
  residentKhataAction,
  residentKhataActionSchema,
} from "@/modules/finance/khata.service";

export const runtime = "nodejs";

/** The resident's khata: status, the price list, and what they have taken. */
export async function GET(request: NextRequest) {
  try {
    const principal = await requireResidentPrincipal(request);

    return successResponse(await getResidentKhata(principal), "Khata");
  } catch (error) {
    return handleRouteError(error);
  }
}

/** Ask to open the khata, ask for an item, or take back an ask still waiting. */
export async function POST(request: NextRequest) {
  try {
    const principal = await requireResidentPrincipal(request);
    const input = residentKhataActionSchema.parse(await request.json());

    return successResponse(await residentKhataAction(principal, input), "Khata updated");
  } catch (error) {
    return handleRouteError(error);
  }
}
