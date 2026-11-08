/**
 * Bed-type mapping — Block 1 item 1.1 of docs/FINANCE_IMPLEMENTATION_PLAN.md
 * (target §3.1, deviation §3.2, D1).
 *
 * `roomType` is free text and the product has shipped three vocabularies for the
 * same five things. The mapping is exhaustively tested because it decides what a
 * resident is charged: a wrong answer here bills a real person the wrong rent
 * every month, and unlike most bugs it does so quietly.
 */
import { describe, expect, it } from "vitest";

import { normalizeBedType } from "@/lib/finance/bed-type";
import { BED_TYPES, bedTypeLabel, isBedType } from "@hostel/shared/types/bed-type";

describe("normalizeBedType — the vocabularies in the data", () => {
  // Read off the development database on 2026-08-06 (residents.roomType,
  // hostels.roomTypes, hostels.roomConfigurations.roomType).
  it.each([
    ["Single Room", "SINGLE"],
    ["Private", "SINGLE"],
    ["Double Sharing", "DOUBLE_SHARING"],
    ["Two Sharing", "DOUBLE_SHARING"],
    ["Triple Sharing", "TRIPLE_SHARING"],
    ["Three Sharing", "TRIPLE_SHARING"],
    ["Four Sharing", "FOUR_SHARING"],
    ["Dormitory", "DORMITORY"],
  ] as const)("maps the live value %s", (input, expected) => {
    expect(normalizeBedType(input)).toBe(expected);
  });

  // The unused shared RoomType enum. Nothing imports it today, which is exactly
  // why it will arrive unannounced (D1).
  it.each([
    ["ONE_SEATER", "SINGLE"],
    ["TWO_SEATER", "DOUBLE_SHARING"],
    ["THREE_SEATER", "TRIPLE_SHARING"],
    ["FOUR_SEATER", "FOUR_SHARING"],
    ["DORMITORY", "DORMITORY"],
  ] as const)("maps the shared enum value %s", (input, expected) => {
    expect(normalizeBedType(input)).toBe(expected);
  });

  it.each([
    ["1 Seater", "SINGLE"],
    ["2 Seater", "DOUBLE_SHARING"],
    ["Twin Sharing", "DOUBLE_SHARING"],
    ["Quad", "FOUR_SHARING"],
    ["Dorm", "DORMITORY"],
  ] as const)("maps the spelling %s", (input, expected) => {
    expect(normalizeBedType(input)).toBe(expected);
  });
});

describe("normalizeBedType — normalisation", () => {
  it.each(["single room", "SINGLE ROOM", "Single-Room", "  Single   Room  "])(
    "ignores case, spacing and punctuation in %s",
    (input) => {
      expect(normalizeBedType(input)).toBe("SINGLE");
    },
  );

  // Arithmetic on what the owner wrote, not inference about what they meant.
  it.each([
    ["5 Sharing", "DORMITORY"],
    ["6 Bed", "DORMITORY"],
    ["12 Sharing", "DORMITORY"],
    ["3 Sharing", "TRIPLE_SHARING"],
  ] as const)("reads an explicit occupancy count in %s", (input, expected) => {
    expect(normalizeBedType(input)).toBe(expected);
  });
});

describe("normalizeBedType — refusing to guess", () => {
  /**
   * The one that matters. "Shared" is real data on live resident rows and it
   * does not say how many people share; two and five are both plausible and the
   * rents differ by thousands. Null here becomes BED_TYPE_NOT_PRICED at billing,
   * where a human resolves it — a loud failure beats a silent wrong rate
   * (plan §7.3).
   */
  it("returns null for 'Shared', which does not state an occupancy", () => {
    expect(normalizeBedType("Shared")).toBeNull();
  });

  it.each([
    "Deluxe",
    "AC Room",
    "Ground Floor",
    "Room 12",
    "Premium Sharing",
    "0 Sharing",
  ])("returns null for the unmappable %s", (input) => {
    expect(normalizeBedType(input)).toBeNull();
  });

  it.each([null, undefined, "", "   ", "---"])(
    "returns null for the empty input %s",
    (input) => {
      expect(normalizeBedType(input)).toBeNull();
    },
  );

  // A near-miss must fail rather than land on a neighbour: charging four-sharing
  // rent for a "Four Sharing Deluxe" is the failure mode this guards.
  it("does not partially match a longer phrase", () => {
    expect(normalizeBedType("Four Sharing Deluxe")).toBeNull();
  });
});

describe("the shared BedType vocabulary", () => {
  it("is the five canonical values of target §3.1", () => {
    expect([...BED_TYPES]).toEqual([
      "SINGLE",
      "DOUBLE_SHARING",
      "TRIPLE_SHARING",
      "FOUR_SHARING",
      "DORMITORY",
    ]);
  });

  it("labels every value for display", () => {
    for (const bedType of BED_TYPES) {
      expect(bedTypeLabel(bedType)).toBeTruthy();
    }
  });

  it("guards against a non-member string", () => {
    expect(isBedType("SINGLE")).toBe(true);
    expect(isBedType("Single Room")).toBe(false);
  });

  it("only ever produces a canonical value", () => {
    const mapped = normalizeBedType("Two Sharing");

    expect(mapped && isBedType(mapped)).toBe(true);
  });
});
