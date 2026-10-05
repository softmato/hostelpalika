import type { NextRequest } from "next/server";

import { requireHostelCapability } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import {
  getKhataOverview,
  khataItemsSchema,
  saveKhataItems,
} from "@/modules/finance/khata.service";
import { resolveAdminHostelId } from "@/modules/hostels/hostel.service";

export const runtime = "nodejs";

/** The khata screen: items, open requests, accounts and waiting asks. */
export async function GET(request: NextRequest) {
  try {
    const principal = await requireHostelCapability(request, "viewPayments");
    const hostelId = resolveAdminHostelId(
      principal,
      request.nextUrl.searchParams.get("hostelId") ?? undefined,
    );

    return successResponse(await getKhataOverview(hostelId), "Khata");
  } catch (error) {
    return handleRouteError(error);
  }
}

/** Replaces the item list. Run by whoever takes cash at the desk. */
export async function PUT(request: NextRequest) {
  try {
    const principal = await requireHostelCapability(request, "recordCash");
    const input = khataItemsSchema.parse(await request.json());
    const hostelId = resolveAdminHostelId(principal, input.hostelId);

    return successResponse(
      { items: await saveKhataItems(hostelId, input.items, principal) },
      "Khata items saved",
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
