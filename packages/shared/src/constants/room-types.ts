/** A bathroom variant is a separate inventory and pricing row, not a hostel amenity. */
export const ROOM_TYPE_OPTIONS = [
  "Single Room",
  "Double Sharing",
  "Triple Sharing",
  "Four Sharing",
  "Dormitory",
  "Single Room — Attached Bathroom",
  "Double Sharing — Attached Bathroom",
  "Triple Sharing — Attached Bathroom",
  "Four Sharing — Attached Bathroom",
  "Dormitory — Attached Bathroom",
];

export const BEDS_BY_ROOM_TYPE: Record<string, number> = Object.fromEntries(
  (
    [
      ["Single Room", 1],
      ["Double Sharing", 2],
      ["Triple Sharing", 3],
      ["Four Sharing", 4],
    ] as const
  ).flatMap(([name, beds]) => [
    [name, beds] as const,
    [`${name} — Attached Bathroom`, beds] as const,
  ]),
);
