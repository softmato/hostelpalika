import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Role } from "@/lib/roles";

const routeMocks = vi.hoisted(() => {
  class MockAuthServiceError extends Error {
    constructor(
      message: string,
      public errorCode = "AUTH_ERROR",
      public status = 401,
    ) {
      super(message);
    }
  }

  return {
    AuthServiceError: MockAuthServiceError,
    authenticateWithGoogle: vi.fn(),
    login: vi.fn(),
    registerPublicAccount: vi.fn(),
    requestOtpChallenge: vi.fn(),
    resetPasswordWithToken: vi.fn(),
    verifyEmailWithToken: vi.fn(),
    verifyOtpChallenge: vi.fn(),
  };
});

vi.mock("@/modules/auth/auth.service", () => routeMocks);

vi.mock("@/lib/db", () => ({ connectToDatabase: vi.fn() }));

vi.mock("@hostel/db/models/AuthAttempt", async () => {
  const { fakeModel } = await import("../../../../../test/fake-mongo");

  return { AuthAttemptModel: fakeModel() };
});

import * as googleRoute from "@/app/api/v1/auth/google/route";
import * as loginRoute from "@/app/api/v1/auth/login/route";
import * as otpRequestRoute from "@/app/api/v1/auth/otp/request/route";
import * as otpVerifyRoute from "@/app/api/v1/auth/otp/verify/route";
import * as registerRoute from "@/app/api/v1/auth/register/route";
import * as resetPasswordRoute from "@/app/api/v1/auth/reset-password/route";
import * as verifyEmailRoute from "@/app/api/v1/auth/verify-email/route";

function jsonRequest(path: string, body: unknown, headers?: Record<string, string>) {
  return new NextRequest(`https://hostelpalika.local${path}`, {
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    method: "POST",
  });
}

function authSession() {
  return {
    accessToken: "access-token",
    refreshToken: "refresh-token",
    user: {
      email: "public@example.com",
      hostelIds: [],
      id: "user-1",
      name: "Public User",
      phone: null,
      role: Role.PUBLIC,
      status: "ACTIVE",
    },
  };
}

describe("phase 1 auth routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates OTP challenges through the route handler", async () => {
    routeMocks.requestOtpChallenge.mockResolvedValue({
      challengeId: "64f0f0f0f0f0f0f0f0f0f0f0",
      delivery: { channel: "email", provider: "development", status: "development" },
      devCode: "123456",
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
    });

    const response = await otpRequestRoute.POST(
      jsonRequest("/api/v1/auth/otp/request", {
        channel: "email",
        identifier: "public@example.com",
      }),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.success).toBe(true);
    expect(payload.data.challengeId).toBe("64f0f0f0f0f0f0f0f0f0f0f0");
  });

  it("verifies OTP challenges through the route handler", async () => {
    routeMocks.verifyOtpChallenge.mockResolvedValue({
      challengeId: "64f0f0f0f0f0f0f0f0f0f0f0",
      channel: "email",
      identifier: "public@example.com",
      verifiedAt: new Date("2030-01-01T00:00:00.000Z"),
    });

    const response = await otpVerifyRoute.POST(
      jsonRequest("/api/v1/auth/otp/verify", {
        challengeId: "64f0f0f0f0f0f0f0f0f0f0f0",
        code: "123456",
      }),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.success).toBe(true);
    expect(payload.message).toBe("OTP verified");
  });

  it("registers mobile public users and exposes the mobile refresh token", async () => {
    routeMocks.registerPublicAccount.mockResolvedValue(authSession());

    const response = await registerRoute.POST(
      jsonRequest(
        "/api/v1/auth/register",
        {
          email: "public@example.com",
          name: "Public User",
          otpChallengeId: "64f0f0f0f0f0f0f0f0f0f0f0",
          password: "ChangeMe123!",
        },
        { "x-hostelhub-client": "mobile" },
      ),
    );
    const payload = await response.json();

    expect(response.status).toBe(201);
    expect(payload.success).toBe(true);
    expect(payload.data.refreshToken).toBe("refresh-token");
    expect(payload.data.user.role).toBe(Role.PUBLIC);
  });

  it("locks an IP out of login after 5 failed attempts in the window", async () => {
    // PHASES.md §1.1 / §5.2: 5 failures per 15 minutes per IP and account
    // (`lib/auth-attempts.ts`), so this address must be unique to this test.
    let probe = 0;
    const attacker = () => ({
      // A new user-agent every try must not buy a new budget.
      "user-agent": `rate-limit-probe-${(probe += 1)}`,
      "x-forwarded-for": "203.0.113.77",
    });

    routeMocks.login.mockRejectedValue(
      new routeMocks.AuthServiceError("Invalid credentials.", "INVALID_CREDENTIALS", 401),
    );

    const attempt = () =>
      loginRoute.POST(
        jsonRequest(
          "/api/v1/auth/login",
          { identifier: "victim@example.com", password: "wrong-password" },
          attacker(),
        ),
      );

    for (let i = 0; i < 5; i += 1) {
      expect((await attempt()).status).toBe(401);
    }

    const blocked = await attempt();

    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toMatchObject({
      errorCode: "RATE_LIMITED",
      success: false,
    });
    // The 6th attempt must never reach the credential check.
    expect(routeMocks.login).toHaveBeenCalledTimes(5);
  });

  it("never counts a sign-in that works, so one hostel's Wi-Fi is not one budget", async () => {
    routeMocks.login.mockResolvedValue(authSession());
    const sharedWifi = { "user-agent": "okhttp/4.12.0", "x-forwarded-for": "203.0.113.78" };

    for (let resident = 0; resident < 12; resident += 1) {
      const response = await loginRoute.POST(
        jsonRequest(
          "/api/v1/auth/login",
          { identifier: `resident${resident}@example.com`, password: "right-password" },
          sharedWifi,
        ),
      );

      expect(response.status).toBe(200);
    }
  });

  it("locks out an OTP challenge after 5 wrong codes from one address", async () => {
    routeMocks.verifyOtpChallenge.mockRejectedValue(
      new routeMocks.AuthServiceError("OTP code is incorrect.", "OTP_INCORRECT", 400),
    );
    const attempt = () =>
      otpVerifyRoute.POST(
        jsonRequest(
          "/api/v1/auth/otp/verify",
          { challengeId: "64f0f0f0f0f0f0f0f0f0f0f1", code: "000000" },
          { "x-forwarded-for": "203.0.113.79" },
        ),
      );

    for (let i = 0; i < 5; i += 1) {
      expect((await attempt()).status).toBe(400);
    }

    expect((await attempt()).status).toBe(429);
    expect(routeMocks.verifyOtpChallenge).toHaveBeenCalledTimes(5);
  });

  it("returns configured service errors from Google auth", async () => {
    routeMocks.authenticateWithGoogle.mockRejectedValue(
      new routeMocks.AuthServiceError(
        "Google auth is not configured.",
        "GOOGLE_AUTH_NOT_CONFIGURED",
        503,
      ),
    );

    const response = await googleRoute.POST(
      jsonRequest("/api/v1/auth/google", {
        idToken: "this-is-a-long-google-id-token-placeholder",
      }),
    );
    const payload = await response.json();

    expect(response.status).toBe(503);
    expect(payload).toMatchObject({
      errorCode: "GOOGLE_AUTH_NOT_CONFIGURED",
      success: false,
    });
  });
});

/** Long enough to clear the schema's 20-character minimum. */
const GUESSED_TOKEN = "0123456789abcdef0123456789abcdef";

describe("token-guessing surfaces are rate limited too", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // PHASES.md §5.1: "Rate limiting on all auth endpoints". Login was covered
  // in Phase 1; a reset or verification token is just as guessable.
  it("locks out repeated password-reset token attempts", async () => {
    routeMocks.resetPasswordWithToken.mockRejectedValue(
      new routeMocks.AuthServiceError("Invalid token.", "INVALID_RESET_TOKEN", 400),
    );

    const headers = {
      "user-agent": "reset-probe",
      "x-forwarded-for": "203.0.113.91",
    };
    const attempt = () =>
      resetPasswordRoute.POST(
        jsonRequest(
          "/api/v1/auth/reset-password",
          { newPassword: "Str0ng-passw0rd!", token: GUESSED_TOKEN },
          headers,
        ),
      );

    for (let i = 0; i < 5; i += 1) {
      expect((await attempt()).status).toBe(400);
    }

    expect((await attempt()).status).toBe(429);
    expect(routeMocks.resetPasswordWithToken).toHaveBeenCalledTimes(5);
  });

  it("locks out repeated email-verification token attempts", async () => {
    routeMocks.verifyEmailWithToken.mockRejectedValue(
      new routeMocks.AuthServiceError(
        "Invalid token.",
        "INVALID_VERIFICATION_TOKEN",
        400,
      ),
    );

    const headers = {
      "user-agent": "verify-probe",
      "x-forwarded-for": "203.0.113.92",
    };
    const attempt = () =>
      verifyEmailRoute.POST(
        jsonRequest("/api/v1/auth/verify-email", { token: GUESSED_TOKEN }, headers),
      );

    for (let i = 0; i < 5; i += 1) {
      expect((await attempt()).status).toBe(400);
    }

    expect((await attempt()).status).toBe(429);
  });

  // Each endpoint has its own budget: burning through resets must not also
  // lock someone out of verifying their email.
  it("keeps the budgets separate per endpoint", async () => {
    routeMocks.resetPasswordWithToken.mockRejectedValue(
      new routeMocks.AuthServiceError("Invalid token.", "INVALID_RESET_TOKEN", 400),
    );
    routeMocks.verifyEmailWithToken.mockResolvedValue({ verified: true });

    const headers = {
      "user-agent": "shared-probe",
      "x-forwarded-for": "203.0.113.93",
    };

    for (let i = 0; i < 6; i += 1) {
      await resetPasswordRoute.POST(
        jsonRequest(
          "/api/v1/auth/reset-password",
          { newPassword: "Str0ng-passw0rd!", token: GUESSED_TOKEN },
          headers,
        ),
      );
    }

    const verify = await verifyEmailRoute.POST(
      jsonRequest(
        "/api/v1/auth/verify-email",
        { token: `${GUESSED_TOKEN}-real` },
        headers,
      ),
    );

    expect(verify.status).toBe(200);
  });
});
