import { Types } from "mongoose";
import { expect, it, vi } from "vitest";
import type { FakeModel } from "../../../test/fake-mongo";
function fake(name: string) {
  return async (original: () => Promise<Record<string, unknown>>) => {
    const actual = await original();
    const { fakeModel } = await import("../../../test/fake-mongo");
    return { ...actual, [name]: fakeModel() };
  };
}
vi.mock("@/lib/db", () => ({ connectToDatabase: vi.fn() }));
vi.mock("@/modules/hostels/hostel.service", () => ({ HostelServiceError: Error }));
vi.mock("@hostel/db/models/Hostel", fake("HostelModel"));
vi.mock("@hostel/db/models/HostelDocument", fake("HostelDocumentModel"));
vi.mock("@hostel/db/models/HostelPayoutAccount", fake("HostelPayoutAccountModel"));
vi.mock("@hostel/db/models/HostelPaymentProfile", fake("HostelPaymentProfileModel"));
vi.mock("@hostel/db/models/FoodRoutine", fake("FoodRoutineModel"));
vi.mock("@hostel/db/models/FileAsset", fake("FileAssetModel"));
const { HostelModel } = await import("@hostel/db/models/Hostel");
const { HostelDocumentModel } = await import("@hostel/db/models/HostelDocument");
const { HostelPayoutAccountModel } =
  await import("@hostel/db/models/HostelPayoutAccount");
const { getHostelKyc } = await import("./hostel-kyc.service");
it("keeps photos, documents and payout KYC separate for branches owned by the same account", async () => {
  const main = new Types.ObjectId();
  const branch = new Types.ObjectId();
  const ownerId = new Types.ObjectId();
  (HostelModel as unknown as FakeModel).reset([
    {
      _id: main,
      ownerId,
      photos: [{ url: "/a.jpg" }, { url: "/b.jpg" }, { url: "/c.jpg" }],
    },
    { _id: branch, ownerId, parentHostelId: main, photos: [{ url: "/branch.jpg" }] },
  ]);
  (HostelDocumentModel as unknown as FakeModel).reset([
    {
      _id: new Types.ObjectId(),
      hostelId: main,
      isDeleted: false,
      documentType: "PAN",
      status: "APPROVED",
    },
  ]);
  (HostelPayoutAccountModel as unknown as FakeModel).reset([{ hostelId: main }]);
  const a = await getHostelKyc(main);
  const b = await getHostelKyc(branch);
  expect(a.photoCount).toBe(3);
  expect(b.photoCount).toBe(1);
  expect(a.documents).toHaveLength(1);
  expect(b.documents).toEqual([]);
  for (const key of ["photos", "documents", "payout"]) {
    expect(a.steps.find((step) => step.key === key)?.done).toBe(true);
    expect(b.steps.find((step) => step.key === key)?.done).toBe(false);
  }
});
