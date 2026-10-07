import crypto from "node:crypto";

import { Types } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  clickCreate: vi.fn(),
  clickFindOneAndUpdate: vi.fn(),
  findCurrentResident: vi.fn(),
  userFindById: vi.fn(),
}));

const lean = (value: unknown) => ({ lean: () => Promise.resolve(value) });

vi.mock("@/lib/db", () => ({ connectToDatabase: vi.fn() }));
vi.mock("@hostel/db/models/Hostel", () => ({ HostelModel: {} }));
vi.mock("@hostel/db/models/QuestionCallClick", () => ({
  QuestionCallClickModel: {
    create: mocks.clickCreate,
    findOneAndUpdate: (...args: unknown[]) => lean(mocks.clickFindOneAndUpdate(...args)),
  },
}));
vi.mock("@hostel/db/models/User", () => ({
  UserModel: {
    findById: (id: unknown) => ({ select: () => lean(mocks.userFindById(id)) }),
  },
}));
vi.mock("@/modules/platform-config/site-config.service", () => ({
  getSiteConfigSection: () => Promise.resolve({ url: "https://questioncall.com/app" }),
}));
vi.mock("@/modules/residents/resident-access", () => ({
  findCurrentResident: mocks.findCurrentResident,
}));

const { exchangeQuestionCallSsoCode, trackQuestionCallClick } = await import(
  "./questioncall.service"
);

const userId = new Types.ObjectId();
const verified = { _id: userId, email: "a@b.np", emailVerified: true, name: "Asha", status: "ACTIVE" };

describe("QuestionCall sign-in handoff", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findCurrentResident.mockResolvedValue({
      _id: new Types.ObjectId(),
      hostelId: new Types.ObjectId(),
      residentType: "STUDENT",
      userId,
    });
  });

  it("mints a code whose secret half is stored only as a hash", async () => {
    mocks.userFindById.mockReturnValue(verified);

    const { clickId, ssoCode } = await trackQuestionCallClick({ deviceType: "android" }, {
      userId: userId.toString(),
    } as never);
    const [id, secret] = ssoCode!.split(".");
    const row = mocks.clickCreate.mock.calls[0][0];

    expect(id).toBe(clickId);
    expect(row.ssoCodeHash).toBe(crypto.createHash("sha256").update(secret).digest("hex"));
    expect(JSON.stringify(row)).not.toContain(secret);
  });

  it("mints nothing for an unverified email", async () => {
    mocks.userFindById.mockReturnValue({ ...verified, emailVerified: false });

    const { ssoCode } = await trackQuestionCallClick({ deviceType: "web" }, {
      userId: userId.toString(),
    } as never);

    expect(ssoCode).toBeNull();
    expect(mocks.clickCreate.mock.calls[0][0].ssoCodeHash).toBeUndefined();
  });

  it("burns the code in the lookup and returns the identity", async () => {
    const clickId = new Types.ObjectId();
    mocks.clickFindOneAndUpdate.mockReturnValue({ _id: clickId, userId });
    mocks.userFindById.mockReturnValue(verified);

    const result = await exchangeQuestionCallSsoCode({ code: `${clickId}.secret` });
    const [filter, update] = mocks.clickFindOneAndUpdate.mock.calls[0];

    expect(filter).toMatchObject({ _id: clickId, ssoUsedAt: null });
    expect(filter.ssoExpiresAt.$gt).toBeInstanceOf(Date);
    expect(update.$set.ssoUsedAt).toBeInstanceOf(Date);
    expect(result.user).toEqual({ email: "a@b.np", id: userId.toString(), name: "Asha", phone: null });
  });

  it("refuses a used, expired or malformed code", async () => {
    mocks.clickFindOneAndUpdate.mockReturnValue(null);

    await expect(
      exchangeQuestionCallSsoCode({ code: `${new Types.ObjectId()}.secret` }),
    ).rejects.toMatchObject({ errorCode: "QUESTIONCALL_SSO_INVALID", status: 401 });
    await expect(exchangeQuestionCallSsoCode({ code: "nonsense" })).rejects.toMatchObject({
      status: 401,
    });
  });
});
