import { NextResponse, type NextRequest } from "next/server";

import { requireHostelCapability } from "@/lib/api-auth";
import { handleRouteError } from "@/lib/api-response";
import { residentIdLookupSchema } from "@/lib/users/resident-identity.validation";
import { readScannedResidentPhoto } from "@/modules/users/resident-scan.service";

export const runtime = "nodejs";

/**
 * The scanned card holder's photograph.
 *
 * Streamed rather than redirected — the bucket is private and a 302 to a
 * presigned URL would lose the caller's `Authorization` header on the hop.
 *
 * Gated on `registerResidents`, the same grant as the dossier this photo sits
 * on, and on the holder's own sharing switch inside the service. There is no
 * asset id in the query: the only thing this route will ever return is the card
 * photo belonging to the resident ID handed to it, so it cannot be walked
 * across the bucket.
 */
export async function GET(request: NextRequest) {
  try {
    await requireHostelCapability(request, "registerResidents");

    const query = residentIdLookupSchema.parse(
      Object.fromEntries(request.nextUrl.searchParams.entries()),
    );

    const photo = await readScannedResidentPhoto(query.residentId);

    return new NextResponse(photo.body, {
      headers: {
        "Cache-Control": "private, max-age=300",
        "Content-Type": photo.contentType,
        // Someone's face is not something to hand to a framing page.
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
