import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import { type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { StyleSheet, useWindowDimensions, View } from "react-native";
import Animated, {
  runOnJS,
  useAnimatedReaction,
  useAnimatedStyle,
  useDerivedValue,
  useFrameCallback,
  useReducedMotion,
  useSharedValue,
} from "react-native-reanimated";
import { captureRef, releaseCapture } from "react-native-view-shot";

import { useAppTheme } from "@/hooks/use-app-theme";
import { getActiveHostelId, subscribeActiveHostel } from "@/lib/active-hostel";

const BAND = 220;
const DURATION = 650;
/**
 * The longest frame the wipe moves by. Mounting the new branch stalls the UI
 * thread for up to 2 s on a budget phone; a clock-timed line that began under
 * it was over before the screen moved again (screen recording, 2026-11-17).
 * Capped per frame, a stall pauses the line instead.
 */
const MAX_STEP = 1000 / 30;

/** Registered by the mounted sweep: photographs the screen, resolves once the photo can cover it. */
let photograph: (() => Promise<void>) | null = null;
/** A slow capture never holds the switch longer than this; the line then runs alone. */
const PHOTO_CAP_MS = 400;

let photo: Promise<void> | null = null;

/**
 * Photographs the screen as it is now. The chip's press-in calls it, so the
 * photo is ready by the time a branch is picked — taken at the pick it held
 * the switch ~0.6 s (device timing, 2026-11-17).
 */
export function photographBranch() {
  photo = photograph?.() ?? Promise.resolve();
}

/** The warm step of a switch (`setActiveHostelId`): the new branch lands under that photo. */
export function branchPhoto() {
  if (!photo) photographBranch();

  return Promise.race([photo, new Promise<void>((resolve) => setTimeout(resolve, PHOTO_CAP_MS))]);
}

/**
 * The branch swap, as one wipe. The pick photographs the branch being left;
 * the data swaps under that photo in one commit, and one glowing line runs
 * down, peeling the photo away — new branch above the line, old below. Nothing
 * loops while it waits: a repeating line read as "again and again", and one
 * passing over unchanged data read as nothing at all (owner, 2026-11-17).
 * Touches pass through.
 */
export function BranchSweep({ children }: { children: ReactNode }) {
  const { colors } = useAppTheme();
  const reduceMotion = useReducedMotion();
  const landed = useSyncExternalStore(subscribeActiveHostel, getActiveHostelId, getActiveHostelId);
  const landedRef = useRef(landed);
  const screen = useRef<View>(null);
  /** The branch being left, as a photo, and which hostel it shows. */
  const [shot, setShot] = useState<{ from: string | null; uri: string } | null>(null);
  /** Resolves `photograph` once the photo is decoded. */
  const decoded = useRef<(() => void) | null>(null);
  // The window, not onLayout: a layout that never reported parked the line on screen at 0.
  const { height } = useWindowDimensions();
  /** 0 → 1 down the screen; parked below it at 1. */
  const progress = useSharedValue(1);

  useEffect(() => {
    if (reduceMotion) return;
    photograph = () =>
      new Promise<void>((resolve) => {
        const from = landedRef.current;
        captureRef(screen, { format: "jpg", quality: 0.9, result: "tmpfile" })
          .then((uri) => {
            // Too late: the switch already landed without it.
            if (landedRef.current !== from) {
              releaseCapture(uri);
              resolve();
              return;
            }
            decoded.current = resolve;
            progress.set(0);
            setShot({ from, uri });
          })
          .catch(() => resolve());
      });

    return () => {
      photograph = null;
    };
  }, [reduceMotion, progress]);

  useEffect(() => {
    if (!shot) return;
    const { uri } = shot;

    return () => releaseCapture(uri);
  }, [shot]);

  const frame = useFrameCallback(({ timeSincePreviousFrame }) => {
    progress.set(
      Math.min(progress.get() + Math.min(timeSincePreviousFrame ?? 0, MAX_STEP) / DURATION, 1),
    );
  }, false);

  const finish = () => {
    frame.setActive(false);
    setShot(null);
  };
  useAnimatedReaction(
    () => progress.value >= 1,
    (parked, was) => {
      if (parked && was === false) runOnJS(finish)();
    },
  );

  useEffect(() => {
    if (landedRef.current === landed) return;
    landedRef.current = landed;
    photo = null;
    if (reduceMotion) return;
    progress.set(0);
    frame.setActive(true);
  }, [landed, reduceMotion, frame, progress]);

  /** Where the old branch ends: from just above the screen to just below it, cubic in-out. */
  const edge = useDerivedValue(() => {
    const p = progress.value;
    const eased = p < 0.5 ? 4 * p ** 3 : 1 - (2 - 2 * p) ** 3 / 2;

    return -BAND / 2 + (height + BAND) * eased;
  });
  const lineStyle = useAnimatedStyle(() => ({ transform: [{ translateY: edge.value - BAND / 2 }] }));
  const coverStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: Math.max(edge.value, 0) }],
  }));
  const photoStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: -Math.max(edge.value, 0) }],
  }));

  // Flips in the very commit that swaps the data, so the new branch never shows uncovered.
  const covering = shot !== null && shot.from !== landed;

  return (
    <View
      collapsable={false}
      ref={screen}
      style={{ flex: 1 }}
    >
      {children}
      {shot ? (
        // Mounted (unseen) from the pick, so the photo is decoded before it is needed.
        <Animated.View
          pointerEvents="none"
          style={[StyleSheet.absoluteFill, { opacity: covering ? 1 : 0, overflow: "hidden" }, coverStyle]}
        >
          <Animated.View style={[StyleSheet.absoluteFill, photoStyle]}>
            <Image
              cachePolicy="none"
              contentFit="fill"
              onLoad={() => {
                decoded.current?.();
                decoded.current = null;
              }}
              source={{ uri: shot.uri }}
              style={{ flex: 1 }}
            />
          </Animated.View>
        </Animated.View>
      ) : null}
      <Animated.View
        pointerEvents="none"
        style={[{ height: BAND, left: 0, position: "absolute", right: 0, top: 0 }, lineStyle]}
      >
        <LinearGradient
          colors={[
            `${colors.primary}00`,
            `${colors.primary}40`,
            "rgba(255,255,255,0.98)",
            `${colors.primary}40`,
            `${colors.primary}00`,
          ]}
          locations={[0, 0.42, 0.5, 0.58, 1]}
          style={{ flex: 1 }}
        />
      </Animated.View>
    </View>
  );
}
