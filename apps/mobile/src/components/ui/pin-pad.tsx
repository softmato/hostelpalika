import * as Haptics from "expo-haptics";
import { useEffect, useRef } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withSequence, withTiming } from "react-native-reanimated";

import { Glyph } from "@/components/ui/glyph";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "finger", "0", "back"] as const;

/**
 * Four boxes and the app's own number pad — the phone keyboard never opens for
 * a PIN. The bank apps' lock, in our green. A new `error` shakes the boxes.
 *
 * A digit lands on touch-down with a haptic tick, as on a bank keypad, rather
 * than on release.
 */
export function PinPad({
  busy = false,
  error,
  onChange,
  onComplete,
  onFingerprint,
  value,
}: {
  busy?: boolean;
  error?: string | null;
  onChange: (value: string) => void;
  onComplete: (value: string) => void;
  onFingerprint?: () => void;
  value: string;
}) {
  const { colors } = useAppTheme();
  const offset = useSharedValue(0);
  const shake = useAnimatedStyle(() => ({ transform: [{ translateX: offset.value }] }));

  /*
   * The digits as typed, ahead of React. Two quick taps both land before the
   * re-render, and a handler reading `value` built the second digit on the
   * stale first — a dropped digit, the "stuck" pad. Reading this instead also
   * keeps `press` free of `value`, so the key grid is not rebuilt per digit.
   * Only a reset flows back in from the parent, and a reset is always "".
   */
  const typed = useRef(value);

  useEffect(() => {
    if (value === "") typed.current = "";
  }, [value]);

  useEffect(() => {
    if (!error) return;
    offset.set(withSequence(
      withTiming(-10, { duration: 50 }),
      withTiming(10, { duration: 50 }),
      withTiming(-7, { duration: 50 }),
      withTiming(7, { duration: 50 }),
      withTiming(0, { duration: 50 }),
    ));
  }, [error, offset]);

  function press(key: (typeof KEYS)[number]) {
    if (busy) return;
    if (key === "finger") {
      onFingerprint?.();
      return;
    }
    const current = typed.current;
    const next = key === "back" ? current.slice(0, -1) : current.length >= 4 ? current : current + key;
    if (next === current) return;
    typed.current = next;
    void Haptics.selectionAsync().catch(() => {});
    onChange(next);
    if (next.length === 4 && key !== "back") onComplete(next);
  }

  return (
    <View className="gap-4">
      <Animated.View
        accessibilityLabel={`${value.length} of 4 digits entered`}
        className="flex-row justify-center gap-3"
        style={shake}
      >
        {[0, 1, 2, 3].map((index) => {
          const active = index === Math.min(value.length, 3) && !busy;
          return (
            <View
              className={`h-14 w-14 items-center justify-center rounded-2xl border-2 ${
                active ? "border-brand bg-card" : "border-transparent bg-muted"
              }`}
              key={index}
            >
              {index < value.length ? (
                <View className="h-3.5 w-3.5 rounded-full bg-foreground" />
              ) : null}
            </View>
          );
        })}
      </Animated.View>

      <View className="min-h-5 items-center justify-center">
        {busy ? (
          <ActivityIndicator color={colors.brand} size="small" />
        ) : error ? (
          <Text className="text-center text-destructive" variant="caption">
            {error}
          </Text>
        ) : null}
      </View>

      <View className="flex-row flex-wrap">
        {KEYS.map((key) => (
          <View className="w-1/3 p-1" key={key}>
            {key === "finger" && !onFingerprint ? null : (
              <Pressable
                accessibilityLabel={
                  key === "back" ? "Delete" : key === "finger" ? "Use biometric" : key
                }
                accessibilityRole="button"
                className="h-16 items-center justify-center rounded-2xl active:bg-brand-soft"
                disabled={busy}
                // The biometric sheet opens on release, so a brushed key cannot pop it.
                onPress={key === "finger" ? () => press(key) : undefined}
                onPressIn={key === "finger" ? undefined : () => press(key)}
              >
                {key === "back" ? (
                  <Glyph name="backspace" color={colors.mutedForeground} size={26} strokeWidth={1.8} />
                ) : key === "finger" ? (
                  <Glyph name="finger-print" color={colors.brand} size={30} strokeWidth={1.6} />
                ) : (
                  <Text className="text-2xl font-semibold text-foreground" variant={null}>
                    {key}
                  </Text>
                )}
              </Pressable>
            )}
          </View>
        ))}
      </View>
    </View>
  );
}
