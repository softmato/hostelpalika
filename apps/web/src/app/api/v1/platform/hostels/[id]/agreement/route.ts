import type { NextRequest } from "next/server";

import { requireSuperadminPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { platformHostelAgreement, platformHostelAgreementPdf } from "@/modules/hostels/hostel-agreement.service";

type RouteContext = { params: Promise<{ id: string }> };

export const runtime = "nodejs";

/**
 * Any hostel's signed service agreement, superadmin only: it carries the
 * owner's signature, IP and device. `?format=pdf` opens the PDF — the issued
 * one, or a marked preview while the KYC waits for approval.
 */
export async function GET(request: NextRequest, context: RouteContext) {
  try {
    await requireSuperadminPrincipal(request);

    const { id } = await context.params;

    if (request.nextUrl.searchParams.get("format") !== "pdf") {
      return successResponse({ agreement: await platformHostelAgreement(id) }, "Agreement");
    }

    const pdf = await platformHostelAgreementPdf(id);

    if (!pdf) {
      return Response.json({ message: "This hostel has not signed the agreement yet.", success: false }, { status: 404 });
    }

    return new Response(Buffer.from(pdf.content), {
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Disposition": `inline; filename="${pdf.filename}"`,
        "Content-Type": "application/pdf",
      },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
