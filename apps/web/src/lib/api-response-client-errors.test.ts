import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn() } }));

const { handleRouteError } = await import("./api-response");

describe("handleRouteError and a caller's mistake", () => {
  it.each([
    ["bad JSON", new SyntaxError("Unexpected token"), 400, "INVALID_JSON"],
    [
      "not a form",
      new TypeError('Content-Type was not one of "multipart/form-data" or "application/x-www-form-urlencoded".'),
      400,
      "INVALID_FORM",
    ],
    ["malformed id", Object.assign(new Error("Cast failed"), { name: "CastError" }), 404, "NOT_FOUND"],
    ["garbage token", new Error("Invalid authentication token."), 401, "UNAUTHENTICATED"],
    [
      "jose failure",
      Object.assign(new Error("signature verification failed"), { code: "ERR_JWS_SIGNATURE_VERIFICATION_FAILED" }),
      401,
      "UNAUTHENTICATED",
    ],
    [
      "storage not set up",
      new Error("R2_ENDPOINT, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY must be set"),
      503,
      "STORAGE_NOT_CONFIGURED",
    ],
  ])("%s", async (_name, error, status, errorCode) => {
    const response = handleRouteError(error);

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toMatchObject({ errorCode, success: false });
  });

  it("still answers a real fault with a 500 that hides the reason", async () => {
    const response = handleRouteError(new Error("connection refused"));
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(text).not.toContain("connection refused");
  });
});
