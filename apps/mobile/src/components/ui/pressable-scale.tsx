import * as Haptics from "expo-haptics";
import { Pressable, type PressableProps, type StyleProp, type ViewStyle } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";

import { MOTION } from "@/constants/motion";

/*
 * No `cssInterop` on this. `className` rides through Reanimated to the inner
 * `Pressable`, which NativeWind already handles — the same path `Animated.View`
 * takes. Registering the outer component made NativeWind flatten the classes
 * and the animated style into one object; Reanimated saw `viewDescriptors` on
 * it, swapped the whole thing for `{ scale: 1 }`, and every class was dropped
 * (tiles lost `flex-1`, the primary Button lost its green and its label went
 * white on white) — and re-attached the animation on every render.
 */
const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

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
