import { Types } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeModel } from "../../../test/fake-mongo";
vi.mock("@hostel/db/models/Hostel", async () => {
  const { fakeModel } = await import("../../../test/fake-mongo");
  return { HostelModel: fakeModel() };
});
const { HostelModel } = await import("@hostel/db/models/Hostel");
const { listPublicSiblingBranches } = await import("./public-branches.service");
const hostels = HostelModel as unknown as FakeModel;
const ownerId = new Types.ObjectId();
const root = new Types.ObjectId();
const b = new Types.ObjectId();
const c = new Types.ObjectId();
function row(id: Types.ObjectId, extra = {}) {
  return {
    _id: id,
    ownerId,
    parentHostelId: root,
    name: String(id),
    slug: String(id),
    isDeleted: false,
    status: "PUBLISHED",
    verificationStatus: "VERIFIED",
    location: { area: "Patan", city: "Lalitpur" },
    photos: [{ url: `/${id}.jpg`, kind: "EXTERIOR" }],
    ...extra,
  };
}
beforeEach(() => {
  hostels.reset([
    row(root, { parentHostelId: null }),
    row(b),
    row(c),
    row(new Types.ObjectId(), { status: "PENDING_APPROVAL" }),
    row(new Types.ObjectId(), { verificationStatus: "PENDING" }),
    row(new Types.ObjectId(), { isDeleted: true }),
    row(new Types.ObjectId(), { status: "SUSPENDED" }),
    row(new Types.ObjectId(), { ownerId: new Types.ObjectId() }),
    row(new Types.ObjectId(), { parentHostelId: null }),
  ]);
});
describe("public branch family", () => {
  it("shows children from the first hostel and siblings plus the first hostel from a branch", async () => {
    expect(
      (await listPublicSiblingBranches({ _id: root, ownerId }))
        .map((item) => item.id)
        .sort(),
    ).toEqual([String(b), String(c)].sort());
    expect(
      (await listPublicSiblingBranches({ _id: b, ownerId, parentHostelId: root }))
        .map((item) => item.id)
        .sort(),
    ).toEqual([String(root), String(c)].sort());
  });
  it("returns only public fields and each branch's own photo", async () => {
    const rows = await listPublicSiblingBranches({ _id: root, ownerId });
    expect(rows).toHaveLength(2);
    expect(rows.find((item) => item.id === String(b))).toEqual({
      id: String(b),
      slug: String(b),
      name: String(b),
      area: "Patan",
      city: "Lalitpur",
      photoUrl: `/${b}.jpg`,
    });
  });
  it("returns empty for a standalone hostel or absent owner", async () => {
    expect(
      await listPublicSiblingBranches({ _id: new Types.ObjectId(), ownerId }),
    ).toEqual([]);
    expect(await listPublicSiblingBranches({ _id: root })).toEqual([]);
  });
});
