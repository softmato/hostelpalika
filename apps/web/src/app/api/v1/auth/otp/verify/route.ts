import type { NextRequest } from "next/server";

import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { recordFailedAttempt, refuseIfTooManyFailures } from "@/lib/auth-attempts";
import { AuthServiceError, verifyOtpChallenge } from "@/modules/auth/auth.service";
import { otpVerifySchema } from "@/modules/auth/auth.validation";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const input = otpVerifySchema.parse(await request.json());
    // A 6-digit OTP falls quickly to an unbounded attacker. Each challenge also
    // caps itself at five; this adds the per-address budget across challenges.
    const limited = await refuseIfTooManyFailures(request, "auth-otp-verify", input.challengeId);

    if (limited) {
      return limited;
    }

    const result = await verifyOtpChallenge(input).catch(async (error: unknown) => {
      if (error instanceof AuthServiceError && error.errorCode === "OTP_INCORRECT") {
        await recordFailedAttempt(request, "auth-otp-verify", input.challengeId);
      }

      throw error;
    });

    return successResponse(result, "OTP verified");
  } catch (error) {
    if (error instanceof AuthServiceError) {
      return errorResponse(error.message, error.errorCode, error.status);
    }

    return handleRouteError(error);
  }
}
