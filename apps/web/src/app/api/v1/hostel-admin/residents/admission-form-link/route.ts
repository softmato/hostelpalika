import type { NextRequest } from "next/server";
import { z } from "zod";

import { handleRouteError, successResponse } from "@/lib/api-response";
import { getAdmissionFormLink, updateAdmissionFormSettings } from "@/modules/residents/admission-form.service";
import { hostelStaffScope } from "@/modules/residents/hostel-staff-scope";

export const runtime = "nodejs";

/** The hostel's Form QR, made on first open, with its form settings. */
export async function GET(request: NextRequest) {
  try {
    const { hostelId, principal } = await hostelStaffScope(request);

    return successResponse(await getAdmissionFormLink(hostelId, principal), "Form QR loaded");
  } catch (error) {
    return handleRouteError(error);
  }
}

const settingsSchema = z.object({ guardianDocRequired: z.boolean() });

/** Settings → Form details: whether the guardian's ID document is required. */
export async function PATCH(request: NextRequest) {
  try {
    const { hostelId, principal } = await hostelStaffScope(request);
    const input = settingsSchema.parse(await request.json());

    return successResponse(await updateAdmissionFormSettings(hostelId, input, principal), "Form settings saved");
  } catch (error) {
    return handleRouteError(error);
  }
}
