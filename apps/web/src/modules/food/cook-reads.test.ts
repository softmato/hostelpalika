import { Types } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Role } from "@/lib/roles";

const mocks = vi.hoisted(() => ({
  connectToDatabase: vi.fn(),
  foodReadyFind: vi.fn(),
  getFoodRoutine: vi.fn(),
  hostelFindOne: vi.fn(),
  hostelSettingsFindOne: vi.fn(),
  residentCountDocuments: vi.fn(),
  residentFind: vi.fn(),
  uploadFoodPhoto: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ connectToDatabase: mocks.connectToDatabase }));

vi.mock("@hostel/db/models/AuditLog", () => ({ AuditLogModel: { create: vi.fn() } }));

vi.mock("@hostel/db/models/FoodReadyLog", () => ({
  FoodReadyLogModel: { create: vi.fn(), find: mocks.foodReadyFind, findOne: vi.fn() },
}));

vi.mock("@hostel/db/models/Hostel", () => ({
  HostelModel: { findOne: mocks.hostelFindOne },
}));

vi.mock("@hostel/db/models/HostelSettings", () => ({
  HostelSettingsModel: { findOne: mocks.hostelSettingsFindOne, findOneAndUpdate: vi.fn() },
}));

vi.mock("@hostel/db/models/Resident", () => ({
  ResidentModel: {
    countDocuments: mocks.residentCountDocuments,
    find: mocks.residentFind,
  },
}));

vi.mock("@hostel/db/models/User", () => ({
  UserModel: { findOne: vi.fn(), findOneAndUpdate: vi.fn(), updateOne: vi.fn() },
}));

vi.mock("@/modules/food/food-routine.service", () => ({
  getFoodRoutine: mocks.getFoodRoutine,
  mealsOn: (routine: { meals: unknown[] }) => routine.meals,
}));

vi.mock("@/modules/food/food.service", () => ({
  uploadFoodPhoto: mocks.uploadFoodPhoto,
}));

vi.mock("@/modules/notifications/notification.service", () => ({
  createInAppNotification: vi.fn(),
}));

vi.mock("@/modules/platform-config/operations-config", () => ({
  getOperationsConfig: vi.fn().mockResolvedValue({ foodReadyCooldownMinutes: 0 }),
}));

vi.mock("@/modules/residents/resident-notify", () => ({
  appUrl: (path: string) => `https://test.local${path}`,
  resolveActiveResidentRecipients: vi.fn().mockResolvedValue([]),
  resolveHostelAdminContacts: vi.fn().mockResolvedValue([]),
  sendNotificationEmail: vi.fn(),
}));

vi.mock("@/lib/realtime/server", () => ({ publishResourceChange: vi.fn() }));

import {
  getCookToday,
  listCookResidents,
  uploadCookFoodPhoto,
} from "@/modules/food/cook.service";

const hostelId = "64f0f0f0f0f0f0f0f0f0f0b1";
const otherHostelId = "64f0f0f0f0f0f0f0f0f0f0b2";

const cookPrincipal = {
  hostelIds: [hostelId],
  role: Role.COOK,
  sessionId: "session-c",
  userId: "64f0f0f0f0f0f0f0f0f0f0b3",
};

function leanResult<T>(value: T) {
  return { lean: vi.fn().mockResolvedValue(value), select: vi.fn().mockReturnThis() };
}

function listResult<T>(value: T) {
  return {
    lean: vi.fn().mockResolvedValue(value),
    limit: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    sort: vi.fn().mockReturnThis(),
  };
}

describe("the cook's own reads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hostelFindOne.mockReturnValue(
      leanResult({ _id: new Types.ObjectId(hostelId), name: "Sunrise" }),
    );
    mocks.getFoodRoutine.mockResolvedValue({
      meals: [{ items: ["Dal bhat"], mealType: "LUNCH" }],
      timings: {},
    });
    mocks.residentCountDocuments.mockResolvedValue(38);
    mocks.hostelSettingsFindOne.mockReturnValue(leanResult({ cookCanRecordExpenses: true }));
    mocks.foodReadyFind.mockReturnValue(listResult([]));
    mocks.residentFind.mockReturnValue(
      listResult([
        {
          _id: new Types.ObjectId("64f0f0f0f0f0f0f0f0f0f0b4"),
          firstName: "Asha",
          lastName: "Rai",
          roomType: "DOUBLE",
        },
      ]),
    );
  });

  /*
   * The gap this closes: before these endpoints, the cook's menu and head count
   * lived under `hostel-admin/food/*` behind `requireHostelCapability`, which
   * resolves to HOSTEL_ADMIN or WARDEN. The person cooking the meal could
   * announce it but not look up what it was.
   */
  it("gives a COOK today's menu and head count without hostel-admin capabilities", async () => {
    const { today } = await getCookToday(cookPrincipal);

    expect(today.meals).toEqual([{ items: ["Dal bhat"], mealType: "LUNCH" }]);
    expect(today.residentCount).toBe(38);
    expect(today.hostel.name).toBe("Sunrise");
  });

  it("tells the kitchen whether the owner let it add expenses", async () => {
    expect((await getCookToday(cookPrincipal)).today.expensesEnabled).toBe(true);

    mocks.hostelSettingsFindOne.mockReturnValue(leanResult(null));

    // No settings row yet is the default: off.
    expect((await getCookToday(cookPrincipal)).today.expensesEnabled).toBe(false);
  });

  it("counts plates, which is every active resident and not only the notifiable ones", async () => {
    await getCookToday(cookPrincipal);

    /*
     * Deliberately wider than the announcement's audience, which additionally
     * requires a linked account (`food-ready-notify.ts`). A cook cooks for
     * everyone living here; the fan-out reaches whoever has installed the app,
     * and the two numbers are meant to differ.
     */
    expect(mocks.residentCountDocuments).toHaveBeenCalledWith({
      hostelId: expect.anything(),
      isDeleted: false,
      status: "ACTIVE",
    });
  });

  it("refuses a hostel the cook is not scoped to", async () => {
    await expect(getCookToday(cookPrincipal, otherHostelId)).rejects.toThrow();
  });

  it("carries the whole week, so the menu screen needs no second request", async () => {
    const { today } = await getCookToday(cookPrincipal);

    expect(today.routine).toEqual({
      meals: [{ items: ["Dal bhat"], mealType: "LUNCH" }],
      timings: {},
    });
  });

  it("reports which meals have already gone out today", async () => {
    mocks.foodReadyFind.mockReturnValue(
      listResult([
        {
          _id: new Types.ObjectId("64f0f0f0f0f0f0f0f0f0f0b5"),
          announcedAt: new Date("2026-08-17T04:00:00.000Z"),
          mealType: "BREAKFAST",
          message: "Breakfast is ready.",
          notifiedCount: 38,
        },
      ]),
    );

    const { today } = await getCookToday(cookPrincipal);

    expect(today.announced).toEqual([
      {
        announcedAt: "2026-08-17T04:00:00.000Z",
        id: "64f0f0f0f0f0f0f0f0f0f0b5",
        mealType: "BREAKFAST",
        message: "Breakfast is ready.",
        notifiedCount: 38,
      },
    ]);
  });

  /*
   * The cook credential is shared kitchen-wide and effectively static, so this
   * list is what a leaked password would hand a stranger. A name and a room is
   * what a noticeboard already shows; a phone number is not.
   */
  it("gives the cook a name and a room, and no way to contact anyone", async () => {
    const { residents } = await listCookResidents(cookPrincipal);

    expect(residents).toEqual([
      { fullName: "Asha Rai", id: "64f0f0f0f0f0f0f0f0f0f0b4", roomType: "DOUBLE" },
    ]);
    expect(JSON.stringify(residents)).not.toContain("@");
  });

  it("selects only the three fields it serializes", async () => {
    await listCookResidents(cookPrincipal);

    const query = mocks.residentFind.mock.results[0]?.value;

    expect(query.select).toHaveBeenCalledWith("firstName lastName roomType");
  });

  it("lists nobody who has moved out", async () => {
    await listCookResidents(cookPrincipal);

    expect(mocks.residentFind).toHaveBeenCalledWith(
      expect.objectContaining({ isDeleted: false, status: "ACTIVE" }),
    );
  });

  /*
   * Delegated rather than reimplemented: `uploadFoodPhoto` owns the audit row
   * and the realtime publish that makes the photo appear on residents' screens.
   * What the cook path adds is the resolved hostel, because the shared
   * function's own `resolveAdminHostelId` would refuse a COOK principal.
   */
  it("posts a photo through the shared pipeline with the cook's hostel", async () => {
    mocks.uploadFoodPhoto.mockResolvedValue({ photo: { id: "photo-1" } });

    await uploadCookFoodPhoto(
      {
        caption: "",
        date: new Date("2026-08-17T00:00:00.000Z"),
        mealType: "LUNCH",
        photoAssetId: "asset-1",
      },
      cookPrincipal,
    );

    expect(mocks.uploadFoodPhoto).toHaveBeenCalledWith(
      expect.objectContaining({ photoAssetId: "asset-1" }),
      cookPrincipal,
      { hostelId: expect.anything() },
    );
  });
});
