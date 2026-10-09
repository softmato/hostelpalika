import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ connectToDatabase: async () => undefined }));
vi.mock("@hostel/db/models/SoftmatoTask", () => ({
  SOFTMATO_TASK_KINDS: ["PLAN_PAYMENT"],
  SoftmatoTaskModel: { updateOne: vi.fn(async () => undefined) },
}));
vi.mock("./client", () => ({
  isSoftmatoDown: (error: { status?: number }) => (error?.status ?? 0) >= 500,
}));
vi.mock("@softmato/sdk", () => {
  class SoftmatoApiError extends Error {
    constructor(
      message: string,
      readonly status: number,
      readonly code: string,
    ) {
      super(message);
    }
  }

  return { SoftmatoApiError };
});

const { SoftmatoApiError } = (await import("@softmato/sdk")) as unknown as {
  SoftmatoApiError: new (message: string, status: number, code: string) => Error;
};
const { SoftmatoRejectedError, unlessSoftmatoDown } = await import("./outage");

describe("unlessSoftmatoDown", () => {
  it("carries a Softmato refusal to the screen in their words, not as a bare 500", async () => {
    const refused = unlessSoftmatoDown(
      () => null,
      async () => {
        throw new SoftmatoApiError("service_ends_at is required", 422, "VALIDATION_ERROR");
      },
    );

    await expect(refused).rejects.toBeInstanceOf(SoftmatoRejectedError);
    await expect(refused).rejects.toMatchObject({
      errorCode: "SOFTMATO_REJECTED",
      message: expect.stringContaining("service_ends_at is required"),
      status: 502,
    });
  });

  it("names the field Softmato refused, when the SDK says", async () => {
    const error = new SoftmatoApiError("The request body failed validation", 422, "VALIDATION_ERROR");
    Object.assign(error, { details: { field: "due_at" } });

    await expect(unlessSoftmatoDown(() => null, async () => Promise.reject(error))).rejects.toMatchObject({
      message: expect.stringContaining("due_at"),
    });
  });

  it("leaves every other error alone", async () => {
    const boom = new TypeError("not Softmato");

    await expect(unlessSoftmatoDown(() => null, async () => Promise.reject(boom))).rejects.toBe(boom);
  });
});
