import { Image } from "expo-image";
import { useEffect, useState } from "react";
import { Platform, StyleSheet } from "react-native";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withTiming,
} from "react-native-reanimated";
import { captureScreen, releaseCapture } from "react-native-view-shot";

import { MOTION } from "@/constants/motion";

/**
 * Theme cross-fade (M9): a snapshot of the frame as it is, the theme swapped
 * underneath it, then the snapshot faded away — so light → dark dissolves
 * instead of every surface snapping at once.
 *
 * Falls straight through to `apply` on web (no native capture), with
 * reduce-motion on, while a fade is already running, or if the capture fails.
 */

type Shot = { apply: () => void; uri: string };

let host: ((apply: () => void) => void) | null = null;

/** Run `apply` (the theme change) behind a snapshot of the current frame. */
export function crossFadeTheme(apply: () => void) {
  if (host) {
    host(apply);
  } else {
    apply();
  }
}

/** The snapshot layer. Mounted once at the root, above everything but the app lock. */
export function ThemeFadeHost() {
  const reduceMotion = useReducedMotion();
  const [shot, setShot] = useState<Shot | null>(null);
  const opacity = useSharedValue(1);
  const style = useAnimatedStyle(() => ({ opacity: opacity.get() }));

  useEffect(() => {
    host = (apply) => {
      if (reduceMotion || Platform.OS === "web" || shot) {
        apply();
        return;
      }

      captureScreen({ format: "jpg", quality: 0.9 }).then(
        (uri) => {
          opacity.set(1);
          setShot({ apply, uri });
        },
        apply,
      );
    };
    return () => {
      host = null;
    };
  });

  function done(uri: string) {
    setShot(null);
    releaseCapture(uri);
  }

  if (!shot) {
    return null;
  }

  return (
    <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, style]}>
      <Image
        cachePolicy="none"
        // Swap only once the old frame is on screen, so nothing flashes between.
        onDisplay={() => {
          shot.apply();
          // Two frames for the new theme to render under the snapshot, then fade.
          requestAnimationFrame(() =>
            requestAnimationFrame(() =>
              opacity.set(
                withDelay(
                  MOTION.fast,
                  withTiming(0, MOTION.themeFade, (finished) => {
                    if (finished) {
                      runOnJS(done)(shot.uri);
                    }
                  }),
                ),
              ),
            ),
          );
        }}
        source={{ uri: shot.uri }}
        style={StyleSheet.absoluteFill}
      />
    </Animated.View>
  );
}
