import type { NextRequest } from "next/server";

import { requireHostelAdminPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { addHostelKycDocuments, getHostelKyc, removeHostelKycDocument } from "@/modules/hostels/hostel-kyc.service";
import { resolveAdminHostelId } from "@/modules/hostels/hostel.service";
import { hostelResubmitDocumentsSchema } from "@/modules/hostels/hostel.validation";

export const runtime = "nodejs";

/** How much of Hostel KYC is done, step by step. */
export async function GET(request: NextRequest) {
  try {
    const principal = await requireHostelAdminPrincipal(request);
    const hostelId = resolveAdminHostelId(
      principal,
      request.nextUrl.searchParams.get("hostelId") ?? undefined,
    );

    return successResponse({ kyc: await getHostelKyc(String(hostelId), principal.userId) }, "Hostel KYC");
  } catch (error) {
    return handleRouteError(error);
  }
}

/** Attaches the owner's documents (uploaded privately, named by claim token). */
export async function POST(request: NextRequest) {
  try {
    const principal = await requireHostelAdminPrincipal(request);
    const body = (await request.json()) as Record<string, unknown>;
    const hostelId = resolveAdminHostelId(
      principal,
      typeof body.hostelId === "string" ? body.hostelId : undefined,
    );
    const input = hostelResubmitDocumentsSchema.parse(body);

    return successResponse(
      { kyc: await addHostelKycDocuments(String(hostelId), principal.userId, input.documents) },
      "Document added",
    );
  } catch (error) {
    return handleRouteError(error);
  }
}

/** Removes one of the caller's own documents (`?documentId=`) before it is approved. */
export async function DELETE(request: NextRequest) {
  try {
    const principal = await requireHostelAdminPrincipal(request);
    const params = request.nextUrl.searchParams;
    const hostelId = resolveAdminHostelId(principal, params.get("hostelId") ?? undefined);

    return successResponse(
      { kyc: await removeHostelKycDocument(String(hostelId), principal.userId, params.get("documentId") ?? "") },
      "Document removed",
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
