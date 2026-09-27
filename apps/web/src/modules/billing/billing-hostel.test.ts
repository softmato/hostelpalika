import { Types } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { FakeModel } from "../../../test/fake-mongo";

vi.mock("@hostel/db/models/Hostel", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { fakeModel } = await import("../../../test/fake-mongo");

  return { ...actual, HostelModel: fakeModel() };
});
vi.mock("@/modules/platform-config/site-config.service", () => ({
  getSiteConfigSection: vi.fn(async () => ({
    plans: [
      { id: "go", maxBranches: 0, name: "Go" },
      { id: "max", maxBranches: 3, name: "Max" },
    ],
  })),
}));

const { assertBranchesFit, billingHostelId } = await import("./billing-hostel");
const { HostelModel } = await import("@hostel/db/models/Hostel");

const hostels = HostelModel as unknown as FakeModel;
const main = new Types.ObjectId();
const branch = new Types.ObjectId();

beforeEach(() => {
  hostels.reset([
    { _id: main, parentHostelId: null, status: "PUBLISHED" },
    { _id: branch, parentHostelId: main, status: "PUBLISHED" },
    { _id: new Types.ObjectId(), parentHostelId: main, status: "PENDING_APPROVAL" },
    { _id: new Types.ObjectId(), parentHostelId: main, status: "REJECTED" },
  ]);
});

describe("billingHostelId", () => {
  it("bills a branch against its main hostel, and any other hostel against itself", async () => {
    expect(String(await billingHostelId(branch))).toBe(String(main));
    expect(String(await billingHostelId(main))).toBe(String(main));
  });
});

describe("assertBranchesFit", () => {
  it("keeps a hostel with branches off a plan that has none, counting pending ones", async () => {
    await expect(assertBranchesFit(main, "go")).rejects.toThrow("has 2 branches");
    await expect(assertBranchesFit(main, "max")).resolves.toBeUndefined();
  });
});
