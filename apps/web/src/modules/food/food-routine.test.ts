import { Types } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Role } from "@/lib/roles";

const mocks = vi.hoisted(() => ({
  auditCreate: vi.fn(),
  connectToDatabase: vi.fn(),
  routineFindOne: vi.fn(),
  routineFindOneAndUpdate: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ connectToDatabase: mocks.connectToDatabase }));

vi.mock("@hostel/db/models/AuditLog", () => ({
  AuditLogModel: { create: mocks.auditCreate },
}));

vi.mock("@hostel/db/models/FoodRoutine", () => ({
  FoodRoutineModel: {
    findOne: mocks.routineFindOne,
    findOneAndUpdate: mocks.routineFindOneAndUpdate,
  },
}));

// Who gets told the menu changed is `kitchen-notify`'s business, and it reads
// models this file does not mock. Stubbed here for the same reason
// `complaint.service.test.ts` stubs its notifier.
vi.mock("@/modules/food/kitchen-notify", () => ({
  notifyKitchenOfRoutineChange: vi.fn(),
}));

import {
  dayOfWeekFor,
  getFoodRoutine,
  isMonthEnd,
  mealsOn,
  saveFoodRoutine,
} from "@/modules/food/food-routine.service";

const hostelId = new Types.ObjectId("64f0f0f0f0f0f0f0f0f0f0a1");

const principal = {
  hostelIds: [hostelId.toString()],
  role: Role.HOSTEL_ADMIN,
  sessionId: "session-1",
  userId: "64f0f0f0f0f0f0f0f0f0f0a4",
};

function leanResult<T>(value: T) {
  return { lean: vi.fn().mockResolvedValue(value) };
}

const storedRoutine = {
  meals: [
    {
      dayOfWeek: "FRIDAY",
      items: ["Bhaat", "Daal", "Omelete"],
      mealType: "DINNER",
    },
    { dayOfWeek: "FRIDAY", items: ["Samosa"], mealType: "SNACKS" },
    { dayOfWeek: "SUNDAY", items: ["Bhaat"], mealType: "DINNER" },
  ],
  monthEndSpecial: { items: ["Goat Meat"], note: "Once a month" },
  timings: { DINNER: "7:00 PM - 8:45 PM", SNACKS: "3:00 PM - 5:00 PM" },
};

describe("food routine", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.routineFindOne.mockReturnValue(leanResult(storedRoutine));
  });

  it("keeps the month end treat separate from that day's dinner", async () => {
    const routine = await getFoodRoutine(hostelId);
    // 31 Jul 2026 is a Friday and the last day of its month — the case that
    // used to overwrite Friday's dinner with the treat.
    const friday = new Date(2026, 6, 31);

    expect(isMonthEnd(friday)).toBe(true);
    expect(
      mealsOn(routine, friday).find((meal) => meal.mealType === "DINNER")?.items,
    ).toEqual(["Bhaat", "Daal", "Omelete"]);
    expect(routine.monthEndSpecial?.items).toEqual(["Goat Meat"]);
  });

  it("repeats every week, so the same weekday reads the same meals", async () => {
    const routine = await getFoodRoutine(hostelId);
    const thisFriday = mealsOn(routine, new Date(2026, 6, 31));
    const nextFriday = mealsOn(routine, new Date(2026, 7, 7));

    expect(nextFriday).toEqual(thisFriday);
    // One read serves any date — the routine is not stored per week.
    expect(mocks.routineFindOne).toHaveBeenCalledTimes(1);
  });

  it("returns meals in meal order with the shared timing attached", async () => {
    const routine = await getFoodRoutine(hostelId);
    const friday = mealsOn(routine, new Date(2026, 6, 31));

    expect(friday.map((meal) => meal.mealType)).toEqual(["SNACKS", "DINNER"]);
    expect(friday[1].timing).toBe("7:00 PM - 8:45 PM");
  });

  it("saves the whole week as one document", async () => {
    mocks.routineFindOneAndUpdate.mockReturnValue(leanResult(storedRoutine));

    await saveFoodRoutine(
      {
        meals: [{ dayOfWeek: "FRIDAY", items: ["Bhaat"], mealType: "DINNER" }],
        monthEndSpecial: { items: ["Goat Meat"] },
        timings: { DINNER: "7 PM" },
      },
      principal,
      hostelId,
    );

    expect(mocks.routineFindOneAndUpdate).toHaveBeenCalledTimes(1);

    const [filter, update, options] = mocks.routineFindOneAndUpdate.mock.calls[0];

    expect(filter).toEqual({ hostelId });
    expect(options.upsert).toBe(true);
    expect(update.$set.meals).toHaveLength(1);
    expect(update.$set.monthEndSpecial.items).toEqual(["Goat Meat"]);
  });

  it("clears the month end treat when it is saved empty", async () => {
    mocks.routineFindOneAndUpdate.mockReturnValue(leanResult(null));

    await saveFoodRoutine(
      { meals: [], monthEndSpecial: { items: [] }, timings: {} },
      principal,
      hostelId,
    );

    expect(
      mocks.routineFindOneAndUpdate.mock.calls[0][1].$set.monthEndSpecial,
    ).toBeNull();
  });

  it("gives an unconfigured hostel an empty routine rather than null", async () => {
    mocks.routineFindOne.mockReturnValue(leanResult(null));

    const routine = await getFoodRoutine(hostelId);

    expect(routine.meals).toEqual([]);
    expect(routine.monthEndSpecial).toBeNull();
    expect(mealsOn(routine, new Date())).toEqual([]);
  });

  it("reads the weekday in Kathmandu, not UTC", () => {
    // 00:30 Saturday 1 Aug in Nepal is still 18:45 Friday in UTC.
    expect(dayOfWeekFor(new Date("2026-07-31T18:45:00Z"))).toBe("SATURDAY");
    // 05:30 Saturday in Nepal: 23:45 Friday UTC.
    expect(dayOfWeekFor(new Date("2026-07-31T23:45:00Z"))).toBe("SATURDAY");
    expect(dayOfWeekFor(new Date("2026-07-31T18:00:00Z"))).toBe("FRIDAY");
  });
});
