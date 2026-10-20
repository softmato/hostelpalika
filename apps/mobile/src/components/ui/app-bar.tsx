import { router } from "expo-router";
import type { ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import Animated, {
  Extrapolation,
  interpolate,
  useAnimatedStyle,
  useReducedMotion,
} from "react-native-reanimated";

import { Glyph } from "@/components/ui/glyph";
import { useScreenScroll } from "@/components/ui/screen";
import { Text } from "@/components/ui/text";
import { MOTION } from "@/constants/motion";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useSystemInsets } from "@/hooks/use-system-insets";

type AppBarProps = {
  /** Right-hand slot: a bell, a filter, an avatar. */
  actions?: ReactNode;
  /**
   * Paint the bar in the brand colour instead of the page background, and round
   * its bottom corners.
   *
   * The two go together deliberately — see `HEADER_RADIUS`. This is the chrome
   * for a **pushed** screen: something you opened from somewhere else, that has
   * a back arrow, and whose title names one subject. The tab screens keep the
   * plain bar, because five tabs whose top two hundred points are identical stop
   * saying where you are (`portal-shared.tsx` has the long version of that
   * argument, and it was learnt on a device).
   */
  accent?: boolean;
  /**
   * Centre the title between fixed-width side slots, instead of letting it start
   * at the left edge.
   *
   * For a bar with **at most one control per side** — the layout it is built for
   * is back-arrow, name, share. The side slots are a fixed `SIDE_SLOT` wide
   * precisely so the two of them cancel out and the title lands on the optical
   * centre of the screen; that only holds if neither side needs more room than
   * one icon. A second action would not clip — the slot is `items-end`, so it
   * would overflow left, under the title. Leave `centerTitle` off in that case
   * and let the default left-aligned bar do its job.
   */
  centerTitle?: boolean;
  onBack?: () => void;
  showBack?: boolean;
  subtitle?: string;
  title: string;
  /**
   * Size the title as a **page** heading rather than as bar chrome.
   *
   * `subtitle` (16pt medium) is the default and is right for a pushed screen,
   * where the title is a label on a strip you are passing through. A tab is not
   * that: it is a destination, and the two tabs that lead with their own header
   * component — Residents and Home, via `AdminSearchBar` and `AdminHomeHeader` —
   * already set their name in `variant="title"`. A tab drawn with a plain
   * `AppBar` was the odd one out at 16 points beside them.
   *
   * Only ever `title`, never `display`: 30-point type in a bar that also has to
   * hold a bell would wrap on the first long hostel name.
   */
  large?: boolean;
  /**
   * Extra painted height below the bar's content, in points, for a card that is
   * going to be pulled up onto it.
   *
   * NOTES §1 — "accent headers are painted blocks with rounded bottom corners,
   * **often with something straddling the bottom edge**" — is a house pattern,
   * and until this prop the component that owns the painted block could not
   * support it. The bar's content row leaves 8dp under itself; a card pulled up
   * by anything more than that lands on the *title*, which is what the first
   * cut of the statement screen did on a device: the back arrow, the name and
   * both actions were behind the card.
   *
   * So the caller asks for the room it is about to occupy, and the bar paints
   * it. `<AppBar accent straddle={26}/>` with a card at `marginTop: -26` puts
   * the card exactly where the bar used to end, with the whole title row clear
   * above it.
   *
   * Only meaningful with `accent`: an unpainted bar has no paint for anything
   * to sit on, and the reserved strip would just be page-coloured emptiness.
   */
  straddle?: number;
};

/**
 * Width of each side slot under `centerTitle`.
 *
 * 40dp: a 26dp `chevron-back` plus enough margin that the 12dp `hitSlop` around
 * it does not reach into the title. Both sides get it whether or not they hold
 * anything, because a title centred against an empty right-hand slot is not
 * centred — it is 20dp left of centre, which is the amount that reads as a
 * mistake rather than as a choice.
 */
const SIDE_SLOT = 40;

/**
 * The bottom corner radius on an accented bar, in points.
 *
 * An accented bar is a painted **block**, not a strip: the colour ends in a
 * curve and the page begins under it. Every app in
 * `ui_inspiration_folder/app_recordings/` that our users already use does this,
 * and the flat-bottomed version reads as a browser chrome by comparison.
 *
 * Only when `accent` is set. A bar painted `background` has nothing to round —
 * the curve would cut a notch of window colour out of a page the same colour,
 * which is invisible at best and a rendering fault at worst.
 */
const HEADER_RADIUS = 20;

/**
 * The top bar, and the only thing allowed to touch the status bar.
 *
 * Android is edge-to-edge from RN 0.86 onwards — there is no opt-out — so the
 * app paints underneath the clock and battery whether it wants to or not. The
 * fix is not to push everything down and leave a grey strip; it is for this bar
 * to *extend* into that area and pad its own content clear of it. The colour
 * runs to the very top of the screen, and the title sits below the clock.
 *
 * `insets.top` is the status bar on Android and the notch/dynamic-island cutout
 * on iOS, so one rule covers both.
 */
export function AppBar({
  actions,
  accent = false,
  centerTitle = false,
  large = false,
  onBack,
  showBack = false,
  straddle = 0,
  subtitle,
  title,
}: AppBarProps) {
  const insets = useSystemInsets();
  const { colors } = useAppTheme();

  /*
   * M3: a `large` title shrinks to the bar's own size as the page scrolls under
   * it, and a hairline fades in to mark the edge the content is passing. Driven
   * by the `Screen`'s scroll value, so it tracks the finger on the UI thread;
   * with reduce-motion on, the title keeps its size and only the hairline shows.
   */
  const scrollY = useScreenScroll();
  const reduceMotion = useReducedMotion();
  const { distance, scale } = MOTION.titleCollapse;

  const titleMotion = useAnimatedStyle(() => ({
    transform: [
      {
        scale:
          large && scrollY && !reduceMotion
            ? interpolate(scrollY.get(), [0, distance], [1, scale], Extrapolation.CLAMP)
            : 1,
      },
    ],
  }));

  const edgeMotion = useAnimatedStyle(() => ({
    opacity:
      large && scrollY
        ? interpolate(scrollY.get(), [0, distance], [0, 1], Extrapolation.CLAMP)
        : 0,
  }));

  /*
   * Resolved colours, not `text-*` classes — and this is a fixed bug, not a
   * preference.
   *
   * `<Text variant="subtitle">` already carries `text-foreground`, and
   * `variant="caption"` carries `text-muted-foreground`. Adding
   * `text-primary-foreground` through `className` does not replace either of
   * them: both rules reach the compiled stylesheet and which one wins is decided
   * by generation order, not by where it sat in the string. The title happened
   * to win that race and the subtitle lost it, so an accented bar rendered its
   * subtitle in grey on green — "Rates, billing and payment setup" was very
   * nearly invisible.
   *
   * A value in the `style` prop cannot lose that race. Same reasoning as
   * `background` below, and the same trap `<Card>`'s `padding` prop documents.
   */
  const ink = accent ? colors.primaryForeground : colors.foreground;

  /*
   * An explicit colour, not a `bg-*` class.
   *
   * This strip is the one surface with nothing behind it but the window itself,
   * so if the class fails to resolve — a stale NativeWind cache, a CSS rebuild
   * that has not happened yet — it falls through to the window background and
   * renders as a black bar under the clock while the rest of the app is white.
   * A resolved value from the palette cannot fail that way.
   */
  const background = accent ? colors.primary : colors.background;

  const back = showBack ? (
    <Pressable
      accessibilityLabel="Go back"
      accessibilityRole="button"
      hitSlop={12}
      onPress={onBack ?? (() => router.back())}
    >
      <Glyph color={ink} name="chevron-back" size={26} />
    </Pressable>
  ) : null;

  const heading = (
    <>
      <Animated.View
        style={[
          {
            // Shrinks toward the start of the line; onto the subtitle when there is one.
            transformOrigin: centerTitle ? "center" : subtitle ? "left bottom" : "left center",
          },
          titleMotion,
        ]}
      >
        <Text
          className={centerTitle ? "text-center" : ""}
          numberOfLines={1}
          style={{ color: ink }}
          variant={large ? "title" : "subtitle"}
        >
          {title}
        </Text>
      </Animated.View>
      {subtitle ? (
        <Text
          className={centerTitle ? "text-center" : ""}
          numberOfLines={1}
          /*
           * The title's colour at 80%, rather than a second colour.
           *
           * `opacity` rather than an `rgba()` literal because `ink` is
           * scheme-dependent — white on the light bar, near-black on the dark
           * one — so a hard-coded `rgba(255,255,255,0.8)` would be white text on
           * a light-green bar in dark mode. Fading whatever the title already is
           * keeps the pair correct in both schemes and needs no second token.
           */
          style={{ color: ink, opacity: 0.8 }}
          variant="caption"
        >
          {subtitle}
        </Text>
      ) : null}
    </>
  );

  /*
   * Written as a style rather than a `rounded-b-[20px]` class: NativeWind
   * compiles its class list from a build-time scan, so an arbitrary value that
   * appears nowhere else resolves to nothing until the bundler rebuilds — the
   * corners would simply be square, silently. Same rule the hero follows.
   */
  const paint = {
    backgroundColor: background,
    borderBottomLeftRadius: accent ? HEADER_RADIUS : 0,
    borderBottomRightRadius: accent ? HEADER_RADIUS : 0,
    /*
     * The room a straddling card is about to take, painted rather than left to
     * the page. Ignored without `accent`, because there is no paint to reserve —
     * see the prop's own note.
     */
    paddingBottom: accent ? straddle : 0,
    paddingTop: insets.top,
  };

  // The hairline the collapsing title leaves behind; an accented bar's paint is edge enough.
  const edge =
    large && !accent ? (
      <Animated.View
        pointerEvents="none"
        style={[
          {
            backgroundColor: colors.border,
            bottom: 0,
            height: StyleSheet.hairlineWidth,
            left: 0,
            position: "absolute",
            right: 0,
          },
          edgeMotion,
        ]}
      />
    ) : null;

  if (centerTitle) {
    return (
      <View style={paint}>
        {/*
          Three columns with the outer two pinned to the same width, rather than
          an absolutely-positioned title over the row.

          Absolute positioning centres the title against the *screen* and is what
          React Navigation does — but it also lets a long name run underneath the
          back arrow and the action, because an absolute child has no siblings to
          be constrained by. A hostel called "Shanti Bhawan Boys Hostel &
          Residency" is not unusual. Here the middle column is `flex-1` between
          two fixed slots, so `numberOfLines={1}` truncates it in the space it
          actually has.
        */}
        <View className="min-h-14 flex-row items-center px-4 pb-2 pt-1">
          <View className="items-start justify-center" style={{ width: SIDE_SLOT }}>
            {back}
          </View>

          <View className="flex-1 items-center px-1">{heading}</View>

          <View className="items-end justify-center" style={{ width: SIDE_SLOT }}>
            {actions}
          </View>
        </View>
        {edge}
      </View>
    );
  }

  return (
    <View style={paint}>
      <View className="min-h-14 flex-row items-center gap-3 px-4 pb-2 pt-1">
        {back}

        <View className="flex-1">{heading}</View>

        {actions}
      </View>
      {edge}
    </View>
  );
}
