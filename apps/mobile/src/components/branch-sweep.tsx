import { LinearGradient } from "expo-linear-gradient";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { useWindowDimensions } from "react-native";
import Animated, {
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";

import { useAppTheme } from "@/hooks/use-app-theme";
import { getChosenHostelId, subscribeActiveHostel } from "@/lib/active-hostel";

const BAND = 220;
const DURATION = 650;

/**
 * The branch swap: a soft glowing line runs down the screen from the moment a
 * branch is picked, again and again while the new branch renders, and once
 * more over the new screens when they land (`landed`, the layout's deferred
 * hostel). Lives outside the keyed admin tree so the rebuild cannot cut it
 * off. UI-thread only; touches pass through.
 */
export function BranchSweep({ landed }: { landed: string | null }) {
  const { height } = useWindowDimensions();
  const { colors } = useAppTheme();
  const chosen = useSyncExternalStore(subscribeActiveHostel, getChosenHostelId, getChosenHostelId);
  const seen = useRef({ chosen, landed });
  const y = useSharedValue(-BAND);

  useEffect(() => {
    const last = seen.current;
    seen.current = { chosen, landed };
    const pass = (repeat: boolean) => {
      const run = withSequence(
        withTiming(-BAND, { duration: 0 }),
        withTiming(height, {
          duration: DURATION,
          easing: Easing.inOut(Easing.cubic),
          reduceMotion: ReduceMotion.System,
        }),
      );
      y.value = repeat ? withRepeat(run, -1) : run;
    };

    if (landed !== last.landed) pass(false);
    else if (chosen !== last.chosen && chosen !== landed) pass(true);
  }, [chosen, landed, height, y]);

  const style = useAnimatedStyle(() => ({ transform: [{ translateY: y.value }] }));

  return (
    <Animated.View
      pointerEvents="none"
      style={[{ height: BAND, left: 0, position: "absolute", right: 0, top: 0 }, style]}
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
  );
}
