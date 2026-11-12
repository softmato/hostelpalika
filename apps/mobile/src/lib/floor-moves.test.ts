import { describe, expect, it } from "vitest";

import { bedsClaimed, firstFloorMoves, floorLeavers } from "./floor-moves";
import type { Room } from "./rooms-api";

const room = (id: string, floor: number, roomType: string, free: number, people: string[] = []): Room => ({
  beds: free + people.length,
  floor,
  free,
  id,
  number: id,
  residents: people.map((name) => ({ id: name, name })),
  roomType,
});

describe("firstFloorMoves", () => {
  const rooms = [
    room("101", 1, "DOUBLE", 0, ["a", "b"]),
    room("102", 1, "SINGLE", 0, ["c"]),
    room("201", 2, "DOUBLE", 1),
    room("202", 2, "DOUBLE", 1),
    room("001", 0, "DOUBLE", 2),
  ];

  it("places each leaver in a free bed of the same type, never over-filling", () => {
    expect(floorLeavers(rooms, 1).map((entry) => entry.person.id)).toEqual(["a", "b", "c"]);
    const picks = firstFloorMoves(rooms, 1);
    expect(picks).toEqual({ a: "201", b: "202" });
    expect(picks.c).toBeUndefined(); // no SINGLE elsewhere
    expect(bedsClaimed(picks, "201", "b")).toBe(1);
    expect(bedsClaimed(picks, "201", "a")).toBe(0);
  });
});
