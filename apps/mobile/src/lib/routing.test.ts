import { describe, expect, it } from "vitest";

import {
  parseRoadRoute,
  parseRoadRoutes,
  parseTravelTimes,
  ROUTE_MODES,
  routeUrl,
} from "@/lib/routing";

/**
 * Trimmed from a **real** reply, taken on 2026-08-18 by asking the endpoint in
 * `routing.ts` for the road between the two hostels in the live catalogue
 * (Ghattekulo → Baneshwor). The distance, the duration and the first three
 * geometry points are exactly as they came back; the other 211 points are cut
 * because they say nothing new about the parsing.
 *
 * An invented fixture is how a parser ships passing its tests and failing on the
 * first real payload — `statement-parsers` in this repo learned that four times
 * over. The two shapes worth having verbatim are the coordinate order and the
 * fact that `distance` is metres as a float, not an integer.
 */
const REAL_RESPONSE = {
  code: "Ok",
  routes: [
    {
      distance: 4850,
      duration: 423.6,
      geometry: {
        coordinates: [
          [85.329578, 27.698822],
          [85.329547, 27.698747],
          [85.329477, 27.698601],
        ],
        type: "LineString",
      },
      legs: [],
      weight: 423.6,
      weight_name: "routability",
    },
  ],
  waypoints: [{ name: "Shanti Marg" }, { name: "" }],
};

describe("routeUrl", () => {
  it("puts longitude before latitude, which is the order OSRM reads", () => {
    const url = routeUrl({ lat: 27.7, lng: 85.3 }, { lat: 27.6, lng: 85.4 }, "car");

    expect(url).toContain("/85.3,27.7;85.4,27.6");
  });

  it("asks for the full geometry as GeoJSON, which is what the parser reads", () => {
    const url = routeUrl({ lat: 1, lng: 2 }, { lat: 3, lng: 4 }, "car");

    expect(url).toContain("overview=full");
    expect(url).toContain("geometries=geojson");
  });

  /*
   * Without this flag the reply carries `legs[].steps: []` and navigation has
   * no instructions to give — a Start button that opens a card saying nothing.
   * It is asked for on every route, so the flag belongs in the shared builder.
   */
  it("asks for turn-by-turn steps", () => {
    expect(routeUrl({ lat: 1, lng: 2 }, { lat: 3, lng: 4 }, "foot")).toContain("steps=true");
  });

  /*
   * The whole point of the toggle. A host that serves a car graph under the foot
   * profile answers both modes identically, which looks like the feature working
   * — so the test pins the deployment, not just the profile name.
   */
  it("sends each mode to its own routing deployment", () => {
    const from = { lat: 27.7, lng: 85.3 };
    const to = { lat: 27.6, lng: 85.4 };

    expect(routeUrl(from, to, "foot")).toContain("routed-foot/route/v1/foot");
    expect(routeUrl(from, to, "car")).toContain("routed-car/route/v1/driving");
  });
});

describe("ROUTE_MODES", () => {
  it("is the pair the map toggles between", () => {
    expect([...ROUTE_MODES]).toEqual(["car", "foot"]);
  });
});

describe("parseRoadRoute", () => {
  it("reads distance, duration and the line out of a real reply", () => {
    const route = parseRoadRoute(REAL_RESPONSE);

    expect(route).toEqual({
      distanceMeters: 4850,
      durationSeconds: 424,
      points: [
        { lat: 27.698822, lng: 85.329578 },
        { lat: 27.698747, lng: 85.329547 },
        { lat: 27.698601, lng: 85.329477 },
      ],
    });
  });

  it("rejects a 200 that carries no route — OSRM says NoRoute in the body", () => {
    expect(parseRoadRoute({ code: "NoRoute", routes: [] })).toBeNull();
  });

  it("rejects a line of one point, which cannot be drawn", () => {
    expect(
      parseRoadRoute({
        code: "Ok",
        routes: [
          { distance: 10, duration: 5, geometry: { coordinates: [[85.3, 27.7]] } },
        ],
      }),
    ).toBeNull();
  });

  it("drops a broken pair rather than plotting it at Null Island", () => {
    const route = parseRoadRoute({
      code: "Ok",
      routes: [
        {
          distance: 10,
          duration: 5,
          geometry: {
            coordinates: [
              [85.3, 27.7],
              [0, 0],
              [85.4, 27.8],
              ["x", "y"],
            ],
          },
        },
      ],
    });

    expect(route?.points).toEqual([
      { lat: 27.7, lng: 85.3 },
      { lat: 27.8, lng: 85.4 },
    ]);
  });

  it("keeps the route when only the duration is missing", () => {
    const route = parseRoadRoute({
      code: "Ok",
      routes: [
        {
          distance: 120,
          geometry: {
            coordinates: [
              [85.3, 27.7],
              [85.31, 27.71],
            ],
          },
        },
      ],
    });

    expect(route?.durationSeconds).toBe(0);
    expect(route?.distanceMeters).toBe(120);
  });

  it("returns null for anything that is not a response", () => {
    expect(parseRoadRoute(null)).toBeNull();
    expect(parseRoadRoute("Ok")).toBeNull();
    expect(parseRoadRoute({ routes: [{ distance: 5 }] })).toBeNull();
  });
});

/**
 * Three steps out of a **real** 34-step walking reply, taken 2026-08-19 from
 * `routed-foot` for Kathmandu (85.324,27.7172 → 85.34,27.70), verbatim apart
 * from the `intersections` and per-step `geometry` this parser does not read.
 *
 * These three, specifically, because they are the three shapes that break a
 * parser written from the OSRM documentation instead of from a reply:
 *
 * - the `depart` step, whose `name` is Devanagari — the app is used in Nepal;
 * - a `turn` with an **empty** `name`, which 20 of the 34 steps had. A parser
 *   that assumes a street name produces "Turn left onto " on most of this route;
 * - the `arrive` step, which is zero-length and still needs its location.
 *
 * `distance` and `duration` come back as floats and are rounded here, matching
 * what the route-level fields already do.
 */
const REAL_STEPS_RESPONSE = {
  code: "Ok",
  routes: [
    {
      distance: 3736,
      duration: 2988.4,
      geometry: {
        coordinates: [
          [85.324116, 27.717524],
          [85.324414, 27.71744],
        ],
        type: "LineString",
      },
      legs: [
        {
          steps: [
            {
              distance: 81.8,
              duration: 65.5,
              maneuver: {
                bearing_after: 108,
                bearing_before: 0,
                location: [85.324116, 27.717524],
                modifier: "right",
                type: "depart",
              },
              mode: "walking",
              name: "उत्तर ढोका रोड",
            },
            {
              distance: 245.8,
              duration: 196.7,
              maneuver: {
                bearing_after: 82,
                bearing_before: 199,
                location: [85.324743, 27.716914],
                modifier: "left",
                type: "turn",
              },
              mode: "walking",
              name: "",
            },
            {
              distance: 0,
              duration: 0,
              maneuver: {
                bearing_after: 0,
                bearing_before: 16,
                location: [85.340049, 27.699987],
                modifier: "left",
                type: "arrive",
              },
              mode: "walking",
              name: "",
            },
          ],
        },
      ],
    },
  ],
};

describe("parseRoadRoute steps", () => {
  it("reads the instructions out of a real reply", () => {
    const route = parseRoadRoute(REAL_STEPS_RESPONSE);

    expect(route?.steps).toEqual([
      {
        distanceMeters: 82,
        durationSeconds: 66,
        location: { lat: 27.717524, lng: 85.324116 },
        maneuver: { modifier: "right", type: "depart" },
        name: "उत्तर ढोका रोड",
      },
      {
        distanceMeters: 246,
        durationSeconds: 197,
        location: { lat: 27.716914, lng: 85.324743 },
        maneuver: { modifier: "left", type: "turn" },
        name: "",
      },
      {
        distanceMeters: 0,
        durationSeconds: 0,
        location: { lat: 27.699987, lng: 85.340049 },
        maneuver: { modifier: "left", type: "arrive" },
        name: "",
      },
    ]);
  });

  /*
   * The same trap as the route geometry, one level down and easier to miss:
   * `maneuver.location` is `[lng, lat]`. Read the pair in the written order and
   * every turn lands in Tibet, which on a rotated map looks like a compass
   * fault rather than a parsing one.
   */
  it("unpicks the maneuver's [lng, lat] into { lat, lng }", () => {
    const step = parseRoadRoute(REAL_STEPS_RESPONSE)?.steps?.[0];

    expect(step?.location.lat).toBeCloseTo(27.7175, 3);
    expect(step?.location.lng).toBeCloseTo(85.3241, 3);
  });

  it("leaves steps off a reply that has none, rather than inventing an empty list", () => {
    // The old behaviour, and still what a router ignoring `steps=true` returns.
    // A line with no instructions is a route worth drawing; see `RoadRoute`.
    const route = parseRoadRoute(REAL_RESPONSE);

    expect(route).not.toBeNull();
    expect(route?.steps).toBeUndefined();
  });

  it("drops a step whose maneuver location is unusable", () => {
    const broken = {
      ...REAL_STEPS_RESPONSE,
      routes: [
        {
          ...REAL_STEPS_RESPONSE.routes[0],
          legs: [
            {
              steps: [
                { distance: 10, duration: 5, maneuver: { location: [0, 0], type: "turn" }, name: "Null Island" },
                ...REAL_STEPS_RESPONSE.routes[0].legs[0].steps,
              ],
            },
          ],
        },
      ],
    };

    expect(parseRoadRoute(broken)?.steps).toHaveLength(3);
  });

  it("survives a maneuver with no modifier and keeps a roundabout's exit", () => {
    const roundabout = {
      ...REAL_STEPS_RESPONSE,
      routes: [
        {
          ...REAL_STEPS_RESPONSE.routes[0],
          legs: [
            {
              steps: [
                {
                  distance: 30.2,
                  duration: 24,
                  maneuver: { exit: 2, location: [85.3, 27.7], type: "roundabout" },
                  name: "Ring Road",
                },
              ],
            },
          ],
        },
      ],
    };

    expect(parseRoadRoute(roundabout)?.steps?.[0].maneuver).toEqual({
      exit: 2,
      type: "roundabout",
    });
  });
});

describe("route choices", () => {
  const leg = (distance: number) => ({
    distance,
    duration: distance / 10,
    geometry: { coordinates: [[85.3, 27.7], [85.31, 27.71], [85.32, 27.72]], type: "LineString" },
  });

  it("asks for alternatives only when told to", () => {
    const from = { lat: 27.7, lng: 85.3 };
    const to = { lat: 27.6, lng: 85.4 };
    expect(routeUrl(from, to, "car", { alternatives: true })).toContain("alternatives=2");
    expect(routeUrl(from, to, "car")).not.toContain("alternatives");
  });

  it("keeps every route that parses, best first", () => {
    const routes = parseRoadRoutes({ code: "Ok", routes: [leg(5000), { distance: "x" }, leg(5600)] });
    expect(routes.map((route) => route.distanceMeters)).toEqual([5000, 5600]);
    expect(parseRoadRoutes({ code: "NoRoute" })).toEqual([]);
  });
});

describe("parseTravelTimes", () => {
  it("drops the origin's own zero and keeps unreachable points as null", () => {
    expect(parseTravelTimes({ code: "Ok", durations: [[0, 412.6, null, 90]] }, 3)).toEqual([413, null, 90]);
  });

  it("answers a row of nulls for anything that is not a table", () => {
    expect(parseTravelTimes({ code: "NoTable" }, 2)).toEqual([null, null]);
  });
});
