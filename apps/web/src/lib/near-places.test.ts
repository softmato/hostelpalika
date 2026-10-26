import { describe, expect, it } from "vitest";

import { buildNearPlaceIndex, formatDistance, isCampusName } from "./near-places";

const at = { lat: 27.68, lng: 85.32 };

describe("isCampusName", () => {
  it.each([
    ["IOE Pulchowk Campus", true],
    ["Tri-Chandra Multiple Campus", true],
    ["Kathmandu University", true],
    ["Islington College", true],
    ["Shree Secondary School and College", true],
    ["Little Angels Boarding School", false],
    ["Sunrise Montessori", false],
    ["Bhatbhateni Supermarket", false],
    ["", false],
  ])("%s → %s", (name, expected) => {
    expect(isCampusName(name)).toBe(expected);
  });
});

describe("buildNearPlaceIndex", () => {
  it("turns each hostel's nearby places into campuses, merged by spelling, most hostels first", () => {
    const index = buildNearPlaceIndex([
      {
        area: "Pulchowk",
        city: "Lalitpur",
        hostelId: "a",
        nearbyPlaces: [
          { coordinates: at, distance: 420, name: "Pulchowk Campus", type: "college" },
          { coordinates: at, distance: 300, name: "Little Angels School", type: "college" },
          { coordinates: at, distance: 200, name: "Patan Hospital", type: "hospital" },
        ],
      },
      {
        area: "Jhamsikhel",
        city: "Lalitpur",
        hostelId: "b",
        nearbyPlaces: [
          { coordinates: at, distance: 900, name: "Pulchowk  Campus", type: "college" },
          { coordinates: at, distance: 700, name: "Pulchowk Campus", type: "college" },
          { coordinates: at, distance: 1200, name: "St. Xavier's College", type: "college" },
        ],
      },
    ]);

    expect(index.map((place) => place.slug)).toEqual(["pulchowk-campus", "st-xavier-s-college"]);
    expect(index[0].name).toBe("Pulchowk Campus");
    expect(index[0].city).toBe("Lalitpur");
    // Hostel b counts once, at its shortest measured distance.
    expect([...index[0].distances.entries()]).toEqual([
      ["a", 420],
      ["b", 700],
    ]);
  });

  it("drops rows without a usable distance or outside the search radius", () => {
    const index = buildNearPlaceIndex([
      {
        hostelId: "a",
        nearbyPlaces: [
          { distance: null, name: "Amrit Campus", type: "college" },
          { distance: 5000, name: "Far Away College", type: "college" },
          { distance: -1, name: "Broken College", type: "college" },
        ],
      },
    ]);

    expect(index).toEqual([]);
  });
});

describe("formatDistance", () => {
  it("rounds the way people say distances", () => {
    expect(formatDistance(12)).toBe("50 m");
    expect(formatDistance(437)).toBe("450 m");
    expect(formatDistance(1234)).toBe("1.2 km");
  });
});
