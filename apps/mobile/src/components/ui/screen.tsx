import { useFocusEffect } from "expo-router";
import { cssInterop } from "nativewind";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { RefreshControl, View } from "react-native";
import {
  KeyboardAwareScrollView,
  KeyboardStickyView,
} from "react-native-keyboard-controller";
import Animated, {
  FadeInDown,
  ReduceMotion,
  type SharedValue,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
} from "react-native-reanimated";

import { useBottomChrome } from "@/components/bottom-chrome";
import { MOTION } from "@/constants/motion";
import { TAB_BAR_HEIGHT } from "@/components/tab-bar";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useSystemInsets } from "@/hooks/use-system-insets";

// Third-party scroll view: NativeWind has to be told which props carry classes.
// The body rises in once when the screen mounts (M4). Refreshes and tab
// switches don't remount, so they don't replay it. Rise only, no fade of its
// own: the navigator already fades the screen (Android's stack in 150ms), and a
// second fade inside that one left the content faint after the transition ended.
const BODY_ENTER = FadeInDown.duration(MOTION.fast)
  .withInitialValues({ opacity: 1, transform: [{ translateY: 10 }] })
  .reduceMotion(ReduceMotion.System);

cssInterop(KeyboardAwareScrollView, {
  className: "style",
  contentContainerClassName: "contentContainerStyle",
});

/** Clearance between a focused field and whatever sits on top of the keyboard. */
const KEYBOARD_GAP = 16;

/**
 * The outermost element of every screen, and the single place system-bar insets
 * are handled.
 *
 * ## Why this is not `<SafeAreaView edges={[...]}>`
 *
 * Android has been edge-to-edge since RN 0.86 with no opt-out, so the app always
 * draws behind the status bar and the navigation bar. `SafeAreaView` solves that
 * by insetting the whole view, which leaves an unpainted strip at the top and
 * stops a colour running to the screen edge. What we want instead is for the
 * chrome to *extend* under the system bars while the **content** stays clear of
 * them. So insets are applied as padding, per region, by this component.
 *
 * ## The bottom edge is the one that actually breaks
 *
 * With gesture navigation `insets.bottom` is a ~20dp hint bar and almost
 * anything looks fine. Switch the phone to **three-button navigation** and it
 * jumps to ~48dp of opaque buttons sitting directly on top of whatever the app
 * drew there — a submit button that cannot be pressed, a last list row that
 * cannot be read. Every screen therefore reserves `insets.bottom`, either on the
 * scroll content, the sticky footer, or the tab bar, and no screen opts out.
 *
 * `MIN_BOTTOM_PAD` keeps a little breathing room on devices that report `0`,
 * so content never sits flush against the physical edge.
 */

const MIN_BOTTOM_PAD = 16;

/**
 * Room reserved under the content for a floating action: the pill's height plus
 * the gap above and below it. Without this the last card sits behind the button
 * at the end of a scroll and cannot be read.
 */
const FLOATING_CLEARANCE = 56 + 20;

/**
 * This page's scroll offset, for the `AppBar` in its `header` — the large title
 * collapses against it (M3) — and for anything in the body that moves with it. Per screen, not app-wide like the bottom chrome: a
 * stacked screen underneath keeps its own offset for when you come back to it.
 * `null` outside a `Screen`, and stuck at 0 on one that isn't `scroll`.
 */
const ScreenScrollContext = createContext<SharedValue<number> | null>(null);

export function useScreenScroll() {
  return useContext(ScreenScrollContext);
}

/**
 * The one piece of `<Screen scroll>` that a screen bringing its own scroller
 * still needs: the handler that drives the bottom chrome. `offset`, when given,
 * is fed from the same handler, so there is still one handler per list.
 *
 * A worklet, so it runs on the UI thread — see `BottomChromeProvider`.
 */
function useChromeScroll(offset?: SharedValue<number>) {
  const chrome = useBottomChrome();

  return useAnimatedScrollHandler({
    onScroll: (event) => {
      chrome?.onScroll(event.contentOffset.y);
      offset?.set(event.contentOffset.y);
    },
  });
}

/**
 * For a screen that scrolls with a list of its own instead of `<Screen scroll>`
 * — a `FlatList` recycling an unbounded feed, which a ScrollView cannot do.
 * Gives that list the same hide-on-scroll behaviour and the same bottom
 * clearance every other screen gets, so the tab bar slides away on the
 * community feed exactly as it does on Home.
 *
 * Spread onto a **Reanimated** list (`Animated.FlatList`): the handler is a
 * worklet, and a plain list would run it on the JS thread, which is busy
 * rendering rows at exactly the moment someone is scrolling.
 *
 * `scrollPaddingBottom` belongs on the list's `contentContainerStyle`, and the
 * screen around it wants `<Screen ownScroll>` — the list has to run the full
 * height of the page and reserve the bar's height inside its *content*. Cutting
 * that space off its viewport instead would end the list above the bar, and the
 * moment the bar slid away it would leave a band of bare background behind it.
 */
export function useOwnScroll(insideTabs = false) {
  const insets = useSystemInsets();
  const onScroll = useChromeScroll();

  return {
    onScroll,
    scrollEventThrottle: 16,
    scrollPaddingBottom:
      (insideTabs ? TAB_BAR_HEIGHT + insets.bottom : insets.bottom) +
      MIN_BOTTOM_PAD,
  };
}

type ScreenProps = {
  /**
   * Drop the gutter between the header and the content, for a screen whose
   * first element is artwork that has to meet the bar with no seam — the admin
   * Home gradient, and nothing else so far.
   *
   * Two things normally sit above the content, and which of them this removes
   * depends on whether there is a `header`: the standard 8dp content gutter
   * always, and the bare `insets.top` spacer as well when there is no header.
   * Either one leaves a strip of page background above the artwork, which does
   * not read as spacing — it reads as a rendering fault.
   *
   * Without a `header`, the first element then owns the status-bar inset, which
   * means it also owns getting it right: `useSystemInsets`, not a guess. A
   * headerless `bleedTop` screen whose first element skips that puts its first
   * line of text under the clock.
   */
  bleedTop?: boolean;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
  /**
   * A floating action that hovers over the content — see `<FloatingButton>`.
   * Unlike `footer` it does not occupy layout, so the page scrolls underneath
   * it; the content reserves room for it via `FLOATING_CLEARANCE`.
   */
  floating?: ReactNode;
  /** Sticky bottom region — a CTA or a summary bar. Gets the bottom inset. */
  footer?: ReactNode;
  /** Usually an `<AppBar />`. It paints its own status-bar padding. */
  header?: ReactNode;
  /**
   * Set when this screen sits inside a `<Tabs>` navigator. Reserves the tab
   * bar's height and connects scrolling to its hide/show animation.
   */
  insideTabs?: boolean;
  onRefresh?: () => void;
  /**
   * The child brings its own scroller — see `useOwnScroll`. The bottom edge is
   * then the list's to reserve, so this screen leaves its content area running
   * to the physical edge and lets the rows scroll under the tab bar.
   */
  ownScroll?: boolean;
  /** Horizontal padding on the content. Off for full-bleed lists. */
  padded?: boolean;
  refreshing?: boolean;
  scroll?: boolean;
  /**
   * Pauses the page scroll without unmounting it — for a child that needs the
   * vertical drag itself, like the signature pad. On Android the native
   * ScrollView takes a vertical drag from any JS responder, whatever it asks.
   */
  scrollEnabled?: boolean;
};

export function Screen({
  bleedTop = false,
  children,
  className = "",
  contentClassName = "",
  floating,
  footer,
  header,
  insideTabs = false,
  onRefresh,
  ownScroll = false,
  padded = true,
  refreshing = false,
  scroll = false,
  scrollEnabled = true,
}: ScreenProps) {
  const insets = useSystemInsets();
  const { colors } = useAppTheme();
  const chrome = useBottomChrome();

  /*
   * Drives the tab bar *and* any floating action. Both hide on a deliberate
   * scroll down and come back on a small scroll up, from the same shared value,
   * so the signed-out home with its Log in pill behaves exactly like a tabbed
   * screen.
   */
  const scrollY = useSharedValue(0);
  const scrollHandler = useChromeScroll(scrollY);

  const reset = chrome?.reset;

  useFocusEffect(
    useCallback(() => {
      // The state is shared app-wide, so a screen left scrolled-and-hidden
      // would otherwise hand the next screen a missing tab bar it has no way
      // to scroll back into view.
      reset?.();
    }, [reset]),
  );

  const floatingStyle = useAnimatedStyle(() => {
    const progress = chrome?.progress.value ?? 0;

    return {
      opacity: 1 - progress,
      // Far enough to clear the screen edge entirely, shadow included.
      transform: [
        { translateY: progress * (FLOATING_CLEARANCE + insets.bottom) },
      ],
    };
  });

  /*
   * When a screen has both a sticky footer and tabs, the footer owns the tab
   * clearance because the tab bar floats over the footer. Otherwise the tab
   * bar, footer, or scroll content owns the bottom edge, in that order.
   *
   * The tab bar is absolutely positioned — it floats over the content so that
   * hiding it does not reflow the list behind it — which means the content has
   * to reserve the full bar height itself, inset included.
   */
  const tabClearance = insideTabs ? TAB_BAR_HEIGHT + insets.bottom : 0;
  const reservedBottom = footer
    ? MIN_BOTTOM_PAD
    : (insideTabs ? tabClearance : insets.bottom) + MIN_BOTTOM_PAD;

  // A floating action does not occupy layout, so the content has to leave room
  // for it on top of whatever the bottom edge already claimed.
  const contentBottomPad = reservedBottom + (floating ? FLOATING_CLEARANCE : 0);

  /** The sticky footer rides up on the keyboard, so a focused field has to clear it too. */
  const [footerHeight, setFooterHeight] = useState(0);

  /*
   * The body mounts one frame after the screen does.
   *
   * A push only starts its transition once the new screen's first render has
   * committed, so a screen that builds sixty cards, a map or an eleven-section
   * form on mount held the tap for as long as that took — the press landed, and
   * nothing moved. With the body a frame behind, the first render is the header
   * alone: the fade starts on the tap, and the heavy part renders while the
   * native animation runs. The header still mounts at once, because the card
   * grow (M8) measures it.
   */
  const [bodyReady, setBodyReady] = useState(false);

  useEffect(() => {
    const frame = requestAnimationFrame(() => setBodyReady(true));

    return () => cancelAnimationFrame(frame);
  }, []);

  const paddingClass = padded ? "px-5" : "";
  const topPadClass = bleedTop ? "" : "pt-2";

  const body = scroll ? (
    <KeyboardAwareScrollView
      // Scrolls only when the focused field would end up under the keyboard or
      // the footer riding on it; a field already in view is left where it is.
      bottomOffset={footerHeight + KEYBOARD_GAP}
      className="flex-1"
      contentContainerClassName={`grow ${paddingClass} ${topPadClass} ${contentClassName}`}
      contentContainerStyle={{ paddingBottom: contentBottomPad }}
      keyboardShouldPersistTaps="handled"
      onScroll={scrollHandler}
      scrollEnabled={scrollEnabled}
      refreshControl={
        onRefresh ? (
          <RefreshControl
            colors={[colors.primary]}
            onRefresh={onRefresh}
            refreshing={refreshing}
            tintColor={colors.primary}
          />
        ) : undefined
      }
      scrollEventThrottle={16}
      showsVerticalScrollIndicator={false}
    >
      {children}
    </KeyboardAwareScrollView>
  ) : (
    <View
      className={`flex-1 ${paddingClass} ${contentClassName}`}
      style={{ paddingBottom: ownScroll ? 0 : contentBottomPad }}
    >
      {children}
    </View>
  );

  return (
    // Around the body as well as the header: Home's shortcut block tucks into
    // its header against the same offset (`HomeShortcuts`).
    <ScreenScrollContext.Provider value={scrollY}>
      <View className={`flex-1 bg-background ${className}`}>
        {/*
          With no AppBar there is nothing to paint the status-bar strip, so the
          screen reserves it itself — otherwise the first line of content renders
          under the clock.
        */}
        {header ?? (bleedTop ? null : <View style={{ height: insets.top }} />)}

        {/*
          Keyboard handling, owned by react-native-keyboard-controller.

          The footer rides up on the keyboard (`KeyboardStickyView`), so every
          form's submit button stays reachable — register, complaints, the ID card
          flow, payment claims. The body scrolls a focused field into view only
          when the keyboard or that footer would cover it.

          It replaced a `KeyboardAvoidingView` that leaned on Android resizing the
          window (`softwareKeyboardLayoutMode: "resize"`). Under edge-to-edge the
          window does not resize, so low fields — step 5 of the ID card — sat
          under the keyboard while the user typed into them blind.
        */}
        <View className="flex-1">
          {bodyReady ? (
            <Animated.View className="flex-1" entering={BODY_ENTER}>
              {body}
            </Animated.View>
          ) : (
            <View className="flex-1" />
          )}

          {footer ? (
            <KeyboardStickyView>
              <View
                onLayout={(event) =>
                  setFooterHeight(event.nativeEvent.layout.height)
                }
                className="border-t border-border bg-background px-5 pt-3"
                style={{
                  paddingBottom: insideTabs
                    ? tabClearance + MIN_BOTTOM_PAD
                    : Math.max(insets.bottom, MIN_BOTTOM_PAD),
                }}
              >
                {footer}
              </View>
            </KeyboardStickyView>
          ) : null}
        </View>

        {floating ? (
          <Animated.View
            /*
             * A wider gutter than the content's `px-5`. The pill is deliberately
             * inset from the cards behind it — matching their width would read as
             * another row in the page rather than as something floating above it,
             * and the shadow would have no ground to fall on.
             */
            className="absolute inset-x-0 items-center px-14"
            style={[
              {
                bottom:
                  (insideTabs ? TAB_BAR_HEIGHT + insets.bottom : insets.bottom) +
                  MIN_BOTTOM_PAD,
                pointerEvents: "box-none",
              },
              floatingStyle,
            ]}
          >
            {floating}
          </Animated.View>
        ) : null}
      </View>
    </ScreenScrollContext.Provider>
  );
}
