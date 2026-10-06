import { LinearGradient } from "expo-linear-gradient";
import { requireOptionalNativeModule } from "expo-modules-core";
import { type ComponentProps, type ReactNode, useEffect, useState } from "react";
import { Image, Platform, StyleSheet, View } from "react-native";
import Animated, {
  Easing,
  FadeOut,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from "react-native-reanimated";

import { APP_NAME, POWERED_BY } from "@/constants/branding";
import { palette } from "@/constants/theme";

/**
 * The JS half of the launch screen.
 *
 * On Android the launch screen is native: `modules/hostelhub-boot-splash`,
 * which MainActivity puts up on its first frame (wired by
 * `plugins/withSplashBranding.js`). The system splash shows only the centred
 * logo — the one thing every phone draws the same — and the native view takes
 * over with that logo in place, then "Powered by Softmato" rises in and a shine
 * crosses the logo. It holds until `releaseBootSplash()` and fades.
 *
 * `BrandSplash` is that screen's end state with the same pixels, so whatever
 * the native view fades onto — the persist gate, the boot gate — nothing moves.
 * Where the module is missing (iOS, the PWA, an Android build from before it),
 * `BootSplashCover` plays the same animation here instead.
 *
 * Geometry mirrors `scripts/gen_splash.py`; re-run it and keep these in sync:
 *   - `LOGO_WIDTH`  ← `imageWidth` in app.json
 *   - `LOGO_HEIGHT` ← the canvas ratio the script prints
 *   - `STRIP_*`     ← the dp size the drawables in `plugins/splash-branding-res` are cut for
 * The timeline and the shine mirror `BootSplash.kt`.
 */

const LOGO_WIDTH = 280;
const LOGO_HEIGHT = Math.round(LOGO_WIDTH * (510 / 1024));

const STRIP_WIDTH = 136;
const STRIP_HEIGHT = 55;
const STRIP_BOTTOM = 60;

const STRIP_DELAY_MS = 300;
const STRIP_MS = 450;
const STRIP_RISE = 14;
const SHINE_DELAY_MS = 750;
const SHINE_MS = 750;
const FADE_OUT_MS = 320;

const SHINE_TRAVEL = 110;
const SHINE_BAND = 44;
const SHINE_ANGLE = 20;

/** The ground colour, clear → 60% (`99`) → clear: invisible over the canvas, a shine over the ink. */
const GROUND = palette.light.background;
const SHINE_COLORS = [`${GROUND}00`, `${GROUND}99`, `${GROUND}00`] as const;

/** `modules/hostelhub-boot-splash` — Android only, and absent from builds that predate it. */
const nativeSplash =
  Platform.OS === "android"
    ? requireOptionalNativeModule<{ hide(): Promise<void> }>("HostelHubBootSplash")
    : null;

let release = () => {};
const released = new Promise<void>((resolve) => {
  release = resolve;
});
let markGone = () => {};
const gone = new Promise<void>((resolve) => {
  markGone = resolve;
});

/** The app is mounted: the launch screen leaves as soon as its animation has played. */
export function releaseBootSplash() {
  release();
  if (nativeSplash) {
    void nativeSplash.hide().then(markGone, markGone);
  }
}

/** Resolves once the launch screen has finished fading — the fingerprint lock asks after it. */
export function bootSplashGone() {
  return gone;
}

/**
 * The launch screen where the native one is missing, laid over the whole app
 * once. It plays the animation, holds until `releaseBootSplash()`, and fades;
 * if boot outlasts it, `BrandSplash` is already drawn below with the same
 * pixels, so lifting it changes nothing visible.
 */
export function BootSplashCover() {
  const [visible, setVisible] = useState(!nativeSplash);

  useEffect(() => {
    if (nativeSplash) return;

    let cancelled = false;
    const played = new Promise((resolve) => setTimeout(resolve, SHINE_DELAY_MS + SHINE_MS));

    void Promise.all([played, released]).then(() => {
      if (cancelled) return;
      setVisible(false);
      setTimeout(markGone, FADE_OUT_MS);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  if (!visible) {
    return null;
  }

  return (
    <Animated.View
      exiting={FadeOut.duration(FADE_OUT_MS).easing(Easing.in(Easing.quad))}
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, styles.cover]}
    >
      <AnimatedSplash />
    </Animated.View>
  );
}

/** The launch screen at rest, also shown while the boot gate decides where to go. */
export function BrandSplash() {
  return <SplashLayout />;
}

/** The native view's animation, step for step: the strip rises in, then the shine crosses the logo. */
function AnimatedSplash() {
  const strip = useSharedValue(0);
  const shine = useSharedValue(0);

  useEffect(() => {
    strip.value = withDelay(
      STRIP_DELAY_MS,
      withTiming(1, { duration: STRIP_MS, easing: Easing.out(Easing.cubic) }),
    );
    shine.value = withDelay(
      SHINE_DELAY_MS,
      withTiming(1, { duration: SHINE_MS, easing: Easing.inOut(Easing.sin) }),
    );
  }, [shine, strip]);

  const stripStyle = useAnimatedStyle(() => ({
    opacity: strip.value,
    transform: [{ translateY: (1 - strip.value) * STRIP_RISE }],
  }));

  const shineStyle = useAnimatedStyle(() => ({
    opacity: shine.value > 0 && shine.value < 1 ? 1 : 0,
    transform: [
      { translateX: (shine.value * 2 - 1) * SHINE_TRAVEL },
      { rotate: `${SHINE_ANGLE}deg` },
    ],
  }));

  return (
    <SplashLayout
      shine={
        <Animated.View pointerEvents="none" style={[styles.shine, shineStyle]}>
          <LinearGradient
            colors={SHINE_COLORS}
            end={{ x: 1, y: 0 }}
            start={{ x: 0, y: 0 }}
            style={StyleSheet.absoluteFill}
          />
        </Animated.View>
      }
      stripStyle={stripStyle}
    />
  );
}

function SplashLayout({
  shine,
  stripStyle,
}: {
  shine?: ReactNode;
  stripStyle?: ComponentProps<typeof Animated.View>["style"];
}) {
  return (
    <View style={[StyleSheet.absoluteFill, styles.ground]}>
      {/* Centred on the whole screen, like the native splash; the strip is absolute so it cannot pull the logo up. */}
      <View style={styles.logoSlot}>
        <View style={styles.logo}>
          <Image
            accessibilityLabel={APP_NAME}
            fadeDuration={0}
            resizeMode="contain"
            source={require("../../assets/images/splash-logo.png")}
            style={styles.logo}
          />
          {shine}
        </View>
      </View>

      <Animated.View style={[styles.stripSlot, stripStyle]}>
        <Image
          accessibilityLabel={POWERED_BY}
          fadeDuration={0}
          resizeMode="contain"
          source={require("../../assets/images/splash-branding.png")}
          style={styles.strip}
        />
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  cover: { elevation: 9999, zIndex: 9999 },
  ground: { backgroundColor: GROUND },
  logo: { height: LOGO_HEIGHT, overflow: "hidden", width: LOGO_WIDTH },
  logoSlot: { alignItems: "center", inset: 0, justifyContent: "center", position: "absolute" },
  shine: {
    height: LOGO_HEIGHT * 2,
    left: (LOGO_WIDTH - SHINE_BAND) / 2,
    position: "absolute",
    top: -LOGO_HEIGHT / 2,
    width: SHINE_BAND,
  },
  strip: { height: STRIP_HEIGHT, width: STRIP_WIDTH },
  stripSlot: { alignItems: "center", bottom: STRIP_BOTTOM, left: 0, position: "absolute", right: 0 },
});
