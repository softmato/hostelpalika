import { Types } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { hostelCode } from "@/lib/hostel-code";

const mocks = vi.hoisted(() => ({
  hostelFind: vi.fn(),
  hostelFindOne: vi.fn(),
  otpFindOne: vi.fn(),
  requestOtp: vi.fn(),
  userFind: vi.fn(),
}));

const lean = (rows: unknown[]) => ({ select: () => ({ lean: async () => rows }) });

vi.mock("@hostel/db/models/User", () => ({ UserModel: { find: mocks.userFind } }));
vi.mock("@hostel/db/models/Hostel", () => ({
  HostelModel: { find: mocks.hostelFind, findOne: mocks.hostelFindOne },
}));
vi.mock("@hostel/db/models/OtpChallenge", () => ({ OtpChallengeModel: { findOne: mocks.otpFindOne } }));
vi.mock("@/lib/db", () => ({ connectToDatabase: async () => undefined }));
vi.mock("@/modules/auth/auth.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/modules/auth/auth.service")>()),
  requestOtpChallenge: mocks.requestOtp,
}));

import { AuthServiceError } from "@/modules/auth/auth.service";
import { findHostelForCheckout, runPlanCheckout } from "@/modules/billing/plan-checkout.service";

const ownerId = new Types.ObjectId();
const owned = { _id: new Types.ObjectId(), name: "Owned", ownerId };
const other = { _id: new Types.ObjectId(), name: "Someone else's", ownerId: new Types.ObjectId() };

describe("findHostelForCheckout — a code is only sent past all three gates", () => {
  beforeEach(() => {
    mocks.userFind.mockReset();
    mocks.hostelFind.mockReset();
  });

  it("1. refuses an email that exists nowhere", async () => {
    mocks.userFind.mockReturnValue(lean([]));
    mocks.hostelFind.mockReturnValue(lean([]));

    expect(await findHostelForCheckout("nobody@x.com", hostelCode(String(owned._id)))).toBeNull();
  });

  it("2. refuses a real account that no hostel is bound to", async () => {
    mocks.userFind.mockReturnValue(lean([{ _id: new Types.ObjectId() }]));
    mocks.hostelFind.mockReturnValue(lean([]));

    expect(await findHostelForCheckout("resident@x.com", hostelCode(String(owned._id)))).toBeNull();
  });

  it("3. refuses a real Hostel ID that belongs to a different email", async () => {
    mocks.userFind.mockReturnValue(lean([{ _id: ownerId }]));
    mocks.hostelFind.mockReturnValueOnce(lean([])).mockReturnValueOnce(lean([owned]));

    expect(await findHostelForCheckout("owner@x.com", hostelCode(String(other._id)))).toBeNull();
  });

  it("matches the owner's own hostel, however the ID is typed", async () => {
    mocks.userFind.mockReturnValue(lean([{ _id: ownerId }]));
    mocks.hostelFind.mockReturnValueOnce(lean([])).mockReturnValueOnce(lean([owned]));

    const typed = hostelCode(String(owned._id)).toLowerCase().replaceAll("-", " ");

    expect(await findHostelForCheckout("owner@x.com", typed)).toBe(owned);
  });

  it("matches through the hostel's contact email", async () => {
    mocks.userFind.mockReturnValue(lean([]));
    mocks.hostelFind.mockReturnValue(lean([other]));

    expect(await findHostelForCheckout("front-desk@x.com", hostelCode(String(other._id)))).toBe(other);
  });

  it("opens the main hostel's checkout for a branch's ID — the branch has no plan of its own", async () => {
    const branch = { _id: new Types.ObjectId(), name: "Branch", ownerId, parentHostelId: owned._id };

    mocks.userFind.mockReturnValue(lean([{ _id: ownerId }]));
    mocks.hostelFind.mockReturnValueOnce(lean([])).mockReturnValueOnce(lean([owned, branch]));
    mocks.hostelFindOne.mockReturnValue({ select: () => ({ lean: async () => owned }) });

    expect(await findHostelForCheckout("owner@x.com", hostelCode(String(branch._id)))).toBe(owned);
    expect(mocks.hostelFindOne).toHaveBeenCalledWith({ _id: owned._id, isDeleted: { $ne: true } });
  });
});

describe("start — pressing Send again inside the resend wait", () => {
  it("resumes the code already in the inbox instead of locking the owner out", async () => {
    const challengeId = new Types.ObjectId();

    mocks.userFind.mockReturnValue(lean([{ _id: ownerId }]));
    mocks.hostelFind.mockReset();
    mocks.hostelFind.mockReturnValueOnce(lean([])).mockReturnValueOnce(lean([owned]));
    mocks.requestOtp.mockRejectedValue(
      new AuthServiceError("Please wait before requesting another OTP.", "OTP_RESEND_COOLDOWN", 429),
    );
    mocks.otpFindOne.mockReturnValue({
      sort: () => ({
        lean: async () => ({
          _id: challengeId,
          codeLastSentAt: new Date(Date.now() - 20_000),
          expiresAt: new Date(Date.now() + 600_000),
        }),
      }),
    });

    const result = await runPlanCheckout({
      email: "owner@x.com",
      hostelCode: hostelCode(String(owned._id)),
      step: "start",
    });

    expect(result).toMatchObject({ challengeId: String(challengeId), resumed: true });
    expect((result as { resendInSeconds: number }).resendInSeconds).toBeGreaterThan(0);
  });
});
