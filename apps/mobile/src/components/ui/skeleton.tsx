import { LinearGradient } from "expo-linear-gradient";
import { useEffect } from "react";
import { StyleSheet, View, type ViewStyle } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";

import { MOTION } from "@/constants/motion";
import { useAppTheme } from "@/hooks/use-app-theme";

/**
 * The shape of the content, with a light band sweeping across, while the content loads.
 *
 * ## When to use this instead of `LoadingState`
 *
 * `LoadingState` is a centred spinner: right when the screen has nothing to
 * show and no idea what shape it will be. A skeleton is right when the layout
 * is already known — a list of invoice rows, a profile header — because it
 * keeps the page from jumping when the data lands, and a jump is what makes an
 * app feel slower than it is even when it is faster.
 *
 * Never use it for a refresh. `use-resource.ts` deliberately keeps the previous
 * data on screen while revalidating; swapping a list somebody is reading for
 * grey blocks throws away what they were reading to tell them nothing.
 *
 * ## On the UI thread
 *
 * The sweep is a Reanimated shared value, so it keeps animating while JS is
 * busy parsing the very response it is waiting for. An `Animated.loop` from
 * React Native's own API stalls exactly then — a loading indicator that freezes
 * during the load is worse than no indicator.
 */

export function Skeleton({
  className = "",
  height = 16,
  radius = 8,
  width,
}: {
  className?: string;
  /** Points, or `"100%"` to cover a box whose size only the layout knows (a loading map). */
  height?: ViewStyle["height"];
  radius?: number;
  /** Omit to fill the parent — the usual case inside a column. */
  width?: ViewStyle["width"];
}) {
  const { isDark } = useAppTheme();
  const sweep = useSharedValue(0);
  const span = useSharedValue(0);

  useEffect(() => {
    // -1 repeats forever, no reverse: the band always travels left to right.
    sweep.value = withRepeat(
      withTiming(1, { duration: MOTION.shimmer, easing: Easing.inOut(Easing.quad), reduceMotion: ReduceMotion.System }),
      -1,
      false,
    );
    // An uncancelled loop outlives the view and keeps writing to a dead tag
    // every frame — Reanimated logs a full stack trace for each one.
    return () => cancelAnimation(sweep);
  }, [sweep]);

  const band = useAnimatedStyle(() => ({
    transform: [{ translateX: (sweep.value * 2 - 1) * span.value }],
  }));
  const light = isDark ? "rgba(255,255,255,0.07)" : "rgba(255,255,255,0.6)";

  return (
    <View
      // `accessibilityElementsHidden`/`importantForAccessibility` keep a screen
      // reader from announcing a column of meaningless blocks.
      accessibilityElementsHidden
      className={`overflow-hidden bg-muted ${className}`}
      importantForAccessibility="no-hide-descendants"
      onLayout={(event) => {
        span.value = event.nativeEvent.layout.width;
      }}
      style={{ borderRadius: radius, height, width: width ?? "100%" }}
    >
      <Animated.View style={[StyleSheet.absoluteFill, band]}>
        <LinearGradient
          colors={["rgba(255,255,255,0)", light, "rgba(255,255,255,0)"]}
          end={{ x: 1, y: 0.5 }}
          start={{ x: 0, y: 0.5 }}
          style={StyleSheet.absoluteFill}
        />
      </Animated.View>
    </View>
  );
}

/** A few lines of body text. The last one is short, the way real text is. */
export function SkeletonText({
  className = "",
  lines = 3,
}: {
  className?: string;
  lines?: number;
}) {
  return (
    <View className={`gap-2 ${className}`}>
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton
          height={12}
          key={index}
          width={index === lines - 1 ? "60%" : "100%"}
        />
      ))}
    </View>
  );
}

/**
 * The placeholder for a `Card` of rows — the shape most lists in this app load
 * into.
 */
export function SkeletonCard({ rows = 3 }: { rows?: number }) {
  return (
    <View className="gap-3 rounded-2xl border border-border bg-card p-4">
      <Skeleton height={18} width="45%" />
      {Array.from({ length: rows }, (_, index) => (
        <View className="flex-row items-center gap-3" key={index}>
          <Skeleton height={36} radius={18} width={36} />
          <View className="flex-1 gap-1.5">
            <Skeleton height={12} width="70%" />
            <Skeleton height={10} width="40%" />
          </View>
        </View>
      ))}
    </View>
  );
}

/**
 * The placeholder for a `<Grid>` of `StatTile`s or `InfoTile`s.
 *
 * The third shape this app loads into, and the one the kit was missing: the
 * metric strip on resident Home and resident Payments is a row of square-ish
 * tiles, and neither `SkeletonCard` nor `SkeletonRows` is anywhere near it —
 * both draw full-width rows, so the page visibly re-flowed into columns when the
 * numbers landed.
 *
 * `columns` rather than a `<Grid>`: `Grid` measures its container to decide how
 * many fit, which is a layout pass this placeholder does not need and cannot
 * benefit from. Pass the same count the real grid will settle on — three on an
 * ordinary phone — and accept that a 320dp screen shows three narrow tiles for
 * the half-second before two wide ones replace them.
 */
export function SkeletonTiles({
  columns = 3,
  height = 84,
}: {
  columns?: number;
  height?: number;
}) {
  return (
    <View className="flex-row gap-2.5">
      {Array.from({ length: columns }, (_, index) => (
        <View
          className="flex-1 justify-between rounded-2xl border border-border bg-card p-3"
          key={index}
          style={{ height }}
        >
          <Skeleton height={20} radius={10} width={20} />
          <View className="gap-1.5">
            <Skeleton height={16} width="55%" />
            <Skeleton height={9} width="80%" />
          </View>
        </View>
      ))}
    </View>
  );
}

/**
 * The placeholder for a stack of `CardRow`s — the shape the admin lists load
 * into now that a menu of destinations is separate cards rather than one card of
 * rows.
 *
 * Distinct from `SkeletonCard` in the thing that actually matters about a
 * skeleton: **the gaps**. `SkeletonCard` draws one bordered box with rows inside
 * it, so its placeholder is continuous; this draws N boxes with 12 points of
 * page showing between them. Use the one that matches what will replace it, or
 * the page jumps on load — which is the whole reason to prefer a skeleton over a
 * spinner in the first place.
 */
export function SkeletonRows({ rows = 5 }: { rows?: number }) {
  return (
    <View className="gap-3">
      {Array.from({ length: rows }, (_, index) => (
        <View
          className="flex-row items-center gap-3 rounded-2xl border border-border bg-card px-3 py-3"
          key={index}
        >
          <Skeleton height={40} radius={12} width={40} />
          <View className="flex-1 gap-1.5">
            <Skeleton height={13} width="60%" />
            <Skeleton height={10} width="85%" />
          </View>
        </View>
      ))}
    </View>
  );
}
