import type { NextRequest } from "next/server";

import { requireHostelCapability } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import {
  getPaymentProfile,
  updatePaymentProfile,
} from "@/modules/finance/payment-profile.service";
import { paymentProfileUpdateSchema } from "@/modules/finance/payment-profile.validation";
import { resolveAdminHostelId } from "@/modules/hostels/hostel.service";

export const runtime = "nodejs";

/**
 * How this hostel takes money (target §11.8, plan item 3.1).
 *
 * Read is `viewPayments` and write is `managePaymentProfile` — item 0.5 split
 * these apart precisely so the warden who approves proofs cannot also change the
 * account the money is asked to go to.
 */
export async function GET(request: NextRequest) {
  try {
    const principal = await requireHostelCapability(request, "viewPayments");
    const hostelId = resolveAdminHostelId(
      principal,
      new URL(request.url).searchParams.get("hostelId") ?? undefined,
    );

    return withEtag(request, successResponse(
      { profile: await getPaymentProfile(hostelId) },
      "Payment profile",
    ));
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const principal = await requireHostelCapability(request, "managePaymentProfile");
    const input = paymentProfileUpdateSchema.parse(await request.json());
    const hostelId = resolveAdminHostelId(principal, input.hostelId);

    return successResponse(
      { profile: await updatePaymentProfile(hostelId, input, principal) },
      "Payment profile saved",
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
