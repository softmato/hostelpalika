import { describe, expect, it } from "vitest";

import { summarizeConfigurations } from "@/modules/hostels/hostel-capacity.service";
import { deriveTypeCounts } from "@/modules/hostels/hostel-rooms.service";

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
