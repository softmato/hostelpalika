import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { rateLimitPublicForm, resetPublicFormRateLimitForTests } from "@/lib/rate-limit";

function request(ip = "203.0.113.10") {
  return new NextRequest("https://hostelpalika.local/api/v1/public/test", {
    headers: {
      "user-agent": "vitest",
      "x-forwarded-for": ip,
    },
    method: "POST",
  });
}

describe("public form rate limit", () => {
  beforeEach(() => {
    resetPublicFormRateLimitForTests();
    process.env.PUBLIC_FORM_RATE_LIMIT_MAX = "2";
    process.env.PUBLIC_FORM_RATE_LIMIT_WINDOW_SECONDS = "60";
  });

  afterEach(() => {
    resetPublicFormRateLimitForTests();
    delete process.env.PUBLIC_FORM_RATE_LIMIT_MAX;
    delete process.env.PUBLIC_FORM_RATE_LIMIT_WINDOW_SECONDS;
  });

  it("does not let a client escape by changing its user-agent", () => {
    const allowed = Array.from({ length: 13 }, (_, i) =>
      rateLimitPublicForm(
        new NextRequest("https://hostelpalika.local/api/v1/public/test", {
          headers: { "user-agent": `rotating-${i}`, "x-forwarded-for": "203.0.113.20" },
          method: "POST",
        }),
        { namespace: "test-rotation" },
      ),
    );

    // Limit 2, so the IP's total is 12: every new user-agent passes until then.
    expect(allowed.slice(0, 12).every((answer) => answer === null)).toBe(true);
    expect(allowed[12]?.status).toBe(429);
  });

  it("blocks repeated submissions after the configured limit", async () => {
    expect(rateLimitPublicForm(request(), { namespace: "test-form" })).toBeNull();
    expect(rateLimitPublicForm(request(), { namespace: "test-form" })).toBeNull();

    const blocked = rateLimitPublicForm(request(), { namespace: "test-form" });

    expect(blocked?.status).toBe(429);
    await expect(blocked?.json()).resolves.toMatchObject({
      errorCode: "RATE_LIMITED",
      success: false,
    });
  });

  it("separates limits by namespace and client", () => {
    expect(rateLimitPublicForm(request(), { namespace: "first-form" })).toBeNull();
    expect(rateLimitPublicForm(request(), { namespace: "first-form" })).toBeNull();
    expect(
      rateLimitPublicForm(request("203.0.113.11"), { namespace: "first-form" }),
    ).toBeNull();
    expect(rateLimitPublicForm(request(), { namespace: "second-form" })).toBeNull();
  });
});
