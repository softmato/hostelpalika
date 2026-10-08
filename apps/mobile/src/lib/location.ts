import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Location from "expo-location";

import type { Coordinates } from "@/lib/geo";
import { isUsableCoordinate } from "@/lib/geo";

/**
 * The device's position, asked for once, held nowhere.
 *
 * ## Asked at most once, then never unprompted again
 *
 * The home screen's Nearby row fills itself, so this *is* reached without a tap
 * — but only under two conditions, and the pair is the whole policy:
 *
 * - **Permission already granted** → read the position silently. No dialogue can
 *   appear, and the row is populated by the time the screen settles.
 * - **Never asked on this install** → ask once, and record that it happened
 *   (`rememberLocationPrompt`). Every later launch takes the branch above or
 *   nothing at all, so a refusal is respected permanently rather than re-asked
 *   at every app start.
 *
 * That flag is the reason this is not just `hasPermission()`: Android's own
 * `canAskAgain` only turns false after the *second* refusal, so relying on it
 * would show the dialogue again on the next launch to somebody who has already
 * said no. What is stored is a boolean about this app's behaviour — never a
 * position; see below.
 *
 * ## Coarse everywhere except navigation
 *
 * Everything that sorts or measures — the Nearby row, the distance badges, the
 * map's "you are here" dot — takes the one `Accuracy.Low` reading above.
 * Sorting hostels by rough proximity does not need a street-level fix, and
 * asking for one is both a worse dialogue and more than the feature is owed.
 *
 * Turn-by-turn navigation is the single exception, and it is why
 * `ACCESS_FINE_LOCATION` is now requested in `app.json` rather than blocked
 * there. `watchNavigationPosition` at the bottom of this file runs
 * `Accuracy.BestForNavigation` — but only while the reader has pressed Start on
 * a route, and it is torn down when they stop or arrive. A hundred-metre fix
 * cannot tell you which side of a junction you are on, so the feature is not
 * worth building on one; the trade is that the higher accuracy exists for the
 * length of a walk and not a second longer.
 *
 * ## Nothing is stored
 *
 * The coordinate is returned to the caller and lives in that screen's state.
 * It is never dispatched to Redux — `redux-persist` writes Redux to disk, and a
 * lat/lng on disk is a location history. `apps/web` has a test holding
 * attendance pings to the same line; this is the same line.
 */

/** How long to wait for a fix before giving up and leaving the list unsorted. */
const FIX_TIMEOUT_MS = 8_000;

export type LocationOutcome =
  | { coordinates: Coordinates; kind: "granted" }
  /** Refused. `canAskAgain: false` means the prompt is spent — send them to settings. */
  | { canAskAgain: boolean; kind: "denied" }
  /** Permitted, but no fix: services off, indoors, or the timeout above. */
  | { kind: "unavailable" };

/**
 * Whether this install has ever put the location dialogue on screen.
 *
 * AsyncStorage rather than SecureStore or Redux: it is one boolean about what
 * the app has already done, it is not a secret, and it must survive a sign-out
 * — a permission prompt is not something a second account should get to ask
 * again. A read failure returns `true` (as if asked), because the failure mode
 * of guessing wrong in the other direction is prompting somebody repeatedly.
 */
const PROMPTED_KEY = "location.prompted";

export async function hasPromptedForLocation(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(PROMPTED_KEY)) !== null;
  } catch {
    return true;
  }
}

export async function rememberLocationPrompt(): Promise<void> {
  try {
    await AsyncStorage.setItem(PROMPTED_KEY, "1");
  } catch {
    // A screen that cannot record the prompt still works; it just may ask once
    // more on a later launch. Not worth failing the reading over.
  }
}

/** Reads the current grant **without** prompting. */
export async function hasLocationPermission(): Promise<boolean> {
  try {
    const { granted } = await Location.getForegroundPermissionsAsync();

    return granted;
  } catch {
    return false;
  }
}

/**
 * Ask (if needed), then take one reading.
 *
 * Every failure path returns an outcome rather than throwing: the caller is a
 * chip on a screen full of working content, and a rejected promise there turns
 * "we could not find you" into a red error state over the whole list.
 */
export async function requestDeviceLocation(): Promise<LocationOutcome> {
  let permission: Location.LocationPermissionResponse;

  try {
    /*
     * Read the grant before asking for it, and ask only when the answer is not
     * already in hand. `requestForegroundPermissionsAsync` looks like a no-op on
     * an install that has said yes, and it is not: Expo's Android permissions
     * service hands every call straight to `Activity.requestPermissions`, with
     * no check for a permission that is already held, and Android answers that
     * by starting `GrantPermissionsActivity` — which finishes immediately, having
     * put another activity in front of ours and taken the foreground away for a
     * few hundred milliseconds.
     *
     * That is not free. The screens that sort by distance re-read on every focus
     * (`useNearby({ auto: true })` in `public-home` and `map`), so the old code
     * bounced the foreground once per visit to either screen, and every bounce is
     * a window in which React Native's current activity is unavailable. Anything
     * Fabric preallocates in that window is built without an activity, and
     * `expo-image`'s view wants one in its constructor: it throws
     * `MissingActivity`, expo-modules-core logs it and substitutes a permanent
     * `ErrorGroupView`, and that `<Image>` stays blank for as long as it is
     * mounted. Not asking a question we know the answer to closes the window.
     */
    permission = await Location.getForegroundPermissionsAsync();

    if (!permission.granted && permission.canAskAgain) {
      permission = await Location.requestForegroundPermissionsAsync();
    }
  } catch {
    return { kind: "unavailable" };
  }

  if (!permission.granted) {
    return { canAskAgain: permission.canAskAgain, kind: "denied" };
  }

  return readPosition();
}

async function readPosition(): Promise<LocationOutcome> {
  try {
    /*
     * The last known fix first: it is instant, it is usually minutes old at
     * worst, and for sorting hostels by kilometres a slightly stale position is
     * indistinguishable from a fresh one. A cold GPS lock can take 30 seconds
     * indoors, which is 30 seconds of a spinner on a list that was already
     * usable.
     */
    const cached = await Location.getLastKnownPositionAsync({ maxAge: 5 * 60 * 1000 });

    if (cached && isUsableCoordinate(toCoordinates(cached))) {
      return { coordinates: toCoordinates(cached), kind: "granted" };
    }

    const fresh = await withTimeout(
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Low }),
      FIX_TIMEOUT_MS,
    );

    if (!fresh) {
      return { kind: "unavailable" };
    }

    const coordinates = toCoordinates(fresh);

    return isUsableCoordinate(coordinates)
      ? { coordinates, kind: "granted" }
      : { kind: "unavailable" };
  } catch {
    // Location services switched off at the OS level lands here.
    return { kind: "unavailable" };
  }
}

/**
 * One fix from the navigation watcher.
 *
 * Three fields beyond the coordinate, because guidance needs all three and
 * asking for them twice is a second subscription:
 *
 * - `accuracyMeters` draws the honest circle around the arrow (§D.3). Without
 *   it, a 30 m fix looks like a lie rather than a fix.
 * - `speed` decides which heading to believe — see `chooseHeading` in
 *   `lib/navigation.ts`.
 * - `heading` is course over ground, which is steadier than the compass while
 *   moving and meaningless while standing still.
 *
 * Any of the three can be `null`: not every platform reports them, and Android
 * uses `-1` for "no idea", which is normalised away here so callers never have
 * to know that.
 */
export type NavigationFix = {
  accuracyMeters: number | null;
  coordinates: Coordinates;
  /** Course over ground in degrees clockwise from north, or `null`. */
  heading: number | null;
  /** Metres per second, or `null`. */
  speed: number | null;
  /** When the fix was taken (epoch ms), or `null` for the coarse seed. */
  timestamp: number | null;
};

/**
 * Stream fine-grained fixes for the length of one navigation session.
 *
 * `BestForNavigation` is the most expensive accuracy the platform offers, so
 * the caller owns its lifetime: the returned subscription **must** be
 * `.remove()`d when guidance stops, arrives, or the screen unmounts. A watcher
 * left running is a GPS the reader cannot switch off.
 *
 * `distanceInterval: 5` with `timeInterval: 2000` is the pair that makes the
 * arrow move smoothly without a callback per second while standing still — the
 * platform delivers when either threshold is crossed, and five metres is about
 * two paces of walking.
 *
 * Permission is the caller's problem. This throws if it has not been granted,
 * rather than prompting: the navigation screen needs to tell the difference
 * between refused, blocked and simply no fix, and a helper that quietly asks
 * takes that choice away from it.
 *
 * Fixes with an unusable coordinate are dropped rather than passed on — `0, 0`
 * is in the Gulf of Guinea, and one of those in the middle of a route would
 * read as a reroute across the planet.
 *
 * Nothing here is stored. The fix goes to `onFix` and lives in the caller's
 * state exactly as long as the screen does; see "Nothing is stored" above.
 */
export function watchNavigationPosition(
  onFix: (fix: NavigationFix) => void,
): Promise<Location.LocationSubscription> {
  return Location.watchPositionAsync(
    {
      accuracy: Location.Accuracy.BestForNavigation,
      // Once a second, like every navigation app: the map glides between fixes
      // over the same second (`map-explorer`), so a slower feed moves in steps.
      distanceInterval: 1,
      timeInterval: 1_000,
    },
    (position) => {
      const coordinates = toCoordinates(position);

      if (!isUsableCoordinate(coordinates)) {
        return;
      }

      onFix({
        accuracyMeters: nonNegativeOrNull(position.coords.accuracy),
        coordinates,
        heading: nonNegativeOrNull(position.coords.heading),
        speed: nonNegativeOrNull(position.coords.speed),
        timestamp: position.timestamp,
      });
    },
  );
}

/**
 * Which way the phone is pointing, for as long as navigation runs.
 *
 * The compass is the half of the answer GPS cannot give: standing at a junction
 * deciding which way to walk, course-over-ground is `null` and only the
 * magnetometer knows where the reader is facing. `chooseHeading` in
 * `lib/navigation.ts` decides which of the two to believe at any moment; this
 * only supplies one of them.
 *
 * No new dependency. `expo-location` carries the compass, so `expo-sensors` is
 * not installed and does not need to be.
 *
 * `trueHeading` is preferred and `magHeading` is the fallback, because true
 * north is what the map's tiles are drawn to and magnetic north is several
 * degrees off it — enough to point the arrow down the wrong fork. Android
 * reports `trueHeading: -1` until it has a position to compute the declination
 * from, which is normal for the first seconds of a session rather than a fault.
 *
 * Same contract as the position watcher: the caller owns the subscription and
 * must `.remove()` it, and permission is the caller's problem.
 */
export function watchDeviceHeading(
  onHeading: (degrees: number) => void,
): Promise<Location.LocationSubscription> {
  return Location.watchHeadingAsync(({ magHeading, trueHeading }) => {
    const heading = trueHeading >= 0 ? trueHeading : magHeading;

    if (heading >= 0) {
      onHeading(heading);
    }
  });
}

/**
 * Android reports `-1` for a value it does not have. Zero is kept: it is a real
 * speed (standing still) and a real heading (due north).
 */
function nonNegativeOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && value >= 0 ? value : null;
}

function toCoordinates(position: Location.LocationObject): Coordinates {
  return { lat: position.coords.latitude, lng: position.coords.longitude };
}

/** Resolves `null` on timeout. The underlying request is left to settle alone. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    promise,
    new Promise<null>((resolve) => {
      setTimeout(() => resolve(null), ms);
    }),
  ]);
}
