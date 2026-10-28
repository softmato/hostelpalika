import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Linking } from "react-native";

import { type Coordinates, haversineMeters } from "@/lib/geo";
import {
  hasLocationPermission,
  hasPromptedForLocation,
  rememberLocationPrompt,
  requestDeviceLocation,
} from "@/lib/location";
import { toastError, toastInfo } from "@/lib/toast";

/**
 * "Near me", as a piece of screen state.
 *
 * Owns the permission dance and the one reading, and nothing else — the sorting
 * itself is `sortByDistance` in `lib/geo.ts`, which is pure and tested.
 *
 * ## The coordinate never reaches the disk
 *
 * It is memory, not Redux. Redux is persisted by `redux-persist`, so a
 * coordinate dispatched into it would be written to the device's disk and kept
 * across launches — that is a location history, not a sort key. The last fix is
 * held for this run of the app (`lastFix`), so a remount paints sorted at once;
 * closing the app forgets it.
 *
 * ## Every failure keeps the screen working
 *
 * Denied, blocked, services off, no fix in eight seconds: all of them turn the
 * toggle back off and leave the list exactly as the server sorted it, with a
 * message saying why. The one thing this must never do is leave a spinner on a
 * list that was already usable.
 *
 * ## `auto`, and why it is not simply "ask on mount"
 *
 * The home screen's Nearby row asked the reader to press a button before it
 * would show anything, which meant the section was empty for everybody who did
 * not — a heading, a paragraph and a button where the design has hostels. With
 * `auto` the row fills itself instead, under the policy in `lib/location.ts`:
 * silently when permission is already granted, and with **one** dialogue on an
 * install that has never seen it. A refusal is remembered, so this cannot become
 * a prompt at every app start; the button stays for anyone who changes their
 * mind, and `blocked` still points at Settings.
 *
 * The automatic attempt is **silent**: it raises no toast. A toast is a reply to
 * something the reader did, and nobody did anything here — the section says what
 * happened in its own words, in place.
 *
 * ## And it re-reads on every focus, because a distance goes stale
 *
 * A position taken when the screen first mounted is the distance from wherever
 * the phone was that morning. So an `auto` screen refreshes on each focus —
 * `getLastKnownPositionAsync` first, so the usual cost is no fix at all — and
 * the refresh **keeps the coordinates it has** until a new one arrives: status
 * never drops back to `locating` once it is `ready`, or the row would flash a
 * skeleton every time the reader came back from a hostel page.
 */

export type NearbyStatus =
  | "idle"
  /** Asking, or waiting on a fix. */
  | "locating"
  /** Sorted by distance. */
  | "ready"
  /** Refused, but the prompt still works next time. */
  | "denied"
  /** Refused permanently — only the system settings screen can undo it. */
  | "blocked"
  /** Allowed, but no position: services off, or the fix timed out. */
  | "unavailable";

/** Below this, a second reading keeps the first — see `refresh`. */
const REFRESH_MOVE_METERS = 50;

/*
 * The last fix, in memory for this run of the app — never on disk, so the
 * "never saved" promise holds. It is what lets Home come back from a hostel page
 * or a tab change with the Nearby row already sorted, instead of locating again
 * from nothing on every mount.
 */
let lastFix: Coordinates | null = null;

export function useNearby({ auto = false }: { auto?: boolean } = {}) {
  const [coordinates, setCoordinatesState] = useState<Coordinates | null>(lastFix);
  // An `auto` screen is about to locate: a skeleton, not the "turn it on" card
  // flashing for the frames before the permission check answers.
  const [status, setStatus] = useState<NearbyStatus>(lastFix ? "ready" : auto ? "locating" : "idle");

  const setCoordinates = useCallback(
    (next: Coordinates | null | ((current: Coordinates | null) => Coordinates | null)) => {
      setCoordinatesState((current) => {
        lastFix = typeof next === "function" ? next(current) : next;
        return lastFix;
      });
    },
    [],
  );

  const disable = useCallback(() => {
    setCoordinates(null);
    setStatus("idle");
  }, [setCoordinates]);

  const enable = useCallback(async ({ silent = false } = {}) => {
    // Raised before the first `await`, in the handler, so the spinner is on
    // screen while the system dialogue is up.
    setStatus("locating");

    const outcome = await requestDeviceLocation();

    if (outcome.kind === "granted") {
      setCoordinates(outcome.coordinates);
      setStatus("ready");
      return;
    }

    setCoordinates(null);

    if (outcome.kind === "denied") {
      setStatus(outcome.canAskAgain ? "denied" : "blocked");

      if (silent) {
        return;
      }

      if (outcome.canAskAgain) {
        toastInfo(
          "Location is off",
          "Hostels are still listed cheapest first.",
        );
      } else {
        // Android never shows the prompt again once it has been refused twice,
        // so pointing at settings is the only honest next step.
        toastInfo(
          "Location is blocked",
          "Turn it on in Settings to sort by distance.",
        );
      }

      return;
    }

    setStatus("unavailable");

    if (!silent) {
      toastError(
        "Couldn't find you",
        "Check that location is switched on, then try again.",
      );
    }
  }, [setCoordinates]);

  /**
   * A second reading, with no dialogue and no visible `locating` state.
   *
   * Only ever called when permission is already granted, so `requestDeviceLocation`
   * cannot prompt. A failure is silent and changes nothing: the previous fix is
   * a better answer than no distance at all, and the reader did not ask for this
   * reading in the first place.
   */
  const refresh = useCallback(async () => {
    const outcome = await requestDeviceLocation();

    if (outcome.kind === "granted") {
      /*
       * The same object when the reader has not really moved. This runs on every
       * focus of Home, and a fresh object re-sorted every row and re-rendered the
       * whole page in the middle of the tab change — for a few metres of GPS jitter
       * that changes no distance anybody reads.
       */
      setCoordinates((current) =>
        current && haversineMeters(current, outcome.coordinates) < REFRESH_MOVE_METERS
          ? current
          : outcome.coordinates,
      );
      setStatus("ready");
    }
  }, [setCoordinates]);

  /*
   * Read through a ref so the focus effect below depends only on stable
   * callbacks. With `status` in its dependency list the effect would tear down
   * and re-run on the transition it causes itself — `locating` → `ready` — and
   * take a second reading every time it took one.
   */
  const statusRef = useRef(status);

  // Synced in an effect rather than assigned during render: a ref written while
  // rendering is not safe under concurrent rendering, and the focus effect below
  // reads it from an async callback that runs well after both.
  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useFocusEffect(
    useCallback(() => {
      if (!auto) {
        return;
      }

      let cancelled = false;

      void (async () => {
        if (await hasLocationPermission()) {
          if (cancelled) {
            return;
          }

          // A fix already in hand is refreshed quietly; the first one goes
          // through `enable`, which is what puts the skeleton on screen.
          await (statusRef.current === "ready" ? refresh() : enable({ silent: true }));

          return;
        }

        /*
         * No permission. Ask only on an install that has never been asked, and
         * only if this screen has not already been refused in this session —
         * `denied` and `blocked` both mean the reader has answered.
         *
         * The flag is recorded before the request rather than after, so someone
         * who backgrounds the app while the dialogue is up is not asked again on
         * the way back in.
         */
        // No permission (any more): nothing to sort by, and nothing to wait for.
        const answered = statusRef.current === "denied" || statusRef.current === "blocked";

        if (statusRef.current === "locating" || statusRef.current === "ready") {
          disable();
        }

        if (answered || (await hasPromptedForLocation())) {
          return;
        }

        await rememberLocationPrompt();

        if (!cancelled) {
          await enable({ silent: true });
        }
      })();

      return () => {
        cancelled = true;
      };
    }, [auto, disable, enable, refresh]),
  );

  /** For the "Open settings" action a `blocked` state offers. */
  const openSettings = useCallback(() => {
    void Linking.openSettings();
  }, []);

  return {
    coordinates,
    disable,
    enable,
    /** Re-reads the position without a dialogue. Granted permission only. */
    refresh,
    /** True while sorting is actually in effect. */
    isActive: status === "ready" && coordinates !== null,
    isBusy: status === "locating",
    openSettings,
    status,
  };
}
