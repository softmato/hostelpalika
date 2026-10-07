import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Role } from "@/lib/roles";

const mocks = vi.hoisted(() => ({
  findById: vi.fn(),
  findOneAndUpdate: vi.fn(),
  hostelFind: vi.fn(),
  updateOne: vi.fn(),
  verifyAccessToken: vi.fn(),
  verifyBiometricCode: vi.fn(),
  verifyPassword: vi.fn(),
  verifyPurposeToken: vi.fn(),
}));

/** `Model.find…().select().lean()` resolving to `row`. */
const query = (row: unknown) => ({ select: () => ({ lean: async () => row }) });

vi.mock("@/lib/db", () => ({ connectToDatabase: vi.fn() }));
vi.mock("@/lib/password", () => ({
  hashPassword: async (value: string) => `hash:${value}`,
  verifyPassword: mocks.verifyPassword,
}));
vi.mock("@/modules/food/cook-identity", () => ({ COOK_LOGIN_DOMAIN: "cook.local" }));
vi.mock("@/modules/auth/auth.service", () => ({
  AuthServiceError: class extends Error {
    constructor(
      message: string,
      public errorCode: string,
      public status = 401,
    ) {
      super(message);
    }
  },
  verifyBiometricCode: mocks.verifyBiometricCode,
}));
vi.mock("@hostel/db/models/User", () => ({
  UserModel: {
    findById: (...args: unknown[]) => mocks.findById(...args),
    findOneAndUpdate: (...args: unknown[]) => mocks.findOneAndUpdate(...args),
    updateOne: mocks.updateOne,
  },
}));
vi.mock("@hostel/db/models/Hostel", () => ({ HostelModel: { find: mocks.hostelFind } }));
vi.mock("@/modules/auth/temporary-credential.service", () => ({
  isTemporaryCredentialActive: vi.fn(),
}));
vi.mock("@/lib/auth", async () => ({
  ...(await vi.importActual("@/lib/auth-cookies")),
  getBearerToken: (header: string | null) =>
    header?.startsWith("Bearer ") ? header.slice(7).trim() : null,
  signPurposeToken: vi.fn(),
  verifyAccessToken: mocks.verifyAccessToken,
  verifyPurposeToken: mocks.verifyPurposeToken,
}));

import { POST as touch } from "@/app/api/v1/auth/lock-pin/touch/route";
import { requireApiPrincipal } from "@/lib/api-auth";
import { setLockPin, verifyLockPin } from "@/modules/auth/lock-pin.service";

const withPin = { _id: "user-1", email: "a@gmail.com", lockPinSetAt: new Date() };

describe("lock PIN", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findById.mockReturnValue(query(withPin));
  });

  it("spends a try before comparing; counts down only after the fifth miss", async () => {
    mocks.verifyPassword.mockResolvedValue(false);

    mocks.findOneAndUpdate.mockReturnValue(query({ lockPinFailures: 5, lockPinHash: "hash:1234" }));
    await expect(verifyLockPin("user-1", "0000")).rejects.toMatchObject({
      errorCode: "LOCK_PIN_INCORRECT",
      message: "Wrong PIN. Try again.",
    });

    mocks.findOneAndUpdate.mockReturnValue(query({ lockPinFailures: 6, lockPinHash: "hash:1234" }));
    await expect(verifyLockPin("user-1", "0000")).rejects.toMatchObject({
      message: "Wrong PIN. 4 tries left.",
    });
    expect(mocks.findOneAndUpdate.mock.calls[0]![0]).toMatchObject({
      lockPinFailures: { $lt: 10 },
    });
  });

  it("blocks after the tenth wrong PIN, and keeps blocking", async () => {
    mocks.findOneAndUpdate.mockReturnValueOnce(query({ lockPinFailures: 10, lockPinHash: "h" }));
    mocks.verifyPassword.mockResolvedValue(false);
    await expect(verifyLockPin("user-1", "0000")).rejects.toMatchObject({
      errorCode: "LOCK_PIN_BLOCKED",
    });

    // Past the limit the atomic update matches nothing — even the right PIN is refused.
    mocks.findOneAndUpdate.mockReturnValueOnce(query(null));
    await expect(verifyLockPin("user-1", "1234")).rejects.toMatchObject({
      errorCode: "LOCK_PIN_BLOCKED",
    });
  });

  it("resets the count on the right PIN", async () => {
    mocks.findOneAndUpdate.mockReturnValue(query({ lockPinFailures: 2, lockPinHash: "hash:1234" }));
    mocks.verifyPassword.mockResolvedValue(true);

    await expect(verifyLockPin("user-1", "1234")).resolves.toEqual({ verified: true });
    expect(mocks.updateOne).toHaveBeenCalledWith(
      { _id: "user-1" },
      { $set: { lockPinFailures: 0 } },
    );
  });

  it("will not replace a PIN without proof, and takes an email code as proof", async () => {
    await expect(setLockPin("user-1", { pin: "4321" })).rejects.toMatchObject({
      errorCode: "LOCK_PIN_PROOF_REQUIRED",
    });

    await setLockPin("user-1", {
      challengeId: "507f1f77bcf86cd799439011",
      code: "123456",
      pin: "4321",
    });
    expect(mocks.verifyBiometricCode).toHaveBeenCalled();
    expect(mocks.updateOne).toHaveBeenCalledWith(
      { _id: "user-1" },
      { $set: expect.objectContaining({ lockPinFailures: 0, lockPinHash: "hash:4321" }) },
    );
  });

  it("refuses a browser session that has not typed the PIN, but not the app", async () => {
    mocks.verifyAccessToken.mockResolvedValue({
      hostelIds: [],
      lockPin: true,
      role: Role.PUBLIC,
      sessionId: "s-1",
      sub: "user-1",
      tokenType: "access",
    });
    mocks.verifyPurposeToken.mockRejectedValue(new Error("no cookie"));

    const browser = new NextRequest("https://x.local/api/v1/residents", {
      headers: { cookie: "hostelpalika_access_token=t" },
    });
    await expect(requireApiPrincipal(browser)).rejects.toMatchObject({
      errorCode: "LOCK_PIN_REQUIRED",
      status: 423,
    });

    // The unlock itself stays reachable.
    const unlock = new NextRequest("https://x.local/api/v1/auth/lock-pin/verify", {
      headers: { cookie: "hostelpalika_access_token=t" },
    });
    await expect(requireApiPrincipal(unlock)).resolves.toMatchObject({ pinLocked: true });

    const app = new NextRequest("https://x.local/api/v1/residents", {
      headers: { authorization: "Bearer t" },
    });
    await expect(requireApiPrincipal(app)).resolves.not.toHaveProperty("pinLocked");
  });

  it("slides a live unlock on activity, but never revives a lapsed one", async () => {
    mocks.verifyAccessToken.mockResolvedValue({
      hostelIds: [],
      lockPin: true,
      role: Role.PUBLIC,
      sessionId: "s-1",
      sub: "user-1",
      tokenType: "access",
    });
    mocks.verifyPurposeToken.mockRejectedValue(new Error("expired"));

    const lapsed = await touch(
      new NextRequest("https://x.local/api/v1/auth/lock-pin/touch", {
        headers: { cookie: "hostelpalika_access_token=t; hostelpalika_unlock=old" },
        method: "POST",
      }),
    );
    expect(lapsed.status).toBe(423);
  });
});
