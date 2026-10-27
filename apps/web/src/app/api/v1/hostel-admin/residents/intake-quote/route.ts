import type { NextRequest } from "next/server";
import { z } from "zod";

import { requireHostelCapability } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { resolveAdminHostelId } from "@/modules/hostels/hostel.service";
import { getIntakeQuote } from "@/modules/residents/resident-intake.service";

export const runtime = "nodejs";

const intakeQuoteQuerySchema = z.object({
  admissionFee: z.coerce.number().int().min(0).max(10_000_000).optional(),
  billingCycle: z.enum(["CALENDAR_MONTH", "SAME_DAY"]).optional(),
  depositAmount: z.coerce.number().int().min(0).max(10_000_000).optional(),
  formFee: z.coerce.number().int().min(0).max(10_000_000).optional(),
  hostelId: z.string().optional(),
  monthlyFee: z.coerce.number().int().min(0).max(10_000_000).optional(),
  moveInDate: z.coerce.date().optional(),
  referralCode: z.string().trim().max(32).optional(),
  roomType: z.string().trim().min(1, "Pick a room type."),
});

/**
 * What this intake costs, resolved on the server.
 *
 * Gated on `registerResidents` rather than `viewPayments` on purpose. The rate
 * card behind it is a `viewPayments` document, but a warden who may admit
 * somebody must be told what to charge them — and the alternative to being told
 * is being asked to type it, which is the thing this replaces. Only the numbers
 * for the one room type asked about come back, never the card.
 */
export async function GET(request: NextRequest) {
  try {
    const principal = await requireHostelCapability(request, "registerResidents");
    const query = intakeQuoteQuerySchema.parse(
      Object.fromEntries(request.nextUrl.searchParams.entries()),
    );
    const hostelId = resolveAdminHostelId(principal, query.hostelId);

    return withEtag(request, successResponse(
      {
        quote: await getIntakeQuote(hostelId, {
          admissionFee: query.admissionFee,
          billingCycle: query.billingCycle,
          depositAmount: query.depositAmount,
          formFee: query.formFee,
          monthlyFee: query.monthlyFee,
          moveInDate: query.moveInDate,
          referralCode: query.referralCode,
          roomType: query.roomType,
        }),
      },
      "Intake quote",
    ));
  } catch (error) {
    return handleRouteError(error);
  }
}
