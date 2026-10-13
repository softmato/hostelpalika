import { Types } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { FakeModel } from "../../../test/fake-mongo";

/** A quick sign-up's KYC goes to our queue only with every required section done. */

function fake(name: string) {
  return async (original: () => Promise<Record<string, unknown>>) => {
    const actual = await original();
    const { fakeModel } = await import("../../../test/fake-mongo");
    return { ...actual, [name]: fakeModel() };
  };
}

vi.mock("@/lib/db", () => ({ connectToDatabase: vi.fn() }));
vi.mock("@/modules/hostels/hostel.service", () => ({
  HostelServiceError: class extends Error {
    constructor(message: string, public errorCode: string, public status: number) {
      super(message);
    }
  },
}));
vi.mock("@/modules/hostels/hostel-notify", () => ({ notifyPlatformOfPendingHostel: vi.fn(async () => {}) }));
for (const [path, name] of [
  ["@hostel/db/models/Hostel", "HostelModel"],
  ["@hostel/db/models/HostelDocument", "HostelDocumentModel"],
  ["@hostel/db/models/HostelPayoutAccount", "HostelPayoutAccountModel"],
  ["@hostel/db/models/HostelPaymentProfile", "HostelPaymentProfileModel"],
  ["@hostel/db/models/FoodRoutine", "FoodRoutineModel"],
  ["@hostel/db/models/FileAsset", "FileAssetModel"],
  ["@hostel/db/models/HostelRoom", "HostelRoomModel"],
  ["@hostel/db/models/HostelSettings", "HostelSettingsModel"],
  ["@hostel/db/models/FeeSchedule", "FeeScheduleModel"],
  ["@hostel/db/models/AuditLog", "AuditLogModel"],
  ["@hostel/db/models/HostelApplication", "HostelApplicationModel"],
  ["@hostel/db/models/HostelVerification", "HostelVerificationModel"],
  ["@hostel/db/models/User", "UserModel"],
] as const) {
  vi.doMock(path, fake(name));
}

const { HostelModel } = await import("@hostel/db/models/Hostel");
const { HostelDocumentModel } = await import("@hostel/db/models/HostelDocument");
const { FeeScheduleModel } = await import("@hostel/db/models/FeeSchedule");
const { HostelApplicationModel } = await import("@hostel/db/models/HostelApplication");
const { submitHostelKyc, getHostelKyc } = await import("./hostel-kyc.service");

const hostels = HostelModel as unknown as FakeModel;
const documents = HostelDocumentModel as unknown as FakeModel;
const rateCards = FeeScheduleModel as unknown as FakeModel;
const applications = HostelApplicationModel as unknown as FakeModel;

const hostelId = new Types.ObjectId();
const ownerId = new Types.ObjectId();

beforeEach(() => {
  documents.reset();
  rateCards.reset();
  applications.reset();
  hostels.reset([
    {
      _id: hostelId,
      kyc: { required: true, status: "DRAFT" },
      location: { area: "Baneshwor", city: "Kathmandu", lat: 27.7, locationSource: "MANUAL" },
      name: "Study Sanjal",
      ownerId,
      photos: [{ url: "a" }, { url: "b" }, { url: "c" }],
      status: "DRAFT",
    },
  ]);
});

describe("submitHostelKyc", () => {
  it("refuses while a required section is missing, and names it", async () => {
    const kyc = await getHostelKyc(hostelId);

    expect(kyc.review).toMatchObject({ canSubmit: false, missing: ["rates", "documents"], status: "DRAFT" });
    await expect(submitHostelKyc(hostelId, ownerId.toString())).rejects.toMatchObject({
      errorCode: "KYC_INCOMPLETE",
    });
  });

  it("puts a finished KYC in the review queue, still editable", async () => {
    await documents.create({ documentType: "Owner ID proof", hostelId, isDeleted: false, status: "PENDING" });
    await rateCards.create({ effectiveTo: null, hostelId, rates: [{ monthlyAmount: 9000, roomType: "Double" }] });

    const kyc = await submitHostelKyc(hostelId, ownerId.toString());

    expect(kyc.review).toMatchObject({ canSubmit: false, status: "SUBMITTED" });
    expect(hostels.docs[0]).toMatchObject({ status: "PENDING_APPROVAL", verificationStatus: "PENDING" });
    expect(applications.docs[0]).toMatchObject({ status: "PENDING" });
  });

  it("does not apply to a hostel registered before the quick sign-up", async () => {
    hostels.docs[0]!.kyc = undefined;

    expect((await getHostelKyc(hostelId)).review).toBeNull();
    await expect(submitHostelKyc(hostelId, ownerId.toString())).rejects.toMatchObject({
      errorCode: "KYC_NOT_REQUIRED",
    });
  });
});
