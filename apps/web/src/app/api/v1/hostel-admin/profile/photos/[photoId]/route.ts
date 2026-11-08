import type { NextRequest } from "next/server";

import { handleRouteError, successResponse } from "@/lib/api-response";
import { requireHostelCapability } from "@/lib/api-auth";
import { deleteHostelAdminProfilePhoto } from "@/modules/hostels/hostel-profile.service";
import { hostelPhotoDeleteQuerySchema } from "@/lib/hostels/hostel.validation";

type RouteContext = {
  params: Promise<{
    photoId: string;
  }>;
};

export const runtime = "nodejs";

export async function DELETE(request: NextRequest, context: RouteContext) {
  try {
    const principal = await requireHostelCapability(request, "editHostelProfile");
    const { photoId } = await context.params;
    const query = hostelPhotoDeleteQuerySchema.parse(
      Object.fromEntries(request.nextUrl.searchParams.entries()),
    );
    const result = await deleteHostelAdminProfilePhoto(photoId, query, principal);

    return successResponse(result, "Hostel photo deleted");
  } catch (error) {
    return handleRouteError(error);
  }
}
