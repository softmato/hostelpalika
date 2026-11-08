import type { NextRequest } from "next/server";

import { requireHostelCapability } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { requestHostelProfileChange } from "@/modules/hostels/hostel-profile.service";
import { hostelChangeRequestSchema } from "@/lib/hostels/hostel.validation";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const principal = await requireHostelCapability(request, "editHostelProfile");
    const input = hostelChangeRequestSchema.parse(await request.json());
    const result = await requestHostelProfileChange(input, principal);

    return successResponse(result, "Change request sent to the platform team", {
      status: 201,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
