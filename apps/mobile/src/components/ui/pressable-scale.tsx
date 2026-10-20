import * as Haptics from "expo-haptics";
import { cssInterop } from "nativewind";
import { Pressable, type PressableProps, type StyleProp, type ViewStyle } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";

import { MOTION } from "@/constants/motion";

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
// Reanimated's own components get this from NativeWind; a created one has to ask.
cssInterop(AnimatedPressable, { className: "style" });

export type PressHaptic = "light" | "selection";

export function pressHaptic(kind: PressHaptic | undefined) {
  // Web and phones without a motor reject; a missing tick is never an error.
  if (kind === "light") {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
  } else if (kind === "selection") {
    void Haptics.selectionAsync().catch(() => {});
  }
}

/**
 * Every tappable surface goes through this (M1): it shrinks under the finger
 * on a spring and springs back, instead of the old `active:opacity-*` dim.
 * `haptic` is for presses that commit something, not for every tap.
 */
export function PressableScale({
  haptic,
  onPress,
  onPressIn,
  onPressOut,
  scale = MOTION.pressScale,
  style,
  ...props
}: Omit<PressableProps, "style"> & {
  className?: string;
  haptic?: PressHaptic;
  scale?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const pressed = useSharedValue(1);
  const animated = useAnimatedStyle(() => ({ transform: [{ scale: pressed.value }] }));

  return (
    <AnimatedPressable
      {...props}
      onPress={(event) => {
        pressHaptic(haptic);
        onPress?.(event);
      }}
      onPressIn={(event) => {
        pressed.set(withSpring(scale, MOTION.press));
        onPressIn?.(event);
      }}
      onPressOut={(event) => {
        pressed.set(withSpring(1, MOTION.press));
        onPressOut?.(event);
      }}
      style={[style, animated]}
    />
  );
}
