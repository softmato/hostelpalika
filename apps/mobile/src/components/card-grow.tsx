import { useEffect, useRef, useState } from "react";
import type { View } from "react-native";
import Animated, {
  interpolateColor,
  runOnJS,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

import { MOTION } from "@/constants/motion";
import { useAppTheme } from "@/hooks/use-app-theme";

/**
 * Card → screen (M8): the tapped card grows into the next screen's header.
 *
 * Reanimated's shared-element transitions are still behind a flag on the new
 * architecture, so this is our own, in three moves:
 *
 * 1. `growFrom` measures the source and asks the host to draw a copy over it,
 *    then runs the navigation.
 * 2. The first accented `AppBar` to mount in the next `CLAIM_WINDOW` ms claims
 *    the grow (`claimGrow`), hides itself, measures, and calls `landGrow`.
 * 3. The copy travels to the bar's box, turning brand green and squaring its
 *    top corners on the way, then cross-fades with the real bar.
 *
 * Nobody claims it (the next screen has no accented bar, or took too long to
 * draw one): the copy fades where it is. Reduce-motion: nothing is drawn and
 * the navigation runs as it always did.
 */

type Box = { height: number; width: number; x: number; y: number };

type Host = {
  land: (to: Box, radius: number, reveal: () => void) => void;
  start: (from: Box, radius: number) => boolean;
};

/** Long enough for a heavy screen's first render on a slow phone. */
const CLAIM_WINDOW = 600;

const NOWHERE: Box = { height: 0, width: 0, x: 0, y: 0 };

let host: Host | null = null;
let claimableUntil = 0;

/**
 * Grow `source` into the next screen's header, then `go` there. `radius` is
 * the source's corner radius. Falls straight through to `go` when there is
 * nothing to measure or no host.
 */
export function growFrom(source: View | null, radius: number, go: () => void) {
  if (!source || !host) {
    go();
    return;
  }

  source.measureInWindow((x, y, width, height) => {
    if (host?.start({ height, width, x, y }, radius)) {
      claimableUntil = Date.now() + CLAIM_WINDOW;
    }
    go();
  });
}

/** True once, for the first header that asks while a grow is waiting. */
export function claimGrow() {
  const claimed = Date.now() < claimableUntil;
  claimableUntil = 0;
  return claimed;
}

/** The claiming header's box. `reveal` brings the real header back at the hand-off. */
export function landGrow(header: View | null, radius: number, reveal: () => void) {
  if (!header || !host) {
    reveal();
    return;
  }

  header.measureInWindow((x, y, width, height) => {
    if (host) {
      host.land({ height, width, x, y }, radius, reveal);
    } else {
      reveal();
    }
  });
}

/** The copy, drawn over everything. Mounted once, after the root `Stack`. */
export function CardGrowHost() {
  const { colors } = useAppTheme();
  const reduceMotion = useReducedMotion();
  const [drawn, setDrawn] = useState(false);

  const box = useSharedValue({ from: NOWHERE, fromRadius: 0, to: NOWHERE, toRadius: 0 });
  const progress = useSharedValue(0);
  const opacity = useSharedValue(0);

  const unclaimed = useRef<ReturnType<typeof setTimeout>>(undefined);
  const reveal = useRef<(() => void) | null>(null);

  function handOff() {
    clearTimeout(unclaimed.current);
    reveal.current?.();
    reveal.current = null;
    opacity.set(
      withTiming(0, { duration: MOTION.fast }, (finished) => {
        if (finished) {
          runOnJS(setDrawn)(false);
        }
      }),
    );
  }

  function start(from: Box, fromRadius: number) {
    if (reduceMotion) {
      return false;
    }

    // A second tap before the first landed: let the first header show.
    handOff();
    box.set({ from, fromRadius, to: from, toRadius: fromRadius });
    progress.set(0);
    opacity.set(withTiming(1, { duration: MOTION.fast }));
    setDrawn(true);
    unclaimed.current = setTimeout(handOff, CLAIM_WINDOW + MOTION.fast);
    return true;
  }

  function land(to: Box, toRadius: number, show: () => void) {
    clearTimeout(unclaimed.current);
    reveal.current = show;
    box.set({ ...box.get(), to, toRadius });
    progress.set(
      withTiming(1, MOTION.grow, (finished) => {
        if (finished) {
          runOnJS(handOff)();
        }
      }),
    );
  }

  useEffect(() => {
    host = { land, start };
    return () => {
      host = null;
    };
  });

  const style = useAnimatedStyle(() => {
    const { from, fromRadius, to, toRadius } = box.get();
    const p = progress.get();
    const at = (a: number, b: number) => a + (b - a) * p;

    return {
      backgroundColor: interpolateColor(p, [0, 1], [colors.brandSoft, colors.primary]),
      // The header is a painted block: square on top, rounded underneath.
      borderBottomLeftRadius: at(fromRadius, toRadius),
      borderBottomRightRadius: at(fromRadius, toRadius),
      borderTopLeftRadius: at(fromRadius, 0),
      borderTopRightRadius: at(fromRadius, 0),
      height: at(from.height, to.height),
      left: at(from.x, to.x),
      opacity: opacity.get(),
      top: at(from.y, to.y),
      width: at(from.width, to.width),
    };
  });

  return drawn ? (
    <Animated.View pointerEvents="none" style={[{ position: "absolute" }, style]} />
  ) : null;
}
