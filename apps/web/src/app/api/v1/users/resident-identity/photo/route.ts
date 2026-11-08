import { NextResponse, type NextRequest } from "next/server";

import { requireApiPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import {
  clearResidentIdentityPhoto,
  readResidentIdentityPhoto,
  setResidentIdentityPhoto,
} from "@/modules/users/resident-identity.service";
import { residentIdentityPhotoSchema } from "@/lib/users/resident-identity.validation";

export const runtime = "nodejs";

/**
 * The ID-card photo.
 *
 * GET streams the bytes through our own origin instead of redirecting to R2 —
 * see readResidentIdentityPhoto() for why the card's canvas needs that. It is
 * always the caller's *own* photo: there is no id in the path, so this endpoint
 * cannot be pointed at anybody else.
 */
export async function GET(request: NextRequest) {
  try {
    const principal = await requireApiPrincipal(request);
    const photo = await readResidentIdentityPhoto(principal.userId);

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

export async function PUT(request: NextRequest) {
  try {
    const principal = await requireApiPrincipal(request);
    const input = residentIdentityPhotoSchema.parse(await request.json());
    const result = await setResidentIdentityPhoto(principal.userId, input.photoAssetId);

    return successResponse(result, "Photo added to your ID card");
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const principal = await requireApiPrincipal(request);
    const result = await clearResidentIdentityPhoto(principal.userId);

    return successResponse(result, "Photo removed from your ID card");
  } catch (error) {
    return handleRouteError(error);
  }
}
