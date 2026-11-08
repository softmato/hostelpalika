/**
 * What a hostel page shows where a Book button could be. Pure and client-safe.
 *
 * Nothing at all while bookings are switched off platform-wide, or for a room
 * with no rent — a greyed button on every hostel before launch says "broken",
 * not "coming". *Full* and *Not taking bookings* only once booking is a thing
 * the visitor could otherwise do.
 */

export type BookingAvailabilityView = {
  hostelReason: string | null;
  /** This room type's own photos — the checkout's chooser stacks them beside the name. */
  rooms: Array<{ bookable: boolean; fee: number | null; photos: string[]; reason: string | null; roomType: string }>;
};

export type BookingButton =
  | { fee: number | null; href: string; kind: "book" }
  | { kind: "closed" }
  | { kind: "full" }
  | { kind: "hidden" };

const CLOSED_REASONS = new Set(["BOOKINGS_PAUSED", "HOSTEL_SUSPENDED", "NO_PAYOUT_ACCOUNT"]);

export function bookingButton(
  availability: BookingAvailabilityView | null,
  hostelSlug: string,
  roomType?: string,
): BookingButton {
  if (!availability || !hostelSlug) {
    return { kind: "hidden" };
  }

  if (availability.hostelReason) {
    return CLOSED_REASONS.has(availability.hostelReason) ? { kind: "closed" } : { kind: "hidden" };
  }

  const base = `/book/${encodeURIComponent(hostelSlug)}`;

  if (roomType === undefined) {
    const fees = availability.rooms.filter((room) => room.bookable).map((room) => room.fee ?? 0);

    if (fees.length > 0) {
      return { fee: Math.min(...fees), href: base, kind: "book" };
    }

    return availability.rooms.some((room) => room.reason === "FULL") ? { kind: "full" } : { kind: "hidden" };
  }

  const room = availability.rooms.find((candidate) => candidate.roomType === roomType);

  if (room?.bookable) {
    return { fee: room.fee, href: `${base}?room=${encodeURIComponent(roomType)}`, kind: "book" };
  }

  return room?.reason === "FULL" ? { kind: "full" } : { kind: "hidden" };
}
