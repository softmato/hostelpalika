import { describe, expect, it } from "vitest";

import { haversineMeters } from "@/lib/geo";
import {
  bearingAlong,
  cardinalFor,
  chooseHeading,
  corridorBoxes,
  distanceToPath,
  formatManeuverDistance,
  hasArrived,
  headingDifference,
  instructionFor,
  isOffRoute,
  nextStep,
  normaliseHeading,
  progressAlong,
  smoothHeading,
  spokenCue,
  spokenDistance,
  startCue,
} from "@/lib/navigation";
import type { RouteStep } from "@/lib/routing";

/**
 * These are the two calculations that decide which way the map faces, and both
 * fail in ways that look like broken hardware rather than broken code: a sign
 * error reads as a compass turning the wrong way, and an unwrapped
 * interpolation reads as the map spinning at random. Hence the wrap cases below
 * being laboured — 359° to 1° is the whole bug.
 */

describe("normaliseHeading", () => {
  it("brings any angle into [0, 360)", () => {
    expect(normaliseHeading(0)).toBe(0);
    expect(normaliseHeading(359)).toBe(359);
    expect(normaliseHeading(360)).toBe(0);
    expect(normaliseHeading(450)).toBe(90);
    expect(normaliseHeading(-90)).toBe(270);
    expect(normaliseHeading(-450)).toBe(270);
  });
});

describe("bearingAlong", () => {
  const origin = { lat: 27.7, lng: 85.3 };

  it("reads the nearest segment's direction", () => {
    const northThenEast = [origin, { lat: 27.71, lng: 85.3 }, { lat: 27.71, lng: 85.31 }];
    expect(bearingAlong(northThenEast, { lat: 27.703, lng: 85.3 })).toBeCloseTo(0, 0);
    expect(bearingAlong(northThenEast, { lat: 27.71, lng: 85.307 })).toBeCloseTo(90, 0);
  });

  it("has nothing to say about a line with no length", () => {
    expect(bearingAlong([origin, origin], origin)).toBeNull();
  });

  it("is the last fallback, after the compass", () => {
    expect(chooseHeading({ compass: null, gpsHeading: null, route: 200, speed: 0 })).toBe(200);
    expect(chooseHeading({ compass: 10, gpsHeading: null, route: 200, speed: 0 })).toBe(10);
  });
});

describe("chooseHeading", () => {
  it("takes the GPS course while moving at walking pace or above", () => {
    expect(chooseHeading({ compass: 10, gpsHeading: 90, speed: 1.5 })).toBe(90);
    expect(chooseHeading({ compass: 10, gpsHeading: 90, speed: 8 })).toBe(90);
  });

  it("takes the compass while standing still", () => {
    // The junction case: nothing is moving, so course over ground is either
    // absent or the direction of the last metre of GPS noise.
    expect(chooseHeading({ compass: 10, gpsHeading: 90, speed: 0 })).toBe(10);
    expect(chooseHeading({ compass: 10, gpsHeading: 90, speed: 0.4 })).toBe(10);
    expect(chooseHeading({ compass: 10, gpsHeading: null, speed: null })).toBe(10);
  });

  it("falls back to the GPS course when there is no compass", () => {
    expect(chooseHeading({ compass: null, gpsHeading: 200, speed: 0 })).toBe(200);
    expect(chooseHeading({ compass: null, gpsHeading: 200, speed: 5 })).toBe(200);
  });

  it("is null only when neither source has anything", () => {
    expect(chooseHeading({ compass: null, gpsHeading: null, speed: 3 })).toBeNull();
  });

  it("normalises whatever it returns", () => {
    expect(chooseHeading({ compass: -10, gpsHeading: null, speed: 0 })).toBe(350);
    expect(chooseHeading({ compass: null, gpsHeading: 370, speed: 5 })).toBe(10);
  });

  it("keeps due north rather than treating zero as missing", () => {
    // `0` is a real heading and `0` is a real speed; neither is "no reading".
    expect(chooseHeading({ compass: 0, gpsHeading: 180, speed: 0 })).toBe(0);
    expect(chooseHeading({ compass: 45, gpsHeading: 0, speed: 5 })).toBe(0);
  });
});

describe("headingDifference", () => {
  it("measures the short way round", () => {
    expect(headingDifference(10, 20)).toBe(10);
    expect(headingDifference(20, 10)).toBe(10);
    // The gate in `map-explorer` reads this: 358 and 2 are four degrees apart,
    // and a naive subtraction would call them 356 and inject on every sample.
    expect(headingDifference(358, 2)).toBe(4);
    expect(headingDifference(2, 358)).toBe(4);
  });

  it("never exceeds a half turn", () => {
    expect(headingDifference(0, 180)).toBe(180);
    expect(headingDifference(0, 181)).toBe(179);
    expect(headingDifference(0, 359)).toBe(1);
    expect(headingDifference(-10, 350)).toBe(0);
  });
});

describe("smoothHeading", () => {
  it("takes the first sample whole", () => {
    expect(smoothHeading(null, 200, 0.2)).toBe(200);
  });

  it("eases part of the way towards the new sample", () => {
    expect(smoothHeading(100, 200, 0.25)).toBe(125);
    expect(smoothHeading(200, 100, 0.25)).toBe(175);
  });

  it("crosses north the short way, not the long way round", () => {
    // 358 → 2 is four degrees clockwise. A filter doing plain arithmetic would
    // return ~269 here and swing the map most of a full turn.
    expect(smoothHeading(358, 2, 0.5)).toBe(0);
    expect(smoothHeading(2, 358, 0.5)).toBe(0);
    expect(smoothHeading(350, 10, 0.25)).toBe(355);
    expect(smoothHeading(10, 350, 0.25)).toBe(5);
  });

  it("stays inside [0, 360) whichever way it moves", () => {
    for (const [previous, next] of [
      [359, 1],
      [1, 359],
      [0, 180],
      [180, 0],
    ]) {
      const result = smoothHeading(previous, next, 0.3);

      expect(result).toBeGreaterThanOrEqual(0);
      expect(result).toBeLessThan(360);
    }
  });

  it("clamps alpha rather than overshooting or reversing", () => {
    expect(smoothHeading(100, 200, 1)).toBe(200);
    expect(smoothHeading(100, 200, 2)).toBe(200);
    expect(smoothHeading(100, 200, 0)).toBe(100);
    expect(smoothHeading(100, 200, -1)).toBe(100);
  });

  it("settles on the target when fed the same sample repeatedly", () => {
    // A filter with a sign error oscillates here instead of converging.
    let heading = smoothHeading(null, 350, 0.2);

    for (let i = 0; i < 40; i += 1) {
      heading = smoothHeading(heading, 20, 0.2);
    }

    expect(heading).toBeGreaterThan(19.9);
    expect(heading).toBeLessThan(20.1);
  });
});

function step(partial: {
  exit?: number;
  modifier?: string;
  name?: string;
  type: string;
}): RouteStep {
  return {
    distanceMeters: 100,
    durationSeconds: 60,
    location: { lat: 27.7, lng: 85.3 },
    maneuver: {
      ...(partial.exit === undefined ? {} : { exit: partial.exit }),
      ...(partial.modifier === undefined ? {} : { modifier: partial.modifier }),
      type: partial.type,
    },
    name: partial.name ?? "",
  };
}

describe("instructionFor", () => {
  it("names the street when OSRM gave one", () => {
    expect(instructionFor(step({ modifier: "right", name: "Ring Road", type: "turn" }))).toBe(
      "Turn right onto Ring Road",
    );
  });

  /*
   * The one that matters most on this map: 20 of the 34 steps in the captured
   * Kathmandu reply have no name at all, so this is the *common* case, not the
   * edge case, and "Turn right onto " would be on most of the route.
   */
  it("says nothing about the street when OSRM gave none", () => {
    expect(instructionFor(step({ modifier: "right", type: "turn" }))).toBe("Turn right");
    expect(instructionFor(step({ modifier: "left", name: "   ", type: "turn" }))).toBe(
      "Turn left",
    );
  });

  it("covers every turn modifier", () => {
    expect(instructionFor(step({ modifier: "left", type: "turn" }))).toBe("Turn left");
    expect(instructionFor(step({ modifier: "sharp left", type: "turn" }))).toBe(
      "Turn sharp left",
    );
    expect(instructionFor(step({ modifier: "sharp right", type: "turn" }))).toBe(
      "Turn sharp right",
    );
    expect(instructionFor(step({ modifier: "slight left", type: "turn" }))).toBe(
      "Turn slightly left",
    );
    expect(instructionFor(step({ modifier: "slight right", type: "turn" }))).toBe(
      "Turn slightly right",
    );
    expect(instructionFor(step({ modifier: "uturn", type: "turn" }))).toBe("Make a U-turn");
  });

  it("falls back to going straight rather than guessing a direction", () => {
    expect(instructionFor(step({ type: "turn" }))).toBe("Continue straight");
    expect(instructionFor(step({ modifier: "straight", type: "turn" }))).toBe(
      "Continue straight",
    );
    // A modifier OSRM adds after this was written must not become "Turn sideways".
    expect(instructionFor(step({ modifier: "sideways", name: "X", type: "turn" }))).toBe(
      "Continue straight onto X",
    );
    expect(instructionFor(step({ modifier: "left", type: "unheard-of" }))).toBe("Turn left");
  });

  it("handles the departure and the arrival", () => {
    expect(instructionFor(step({ name: "Sama Marg", type: "depart" }))).toBe(
      "Set off along Sama Marg",
    );
    expect(instructionFor(step({ modifier: "right", type: "depart" }))).toBe("Set off");
    expect(instructionFor(step({ modifier: "left", type: "arrive" }))).toBe(
      "You have arrived",
    );
  });

  it("counts roundabout exits", () => {
    expect(instructionFor(step({ exit: 1, type: "roundabout" }))).toBe("Take the 1st exit");
    expect(instructionFor(step({ exit: 2, name: "Ring Road", type: "roundabout" }))).toBe(
      "Take the 2nd exit onto Ring Road",
    );
    expect(instructionFor(step({ exit: 3, type: "rotary" }))).toBe("Take the 3rd exit");
    expect(instructionFor(step({ exit: 4, type: "roundabout" }))).toBe("Take the 4th exit");
    // Nobody will meet an eleventh exit, but 11th/12th/13th are where every
    // hand-written ordinal breaks, so they are pinned.
    expect(instructionFor(step({ exit: 11, type: "roundabout" }))).toBe("Take the 11th exit");
    expect(instructionFor(step({ exit: 12, type: "roundabout" }))).toBe("Take the 12th exit");
    expect(instructionFor(step({ exit: 13, type: "roundabout" }))).toBe("Take the 13th exit");
    expect(instructionFor(step({ exit: 21, type: "roundabout" }))).toBe("Take the 21st exit");
    expect(instructionFor(step({ type: "roundabout" }))).toBe("Enter the roundabout");
    expect(instructionFor(step({ name: "Sama Marg", type: "exit roundabout" }))).toBe(
      "Leave the roundabout onto Sama Marg",
    );
    expect(instructionFor(step({ type: "exit rotary" }))).toBe("Leave the roundabout");
  });

  /*
   * These four types have spaces in them. Matching on a camelCase spelling
   * compiles, passes an invented fixture, and drops through to the default on
   * the real route — the reader is told to continue straight at a junction.
   */
  it("reads the maneuver types that contain spaces", () => {
    expect(instructionFor(step({ modifier: "left", name: "Bhagwati Marg", type: "end of road" }))).toBe(
      "Turn left at the end of the road onto Bhagwati Marg",
    );
    expect(instructionFor(step({ modifier: "straight", type: "end of road" }))).toBe(
      "Continue straight",
    );
    expect(instructionFor(step({ modifier: "straight", name: "Maiti Devi marg", type: "new name" }))).toBe(
      "Continue onto Maiti Devi marg",
    );
    expect(instructionFor(step({ modifier: "straight", type: "new name" }))).toBe(
      "Continue straight",
    );
    expect(instructionFor(step({ name: "Ring Road", type: "on ramp" }))).toBe(
      "Take the slip road onto Ring Road",
    );
    expect(instructionFor(step({ type: "off ramp" }))).toBe("Take the exit");
  });

  it("keeps rather than turns at a fork, and merges", () => {
    expect(instructionFor(step({ modifier: "left", type: "fork" }))).toBe("Keep left");
    expect(instructionFor(step({ modifier: "slight right", name: "Ring Road", type: "fork" }))).toBe(
      "Keep slightly right onto Ring Road",
    );
    expect(instructionFor(step({ type: "fork" }))).toBe("Keep straight on");
    expect(instructionFor(step({ modifier: "left", type: "merge" }))).toBe("Merge left");
    expect(instructionFor(step({ type: "merge" }))).toBe("Merge");
  });

  it("continues along a road rather than onto it", () => {
    expect(
      instructionFor(step({ modifier: "slight right", name: "Ananda Bhairav Marg", type: "continue" })),
    ).toBe("Continue slightly right along Ananda Bhairav Marg");
    expect(instructionFor(step({ modifier: "straight", type: "continue" }))).toBe(
      "Continue straight",
    );
    expect(instructionFor(step({ type: "continue" }))).toBe("Continue straight");
  });

  it("never ends in a stray preposition or a full stop", () => {
    const types = [
      "arrive", "continue", "depart", "end of road", "exit roundabout", "fork",
      "merge", "new name", "off ramp", "on ramp", "roundabout", "turn", "whatever",
    ];

    for (const type of types) {
      for (const modifier of [undefined, "left", "straight", "uturn", "slight right"]) {
        for (const name of ["", "Ring Road"]) {
          const text = instructionFor(step({ modifier, name, type }));

          expect(text).not.toMatch(/\s$/);
          expect(text).not.toMatch(/(onto|along)$/);
          expect(text).not.toMatch(/\.$/);
          expect(text[0]).toBe(text[0].toUpperCase());
        }
      }
    }
  });
});

/**
 * A straight kilometre of road running due east from Ghattekulo, as OSRM would
 * return it: two points, because a straight road needs no others. Every
 * off-route bug in a naive implementation shows up on exactly this shape.
 */
const START = { lat: 27.7, lng: 85.3 };

/** Moves a point by metres. North/east positive; the inverse of the projection. */
function offset(from: { lat: number; lng: number }, north: number, east: number) {
  const perDegree = 111_194.9;

  return {
    lat: from.lat + north / perDegree,
    lng: from.lng + east / (perDegree * Math.cos((from.lat * Math.PI) / 180)),
  };
}

const KILOMETRE_EAST = [START, offset(START, 0, 1_000)];

describe("distanceToPath", () => {
  /*
   * The reason this measures to the segment and not to the vertices. Standing
   * in the middle of a straight kilometre of road, a vertex-only check reports
   * five hundred metres off-route and reroutes somebody who is walking exactly
   * where they were told to.
   */
  it("is ~zero in the middle of a long straight segment", () => {
    expect(distanceToPath(offset(START, 0, 500), KILOMETRE_EAST)).toBeLessThan(1);
  });

  it("measures the perpendicular offset from the line", () => {
    expect(distanceToPath(offset(START, 50, 500), KILOMETRE_EAST)).toBeCloseTo(50, 0);
    expect(distanceToPath(offset(START, -20, 250), KILOMETRE_EAST)).toBeCloseTo(20, 0);
  });

  it("falls back to the endpoint beyond either end", () => {
    // 100 m west of the start is 100 m from the route, not on an extended line.
    expect(distanceToPath(offset(START, 0, -100), KILOMETRE_EAST)).toBeCloseTo(100, 0);
    expect(distanceToPath(offset(START, 0, 1_100), KILOMETRE_EAST)).toBeCloseTo(100, 0);
  });

  it("picks the nearest of several segments", () => {
    // East a kilometre, then north a kilometre.
    const corner = offset(START, 0, 1_000);
    const dogleg = [START, corner, offset(corner, 1_000, 0)];

    expect(distanceToPath(offset(corner, 500, 10), dogleg)).toBeCloseTo(10, 0);
  });

  it("copes with a route it cannot measure against", () => {
    expect(distanceToPath(START, [])).toBe(Number.POSITIVE_INFINITY);
    expect(distanceToPath(offset(START, 0, 100), [START])).toBeCloseTo(100, 0);
    // OSRM does emit duplicate points; a zero-length segment must not divide by zero.
    expect(distanceToPath(offset(START, 0, 100), [START, START])).toBeCloseTo(100, 0);
  });
});

describe("progressAlong", () => {
  it("counts down from the full length to nothing", () => {
    expect(progressAlong(KILOMETRE_EAST, START)).toBeGreaterThan(995);
    expect(progressAlong(KILOMETRE_EAST, offset(START, 0, 500))).toBeCloseTo(500, -1);
    expect(progressAlong(KILOMETRE_EAST, offset(START, 0, 1_000))).toBeLessThan(5);
  });

  it("ignores how far off the line the reader is", () => {
    // Thirty metres to the side is still five hundred metres from the end.
    expect(progressAlong(KILOMETRE_EAST, offset(START, 30, 500))).toBeCloseTo(500, -1);
  });

  it("adds up the segments still to come", () => {
    const corner = offset(START, 0, 1_000);
    const dogleg = [START, corner, offset(corner, 1_000, 0)];

    expect(progressAlong(dogleg, offset(START, 0, 500))).toBeCloseTo(1_500, -2);
  });

  it("has nothing to count without a line", () => {
    expect(progressAlong([], START)).toBe(0);
  });
});

describe("nextStep", () => {
  const corner = offset(START, 0, 1_000);
  const steps = [
    step({ modifier: "right", name: "First Road", type: "depart" }),
    step({ modifier: "left", name: "Second Road", type: "turn" }),
    step({ modifier: "left", type: "arrive" }),
  ];
  const located = [
    { ...steps[0], location: START },
    { ...steps[1], location: corner },
    { ...steps[2], location: offset(corner, 1_000, 0) },
  ];

  /*
   * The trap: a step's maneuver is at its *start*. Half way along the first
   * road, the nearest maneuver is the departure behind the reader — announcing
   * that is announcing a turn they made a minute ago. What they need is the
   * turn at the far end.
   */
  it("gives the maneuver ahead, not the nearest one", () => {
    const upcoming = nextStep(located, offset(START, 0, 100));

    expect(upcoming?.index).toBe(1);
    expect(upcoming?.step.name).toBe("Second Road");
    expect(upcoming?.distanceMeters).toBeCloseTo(900, -2);
  });

  it("counts down to zero as the maneuver is reached", () => {
    expect(nextStep(located, offset(START, 0, 500))?.distanceMeters).toBeCloseTo(500, -2);
    expect(nextStep(located, offset(START, 0, 950))?.distanceMeters).toBeLessThan(60);
    expect(nextStep(located, corner)?.distanceMeters).toBeLessThan(5);
  });

  it("moves on to the next leg once past the turn", () => {
    const upcoming = nextStep(located, offset(corner, 200, 0));

    expect(upcoming?.index).toBe(2);
    expect(upcoming?.step.maneuver.type).toBe("arrive");
  });

  it("handles the degenerate lists", () => {
    expect(nextStep([], START)).toBeNull();
    expect(nextStep([located[2]], START)?.index).toBe(0);
  });
});

describe("isOffRoute", () => {
  /*
   * These thresholds are generous by design: a fix in a street canyon is
   * routinely twenty metres out while standing still, and a map that reroutes
   * on that is unusable — and hammers somebody else's free routing server.
   */
  it("tolerates ordinary city GPS error", () => {
    expect(isOffRoute(20, "foot")).toBe(false);
    expect(isOffRoute(20, "car")).toBe(false);
  });

  it("fires at 40 m on foot and 60 m by car", () => {
    expect(isOffRoute(40, "foot")).toBe(false);
    expect(isOffRoute(41, "foot")).toBe(true);
    expect(isOffRoute(50, "car")).toBe(false);
    expect(isOffRoute(61, "car")).toBe(true);
  });
});

describe("hasArrived", () => {
  it("is thirty metres, not nought", () => {
    expect(hasArrived(START, START)).toBe(true);
    expect(hasArrived(offset(START, 0, 25), START)).toBe(true);
    expect(hasArrived(offset(START, 0, 35), START)).toBe(false);
    // Sanity: the offset helper is measuring what the app measures.
    expect(haversineMeters(START, offset(START, 0, 35))).toBeCloseTo(35, 0);
  });
});

describe("formatManeuverDistance", () => {
  it("counts down in tens near a junction", () => {
    // `formatDistance` would round these to 150, 100, 50 — which cannot tell
    // the turning in front of you from the one after it.
    expect(formatManeuverDistance(124)).toBe("In 120 m");
    expect(formatManeuverDistance(96)).toBe("In 100 m");
    expect(formatManeuverDistance(45)).toBe("In 50 m");
  });

  it("stops counting at the turn rather than claiming ten metres", () => {
    expect(formatManeuverDistance(19)).toBe("Now");
    expect(formatManeuverDistance(0)).toBe("Now");
    expect(formatManeuverDistance(20)).toBe("In 20 m");
  });

  it("switches to kilometres on a long leg", () => {
    expect(formatManeuverDistance(1_000)).toBe("In 1.0 km");
    expect(formatManeuverDistance(2_449)).toBe("In 2.4 km");
  });

  it("admits it rather than announcing a turn on a number that is not one", () => {
    expect(formatManeuverDistance(Number.NaN)).toBe("—");
    expect(formatManeuverDistance(Number.POSITIVE_INFINITY)).toBe("—");
    expect(formatManeuverDistance(-5)).toBe("Now");
  });
});

describe("cardinalFor", () => {
  it("names the eight points", () => {
    expect(cardinalFor(0)).toBe("N");
    expect(cardinalFor(45)).toBe("NE");
    expect(cardinalFor(90)).toBe("E");
    expect(cardinalFor(135)).toBe("SE");
    expect(cardinalFor(180)).toBe("S");
    expect(cardinalFor(225)).toBe("SW");
    expect(cardinalFor(270)).toBe("W");
    expect(cardinalFor(315)).toBe("NW");
  });

  it("gives each point the 45 degrees centred on it", () => {
    // North owns 337.5 round to 22.5, not 0 to 45 — an offset error here reads
    // as a compass permanently lagging by an eighth of a turn.
    expect(cardinalFor(22)).toBe("N");
    expect(cardinalFor(23)).toBe("NE");
    expect(cardinalFor(338)).toBe("N");
    expect(cardinalFor(337)).toBe("NW");
  });

  it("wraps rather than falling off the end of the list", () => {
    expect(cardinalFor(359)).toBe("N");
    expect(cardinalFor(360)).toBe("N");
    expect(cardinalFor(-45)).toBe("NW");
    expect(cardinalFor(720 + 90)).toBe("E");
  });
});

describe("voice cues", () => {
  const left: RouteStep = {
    distanceMeters: 300,
    durationSeconds: 60,
    location: { lat: 27.7, lng: 85.3 },
    maneuver: { modifier: "left", type: "turn" },
    name: "Ring Road",
  };
  const door: RouteStep = { ...left, maneuver: { type: "arrive" }, name: "" };
  const at = (step: RouteStep, distanceMeters: number) => ({ distanceMeters, index: 1, step });

  it("says nothing far out, then the approach, then the turn — each once", () => {
    const spoken = new Set<string>();

    expect(spokenCue(at(left, 150), "foot", spoken)).toBeNull();

    const early = spokenCue(at(left, 96), "foot", spoken)!;
    expect(early.text).toBe("In 100 metres, turn left onto Ring Road");
    spoken.add(early.key);
    expect(spokenCue(at(left, 60), "foot", spoken)).toBeNull();

    const now = spokenCue(at(left, 15), "foot", spoken)!;
    expect(now.text).toBe("Turn left onto Ring Road");
    spoken.add(now.key);
    expect(spokenCue(at(left, 5), "foot", spoken)).toBeNull();
  });

  it("warns a driver further out than a walker", () => {
    expect(spokenCue(at(left, 380), "car", new Set())?.text).toBe(
      "In 400 metres, turn left onto Ring Road",
    );
    expect(spokenCue(at(left, 380), "foot", new Set())).toBeNull();
  });

  it("announces the destination ahead but leaves the door to the arrival", () => {
    expect(spokenCue(at(door, 80), "foot", new Set())?.text).toBe(
      "Your destination is 80 metres ahead",
    );
    expect(spokenCue(at(door, 10), "foot", new Set())).toBeNull();
  });

  it("never opens with silence", () => {
    expect(startCue(at(left, 1_250), "car", "Sunrise Hostel")).toBe(
      "Starting route to Sunrise Hostel. In 1.3 kilometres, turn left onto Ring Road",
    );
    expect(startCue(at(left, 50), "foot", "Sunrise Hostel")).toBe("Starting route to Sunrise Hostel");
    expect(spokenDistance(2_000, "car")).toBe("2 kilometres");
  });
});

describe("corridorBoxes", () => {
  it("splits a long route into overlapping boxes that cover every point", () => {
    // ~4.4 km due north, a point every ~110 m.
    const route = Array.from({ length: 41 }, (_, i) => ({ lat: 27.66 + i * 0.001, lng: 85.32 }));
    const boxes = corridorBoxes(route);

    expect(boxes.length).toBe(3);
    for (const point of route) {
      expect(
        boxes.some(([w, s, e, n]) => point.lng >= w && point.lng <= e && point.lat >= s && point.lat <= n),
      ).toBe(true);
    }
  });

  it("gives a short route one box", () => {
    expect(corridorBoxes([{ lat: 27.7, lng: 85.3 }, { lat: 27.701, lng: 85.3 }])).toHaveLength(1);
  });
});
