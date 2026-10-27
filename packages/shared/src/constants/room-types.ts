/** A bathroom variant is a separate inventory and pricing row, not a hostel amenity. */
export const ROOM_TYPE_OPTIONS = [
  "Single Room",
  "Single Room — Attached Bathroom",
  "Double Sharing",
  "Double Sharing — Attached Bathroom",
  "Triple Sharing",
  "Triple Sharing — Attached Bathroom",
  "Four Sharing",
  "Four Sharing — Attached Bathroom",
  "Dormitory",
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

/**
 * What a room type is called on screen and on paper (field review B1). The
 * stored value stays the key — rate card, capacity and photos match on it —
 * so only display goes through here. A type the owner typed passes unchanged;
 * the old enum spelling ("DOUBLE_SHARING") reads as its type.
 */
const ROOM_TYPE_NAMES: Record<string, string> = {
  "double sharing": "Double Sharing Room",
  "four sharing": "Four Sharing Room",
  single: "Single Sitter Room",
  "single room": "Single Sitter Room",
  "triple sharing": "Triple Sharing Room",
};

export function roomTypeLabel(roomType: string | null | undefined) {
  if (!roomType) return "";

  const [base, ...rest] = roomType.split(" — ");
  const name = ROOM_TYPE_NAMES[base.replaceAll("_", " ").trim().toLowerCase()];

  return name ? [name, ...rest].join(" — ") : roomType.replaceAll("_", " ");
}

const BED_WORDS: Record<string, number> = { single: 1, double: 2, two: 2, triple: 3, three: 3, four: 4, quad: 4, five: 5, six: 6, dorm: 6, dormitory: 6 };

/**
 * Beds in one room of a type, read off its name — "Double Sharing" → 2,
 * "6 Sharing" → 6. Owners are never asked it. Dormitory, uncounted, is 6.
 */
export function bedsForRoomType(roomType: string) {
  if (BEDS_BY_ROOM_TYPE[roomType]) return BEDS_BY_ROOM_TYPE[roomType];

  const counted = /(\d{1,2})/.exec(roomType);
  if (counted) return Math.max(1, Number(counted[1]));

  const word = roomType.toLowerCase().split(/[^a-z]+/).find((part) => BED_WORDS[part]);
  return word ? BED_WORDS[word] : 1;
}
