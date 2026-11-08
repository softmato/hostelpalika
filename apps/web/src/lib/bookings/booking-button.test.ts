/** docs/BOOKINGS.md item 14: which Book state a hostel page draws. */
import { describe, expect, it } from "vitest";

import { bookingButton, type BookingAvailabilityView } from "@/lib/bookings/booking-button";

const open: BookingAvailabilityView = {
  hostelReason: null,
  rooms: [
    { bookable: true, fee: 700, photos: [], reason: null, roomType: "Double sharing" },
    { bookable: false, fee: 1050, photos: [], reason: "FULL", roomType: "Single" },
    { bookable: false, fee: null, photos: [], reason: "NOT_PRICED", roomType: "Triple" },
    { bookable: true, fee: 490, photos: [], reason: null, roomType: "Four sharing" },
  ],
};

describe("bookingButton", () => {
  it("books a room at its fee, and the hostel from its cheapest", () => {
    expect(bookingButton(open, "everest-boys", "Double sharing")).toEqual({
      fee: 700,
      href: "/book/everest-boys?room=Double%20sharing",
      kind: "book",
    });
    expect(bookingButton(open, "everest-boys")).toEqual({ fee: 490, href: "/book/everest-boys", kind: "book" });
  });

  it("says Full for a full room, and hides an unpriced one", () => {
    expect(bookingButton(open, "everest-boys", "Single")).toEqual({ kind: "full" });
    expect(bookingButton(open, "everest-boys", "Triple")).toEqual({ kind: "hidden" });
  });

  it("says Not taking bookings for a paused hostel, and nothing while bookings are off", () => {
    expect(bookingButton({ ...open, hostelReason: "BOOKINGS_PAUSED" }, "everest-boys", "Double sharing")).toEqual({
      kind: "closed",
    });
    expect(bookingButton({ ...open, hostelReason: "BOOKINGS_OFF" }, "everest-boys")).toEqual({ kind: "hidden" });
    expect(bookingButton(null, "everest-boys")).toEqual({ kind: "hidden" });
  });
});
