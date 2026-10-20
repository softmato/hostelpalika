import { LinearGradient } from "expo-linear-gradient";
import { router, useFocusEffect } from "expo-router";
import { setStatusBarStyle } from "expo-status-bar";
import { useCallback, useEffect, useState } from "react";
import { Pressable, TextInput, View } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";

import { IdCardPrompt } from "@/components/id-card-prompt";
import { NotificationBell } from "@/components/notification-bell";
import { usePortalPaint } from "@/components/portal-shared";
import { Glyph } from "@/components/ui/glyph";
import { IconButton } from "@/components/ui/icon-button";
import { Text } from "@/components/ui/text";
import { APP_NAME, APP_NAME_PARTS } from "@/constants/branding";
import { useAppSelector } from "@/hooks/redux";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useSystemInsets } from "@/hooks/use-system-insets";
import { idCardNoun, idCardTypeForAccount } from "@/lib/id-card";

/**
 * The home screen's top bar: who you are, the bell, and the search field.
 *
 * ## Why this is not `<AppBar>`
 *
 * `AppBar` is a title, an optional subtitle and a slot — one row, no leading
 * avatar and no second row. This bar leads with a face and carries the search
 * field underneath it, which is the whole shape of the mockup's header. Bending
 * `AppBar` into both would give every screen in the app a set of props only this
 * one uses.
 *
 * What it does copy from `AppBar`, because both are non-negotiable on Android:
 * it extends *into* the status bar and pads its own content clear of it
 * (edge-to-edge is mandatory from RN 0.86), and it paints an explicit colour
 * from the palette rather than a `bg-*` class — this strip has nothing behind it
 * but the window, so a class that fails to resolve renders as a black band under
 * the clock.
 *
 * ## The wordmark, not a greeting
 *
 * This led with the account's face and "Welcome back, {name}" until the
 * discovery mockup replaced it with the two-tone wordmark. Two reasons it is the
 * better trade, beyond matching the design: the greeting spent the widest row on
 * the screen telling people something they already know, and the avatar had to
 * be non-pressable — this header renders in three different shells and only one
 * of them has a Profile tab, so a tap would land somewhere different depending
 * on how you got here. The Profile tab now draws that face, where tapping it
 * does the obvious thing.
 *
 * ## The chrome adapts to having an account, it does not duplicate
 *
 * Signed out there is nothing to count and no card to hold, so both actions are
 * **absent** rather than disabled — a bell that opens an empty "sign in first"
 * screen is a worse answer than no bell. The wordmark is what is left, which is
 * what the mockup draws.
 *
 * ## The ID card replaced Compare here
 *
 * Compare had a button in this header **and** a tab in `(browse)` **and** a bar
 * that appears in the browse screen the moment two hostels are ticked — three
 * ways to the same screen, one of which sat in the scarcest row in the app. It
 * kept the two that are reached with hostels already chosen, which is the only
 * state in which compare has anything to show.
 *
 * What took its place is the control the web puts in its account menu: the ID
 * card. It does what that menu does — opens the card when there is one, offers
 * to create it when there is not — because those are genuinely one intent, and a
 * button that greys itself out for everyone who has not filled the form is a
 * button that never teaches anybody what it is for.
 *
 * ## Search submits, it does not filter in place
 *
 * The field pushes `?q=` into the browse screen, which is where the results and
 * every filter live. Filtering the home screen's carousels by a query would
 * leave "Popular right now" and "Newly listed" showing the same three matches
 * under two headings that no longer mean anything. The mockup's mic is not here:
 * there is no speech recognition in this app, and a mic that does nothing is the
 * control people decide the app is broken over.
 *
 * ## The map button is the only way in that opens the *whole* catalogue
 *
 * Every other door into `/map` arrives with a hostel already chosen: the
 * distance badge on a card pushes `?slug=…&route=1`, which opens on that hostel
 * with directions running, and `/directions/[slug]` redirects to the same thing.
 * There was no way to open the map as a map — pins for everything registered, an
 * empty search field, nothing selected — which is the state somebody who wants
 * to look at an area rather than at one listing is asking for. That is this
 * button, and it is why it pushes `/map` bare: the screen's own default with no
 * `slug` is exactly that view.
 */

/**
 * The search row, and the button that lives inside it.
 *
 * Measured here rather than written as `h-16` / `h-12 w-12`, for the reason
 * every other dimension in this app is: NativeWind resolves classes at bundle
 * time, and a size nothing else uses can silently resolve to nothing. Keeping
 * the two numbers side by side also makes the proportion explicit — the button
 * is inset 7dp top and bottom, which is what keeps the row reading as one
 * control rather than a field with a square stuck on the end.
 *
 * Both came down together, from 40 in 54 with an 18dp glyph. The button at 40
 * filled three-quarters of the row's height, which is the weight a primary
 * action gets, and this row's primary action is typing. The field at 54 was
 * then the tallest thing on the screen for a single line of 16dp text — a
 * search box with more air in it than the cards below it have around their
 * prices, pushing the first hostel down for nothing.
 *
 * 46 is what a one-line field needs: 16dp of text with 15dp above and below it,
 * still a comfortable target, and eight fewer points before the content starts.
 * The button stays at the smaller of the two sizes that survive the trim — 32dp
 * is the floor for something you tap without aiming, and it keeps the field
 * visibly the taller control.
 */
const SEARCH_HEIGHT = 46;
const FILTER_BUTTON = 32;

/**
 * The three glyphs *inside* the field — search, clear, filter.
 *
 * One number, because they are one row: sizing them apart is how a search icon
 * ends up a point bigger than the clear icon two fingers away from it for no
 * reason anybody can state. 16 sits a step under the 19 the header's round
 * actions use, which is the ranking — the bar above is chrome you press, this
 * row is a field you type in.
 */
const FIELD_GLYPH = 16;

/**
 * The map button, which lives *outside* the field.
 *
 * Deliberately smaller than `SEARCH_HEIGHT`: matching the field's height made it
 * a slab with as much weight as the search box itself, which is the wrong
 * ranking for a secondary way off this screen. It follows the field down: 40
 * against a 46dp field keeps the gap the 44-against-54 pair had, and its glyph
 * is 18 in 40 — near enough the filter button's 16 in 32 that the two read as
 * the same family of control at two sizes rather than as two unrelated squares.
 * It stays the larger of the two because it is the only control in the row that
 * leaves the screen.
 */
const MAP_BUTTON = 40;

/** The map button's glyph. A step up from `FIELD_GLYPH`, as the button is. */
const MAP_GLYPH = 18;

export type DiscoveryHeaderProps = {
  /** Where the filters button goes — the browse screen owns the filter sheet. */
  browseHref: string;
  onQueryChange: (value: string) => void;
  onSearch: () => void;
  query: string;
};

export function DiscoveryHeader({
  browseHref,
  onQueryChange,
  onSearch,
  query,
}: DiscoveryHeaderProps) {
  const insets = useSystemInsets();
  const { colors, isDark } = useAppTheme();
  const paint = usePortalPaint();
  const account = useAppSelector((state) => state.auth.account);
  const [promptingIdCard, setPromptingIdCard] = useState(false);

  /*
   * The bar is painted green, so the clock and battery go white while Home is
   * in front, and back to the theme's own colour the moment another tab is.
   */
  useFocusEffect(
    useCallback(() => {
      setStatusBarStyle("light");
      return () => setStatusBarStyle(isDark ? "light" : "dark");
    }, [isDark]),
  );

  /*
   * Decided from the cached account, not from `/users/resident-identity` — the
   * web header does the same (`user.userResidentId`), and for the same reason:
   * the button has to know which of the two things it does *before* it is
   * pressed, and a fetch on mount would be one more request on every home
   * screen for a control most people will not touch.
   *
   * `userResidentId` is minted by the first successful profile save, so it is
   * exactly "there is a card". `/id-card/edit` calls `revalidateSession()` after
   * that save, which is what flips this without a sign-out.
   */
  const hasCard = Boolean(account?.userResidentId);
  const cardType = idCardTypeForAccount({
    isServiceProvider: account?.isServiceProvider,
    role: account?.role ?? "PUBLIC",
  });
  const cardNoun = idCardNoun(cardType);

  return (
    // The top of the green that `PublicHome` fades down into the page.
    <View style={{ backgroundColor: paint.from, paddingTop: insets.top }}>
      <View className="gap-3 px-5 pb-3 pt-2">
        <View className="flex-row items-center gap-3">
          {/*
            Sized with `style`, not `text-[30px]`. NativeWind compiles the class
            list at build time, so an arbitrary value that appears nowhere else in
            the app is absent from the generated CSS until the bundler is rebuilt
            — the class resolves to nothing and the text silently renders at its
            default size. Inline styles cannot fail that way, which is why every
            measured dimension in this app is already written this way.
          */}
          <View accessibilityLabel={APP_NAME} accessibilityRole="header" className="flex-1">
            <Text style={{ fontSize: 30, fontWeight: "800", letterSpacing: -0.5 }}>
              <Text style={{ color: "#FFFFFF" }}>{APP_NAME_PARTS.head}</Text>
              <Text style={{ color: "rgba(255,255,255,0.72)" }}>{APP_NAME_PARTS.tail}</Text>
            </Text>
          </View>

          {account ? (
            <>
              <IconButton
                label={
                  hasCard
                    ? `My ${cardNoun} ID card`
                    : `Create my ${cardNoun} ID card`
                }
                /*
                  `id-card`, not `card`. The latter is the
                  *payment* card — a plain rounded rectangle with a magnetic
                  stripe — which beside a bell in a hostel app reads as billing,
                  not identity. This one draws the portrait and the lines beside
                  it, which is the thing the button opens.

                  The same icon either way. A `+` here reads as "add something"
                  beside a bell, and the button means "my ID card" whether or not
                  one exists yet — which is what the label and the sheet say.
                */
                name="id-card"
                onPress={() =>
                  hasCard ? router.push("/id-card") : setPromptingIdCard(true)
                }
                tone="onAccent"
              />

              <NotificationBell tone="onAccent" />
            </>
          ) : null}
        </View>

        <View className="flex-row items-center gap-2">
          {/*
            One field, with the filter button *inside* it rather than beside it —
            the mockup's shape, and the reason the search row reads as a single
            control instead of a field plus a mystery square.
          */}
          <View
            className="flex-1 flex-row items-center gap-2 rounded-2xl border border-border bg-card"
            style={{ height: SEARCH_HEIGHT, paddingLeft: 12, paddingRight: 6 }}
          >
            <Glyph color={colors.mutedForeground} name="search" size={FIELD_GLYPH} />

            {/*
              A bare `TextInput`, not the design system's `Input`: that carries a
              label, its own border and its own height, all of which fight a field
              living inside a pill.
            */}
            <TextInput
              className="h-full flex-1 text-base text-foreground"
              onChangeText={onQueryChange}
              onSubmitEditing={onSearch}
              /*
                Short because the row is: the field now shares it with the map
                button as well as the filter button, and "Search by city, hostel
                or landmark" was being cut off mid-word on a small phone — a
                placeholder that ends in "…or land" teaches nobody anything. Two
                of the three nouns still say the field takes more than a name.
              */
              placeholder="Search hostels or cities"
              placeholderTextColor={colors.mutedForeground}
              returnKeyType="search"
              value={query}
            />

            {query ? (
              <Pressable
                accessibilityLabel="Clear search"
                accessibilityRole="button"
                hitSlop={8}
                onPress={() => onQueryChange("")}
              >
                <Glyph
                  color={colors.mutedForeground}
                  name="close-circle"
                  size={FIELD_GLYPH}
                />
              </Pressable>
            ) : null}

            <Pressable
              accessibilityLabel="Filters"
              accessibilityRole="button"
              className="items-center justify-center rounded-xl bg-primary active:opacity-80"
              onPress={() => router.push(browseHref)}
              style={{ height: FILTER_BUTTON, width: FILTER_BUTTON }}
            >
              <Glyph
                color={colors.primaryForeground}
                name="options"
                size={FIELD_GLYPH}
              />
            </Pressable>
          </View>

          <MapButton />
        </View>
      </View>

      {/*
        Mounted here rather than on the screen: the button that opens it is this
        component's, and both surfaces that render this header — the signed-out
        stack and the browse tabs — would otherwise need the same state and the
        same sheet. It portals to the root provider, so living inside a header
        does not clip it.
      */}
      <IdCardPrompt
        cardType={cardType}
        onClose={() => setPromptingIdCard(false)}
        open={promptingIdCard}
      />
    </View>
  );
}

/**
 * The map button, and the light that moves inside it.
 *
 * ## Inside the button, not around it
 *
 * A halo around the outside was the first attempt and it was the wrong shape of
 * signal: light bleeding out of a control reads as a *state* — selected, live,
 * recording — and it made a 44dp button occupy 66dp of a row that has none to
 * spare. This stays within the button's own edges: a soft band of brand colour
 * that drifts across the face and leaves, so the thing that catches the eye is
 * the same rectangle you are being asked to press.
 *
 * ## Why a gradient sweep rather than a pulse
 *
 * A button that brightens and dims on the spot is a status light, and this app
 * already uses steady colour for status. Movement across the face is the
 * vocabulary of "new here, have a look" — the same gesture as a shimmer over a
 * skeleton, slowed down by a factor of three and tinted instead of white.
 *
 * ## The numbers are the brief: slow, faint, with a rest
 *
 * `SWEEP_MS` at 2.2s is far past the ~300ms that reads as a response to
 * something you did and well into the range that reads as ambient.
 * `Easing.inOut(Easing.quad)` means it never starts or stops, it only drifts.
 * `REST_MS` is the pause between passes: without it the button flickers
 * continuously, which is a notification. And the band's own opacity rides a sine
 * over the sweep, so it fades up as it enters and away as it leaves rather than
 * appearing at one edge and vanishing at the other.
 *
 * ## Card → brandSoft → card, and never `transparent`
 *
 * The band is painted between the button's own background and the soft brand
 * tint, so its ends are invisible against the face it crosses. Fading to
 * `"transparent"` would be the obvious way to write that and is a bug on
 * Android, where it interpolates through **rgba(0,0,0,0)** — a band that darkens
 * to grey before it disappears. Two opaque colours from the palette cannot do
 * that on either platform.
 *
 * ## It respects "reduce motion"
 *
 * `useReducedMotion` is a real setting people turn on for real reasons —
 * vestibular disorders among them — and a looping animation in the header of the
 * first screen after launch is exactly what it is turned on to stop. With it on
 * the band never moves and never appears; the button is still there, still
 * labelled, still does the same thing.
 */
const SWEEP_MS = 2_200;
const REST_MS = 1_400;

/** The moving band, wider than the button so it enters and leaves off-face. */
const BAND_WIDTH = Math.round(MAP_BUTTON * 1.5);

function MapButton() {
  const { colors } = useAppTheme();
  const reducedMotion = useReducedMotion();
  const sweep = useSharedValue(0);

  useEffect(() => {
    if (reducedMotion) {
      return;
    }

    sweep.value = withRepeat(
      withSequence(
        withTiming(1, { duration: SWEEP_MS, easing: Easing.inOut(Easing.quad) }),
        // Back to the start with no movement to watch. Invisible, because the
        // band's opacity is already zero at both ends of the sweep.
        withTiming(0, { duration: 0 }),
        withTiming(0, { duration: REST_MS }),
      ),
      -1,
      false,
    );
  }, [reducedMotion, sweep]);

  const band = useAnimatedStyle(() => ({
    // A sine over the pass: nothing at either edge, fullest in the middle.
    opacity: Math.sin(sweep.value * Math.PI),
    transform: [
      { translateX: -BAND_WIDTH + sweep.value * (MAP_BUTTON + BAND_WIDTH) },
    ],
  }));

  return (
    <Pressable
      accessibilityLabel="Open the map"
      accessibilityRole="button"
      className="items-center justify-center rounded-xl border border-border bg-card active:opacity-80"
      onPress={() => router.push("/map")}
      // `overflow: hidden` is what keeps the band inside the rounded corners
      // rather than crossing the square one behind them.
      style={{ height: MAP_BUTTON, overflow: "hidden", width: MAP_BUTTON }}
    >
      <Animated.View
        style={[
          {
            bottom: 0,
            pointerEvents: "none",
            position: "absolute",
            top: 0,
            width: BAND_WIDTH,
          },
          band,
        ]}
      >
        <LinearGradient
          colors={[colors.card, colors.brandSoft, colors.card]}
          end={{ x: 1, y: 0.85 }}
          start={{ x: 0, y: 0.15 }}
          style={{ flex: 1 }}
        />
      </Animated.View>

      {/* After the band in the tree, so it draws over it. */}
      <Glyph color={colors.foreground} name="map" size={MAP_GLYPH} />
    </Pressable>
  );
}
