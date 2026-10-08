import type { Coordinates } from "@/lib/geo";
import { isUsableCoordinate } from "@/lib/geo";

/**
 * The road between the device and a hostel, as a line to draw.
 *
 * ## Why a third party at all
 *
 * `haversineMeters` is the distance a bird flies. It is the right number for
 * *sorting* — two hostels 400m apart in a straight line are 400m apart in any
 * ranking — and the wrong one for "how far is it": the Bagmati is 30 metres wide
 * and the nearest bridge is a kilometre away. Tracing an actual path means
 * asking something that holds a road graph, and nothing in this product does.
 *
 * ## What is sent, and to whom
 *
 * Two coordinate pairs go to **OSRM's public demo server** — the device's
 * position and the hostel's. That is the one place in this app where the user's
 * position leaves the phone, so it is worth stating plainly:
 *
 * - It happens **only** on the directions screen, which is opened by tapping a
 *   distance, never on a list or a home screen.
 * - Nothing is stored, here or there: no account, no cookie, no id. The request
 *   carries two points and nothing that says whose they are.
 * - Every other distance in the app stays local arithmetic (`lib/geo.ts`).
 *
 * ## Which router, and why not the OSRM demo
 *
 * `router.project-osrm.org` is the obvious address and the wrong one: it hosts
 * a **car graph under every profile name**, so `/route/v1/foot/` there returns a
 * driving route with a driving duration and calls it walking. Between the two
 * hostels in the live catalogue it answers 4,850m in 7 minutes for both.
 *
 * The FOSSGIS instances below are the ones openstreetmap.org's own directions
 * use, and they are one deployment per profile — `routed-foot` really is a
 * pedestrian graph. The same pair of points comes back as 5,252m in 70 minutes
 * on foot and 4,850m in 7 by car, which is the difference the toggle on the map
 * is offering.
 *
 * They are still somebody else's free service. A keyed provider
 * (OpenRouteService, GraphHopper, Mapbox) is a drop-in replacement for
 * `ROUTERS` and nothing else: the app talks to this module, not to a URL.
 *
 * ## Every failure is a `null`, never a throw
 *
 * The caller is a map with two points already on it. A rejected promise there
 * would take out a screen that can perfectly well draw a dashed straight line
 * and say so, which is exactly what it does.
 */

export const ROUTE_MODES = ["car", "foot"] as const;

export type RouteMode = (typeof ROUTE_MODES)[number];

/** One OSRM deployment per profile — see the note above about why. */
const ROUTERS: Record<RouteMode, string> = {
  car: "https://routing.openstreetmap.de/routed-car/route/v1/driving",
  foot: "https://routing.openstreetmap.de/routed-foot/route/v1/foot",
};

/** Longer than this and the straight line is the better answer. */
const TIMEOUT_MS = 8_000;

/** Below two points there is no line to draw. */
const MIN_POINTS = 2;

/**
 * One instruction on the route: a maneuver, and the leg of road after it.
 *
 * `distanceMeters` is the length of *this* step — the ground covered between
 * this maneuver and the next one — which is what "In 120 m, turn left" counts
 * down. It is not the distance to the maneuver from where the reader is now;
 * that is `nextStep` in `lib/navigation.ts`, and confusing the two gives a
 * countdown that never reaches zero.
 *
 * `name` is the street, and it is **often empty**: 20 of the 34 steps in the
 * captured reply in `routing.test.ts` have none, because much of Kathmandu is
 * unnamed in OSM. Anything printing it must handle that — see `instructionFor`.
 */
export type RouteStep = {
  distanceMeters: number;
  durationSeconds: number;
  /** Where the maneuver happens. Unpicked from OSRM's `[lng, lat]`. */
  location: Coordinates;
  maneuver: {
    /** Which exit to take, roundabouts only. */
    exit?: number;
    /** `left`, `slight right`, `straight`… Absent on some maneuvers. */
    modifier?: string;
    /** `turn`, `depart`, `arrive`, `end of road`, `new name`, `continue`… */
    type: string;
  };
  /** The street this step runs along. Empty when OSM has no name for it. */
  name: string;
};

export type RoadRoute = {
  /** Metres along the road, which is always ≥ the straight-line distance. */
  distanceMeters: number;
  durationSeconds: number;
  /** In order, device first. Every point is `{ lat, lng }`, not OSRM's pairs. */
  points: Coordinates[];
  /**
   * Turn-by-turn instructions, when the router gave any.
   *
   * Optional on purpose: a route with no steps is still a line worth drawing,
   * and the directions screen drew exactly that before navigation existed. Only
   * guidance requires them, and it says so rather than assuming.
   */
  steps?: RouteStep[];
};

/**
 * **`lng,lat`, in that order, semicolon-separated.**
 *
 * OSRM takes longitude first — the GeoJSON convention — and every other
 * coordinate in this codebase is written latitude first. Swapping them does not
 * fail: it returns a perfectly good route between two points in the wrong
 * hemisphere. Hence a builder with a test rather than a template literal at the
 * call site.
 *
 * `steps=true` is asked for on every route, not only when navigating. It costs
 * one request either way — the alternative is asking a second time the moment
 * the reader presses Start, which is the worst moment to wait — and the parser
 * makes them optional, so a router that ignores the flag still draws a line.
 */
export function routeUrl(
  from: Coordinates,
  to: Coordinates,
  mode: RouteMode,
  { alternatives = false }: { alternatives?: boolean } = {},
): string {
  const path = `${from.lng},${from.lat};${to.lng},${to.lat}`;
  const others = alternatives ? "&alternatives=2" : "";

  return `${ROUTERS[mode]}/${path}?overview=full&geometries=geojson&steps=true${others}`;
}

/**
 * The parts of an OSRM response this app draws, or `null`.
 *
 * Written against a real reply from the endpoint above rather than an invented
 * one — see `routing.test.ts`. `code` is checked because OSRM answers `200 OK`
 * with `{"code":"NoRoute"}` when the two points are on graphs that do not
 * connect, which is a real case here: a hostel geocoded into the middle of a
 * field has no road to it.
 */
export function parseRoadRoute(payload: unknown): RoadRoute | null {
  return parseRoadRoutes(payload)[0] ?? null;
}

/**
 * Every route in the reply, best first — the router's own pick, then up to two
 * alternatives when they were asked for. A route that does not parse is
 * dropped rather than failing the others.
 */
export function parseRoadRoutes(payload: unknown): RoadRoute[] {
  if (!isRecord(payload) || payload.code !== "Ok" || !Array.isArray(payload.routes)) {
    return [];
  }

  return payload.routes.flatMap((route) => {
    const parsed = parseOne(route);

    return parsed ? [parsed] : [];
  });
}

function parseOne(route: unknown): RoadRoute | null {
  if (!isRecord(route)) {
    return null;
  }

  const { distance, duration, geometry } = route;

  if (typeof distance !== "number" || !Number.isFinite(distance)) {
    return null;
  }

  const coordinates =
    isRecord(geometry) && Array.isArray(geometry.coordinates) ? geometry.coordinates : [];

  const points = coordinates.flatMap((pair) => {
    if (!Array.isArray(pair) || pair.length < 2) {
      return [];
    }

    // GeoJSON order, unpicked here so nothing downstream has to remember it.
    const point = { lat: Number(pair[1]), lng: Number(pair[0]) };

    return isUsableCoordinate(point) ? [point] : [];
  });

  if (points.length < MIN_POINTS) {
    return null;
  }

  const steps = parseSteps(route.legs);

  return {
    distanceMeters: Math.round(distance),
    durationSeconds:
      typeof duration === "number" && Number.isFinite(duration) ? Math.round(duration) : 0,
    points,
    ...(steps.length > 0 ? { steps } : {}),
  };
}

/**
 * The instructions, flattened across legs.
 *
 * OSRM splits a route into one leg per pair of waypoints. This app only ever
 * sends two points, so there is always exactly one leg — but flattening costs a
 * line and means a via-point added later does not silently drop half the
 * instructions.
 *
 * A step with an unreadable maneuver location is dropped rather than defaulted:
 * every consumer measures a distance to that point, and a `0, 0` in the middle
 * of the list would put the next turn in the Gulf of Guinea.
 */
function parseSteps(legs: unknown): RouteStep[] {
  if (!Array.isArray(legs)) {
    return [];
  }

  return legs.flatMap((leg) => {
    const raw = isRecord(leg) && Array.isArray(leg.steps) ? leg.steps : [];

    return raw.flatMap((step) => {
      if (!isRecord(step) || !isRecord(step.maneuver)) {
        return [];
      }

      const { maneuver } = step;
      const pair = maneuver.location;

      if (!Array.isArray(pair) || pair.length < 2) {
        return [];
      }

      // GeoJSON order here too — `maneuver.location` is `[lng, lat]`.
      const location = { lat: Number(pair[1]), lng: Number(pair[0]) };

      if (!isUsableCoordinate(location) || typeof maneuver.type !== "string") {
        return [];
      }

      return [
        {
          distanceMeters: finiteOrZero(step.distance),
          durationSeconds: finiteOrZero(step.duration),
          location,
          maneuver: {
            ...(typeof maneuver.exit === "number" ? { exit: maneuver.exit } : {}),
            ...(typeof maneuver.modifier === "string"
              ? { modifier: maneuver.modifier }
              : {}),
            type: maneuver.type,
          },
          name: typeof step.name === "string" ? step.name.trim() : "",
        },
      ];
    });
  });
}

function finiteOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : 0;
}

/**
 * One request, one route, `null` for everything else.
 *
 * `AbortController` rather than a `Promise.race`: a race leaves the request
 * running and its response parsed into a screen that has already given up,
 * where an abort ends it. The timeout is cleared on both paths so a resolved
 * request does not hold a timer for eight seconds.
 */
export async function fetchRoadRoute(
  from: Coordinates,
  to: Coordinates,
  mode: RouteMode = "car",
): Promise<RoadRoute | null> {
  return (await fetchRoadRoutes(from, to, mode, { alternatives: false }))[0] ?? null;
}

/**
 * The route and up to two alternatives, for the reader to choose between.
 * Empty for every failure, like `fetchRoadRoute`'s `null`.
 *
 * On foot the road routes are candidates too — see `walkingChoices`.
 */
export async function fetchRoadRoutes(
  from: Coordinates,
  to: Coordinates,
  mode: RouteMode = "car",
  { alternatives = true }: { alternatives?: boolean } = {},
): Promise<RoadRoute[]> {
  if (!isUsableCoordinate(from) || !isUsableCoordinate(to)) {
    return [];
  }

  if (mode === "foot") {
    const [foot, street] = await Promise.all([
      requestRoutes(from, to, "foot", alternatives),
      requestRoutes(from, to, "car", alternatives),
    ]);

    return walkingChoices(foot, street, alternatives ? MAX_CHOICES : 1);
  }

  return requestRoutes(from, to, mode, alternatives);
}

async function requestRoutes(
  from: Coordinates,
  to: Coordinates,
  mode: RouteMode,
  alternatives: boolean,
): Promise<RoadRoute[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(routeUrl(from, to, mode, { alternatives }), {
      signal: controller.signal,
    });

    if (!response.ok) {
      return [];
    }

    return parseRoadRoutes(await response.json());
  } catch {
    // Offline, aborted, or a body that was not JSON. All the same to the caller.
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** The router's best and two alternatives — what the card has room to list. */
const MAX_CHOICES = 3;

/** 5 km/h, the foot profile's own pace, for when the foot router gave nothing to measure. */
const WALKING_METERS_PER_SECOND = 5_000 / 3_600;

/**
 * Walking routes, shortest first, from the foot graph **and** the road graph.
 *
 * The foot router is not always the shorter answer. Between Koteshwor and
 * Putalisadak it walks 5.8 km while the car router's road is 5.5 km — the foot
 * profile weighs some main roads down, and on a Kathmandu street a person can
 * walk anywhere a car can drive. So the road routes are re-timed at the
 * walker's pace and put in the same list, and the list is ordered by length:
 * on foot, shorter *is* faster, which the router's own first pick is not always
 * (it answered 6.4 km first with 6.3 km second).
 *
 * Two routes within 1% (or 25 m) of each other are the same walk drawn twice;
 * the first, shorter one stays.
 */
export function walkingChoices(
  foot: RoadRoute[],
  street: RoadRoute[],
  limit = MAX_CHOICES,
): RoadRoute[] {
  const sample = foot.find((route) => route.durationSeconds > 0);
  const pace = sample ? sample.distanceMeters / sample.durationSeconds : WALKING_METERS_PER_SECOND;
  const candidates = [...foot, ...street.map((route) => onFoot(route, pace))].sort(
    (a, b) => a.distanceMeters - b.distanceMeters,
  );
  const kept: RoadRoute[] = [];

  for (const route of candidates) {
    const same = kept.some(
      (other) =>
        Math.abs(other.distanceMeters - route.distanceMeters) <=
        Math.max(25, other.distanceMeters * 0.01),
    );

    if (!same) {
      kept.push(route);
    }

    if (kept.length === limit) {
      break;
    }
  }

  return kept;
}

/** A road route, walked: the same line and turns, timed at `pace` metres a second. */
function onFoot(route: RoadRoute, pace: number): RoadRoute {
  return {
    ...route,
    durationSeconds: Math.round(route.distanceMeters / pace),
    ...(route.steps
      ? {
          steps: route.steps.map((step) => ({
            ...step,
            durationSeconds: Math.round(step.distanceMeters / pace),
          })),
        }
      : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** OSRM's `table` service caps how many points one request may carry. */
const TABLE_CHUNK = 90;

/**
 * Seconds from `origin` to each of `points`, in order, `null` where the router
 * found no way. One `table` request per ninety points — the whole catalogue is
 * one request — and every failure is a row of `null`s, never a throw.
 *
 * On foot the road table is asked as well, for the same reason as
 * `walkingChoices`: the minutes on a pin must be the walk the route then draws,
 * not the foot graph's longer one.
 */
export async function fetchTravelTimes(
  origin: Coordinates,
  points: Coordinates[],
  mode: RouteMode,
): Promise<(number | null)[]> {
  if (mode === "foot") {
    const [foot, street] = await Promise.all([
      fetchTable(origin, points, "foot"),
      fetchTable(origin, points, "car"),
    ]);

    return foot.map((walk, index) => walkingSeconds(walk, street[index]));
  }

  return (await fetchTable(origin, points, mode)).map((cell) => cell.seconds);
}

/** One destination's answer from a `table` request. */
export type TableCell = { meters: number | null; seconds: number | null };

/**
 * The walk to one destination: the foot graph's time, or the road's length at
 * that walker's pace, whichever is shorter. `null` only when neither answered.
 */
export function walkingSeconds(walk: TableCell, street: TableCell | undefined): number | null {
  const pace = walk.seconds && walk.meters ? walk.meters / walk.seconds : WALKING_METERS_PER_SECOND;
  const byRoad = street?.meters ? Math.round(street.meters / pace) : null;

  if (walk.seconds === null) {
    return byRoad;
  }

  return byRoad === null ? walk.seconds : Math.min(walk.seconds, byRoad);
}

async function fetchTable(
  origin: Coordinates,
  points: Coordinates[],
  mode: RouteMode,
): Promise<TableCell[]> {
  const base = ROUTERS[mode].replace("/route/v1/", "/table/v1/");
  const chunks: Coordinates[][] = [];

  for (let i = 0; i < points.length; i += TABLE_CHUNK) {
    chunks.push(points.slice(i, i + TABLE_CHUNK));
  }

  const nothing = (chunk: Coordinates[]) => chunk.map(() => ({ meters: null, seconds: null }));

  const answers = await Promise.all(
    chunks.map(async (chunk) => {
      const coords = [origin, ...chunk].map((point) => `${point.lng},${point.lat}`).join(";");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

      try {
        const response = await fetch(`${base}/${coords}?sources=0&annotations=duration,distance`, {
          signal: controller.signal,
        });

        if (!response.ok) {
          return nothing(chunk);
        }

        const payload: unknown = await response.json();
        const seconds = parseTravelTimes(payload, chunk.length);
        const meters = parseTableRow(payload, "distances", chunk.length);

        return chunk.map((_, index) => ({ meters: meters[index], seconds: seconds[index] }));
      } catch {
        return nothing(chunk);
      } finally {
        clearTimeout(timer);
      }
    }),
  );

  return answers.flat();
}

/** The source row of a `table` reply, minus the origin's own zero. */
export function parseTravelTimes(payload: unknown, count: number): (number | null)[] {
  return parseTableRow(payload, "durations", count);
}

function parseTableRow(
  payload: unknown,
  key: "distances" | "durations",
  count: number,
): (number | null)[] {
  const rows = isRecord(payload) && payload.code === "Ok" ? payload[key] : null;
  const row = Array.isArray(rows) ? rows[0] : null;

  return Array.from({ length: count }, (_, index) => {
    const value = Array.isArray(row) ? row[index + 1] : null;

    return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null;
  });
}
