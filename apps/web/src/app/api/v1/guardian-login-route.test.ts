import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ loginGuardian: vi.fn() }));

vi.mock("@/modules/guardian/guardian.service", () => ({
  loginGuardian: mocks.loginGuardian,
}));

vi.mock("@/lib/db", () => ({ connectToDatabase: vi.fn() }));

vi.mock("@hostel/db/models/AuthAttempt", async () => {
  const { fakeModel } = await import("../../../../test/fake-mongo");

  return { AuthAttemptModel: fakeModel() };
});

import * as guardianLoginRoute from "@/app/api/v1/guardian/login/route";
import { ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE } from "@/lib/auth-cookies";

/**
 * The access-code route is the only way to present a guardian's code-and-phone
 * credential, and until 2026-08-17 it had none of the protections `/auth/login`
 * has. These pin the three that were added when the mobile screen made it
 * reachable from a phone.
 */
function request(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest("https://hostelpalika.local/api/v1/guardian/login", {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
    method: "POST",
  });
}

const validBody = { accessCode: "AB12CD", phone: "9800000000" };

describe("POST /api/v1/guardian/login", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loginGuardian.mockResolvedValue({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      user: { id: "user-1", role: "GUARDIAN" },
    });
  });

  /*
   * A six-character code plus a phone number that is not a secret. Unthrottled,
   * that is a guessing game whose prize is a session on somebody's guardian
   * view — and it was unthrottled.
   */
  it("rate limits to five wrong codes, like /auth/login", async () => {
    mocks.loginGuardian.mockRejectedValue(
      Object.assign(new Error("Invalid guardian access."), {
        errorCode: "INVALID_GUARDIAN_LOGIN",
        status: 401,
      }),
    );
    const headers = { "x-forwarded-for": "203.0.113.9" };
    const statuses: number[] = [];

    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await guardianLoginRoute.POST(request(validBody, headers));
      statuses.push(response.status);
    }

    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(statuses[5]).toBe(429);
    // The sixth never reached the service.
    expect(mocks.loginGuardian).toHaveBeenCalledTimes(5);
  });

  // Guardians of one hostel share its Wi-Fi; signing in must not use anyone's budget.
  it("does not count sign-ins that work", async () => {
    const headers = { "x-forwarded-for": "203.0.113.19" };

    for (let attempt = 0; attempt < 8; attempt += 1) {
      expect((await guardianLoginRoute.POST(request(validBody, headers))).status).toBe(200);
    }
  });

  /*
   * A refresh token readable by page scripts outlives an access-token rotation
   * and is the single most useful thing an XSS can steal. `/auth/login` gates
   * it behind the mobile client header; this route used to hand it to everyone.
   */
  it("withholds the refresh token from a browser", async () => {
    const response = await guardianLoginRoute.POST(
      request(validBody, { "x-forwarded-for": "203.0.113.10" }),
    );
    const payload = await response.json();

    expect(payload.data.accessToken).toBe("access-token");
    expect(payload.data).not.toHaveProperty("refreshToken");
  });

  it("returns it to the mobile client, which has no cookie jar", async () => {
    const response = await guardianLoginRoute.POST(
      request(validBody, {
        "x-forwarded-for": "203.0.113.11",
        "x-hostelhub-client": "mobile",
      }),
    );
    const payload = await response.json();

    expect(payload.data.refreshToken).toBe("refresh-token");
  });

  /*
   * Without these a browser sign-in produced tokens with nowhere to live, which
   * is why the web has never been able to use this route at all.
   */
  it("sets the session cookies", async () => {
    const response = await guardianLoginRoute.POST(
      request(validBody, { "x-forwarded-for": "203.0.113.12" }),
    );

    expect(response.cookies.get(ACCESS_TOKEN_COOKIE)?.value).toBe("access-token");
    expect(response.cookies.get(REFRESH_TOKEN_COOKIE)?.value).toBe("refresh-token");
  });
});
