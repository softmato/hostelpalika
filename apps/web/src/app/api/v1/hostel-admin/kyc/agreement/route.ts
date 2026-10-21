import type { NextRequest } from "next/server";
import { z } from "zod";

import { requireHostelAdminPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { getHostelAgreement, hostelAgreementPdf, signHostelAgreement } from "@/modules/hostels/hostel-agreement.service";
import { resolveAdminHostelId } from "@/modules/hostels/hostel.service";
import { signature } from "@/modules/users/resident-identity.validation";

export const runtime = "nodejs";

const signSchema = z.object({
  agree: z.literal(true, { error: "Tick that you have read and agree to the agreement." }),
  signature,
  signerName: z.string().trim().min(2, "Type your full name.").max(80),
});

/** The agreement to read and sign; `?format=pdf` downloads the signed copy once it is issued. */
export async function GET(request: NextRequest) {
  try {
    const principal = await requireHostelAdminPrincipal(request);
    const params = request.nextUrl.searchParams;
    const hostelId = String(resolveAdminHostelId(principal, params.get("hostelId") ?? undefined));

    if (params.get("format") === "pdf") {
      const issued = await hostelAgreementPdf(hostelId);

      if (!issued) {
        return Response.json({ message: "Your agreement is sent once your KYC is approved.", success: false }, { status: 404 });
      }

      return new Response(Buffer.from(issued.attachment.content), {
        headers: {
          "Cache-Control": "private, no-store",
          "Content-Disposition": `attachment; filename="${issued.attachment.filename}"`,
          "Content-Type": "application/pdf",
        },
      });
    }

    return successResponse({ agreement: await getHostelAgreement(hostelId) }, "Agreement");
  } catch (error) {
    return handleRouteError(error);
  }
}

/** The owner signs: a drawn signature, their typed name, and the tick. */
export async function POST(request: NextRequest) {
  try {
    const principal = await requireHostelAdminPrincipal(request);
    const body = (await request.json()) as Record<string, unknown>;
    const hostelId = String(resolveAdminHostelId(principal, typeof body.hostelId === "string" ? body.hostelId : undefined));
    const input = signSchema.parse(body);

    return successResponse(
      {
        agreement: await signHostelAgreement(hostelId, principal.userId, input, {
          ip: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "",
          userAgent: request.headers.get("user-agent") ?? "",
        }),
      },
      "Agreement signed",
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
