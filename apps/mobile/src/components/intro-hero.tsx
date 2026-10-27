import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  ReduceMotion,
  type SharedValue,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
  ZoomIn,
} from "react-native-reanimated";
import Svg, { Circle } from "react-native-svg";

import { Glyph, type GlyphName } from "@/components/ui/glyph";
import { MOTION, riseIn } from "@/constants/motion";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";

/**
 * The first glimpse of a door from Home — Register hostel, Service provider,
 * Offer Program: one living icon, a few words, and nothing to read.
 *
 * Drawn from vectors and tokens, like `StateArt` in `ui/states.tsx`, but alive:
 * the tile floats, a dashed ring turns, a soft pulse breathes out, and three
 * small chips orbit-bob around it, naming the door's world in pictures
 * (a bed, wifi and people for a hostel). `StateArt` stays still on purpose — an
 * empty list should not perform — so this is its own piece rather than a flag.
 *
 * Reduce motion freezes every loop at rest; the entrance is the system's call.
 */
const SIZE = 200;
const CENTER = SIZE / 2;
const TILE = 76;
const CHIP = 38;
const ORBIT = 82;

/** Upper left, upper right, bottom — the three chips never crowd the title. */
const ANGLES = [-150, -30, 90];

const ENTER = ZoomIn.withInitialValues({ transform: [{ scale: 0.8 }] })
  .springify()
  .damping(14)
  .reduceMotion(ReduceMotion.System);

function loop(value: SharedValue<number>, duration: number, easing = Easing.linear) {
  value.set(withRepeat(withTiming(1, { duration, easing }), -1, false));
}

export function IntroHero({
  icon,
  line,
  orbit,
  title,
}: {
  icon: GlyphName;
  /** One short line. A sentence with a comma in it is already too long. */
  line?: string;
  /** Exactly three small glyphs that say what this door is about. */
  orbit: [GlyphName, GlyphName, GlyphName];
  title: string;
}) {
  const { colors } = useAppTheme();
  const reduce = useReducedMotion();
  const spin = useSharedValue(0);
  const pulse = useSharedValue(0);
  const wave = useSharedValue(0);

  useEffect(() => {
    if (reduce) return;

    loop(spin, 24000);
    loop(pulse, 2600, Easing.out(Easing.quad));
    loop(wave, 6000);

    return () => {
      cancelAnimation(spin);
      cancelAnimation(pulse);
      cancelAnimation(wave);
    };
  }, [pulse, reduce, spin, wave]);

  const ring = useAnimatedStyle(() => ({
    transform: [{ rotate: `${spin.value * 360}deg` }],
  }));
  const breath = useAnimatedStyle(() => ({
    opacity: 0.22 * (1 - pulse.value),
    transform: [{ scale: 0.7 + pulse.value * 0.5 }],
  }));
  const float = useAnimatedStyle(() => ({
    transform: [{ translateY: Math.sin(wave.value * Math.PI * 2) * 5 }, { rotate: "-6deg" }],
  }));

  return (
    <View className="items-center gap-3">
      <Animated.View entering={ENTER} style={{ height: SIZE, width: SIZE }}>
        <Animated.View
          style={[
            StyleSheet.absoluteFill,
            { backgroundColor: colors.primary, borderRadius: SIZE / 2 },
            breath,
          ]}
        />

        <Svg height={SIZE} style={StyleSheet.absoluteFill} width={SIZE}>
          <Circle cx={CENTER} cy={CENTER} fill={colors.primary} fillOpacity={0.06} r={CENTER - 4} />
          <Circle cx={CENTER} cy={CENTER} fill={colors.primary} fillOpacity={0.1} r={58} />
        </Svg>

        <Animated.View style={[StyleSheet.absoluteFill, ring]}>
          <Svg height={SIZE} width={SIZE}>
            <Circle
              cx={CENTER}
              cy={CENTER}
              fill="none"
              r={ORBIT}
              stroke={colors.primary}
              strokeDasharray="2 7"
              strokeLinecap="round"
              strokeOpacity={0.35}
              strokeWidth={1.6}
            />
          </Svg>
        </Animated.View>

        <View className="absolute inset-0 items-center justify-center">
          <Animated.View
            className="items-center justify-center rounded-3xl bg-primary"
            style={[
              {
                elevation: 6,
                height: TILE,
                shadowColor: colors.primary,
                shadowOffset: { height: 8, width: 0 },
                shadowOpacity: 0.3,
                shadowRadius: 14,
                width: TILE,
              },
              float,
            ]}
          >
            <Glyph color="#FFFFFF" name={icon} size={36} strokeWidth={1.8} />
          </Animated.View>
        </View>

        {orbit.map((name, index) => (
          <OrbitChip angle={ANGLES[index]} key={name} name={name} phase={index / 3} wave={wave} />
        ))}
      </Animated.View>

      <Animated.View
        className="items-center gap-1.5 px-6"
        entering={riseIn(MOTION.stagger)}
      >
        <Text className="text-center" variant="title">
          {title}
        </Text>
        {line ? (
          <Text className="text-center" variant="muted">
            {line}
          </Text>
        ) : null}
      </Animated.View>
    </View>
  );
}

/**
 * What comes next, as three tinted icons with a word or two under each — the
 * "how it works" paragraph, said in pictures.
 */
export function IntroSteps({ steps }: { steps: { icon: GlyphName; label: string }[] }) {
  const { colors } = useAppTheme();

  return (
    <View className="flex-row justify-center gap-3">
      {steps.map((step, index) => (
        <Animated.View
          className="flex-1 items-center gap-2"
          entering={riseIn((2 + index) * MOTION.stagger)}
          key={step.label}
        >
          <View className="h-12 w-12 items-center justify-center rounded-2xl bg-primary/10">
            <Glyph color={colors.primary} name={step.icon} size={22} />
          </View>
          <Text className="text-center" variant="caption">
            {step.label}
          </Text>
        </Animated.View>
      ))}
    </View>
  );
}

function OrbitChip({
  angle,
  name,
  phase,
  wave,
}: {
  angle: number;
  name: GlyphName;
  phase: number;
  wave: SharedValue<number>;
}) {
  const { colors } = useAppTheme();
  const radians = (angle * Math.PI) / 180;
  const left = CENTER + Math.cos(radians) * ORBIT - CHIP / 2;
  const top = CENTER + Math.sin(radians) * ORBIT - CHIP / 2;

  const bob = useAnimatedStyle(() => ({
    transform: [{ translateY: Math.sin((wave.value + phase) * Math.PI * 2) * 4 }],
  }));

  return (
    <Animated.View
      className="absolute items-center justify-center rounded-full border border-border bg-card"
      style={[
        {
          elevation: 3,
          height: CHIP,
          left,
          shadowColor: "#000000",
          shadowOffset: { height: 3, width: 0 },
          shadowOpacity: 0.08,
          shadowRadius: 6,
          top,
          width: CHIP,
        },
        bob,
      ]}
    >
      <Glyph color={colors.primary} name={name} size={18} />
    </Animated.View>
  );
}
