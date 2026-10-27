import { describe, expect, it } from "vitest";

import { summarizeConfigurations } from "@/modules/hostels/hostel-capacity.service";
import { roomTypeLabel } from "@hostel/shared/constants/room-types";
import { deriveTypeCounts, typeChangeRefusal } from "@/modules/hostels/hostel-rooms.service";

describe("deriveTypeCounts", () => {
  it("makes the type view total exactly what the floor plan totals", () => {
    // Typed at KYC: 38 rooms. Laid out: 3 rooms, all Double.
    const typed = [
      { bedsPerRoom: 2, rooms: 20, roomType: "Double", vacantBeds: 30 },
      { bedsPerRoom: 1, rooms: 18, roomType: "Single", vacantBeds: 18 },
    ];
    const rooms = [
      { beds: 2, roomType: "Double" },
      { beds: 2, roomType: "Double" },
      { beds: 3, roomType: "Double" },
    ];
    // One Double resident has no room yet — they still hold a Double bed.
    const residents = [{ roomType: "Double" }, { roomType: "Double" }];

    const summary = summarizeConfigurations(deriveTypeCounts(typed, rooms, residents));

    expect(summary.totalRooms).toBe(3);
    expect(summary.vacantBeds).toBe(5);
    expect(deriveTypeCounts(typed, rooms, residents)[1]).toMatchObject({ rooms: 0, vacantBeds: 0 });
  });
});

describe("typeChangeRefusal (field review B6)", () => {
  it("lets an empty or fitting room change type", () => {
    expect(typeChangeRefusal("101", 0, "Single Room", 1)).toBeNull();
    expect(typeChangeRefusal("101", 2, "Double Sharing", 2)).toBeNull();
  });

  it("refuses a type with fewer beds than the people living there, and says why", () => {
    expect(typeChangeRefusal("101", 3, "Double Sharing", 2)).toBe(
      "3 people live in Room 101; a Double Sharing Room has 2 beds. Move 1 person out first.",
    );
  });
});

describe("roomTypeLabel (field review B1)", () => {
  it("names the four stock types and keeps the bathroom variant", () => {
    expect(roomTypeLabel("Single Room")).toBe("Single Sitter Room");
    expect(roomTypeLabel("Four Sharing — Attached Bathroom")).toBe("Four Sharing Room — Attached Bathroom");
    expect(roomTypeLabel("DOUBLE_SHARING")).toBe("Double Sharing Room");
  });

  it("passes an owner's own type through", () => {
    expect(roomTypeLabel("Dormitory")).toBe("Dormitory");
    expect(roomTypeLabel("6 Sharing")).toBe("6 Sharing");
  });
});
