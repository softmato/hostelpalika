import { useState } from "react";
import { Pressable, type PressableProps, type StyleProp, type ViewStyle } from "react-native";

import { MOTION } from "@/constants/motion";
import { pressHaptic, type PressHaptic } from "@/components/ui/pressable-scale";

export { pressHaptic, type PressHaptic };

/**
 * Web stand-in for `PressableScale`. In the browser, Reanimated's animated
 * `Pressable` drops `className` (and the a11y props), so every tile lost
 * `flex-1` and the action grids collapsed to content width. A plain `Pressable`
 * keeps NativeWind's classes; the press shrink is a style while held.
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
  const [held, setHeld] = useState(false);

  return (
    <Pressable
      {...props}
      onPress={(event) => {
        pressHaptic(haptic);
        onPress?.(event);
      }}
      onPressIn={(event) => {
        setHeld(true);
        onPressIn?.(event);
      }}
      onPressOut={(event) => {
        setHeld(false);
        onPressOut?.(event);
      }}
      style={[style, held ? { transform: [{ scale }] } : null]}
    />
  );
}
