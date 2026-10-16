import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn() } }));

const { handleRouteError } = await import("./api-response");

describe("handleRouteError and a Softmato refusal", () => {
  it("says what the payment server refused instead of a bare 500", async () => {
    const refused = Object.assign(new Error("The request body failed validation"), {
      code: "VALIDATION_FAILED",
      name: "SoftmatoApiError",
      status: 422,
    });

    const response = handleRouteError(refused);
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(JSON.stringify(body)).toContain("Our payment server could not accept this");
    expect(JSON.stringify(body)).toContain("SOFTMATO_REJECTED");
  });

  it("answers a duplicate phone (Mongo E11000) as a plain 409", async () => {
    const duplicate = Object.assign(new Error("E11000 duplicate key error"), {
      code: 11000,
      keyPattern: { phone: 1 },
      name: "MongoServerError",
    });

    const response = handleRouteError(duplicate);
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.message).toBe("This phone number is already used by another account.");
  });

  it("still answers 500 for an error it does not know", async () => {
    expect(handleRouteError(new TypeError("boom")).status).toBe(500);
  });
});
