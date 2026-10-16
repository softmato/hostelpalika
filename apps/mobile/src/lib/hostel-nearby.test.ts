import { describe, expect, it } from "vitest";

import {
  groupNearbyPlaces,
  humanizeNearbyType,
  nearbyGlyph,
  nearbyIcon,
} from "@/lib/hostel-nearby";
import type { NearbyPlace } from "@/lib/public-api";

function place(
  name: string,
  type: string,
  distance: number,
): NearbyPlace {
  return {
    coordinates: { lat: 27.7, lng: 85.3 },
    distance,
    name,
    type,
  };
}

describe("groupNearbyPlaces", () => {
  it("keeps the website's group order, not the payload's and not alphabetical", () => {
    // The order is a judgement about what decides a tenancy: a student picks a
    // hostel by how far the campus is and worries about the gym later. Ported
    // from `NEARBY_GROUPS` in the web's detail page.
    const groups = groupNearbyPlaces([
      place("Anytime Fitness", "gym", 100),
      place("Ratna Park", "park", 200),
      place("Padma Kanya Campus", "college", 300),
      place("Norvic Hospital", "hospital", 400),
    ]);

    expect(groups.map((group) => group.type)).toEqual([
      "college",
      "hospital",
      "park",
      "gym",
    ]);
  });

  it("drops categories the hostel has nothing near", () => {
    const groups = groupNearbyPlaces([place("A Campus", "college", 100)]);

    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe("Colleges & schools");
  });

  it("sorts within a group by distance, so the closest is one of the three shown", () => {
    const groups = groupNearbyPlaces([
      place("Far Campus", "college", 1500),
      place("Near Campus", "college", 120),
      place("Mid Campus", "college", 600),
    ]);

    expect(groups[0].places.map((item) => item.name)).toEqual([
      "Near Campus",
      "Mid Campus",
      "Far Campus",
    ]);
  });

  it("does not mutate the array it was given", () => {
    const places = [place("Far", "college", 900), place("Near", "college", 100)];

    groupNearbyPlaces(places);

    expect(places.map((item) => item.name)).toEqual(["Far", "Near"]);
  });

  /**
   * `type` is a free string from the cached OpenStreetMap lookup, so the
   * geocoder can return a category this client has never heard of. Dropping it
   * would lose a hostel a genuine selling point because the app is a version
   * behind.
   */
  it("keeps a category the table does not name, after the known ones", () => {
    const groups = groupNearbyPlaces([
      place("Bhatbhateni", "supermarket", 250),
      place("A Campus", "college", 300),
    ]);

    expect(groups.map((group) => group.type)).toEqual(["college", "supermarket"]);
    expect(groups[1].label).toBe("Supermarket");
    expect(groups[1].icon).toBe("location");
  });

  it("returns nothing for a hostel with nothing around it", () => {
    expect(groupNearbyPlaces([])).toEqual([]);
  });
});

describe("humanizeNearbyType", () => {
  it("reads an underscored enum as a sentence", () => {
    expect(humanizeNearbyType("bus_stop")).toBe("Bus stop");
    expect(humanizeNearbyType("PETROL-PUMP")).toBe("Petrol pump");
  });
});

describe("nearbyGlyph and nearbyIcon", () => {
  it("both fall back rather than rendering nothing", () => {
    expect(nearbyGlyph("something-new")).toBe("📍");
    expect(nearbyIcon("something-new")).toBe("location");
  });

  it("cover the same categories the groups do", () => {
    for (const type of [
      "college",
      "hospital",
      "pharmacy",
      "bus_stop",
      "restaurant",
      "park",
      "gym",
    ]) {
      expect(nearbyGlyph(type)).not.toBe("📍");
      expect(nearbyIcon(type)).not.toBe("location");
    }
  });
});
