import { Types } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { FakeModel } from "../../../test/fake-mongo";

/** The emailed "Pay now" link: opens one hostel's checkout, and only while it still belongs to that owner. */

vi.mock("@/lib/db", () => ({ connectToDatabase: vi.fn() }));
vi.mock("@hostel/db/models/Hostel", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { fakeModel } = await import("../../../test/fake-mongo");

  return { ...actual, HostelModel: fakeModel() };
});

process.env.JWT_ACCESS_SECRET ??= "test-access-secret-at-least-32-characters-long";

const { planPayLink, readPlanPayLink } = await import("./plan-pay-link");
const { HostelModel } = await import("@hostel/db/models/Hostel");
const hostels = HostelModel as unknown as FakeModel;

const hostelId = new Types.ObjectId();
const ownerId = new Types.ObjectId();

function tokenOf(url: string) {
  return decodeURIComponent(new URL(url).searchParams.get("link") ?? "");
}

beforeEach(() => {
  hostels.reset([{ _id: hostelId, ownerId, slug: "study-sanjal" }]);
});

describe("plan pay link", () => {
  it("opens the checkout for the hostel it was signed for", async () => {
    const url = await planPayLink({ slug: "study-sanjal" }, "fallback");

    expect(url).toContain("/plans-pricing/checkout?link=");
    expect(await readPlanPayLink(tokenOf(url))).toEqual({
      hostelId: hostelId.toString(),
      ownerId: ownerId.toString(),
    });
  });

  it("stops working once the hostel has another owner", async () => {
    const url = await planPayLink({ id: hostelId.toString() }, "fallback");
    hostels.docs[0]!.ownerId = new Types.ObjectId();

    expect(await readPlanPayLink(tokenOf(url))).toBeNull();
  });

  it("falls back to the signed-in billing page when the hostel is unknown", async () => {
    expect(await planPayLink({ slug: "nowhere" }, "fallback")).toBe("fallback");
    expect(await readPlanPayLink("not-a-token")).toBeNull();
  });
});
