import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RegistrationRooms } from "./registration-rooms";
import { roomTypeOptions } from "./registration-fields";
import { availableRoomTypes, nextAvailableRoomType } from "./room-type-picker";

describe("registration room picker", () => {
  it("shows the selected type without a free-text room field", () => {
    const html = renderToStaticMarkup(
      createElement(RegistrationRooms, {
        rooms: [
          {
            id: "one",
            roomType: "Double Sharing",
            rooms: "20",
            bedsPerRoom: "2",
            vacantBeds: "40",
            monthlyRent: "5000",
            securityDeposit: "",
            mealInclusion: "Included",
          },
        ],
        globalDeposit: "3000",
        onDepositChange: () => {},
        updateRoom: () => {},
        onAdd: () => {},
        onRemove: () => {},
      }),
    );
    expect(html).toContain('aria-label="Room type 1"');
    expect(html).toContain('aria-haspopup="listbox"');
    expect(html).toContain("Double Sharing");
    expect(html).not.toContain("datalist");
    expect(html).toContain('placeholder="3000"');
  });

  it("filters options and excludes types already selected in other rows", () => {
    expect(availableRoomTypes(["Single Room"], "attached bathroom")).not.toContain("Single Room");
    expect(availableRoomTypes(["Single Room"], "single")).toEqual([
      "Single Room — Attached Bathroom",
    ]);
    expect(nextAvailableRoomType(["Single Room"])).toBe("Single Room — Attached Bathroom");
    expect(nextAvailableRoomType(roomTypeOptions)).toBeUndefined();
    for (let i = 0; i < roomTypeOptions.length; i += 2) {
      expect(roomTypeOptions[i + 1]).toBe(`${roomTypeOptions[i]} — Attached Bathroom`);
    }
  });
});
