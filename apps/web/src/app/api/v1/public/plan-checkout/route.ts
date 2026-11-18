import type { NextRequest } from "next/server";

import { handleRouteError, progressResponse, successResponse } from "@/lib/api-response";
import { rateLimitPublicForm } from "@/lib/rate-limit";
import { requireHostelAdminPrincipal } from "@/lib/api-auth";
import { openSessionCheckout, planCheckoutSchema, runPlanCheckout } from "@/modules/billing/plan-checkout.service";

export const runtime = "nodejs";

/**
 * The pricing page's "Get plan" checkout for a hostel already on the platform.
 * One endpoint, one `step` per call: start → verify → invoice → pay | claim.
 * `session` replaces start → verify for a signed-in hostel admin.
 * See `plan-checkout.service.ts` for how the owner proves the hostel is theirs.
 */
export async function POST(request: NextRequest) {
  try {
    const input = planCheckoutSchema.parse(await request.json());

    // Only the steps that send or check a code are worth guessing at.
    if (input.step === "start" || input.step === "verify") {
      const limited = rateLimitPublicForm(request, { namespace: `plan-checkout-${input.step}` });

      if (limited) return limited;
    }

    if (input.step === "session") {
      const principal = await requireHostelAdminPrincipal(request);

      return successResponse(await openSessionCheckout(principal.hostelIds[0]), "OK");
    }

    if (input.step === "pay") {
      return progressResponse(request, (step) => runPlanCheckout(input, undefined, step), "OK");
    }

    const result = await runPlanCheckout(input, {
      ipAddress: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim(),
      userAgent: request.headers.get("user-agent") ?? undefined,
    });

    return successResponse(result, "OK");
  } catch (error) {
    return handleRouteError(error);
  }
}
