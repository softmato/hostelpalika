import { useEffect } from "react";
import { View } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

import { Text } from "@/components/ui/text";

/**
 * A filled track — "this much of that", as a shape rather than as two numbers.
 *
 * The pair it replaces is `NPR 74,000 of NPR 98,000`, which is accurate and
 * takes a moment's arithmetic to turn into the thing anybody actually wanted:
 * *are we nearly there*. A bar answers that before it is read. Both are shown —
 * the figures stay above it — because the bar alone cannot be acted on.
 *
 * ## The tone comes from the value, not from the call site
 *
 * The screens that use this all mean the same thing by a low bar (money that
 * has not come in), so deciding the colour per call site is how two of them end
 * up disagreeing about what counts as bad. The thresholds are deliberately
 * generous: below 60% is amber rather than red, because a hostel collects rent
 * through the month and a red bar on the 3rd would cry wolf every month.
 *
 * ## …and from which way the value reads
 *
 * `reading="elapsed"` is the other meaning a bar can carry: time used up, the
 * way a usage-limit bar fills. There a *high* bar is the one to notice, so the
 * scale runs the other way — brand green while there is plenty left, amber past
 * 60%. Never red: a plan or a payment window running down is the product
 * working, and the screens that show one already say in words when it has
 * actually run out. Still derived from the value; the caller only says which
 * way round it is.
 *
 * `reading="remaining"` is the same meaning drawn the other way: the fill is
 * what is *left*, so a plan opens as a full bar and empties towards its
 * renewal — a fuel gauge rather than a usage meter. Brand green down to 40%
 * left and amber under it, which is exactly `elapsed` past 60%.
 *
 * ## `animated` fills from empty once
 *
 * The usage-bar treatment: the track fills to its value on arrival, so the eye
 * reads the proportion as a movement rather than having to measure it. Once per
 * value, never looping — `DESIGN.md` §8 keeps the one continuous animation for
 * SOS — and skipped entirely under the OS's reduce-motion setting.
 *
 * ## `null` is a state, not a zero
 *
 * A month nobody billed has no percentage, and drawing an empty track for it
 * says "you have collected nothing" to a hostel whose real problem is that no
 * invoices exist. That case renders the track alone with a dash, and the caller
 * supplies the sentence explaining it.
 */

const TONES = {
  brand: "bg-primary",
  danger: "bg-destructive",
  neutral: "bg-muted-foreground",
  success: "bg-success",
  warning: "bg-warning",
} as const;

/**
 * `share` is a slice of a whole — one category's part of a month's spending —
 * where no fill level is good or bad, so it is always the brand colour. Without
 * it the biggest category would turn amber or red for being big.
 */
type Reading = "collected" | "elapsed" | "remaining" | "share";

function toneFor(percent: number, reading: Reading): keyof typeof TONES {
  if (reading === "share") {
    return "brand";
  }

  if (reading === "elapsed") {
    return percent >= 60 ? "warning" : "brand";
  }

  if (reading === "remaining") {
    return percent < 40 ? "warning" : "brand";
  }

  if (percent >= 90) {
    return "success";
  }

  if (percent >= 60) {
    return "warning";
  }

  return "danger";
}

/** Long enough to be seen as a fill, short enough never to be waited on. */
const FILL_MS = 900;

export function Meter({
  animated = false,
  /** Height of the track in points. The default is a bar, not a hairline. */
  height = 8,
  label,
  /** `0`–`100`, or `null` when the ratio does not apply. */
  percent,
  reading = "collected",
}: {
  animated?: boolean;
  height?: number;
  /**
   * Caption under the track. Falls back to the percentage itself; `null`
   * draws no caption, for a caller that lays out its own around the bar.
   */
  label?: string | null;
  percent: number | null;
  reading?: Reading;
}) {
  const clamped = percent === null ? null : Math.max(0, Math.min(100, percent));
  const tone = clamped === null ? "neutral" : toneFor(clamped, reading);
  const caption =
    label === null ? null : (label ?? (clamped === null ? "—" : `${clamped}%`));

  return (
    <View className="gap-1.5">
      <View
        className="w-full overflow-hidden rounded-full bg-muted"
        style={{ height }}
      >
        {clamped === null ? null : (
          <Fill
            animated={animated}
            className={TONES[tone]}
            /*
             * A percentage width, not a measured pixel one. `<Grid>` measures
             * because it has to divide a row into a whole number of cells;
             * a single bar has no such constraint, and percentage widths inside
             * a rounded, clipping parent are exact enough that the extra layout
             * pass would buy nothing but a frame of empty track on every render.
             */
            width={Math.max(clamped > 0 ? 4 : 0, clamped)}
          />
        )}
      </View>

      {caption === null ? null : <Text variant="caption">{caption}</Text>}
    </View>
  );
}

/**
 * The filled part. The colour is on a plain `View` inside the animated one, so
 * the tone stays a class like every other in this file and only the width is
 * driven from the UI thread.
 */
function Fill({
  animated,
  className,
  width,
}: {
  animated: boolean;
  className: string;
  width: number;
}) {
  const reduced = useReducedMotion();
  const moving = animated && !reduced;
  const progress = useSharedValue(moving ? 0 : width);

  useEffect(() => {
    progress.value = moving
      ? withTiming(width, { duration: FILL_MS, easing: Easing.out(Easing.cubic) })
      : width;
  }, [moving, progress, width]);

  const style = useAnimatedStyle(() => ({ width: `${progress.value}%` }));

  return (
    <Animated.View className="h-full overflow-hidden rounded-full" style={style}>
      <View className={`h-full w-full rounded-full ${className}`} />
    </Animated.View>
  );
}
