import { Tabs } from "expo-router";
import { type ComponentProps, useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import Animated, { ReduceMotion, useAnimatedStyle, useSharedValue, withSpring, ZoomIn } from "react-native-reanimated";

import { useBottomChrome } from "@/components/bottom-chrome";
import { Text } from "@/components/ui/text";
import { MOTION } from "@/constants/motion";
import { type RoleAccentKey, roleAccent } from "@/constants/theme";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useSystemInsets } from "@/hooks/use-system-insets";

/**
 * expo-router vendors react-navigation rather than depending on it, so
 * `@react-navigation/bottom-tabs` is not resolvable here. Deriving the props
 * from the `tabBar` slot keeps this correct across expo-router upgrades without
 * reaching into `expo-router/build/...`.
 */
export type TabBarRenderProps = Parameters<
  NonNullable<ComponentProps<typeof Tabs>["tabBar"]>
>[0];

/** Bar height excluding the system inset. Screens reserve this much. */
export const TAB_BAR_HEIGHT = 58;

// The tinted pill behind the active icon (M2). Sized to the icon, not the slot.
const PILL_W = 52;
const PILL_H = 30;
const PILL_TOP = 9;

// The icon a tab lands on pops from a little smaller.
const ICON_POP = ZoomIn.withInitialValues({ transform: [{ scale: 0.72 }] })
  .springify()
  .damping(13)
  .reduceMotion(ReduceMotion.System);

/**
 * The tab bar.
 *
 * Custom rather than the navigator's default because the default cannot be
 * animated from a screen's scroll position. It is absolutely positioned so the
 * content behind it keeps its full height — the bar sliding away must not
 * reflow the list underneath, or every hide and show would shift the text the
 * reader is looking at.
 *
 * Visibility comes from `BottomChromeProvider`, shared with floating actions,
 * so a tabbed screen and the signed-out home behave identically on scroll.
 */
export function AnimatedTabBar({
  accent,
  descriptors,
  navigation,
  state,
}: TabBarRenderProps & { accent: RoleAccentKey }) {
  const insets = useSystemInsets();
  const { colors, isDark } = useAppTheme();
  const chrome = useBottomChrome();

  const activeColor = isDark ? roleAccent[accent].dark : roleAccent[accent].light;
  const totalHeight = TAB_BAR_HEIGHT + insets.bottom;

  // One pill for the whole bar, sliding between slots. Hidden routes
  // (`href: null`) take no slot, so they are left out of the count.
  const slots = state.routes.filter(
    (route) => StyleSheet.flatten(descriptors[route.key].options.tabBarItemStyle)?.display !== "none",
  );
  const slot = slots.findIndex((route) => route.key === state.routes[state.index]?.key);
  const [barWidth, setBarWidth] = useState(0);
  const pillX = useSharedValue(0);
  const placed = useRef(false);

  useEffect(() => {
    if (!barWidth || slot < 0) {
      return;
    }

    const segment = barWidth / slots.length;
    const x = segment * slot + (segment - PILL_W) / 2;

    // The first placement jumps; only a change of tab travels.
    pillX.value = placed.current ? withSpring(x, MOTION.slide) : x;
    placed.current = true;
  }, [barWidth, pillX, slot, slots.length]);

  const pillStyle = useAnimatedStyle(() => ({ transform: [{ translateX: pillX.value }] }));

  const barStyle = useAnimatedStyle(() => {
    const progress = chrome?.progress.value ?? 0;

    return {
      // Fades slightly ahead of the slide, so the bar reads as leaving rather
      // than as being clipped by the screen edge.
      opacity: 1 - progress * 0.6,
      // Slid by its full height, inset included, so nothing peeks out.
      transform: [{ translateY: progress * totalHeight }],
    };
  });

  return (
    <Animated.View
      className="absolute inset-x-0 bottom-0 flex-row border-t border-border"
      style={[
        {
          backgroundColor: colors.background,
          height: totalHeight,
          paddingBottom: insets.bottom,
          paddingTop: 6,
        },
        barStyle,
      ]}
      onLayout={(event) => setBarWidth(event.nativeEvent.layout.width)}
    >
      {barWidth > 0 && slot >= 0 ? (
        <Animated.View
          pointerEvents="none"
          style={[
            {
              backgroundColor: activeColor,
              borderRadius: PILL_H / 2,
              height: PILL_H,
              left: 0,
              opacity: 0.14,
              position: "absolute",
              top: PILL_TOP,
              width: PILL_W,
            },
            pillStyle,
          ]}
        />
      ) : null}

      {state.routes.map((route, index) => {
        const { options } = descriptors[route.key];

        /*
         * A `<Tabs>` navigator adopts every route file in its directory, so a
         * group's non-tab screens — the admin action queue, reached by a push
         * from Home — arrive here too. expo-router's `href: null` marks them by
         * setting `tabBarItemStyle.display`, which its *default* bar honours and
         * this one has to read for itself. Flattened rather than compared
         * directly: the option is a `StyleProp`, so it can be an array.
         */
        if (StyleSheet.flatten(options.tabBarItemStyle)?.display === "none") {
          return null;
        }

        const focused = state.index === index;
        const label = typeof options.title === "string" ? options.title : route.name;
        const tint = focused ? activeColor : colors.mutedForeground;
        const badge = typeof options.tabBarBadge === "number" ? options.tabBarBadge : 0;

        function onPress() {
          const event = navigation.emit({
            canPreventDefault: true,
            target: route.key,
            type: "tabPress",
          });

          if (focused || event.defaultPrevented) {
            return;
          }

          navigation.navigate(route.name, route.params);
        }

        return (
          <Pressable
            accessibilityLabel={label}
            /*
             * `tab`, not `button`. With `button` a screen reader announces five
             * unrelated buttons and drops the position-in-set — "tab 2 of 5" is
             * the whole orientation cue for someone who cannot see the bar.
             */
            accessibilityRole="tab"
            accessibilityState={{ selected: focused }}
            className="flex-1 items-center justify-center gap-0.5 active:opacity-60"
            key={route.key}
            onPress={onPress}
          >
            <View>
              <Animated.View entering={focused ? ICON_POP : undefined} key={focused ? "on" : "off"}>
                {options.tabBarIcon?.({ color: tint, focused, size: 23 })}
              </Animated.View>

              {/*
                Drawn here rather than left to `tabBarBadge`: that option is
                rendered by React Navigation's own bar, and this is not it. The
                count is capped at 9+ for the same reason the header bell caps —
                three digits either overflow an 18px circle or shrink past
                reading size, and nobody acts on the difference between 12 and 40
                claims. It stays a number rather than a dot because "how many"
                is the whole question a queue badge answers.
              */}
              {badge > 0 ? (
                <View
                  className="absolute -right-2.5 -top-1 h-[17px] min-w-[17px] items-center justify-center rounded-full px-1"
                  style={{ backgroundColor: colors.destructive }}
                >
                  <Text
                    style={{
                      // White, not a token: the palette has no
                      // `destructiveForeground`, and `primaryForeground` is
                      // near-black in the dark theme — which is what a red chip
                      // must never be. Both `destructive` values are mid-reds,
                      // so white clears contrast in either theme.
                      color: "#ffffff",
                      fontSize: 10,
                      fontWeight: "700",
                    }}
                  >
                    {badge > 9 ? "9+" : badge}
                  </Text>
                </View>
              ) : null}
            </View>
            <Text
              numberOfLines={1}
              style={{ color: tint, fontSize: 11, fontWeight: "500" }}
            >
              {label}
            </Text>
          </Pressable>
        );
      })}
    </Animated.View>
  );
}
