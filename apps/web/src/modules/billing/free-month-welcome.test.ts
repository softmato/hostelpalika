import { Types } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Role } from "@/lib/roles";
import { bsMonthsEnd } from "@hostel/shared/calendar/bs";

import type { FakeModel } from "../../../test/fake-mongo";

const bells = vi.hoisted(() => [] as Array<{ title: string; userId: string }>);

function fake(exportName: string) {
  return async (importOriginal: () => Promise<Record<string, unknown>>) => {
    const actual = await importOriginal();
    const { fakeModel } = await import("../../../test/fake-mongo");

    return { ...actual, [exportName]: fakeModel() };
  };
}

vi.mock("@/lib/db", () => ({ connectToDatabase: vi.fn() }));
vi.mock("@hostel/db/models/Hostel", fake("HostelModel"));
vi.mock("@hostel/db/models/HostelSubscription", fake("HostelSubscriptionModel"));
vi.mock("@hostel/db/models/User", fake("UserModel"));
vi.mock("@/modules/notifications/notification.service", () => ({
  createInAppNotification: vi.fn(async (input: { title: string; userId: string }) => {
    bells.push(input);
  }),
}));

const { sendFreeMonthWelcomes } = await import("./free-month-welcome.service");
const { HostelModel } = await import("@hostel/db/models/Hostel");
const { HostelSubscriptionModel } = await import("@hostel/db/models/HostelSubscription");
const { UserModel } = await import("@hostel/db/models/User");

const hostelId = new Types.ObjectId();
const adminId = new Types.ObjectId();
const activatedAt = new Date("2026-09-11T06:00:00Z");

beforeEach(() => {
  bells.length = 0;
  (HostelModel as unknown as FakeModel).reset([{ _id: hostelId, status: "PUBLISHED" }]);
  (UserModel as unknown as FakeModel).reset([{ _id: adminId, hostelIds: [hostelId], role: Role.HOSTEL_ADMIN }]);
  (HostelSubscriptionModel as unknown as FakeModel).reset([
    {
      activatedAt,
      freeMonths: 6,
      freeMonthsWelcomed: [],
      freeUntil: bsMonthsEnd(activatedAt, 6),
      hostelId,
      planName: "Go",
      status: "ACTIVE",
    },
  ]);
});

describe("sendFreeMonthWelcomes", () => {
  it("welcomes each free month once, to the hostel's admins", async () => {
    await sendFreeMonthWelcomes({ now: activatedAt });
    await sendFreeMonthWelcomes({ now: new Date(activatedAt.getTime() + 86_400_000) });

    expect(bells).toHaveLength(1);
    expect(bells[0]).toMatchObject({ title: "Welcome — enjoy the free Go plan this month", userId: adminId.toString() });

    await sendFreeMonthWelcomes({ now: new Date(bsMonthsEnd(activatedAt, 1).getTime() + 1) });

    expect(bells).toHaveLength(2);
  });
});
