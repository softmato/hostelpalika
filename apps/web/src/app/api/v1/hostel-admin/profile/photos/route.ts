import type { NextRequest } from "next/server";

import { handleRouteError, successResponse } from "@/lib/api-response";
import { requireHostelCapability } from "@/lib/api-auth";
import { addHostelAdminProfilePhoto } from "@/modules/hostels/hostel-profile.service";
import { hostelPhotoCreateSchema } from "@/lib/hostels/hostel.validation";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const principal = await requireHostelCapability(request, "editHostelProfile");
    const input = hostelPhotoCreateSchema.parse(await request.json());
    const result = await addHostelAdminProfilePhoto(input, principal);

    return successResponse(result, "Hostel photo added", { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
