/**
 * The arithmetic behind turn-by-turn guidance.
 *
 * Everything in this file is pure and tested, and that is the point of the
 * file existing at all. Guidance is made of the kind of small calculations that
 * look right and are quietly wrong — a heading that spins the long way round
 * north, an off-route check that fires on a straight road, a distance that
 * counts down to the wrong turning — and none of them can be debugged on a
 * phone while walking. So the judgement lives here, where a test can hold it,
 * and `hooks/use-guidance.ts` is left holding only subscriptions and state.
 *
 * Angles are degrees clockwise from north, in `[0, 360)`, matching both the
 * compass and OSRM. Distances are metres.
 */

import type { Coordinates } from "@/lib/geo";
import { haversineMeters } from "@/lib/geo";
import type { RouteMode, RouteStep } from "@/lib/routing";

/** Above this speed, course over ground beats the magnetometer. Metres/second. */
const GPS_HEADING_MIN_SPEED = 1.5;

/**
 * How far off the line counts as off the route, per mode.
 *
 * Generous on purpose. A GPS fix in a street canyon is routinely twenty metres
 * out with the phone sitting still, and a reader walking a pavement is a good
 * five metres off the centreline OSM drew. Reroute on those and the app spends
 * the whole walk re-planning a route the reader is already following, which is
 * both unusable and a request per fix to somebody else's free server.
 *
 * Cars get more slack than feet because roads are wider than the line through
 * them and because sixty metres passes in three seconds at speed.
 */
const OFF_ROUTE_METERS: Record<RouteMode, number> = { car: 60, foot: 40 };

/**
 * Close enough to be there.
 *
 * Thirty metres is about the width of a forecourt, and it is inside the error
 * of a city fix — holding out for ten would leave the card counting down "20 m"
 * while the reader stands at the door.
 */
const ARRIVAL_METERS = 30;

/** Metres in one degree of latitude: the haversine earth radius × π/180. */
const METERS_PER_DEGREE_LAT = 111_194.9;

/** Degrees into `[0, 360)`. `-90` is `270`; `450` is `90`. */
export function normaliseHeading(degrees: number): number {
  return ((degrees % 360) + 360) % 360;
}

/**
 * Which of the two headings to believe right now.
 *
 * Neither source is good on its own. The compass knows which way the phone is
 * pointing while the reader stands at a junction and turns on the spot — GPS
 * course is `null` there, because nothing is moving — but it sits next to a
 * speaker magnet and a metal-cased phone, and indoors it can be tens of degrees
 * out. Course over ground has no such problem while actually moving, and is
 * meaningless below walking pace, where it becomes the direction of the last
 * bit of GPS noise.
 *
 * So: above roughly 1.5 m/s (a brisk walk) trust the GPS course, otherwise
 * trust the compass, and fall back to whichever exists. Google fuses the two
 * with rather more machinery; this is the cheap version of the same idea, and
 * being cheap is why it can be tested.
 */
export function chooseHeading({
  compass,
  gpsHeading,
  route = null,
  speed,
}: {
  compass: number | null;
  gpsHeading: number | null;
  /**
   * Which way the road runs where the reader is (`bearingAlong`). The last
   * resort, for a phone with no magnetometer standing still: the arrow and
   * the map still face along the road, which is what Google's snapped puck does.
   */
  route?: number | null;
  speed: number | null;
}): number | null {
  const moving = speed !== null && speed >= GPS_HEADING_MIN_SPEED;

  if (moving && gpsHeading !== null) {
    return normaliseHeading(gpsHeading);
  }

  if (compass !== null) {
    return normaliseHeading(compass);
  }

  if (route !== null) {
    return normaliseHeading(route);
  }

  return gpsHeading === null ? null : normaliseHeading(gpsHeading);
}

/**
 * The bearing of the route segment nearest the reader, `null` for a line with
 * no length. Same flat projection as `distanceToPath`.
 */
export function bearingAlong(points: Coordinates[], point: Coordinates): number | null {
  let best = Number.POSITIVE_INFINITY;
  let bearing: number | null = null;

  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i];
    const b = points[i + 1];

    if (a.lat === b.lat && a.lng === b.lng) {
      continue;
    }

    const { distance } = projectOntoSegment(point, a, b);

    if (distance < best) {
      best = distance;
      const east = (b.lng - a.lng) * Math.cos((a.lat * Math.PI) / 180);
      const north = b.lat - a.lat;
      bearing = normaliseHeading((Math.atan2(east, north) * 180) / Math.PI);
    }
  }

  return bearing;
}

/**
 * How far apart two headings are, the short way round: 0 to 180.
 *
 * The same wrap as `smoothHeading`, exported rather than written out a second
 * time — `map-explorer` needs it to decide whether a compass sample is worth an
 * injection, and two copies of an angle wrap is how the signs drift apart.
 */
export function headingDifference(a: number, b: number): number {
  return Math.abs(((normaliseHeading(b) - normaliseHeading(a) + 540) % 360) - 180);
}

/**
 * A low-pass filter for the heading — the thing that stops the map twitching.
 *
 * Raw compass samples jitter by several degrees at rest, and a map rotated
 * straight from them shivers. Easing each sample towards the last fixes that,
 * but only if the interpolation goes **the short way round**: 359° to 1° is two
 * degrees clockwise, and a filter that treats those as numbers walks the whole
 * 358° backwards instead, spinning the map a full turn every time the reader
 * crosses north.
 *
 * `alpha` is how much of the new sample to take, 0 to 1. Around 0.2 is smooth
 * without feeling laggy. With no previous heading the new one is taken whole —
 * easing in from an arbitrary zero would sweep the map across the compass on
 * the first sample of every session.
 */
export function smoothHeading(
  previous: number | null,
  next: number,
  alpha: number,
): number {
  if (previous === null) {
    return normaliseHeading(next);
  }

  const weight = Math.min(1, Math.max(0, alpha));
  // Signed shortest angle from `previous` to `next`, in (-180, 180].
  const delta = ((normaliseHeading(next) - normaliseHeading(previous) + 540) % 360) - 180;

  return normaliseHeading(normaliseHeading(previous) + delta * weight);
}

/** The eight points of the compass, clockwise from north. */
const CARDINALS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;

/**
 * Which way that heading faces, in words.
 *
 * Eight points rather than sixteen: "NNE" is more precision than a magnetometer
 * in a phone deserves, and more than anyone reads off a 44dp button. Each point
 * owns 45 degrees centred on itself, so north runs from 337.5 round to 22.5 —
 * hence the half-sector offset before the divide, which is the part that is
 * easy to get wrong and reads as a compass that lags by an eighth of a turn.
 */
export function cardinalFor(degrees: number): (typeof CARDINALS)[number] {
  const sector = Math.round(normaliseHeading(degrees) / 45) % CARDINALS.length;

  return CARDINALS[sector];
}

/**
 * How far to the next maneuver, as the card says it.
 *
 * Not `formatDistance` from `hostel-display.ts`, which rounds to the nearest
 * 50 m — right for "how far away is this hostel", wrong for a countdown, where
 * it would tick 150, 100, 50 and then straight to the turn. Ten-metre steps
 * near a junction are the difference between the turning in front of you and
 * the one after it.
 *
 * Under twenty metres it stops counting and says "Now": the fix is not accurate
 * enough to justify "In 10 m", and by the time the reader has read it they are
 * at the turn anyway.
 */
export function formatManeuverDistance(meters: number): string {
  // Not "Now": a distance that is not a number is not a turn you are standing
  // at, and sending somebody round a corner on a NaN is worse than admitting it.
  if (!Number.isFinite(meters)) {
    return "—";
  }

  if (meters < 20) {
    return "Now";
  }

  if (meters < 1_000) {
    return `In ${Math.round(meters / 10) * 10} m`;
  }

  return `In ${(Math.round(meters / 100) / 10).toFixed(1)} km`;
}

/**
 * The maneuver, in words.
 *
 * Two rules the captured OSRM reply forced, both in `routing.test.ts`:
 *
 * - **The street name is appended only when there is one.** Twenty of the
 *   thirty-four steps on that walk came back with `name: ""`, because much of
 *   Kathmandu is unnamed in OSM. "Turn right onto " is a bug the reader can see.
 * - **Maneuver types contain spaces** — `end of road`, `new name`, `on ramp`.
 *   Matching on `endOfRoad` silently falls through to the default on a real
 *   route, which is how a turn becomes "Continue straight" at a junction.
 *
 * British spelling and sentence case, matching the rest of the app's copy: slip
 * road rather than ramp, and one capital at the front rather than Title Case.
 * Nothing here is punctuated — the card sets these in a heading, and a full stop
 * in a heading reads as a typo.
 */
export function instructionFor(step: RouteStep): string {
  const { exit, modifier, type } = step.maneuver;
  const name = step.name.trim();
  const onto = name ? ` onto ${name}` : "";
  const along = name ? ` along ${name}` : "";
  const direction = directionWord(modifier);

  switch (type) {
    case "arrive":
      return "You have arrived";

    case "depart":
      return `Set off${along}`;

    case "roundabout":
    case "rotary":
      return exit === undefined
        ? `Enter the roundabout${onto}`
        : `Take the ${ordinal(exit)} exit${onto}`;

    case "exit roundabout":
    case "exit rotary":
      return `Leave the roundabout${onto}`;

    case "fork":
      // "Keep left", not "Turn left": a fork is a choice of lane at speed, and
      // "turn" sends people across the carriageway looking for a junction.
      return direction === null || direction === "straight"
        ? `Keep straight on${onto}`
        : `Keep ${direction}${onto}`;

    case "merge":
      return direction === null || direction === "straight"
        ? `Merge${onto}`
        : `Merge ${direction}${onto}`;

    case "on ramp":
      return `Take the slip road${onto}`;

    case "off ramp":
      return `Take the exit${onto}`;

    case "end of road":
      return direction === null || direction === "straight"
        ? `Continue straight${onto}`
        : `Turn ${direction} at the end of the road${onto}`;

    case "new name":
      // The road changed name under the reader's feet; there is no turn to make.
      return name ? `Continue onto ${name}` : "Continue straight";

    case "continue":
      return `Continue ${direction ?? "straight"}${along}`;

    default:
      return `${turnPhrase(modifier, direction)}${onto}`;
  }
}

/**
 * `slight right` → `slightly right`, and `uturn` → `null` because it is not a
 * direction you can put after "Turn". Unknown modifiers also come back `null`:
 * OSRM adds to this list, and "Turn sharp-ish left" is worse than "Continue
 * straight".
 */
function directionWord(modifier: string | undefined): string | null {
  switch (modifier) {
    case "left":
    case "right":
    case "sharp left":
    case "sharp right":
    case "straight":
      return modifier;
    case "slight left":
      return "slightly left";
    case "slight right":
      return "slightly right";
    default:
      return null;
  }
}

function turnPhrase(modifier: string | undefined, direction: string | null): string {
  if (modifier === "uturn") {
    return "Make a U-turn";
  }

  // No modifier, or one this app does not know: say the safe thing rather than
  // guess a direction. Being vague costs a glance at the map; being wrong costs
  // a wrong turn.
  return direction === null || direction === "straight"
    ? "Continue straight"
    : `Turn ${direction}`;
}

/** 1st, 2nd, 3rd, 4th… including the 11th/12th/13th exceptions. */
function ordinal(value: number): string {
  const n = Math.abs(Math.round(value));
  const tens = n % 100;

  if (tens >= 11 && tens <= 13) {
    return `${n}th`;
  }

  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

/**
 * Point-to-**segment** distance, in metres.
 *
 * Segment, not vertex, and that is the whole reason this is a function rather
 * than a `Math.min` over `haversineMeters`. OSRM returns a straight kilometre of
 * road as two points a kilometre apart; measured to the nearest *vertex*, a
 * reader standing squarely in the middle of that road is five hundred metres
 * from the route and every off-route check fires.
 *
 * The arithmetic is a flat local projection rather than spherical trigonometry:
 * over the few kilometres of a hostel route the error is centimetres, and the
 * alternative is cross-track formulae that are hard to read and harder to test.
 */
export function distanceToPath(point: Coordinates, points: Coordinates[]): number {
  if (points.length === 0) {
    return Number.POSITIVE_INFINITY;
  }

  if (points.length === 1) {
    return haversineMeters(point, points[0]);
  }

  let nearest = Number.POSITIVE_INFINITY;

  for (let i = 0; i < points.length - 1; i += 1) {
    nearest = Math.min(nearest, projectOntoSegment(point, points[i], points[i + 1]).distance);
  }

  return nearest;
}

/**
 * Metres still to travel to the end of the line.
 *
 * The remainder of the segment the reader is on, plus every segment after it —
 * so the number falls as they walk and does not jump when they cut a corner.
 * Measured from the *nearest* segment, which is what makes it robust to being a
 * few metres off the line; a route doubling back on itself can pick the wrong
 * one, and that is a known limit rather than a bug worth carrying state for.
 */
export function progressAlong(points: Coordinates[], point: Coordinates): number {
  if (points.length === 0) {
    return 0;
  }

  if (points.length === 1) {
    return haversineMeters(point, points[0]);
  }

  const lengths = points.slice(1).map((next, i) => haversineMeters(points[i], next));

  let best = Number.POSITIVE_INFINITY;
  let remaining = 0;

  for (let i = 0; i < points.length - 1; i += 1) {
    const { distance, t } = projectOntoSegment(point, points[i], points[i + 1]);

    if (distance < best) {
      best = distance;
      remaining =
        (1 - t) * lengths[i] + lengths.slice(i + 1).reduce((sum, length) => sum + length, 0);
    }
  }

  return Math.round(remaining);
}

export type UpcomingStep = {
  /** Metres from here to that maneuver — the number the card counts down. */
  distanceMeters: number;
  index: number;
  step: RouteStep;
};

/**
 * The instruction the reader is walking towards, and how far off it is.
 *
 * The subtlety is which step that is. An OSRM step's maneuver sits at its
 * **start** — step *i* says what to do to get onto the stretch of road that step
 * *i* then describes. So somebody part-way along step *i*'s road has already
 * done its maneuver, and the instruction they need is step *i + 1*'s. Return
 * the nearest maneuver instead and the card announces the turn they took thirty
 * seconds ago.
 *
 * Which stretch they are on is decided by the chords between consecutive
 * maneuvers — nearest chord wins. That is a coarser line than the route
 * geometry, but it is the one whose ends are the maneuvers, so the countdown
 * lands exactly on the turn.
 */
export function nextStep(steps: RouteStep[], point: Coordinates): UpcomingStep | null {
  if (steps.length === 0) {
    return null;
  }

  if (steps.length === 1) {
    return { distanceMeters: haversineMeters(point, steps[0].location), index: 0, step: steps[0] };
  }

  let best = Number.POSITIVE_INFINITY;
  let index = 1;
  let distanceMeters = 0;

  for (let i = 0; i < steps.length - 1; i += 1) {
    const from = steps[i].location;
    const to = steps[i + 1].location;
    const { distance, t } = projectOntoSegment(point, from, to);

    if (distance < best) {
      best = distance;
      index = i + 1;
      distanceMeters = Math.round((1 - t) * haversineMeters(from, to));
    }
  }

  return { distanceMeters, index, step: steps[index] };
}

/** Whether that distance from the line is far enough to be worth re-planning. */
export function isOffRoute(distanceMeters: number, mode: RouteMode): boolean {
  return distanceMeters > OFF_ROUTE_METERS[mode];
}

/** Within thirty metres of the door. */
export function hasArrived(point: Coordinates, destination: Coordinates): boolean {
  return haversineMeters(point, destination) <= ARRIVAL_METERS;
}

/**
 * The nearest point on `a`→`b` to `point`: how far away it is in metres, and how
 * far along the segment it fell, clamped to the ends.
 *
 * Everything is projected onto a flat plane centred on `point` itself, so the
 * longitude scaling is taken at the latitude that matters and the numbers stay
 * small. A zero-length segment (OSRM does emit duplicate points) would divide by
 * zero, so it is answered as the distance to the vertex.
 */
function projectOntoSegment(
  point: Coordinates,
  a: Coordinates,
  b: Coordinates,
): { distance: number; t: number } {
  const scale = Math.cos((point.lat * Math.PI) / 180) * METERS_PER_DEGREE_LAT;
  const toX = (c: Coordinates) => (c.lng - point.lng) * scale;
  const toY = (c: Coordinates) => (c.lat - point.lat) * METERS_PER_DEGREE_LAT;

  const ax = toX(a);
  const ay = toY(a);
  const bx = toX(b);
  const by = toY(b);
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;

  if (lengthSquared === 0) {
    return { distance: haversineMeters(point, a), t: 0 };
  }

  // The point is the origin of this projection, so the dot product is simply
  // the projection of `-a` onto the segment.
  const t = Math.min(1, Math.max(0, (-ax * dx - ay * dy) / lengthSquared));
  const nearestX = ax + t * dx;
  const nearestY = ay + t * dy;

  return { distance: Math.hypot(nearestX, nearestY), t };
}

/**
 * When a maneuver is spoken: once on the approach, once at it.
 *
 * Per mode, because the same 300 m is a minute and a half on foot and half a
 * minute at city speed. Each cue is said once — the caller keeps the keys.
 */
const CUE_METERS: Record<RouteMode, { early: number; now: number }> = {
  car: { early: 400, now: 60 },
  foot: { early: 100, now: 20 },
};

export type SpokenCue = { key: string; text: string };

/** "120 metres", "1.5 kilometres" — rounded the way a voice says them. */
export function spokenDistance(meters: number, mode: RouteMode): string {
  if (meters >= 1_000) {
    return `${(Math.round(meters / 100) / 10).toFixed(1).replace(/\.0$/, "")} kilometres`;
  }

  const unit = mode === "car" && meters >= 200 ? 50 : 10;

  return `${Math.max(unit, Math.round(meters / unit) * unit)} metres`;
}

function lowerFirst(text: string) {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/**
 * What to say about the maneuver ahead, or `null` for silence.
 *
 * The arrival step is special: its approach is "your destination is ahead",
 * and at the door it says nothing, because `hasArrived` ends guidance and the
 * arrival is announced from that.
 */
export function spokenCue(
  upcoming: UpcomingStep,
  mode: RouteMode,
  spoken: ReadonlySet<string>,
): SpokenCue | null {
  const { distanceMeters, step } = upcoming;
  const at = `${step.location.lat},${step.location.lng}`;
  const { early, now } = CUE_METERS[mode];
  const arriving = step.maneuver.type === "arrive";

  if (distanceMeters <= now) {
    const key = `${at}:now`;

    return arriving || spoken.has(key) ? null : { key, text: instructionFor(step) };
  }

  if (distanceMeters <= early) {
    const key = `${at}:early`;

    if (spoken.has(key) || spoken.has(`${at}:now`)) {
      return null;
    }

    const distance = spokenDistance(distanceMeters, mode);

    return {
      key,
      text: arriving
        ? `Your destination is ${distance} ahead`
        : `In ${distance}, ${lowerFirst(instructionFor(step))}`,
    };
  }

  return null;
}

/**
 * The first thing said when guidance starts. When the first maneuver is still
 * beyond its approach cue, it is named now, so Start is never met with silence.
 */
export function startCue(upcoming: UpcomingStep | null, mode: RouteMode, place: string): string {
  const opening = `Starting route to ${place}`;

  if (!upcoming || upcoming.distanceMeters <= CUE_METERS[mode].early) {
    return opening;
  }

  const distance = spokenDistance(upcoming.distanceMeters, mode);
  const next =
    upcoming.step.maneuver.type === "arrive"
      ? `Your destination is in ${distance}`
      : `In ${distance}, ${lowerFirst(instructionFor(upcoming.step))}`;

  return `${opening}. ${next}`;
}

/**
 * The route as a chain of small boxes, `[west, south, east, north]` each — what
 * gets saved for offline. One box around a whole diagonal route would be mostly
 * fields; boxes every `chunkMeters`, padded by `padMeters` either side, keep the
 * download to the streets the reader will actually walk or drive.
 */
export function corridorBoxes(
  points: Coordinates[],
  chunkMeters = 1_500,
  padMeters = 300,
): [number, number, number, number][] {
  const boxes: [number, number, number, number][] = [];
  let chunk: Coordinates[] = [];
  let length = 0;

  const close = () => {
    if (chunk.length === 0) {
      return;
    }

    const lats = chunk.map((point) => point.lat);
    const lngs = chunk.map((point) => point.lng);
    const padLat = padMeters / METERS_PER_DEGREE_LAT;
    const padLng = padLat / Math.cos((lats[0] * Math.PI) / 180);

    boxes.push([
      Math.min(...lngs) - padLng,
      Math.min(...lats) - padLat,
      Math.max(...lngs) + padLng,
      Math.max(...lats) + padLat,
    ]);
  };

  points.forEach((point, index) => {
    if (index > 0) {
      length += haversineMeters(points[index - 1], point);
    }

    chunk.push(point);

    if (length >= chunkMeters) {
      close();
      // The joint belongs to both boxes, so no street falls between them.
      chunk = [point];
      length = 0;
    }
  });

  if (chunk.length > 1 || boxes.length === 0) {
    close();
  }

  return boxes;
}
