import { Image } from "expo-image";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AccessibilityInfo,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  ScrollView,
  useWindowDimensions,
  View,
} from "react-native";

import { SaveButton, TYPE_TAG_SIZE } from "@/components/hostel-card";
import { Glyph } from "@/components/ui/glyph";
import { Skeleton } from "@/components/ui/skeleton";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { API_BASE_URL } from "@/lib/api";
import { coverPhoto, locationLabel, priceRange, ratingDisplay } from "@/lib/hostel-display";
import { absoluteMediaUrl } from "@/lib/media";
import { HOSTEL_TYPE_LABELS, type PublicHostel } from "@/lib/public-api";

/**
 * The top of the home screen: real listings, sliding on their own.
 *
 * ## What this replaced, and why
 *
 * A full-width green card with a headline, a search field and three trust chips
 * — an older mockup's hero. It filled the first screenful with copy nobody reads and
 * one photo, on a screen whose entire job is showing hostels. This puts the
 * hostels there instead, at the size a photo is actually worth looking at, and
 * the search field moved up into the header where it is reachable without
 * scrolling.
 *
 * ## Auto-advance, and how it stops
 *
 * It slides every few seconds and then **yields to the user permanently**: the
 * first drag cancels the timer for the life of the screen. A carousel that
 * resumes after a delay takes the card away from under the thumb of the person
 * reading it, which is the one thing an auto-slider must not do — and "resume
 * after N seconds" is a race with how long someone spends reading.
 *
 * Three other things switch it off, all for the same underlying reason — an
 * animation nobody is watching is a battery and a vestibular problem, not a
 * feature:
 *
 * - **Reduce Motion.** Honoured, and re-read live: this is an unprompted,
 *   repeating, horizontal movement, which is exactly what the setting exists for.
 * - **Blur.** `useFocusEffect` stops the timer when the screen is not on top, so
 *   a phone left on the notifications screen is not animating a list behind it.
 * - **One card.** Nothing to advance to; the dots are hidden too.
 *
 * ## Widths are measured, not assumed
 *
 * The card width comes from `useWindowDimensions`, so it follows a rotation and
 * a foldable rather than baking in a phone-sized constant. `snapToInterval` does
 * the paging instead of `pagingEnabled`, because a gap between cards means one
 * page is *not* one screen width and `pagingEnabled` would drift a little
 * further out of alignment on every swipe.
 */

const SLIDE_MS = 4_500;
const CARD_GAP = 12;
/** `Screen`'s `px-5` on both sides — the card is inset, not full-bleed. */
const PAGE_INSET = 40;
/**
 * The card is a **split**: photograph on the left, the details column on the
 * right, both running the full height. That is the mockup's shape, and it is
 * what lets one card carry the price, the rating, three facilities and a call
 * to action without becoming a screenful.
 *
 * ## The two numbers below are the whole shape of the card
 *
 * The mockup's card is **short and wide**, with a nearly square photograph. This
 * shipped at `0.42 × 268`, which on a 360dp handset is a 134×268 photo — a tall
 * strip, twice as high as it is wide, on a card half again as deep as the design
 * draws it. Both numbers moved together, because either one alone makes it
 * worse: a shorter card with a 42% photo is a *thinner* strip, and a wider photo
 * on a 268 card is a taller one.
 *
 * The photo stops at 44% rather than going to the mockup's half, and the number
 * is the reason. On a 360dp handset an even split leaves about 130dp of text
 * column, and `NPR 10,000 – 18,000 /month` needs about 155 at the sizes below —
 * so the price, the one string on the card people are actually reading, either
 * came out as `NPR 10,000 – 1…` or dropped its `/month` onto a line of its own,
 * which is the shape a price should never have. 44%, an 8dp column padding and
 * a point off both type sizes are what fit the whole thing on one line; the row
 * still wraps rather than truncates if a longer range ever does not.
 *
 * The height is what the contents need and no more: name, place, rating, price,
 * the rule and facilities are ~110dp stacked once they come off the variant
 * table, the View Details bar is 36, and the rest is padding. The eight points
 * it grew are the rule above the facilities row and the gap over it — the
 * column is `justify-between`, so leaving the height alone would have paid for
 * the rule out of the space under the facilities instead. It came down with the type
 * rather than by squeezing: the numbers are what the mockup's short, wide card
 * costs, and cutting further starts clipping the bar at large system font sizes.
 */
/**
 * The card's type scale, in points — and every size here is a `fontSize` rather
 * than a `text-sm` / `text-xs` / `text-[9px]` class, which is the whole reason
 * this table exists.
 *
 * `Text` glues its variant's classes to the caller's with a plain template
 * string (`ui/text.tsx`) — no `tailwind-merge`. So a `text-xs` passed in was
 * racing the default `body` variant's `text-base` for the same property, and
 * NativeWind settles that by stylesheet order, not by which class was written
 * last. `text-base` won every time: the name, the chip and the price had all
 * been rendering at 16 regardless of what the class said, and an arbitrary
 * `text-[9px]` compiles to nothing at all when that size appears nowhere else
 * in the app. The column read as one flat block of 16px with a 9px facility row
 * under it — the "cramped at the top, tiny at the bottom" shape.
 *
 * A measured dimension goes in `style`, where it cannot silently fail to exist.
 * `TYPE_TAG_SIZE` above and the same note in `hostel-card.tsx` are this rule
 * arrived at twice already.
 */
const TYPE_SCALE = {
  /** The soft "View Details" bar. */
  cta: 13,
  /** Rating / vacancy chips, and the `/month` unit. */
  meta: 10,
  name: 15,
  /** Address and campus distance. */
  place: 11,
  /*
   * Two points under the name, and both of them measured rather than chosen.
   * The text column is ~159dp once the 44% photo and the padding come off a
   * 360dp handset, and `NPR 10,000 – 18,000` in bold is ~127dp of that at 14 —
   * which leaves 28 for a `/month` that needs 34. So the unit wrapped to a line
   * of its own, the exact shape the note on the price row says it must never
   * have, and the extra line then pushed the facilities out of the stack
   * entirely. At 13 the number is ~118dp and the pair fits with room to spare.
   */
  price: 13,
} as const;

const IMAGE_RATIO = 0.44;
const CARD_HEIGHT = 172;

export type HostelShowcaseProps = {
  hostels: PublicHostel[];
  /** True on the very first load, when there is nothing to draw yet. */
  loading?: boolean;
  onToggleSave: (hostel: PublicHostel) => void;
  savedIds: Set<string>;
};

export function HostelShowcase({
  hostels,
  loading = false,
  onToggleSave,
  savedIds,
}: HostelShowcaseProps) {
  const { width } = useWindowDimensions();
  const scroller = useRef<ScrollView>(null);
  /*
   * The live index lives in a ref, and only the dots read state. Putting it in
   * state alone would list `index` as a dependency of the interval effect, which
   * tears down and rebuilds the timer on every advance — so the interval would
   * restart mid-cycle and the slide would arrive early.
   */
  const index = useRef(0);
  const [dot, setDot] = useState(0);
  const [surrendered, setSurrendered] = useState(false);
  const [focused, setFocused] = useState(true);
  const reduceMotion = useReduceMotion();

  const cardWidth = Math.max(1, width - PAGE_INSET);
  const step = cardWidth + CARD_GAP;
  const count = hostels.length;
  const sliding = focused && !surrendered && !reduceMotion && count > 1;

  useFocusEffect(
    useCallback(() => {
      setFocused(true);

      return () => setFocused(false);
    }, []),
  );

  useEffect(() => {
    if (!sliding) {
      return;
    }

    const timer = setInterval(() => {
      const next = (index.current + 1) % count;

      index.current = next;
      setDot(next);
      scroller.current?.scrollTo({ animated: true, x: next * step });
    }, SLIDE_MS);

    return () => clearInterval(timer);
  }, [count, sliding, step]);

  /*
   * A shrinking list can leave the scroller parked past its own end — the
   * catalogue is refetched on every focus, and a hostel can be delisted between
   * two of those. Rewinding to the first card is the only position guaranteed to
   * exist.
   */
  useEffect(() => {
    if (index.current >= count) {
      index.current = 0;
      setDot(0);
      scroller.current?.scrollTo({ animated: false, x: 0 });
    }
  }, [count]);

  const onMomentumEnd = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const landed = Math.round(event.nativeEvent.contentOffset.x / step);

      index.current = Math.max(0, Math.min(landed, count - 1));
      setDot(index.current);
    },
    [count, step],
  );

  if (loading && count === 0) {
    return <Skeleton height={CARD_HEIGHT} radius={24} />;
  }

  // No hostel with a usable photo. The rows below still work, and an empty
  // card-sized frame at the top of the screen reads as a broken app. The
  // section's heading is hidden by the caller for the same reason.
  if (count === 0) {
    return null;
  }

  return (
    <View className="gap-3">
      <ScrollView
        contentContainerStyle={{ gap: CARD_GAP }}
        decelerationRate="fast"
        horizontal
        onMomentumScrollEnd={onMomentumEnd}
        // The first drag is the handover. See the note above.
        onScrollBeginDrag={() => setSurrendered(true)}
        ref={scroller}
        showsHorizontalScrollIndicator={false}
        snapToAlignment="start"
        snapToInterval={step}
      >
        {hostels.map((hostel) => (
          <ShowcaseCard
            hostel={hostel}
            key={hostel.id}
            onToggleSave={onToggleSave}
            saved={savedIds.has(hostel.id)}
            width={cardWidth}
          />
        ))}
      </ScrollView>

      {count > 1 ? <Dots active={dot} count={count} /> : null}
    </View>
  );
}

function ShowcaseCard({
  hostel,
  onToggleSave,
  saved,
  width,
}: {
  hostel: PublicHostel;
  onToggleSave: (hostel: PublicHostel) => void;
  saved: boolean;
  width: number;
}) {
  const { colors } = useAppTheme();

  const cover = coverPhoto(hostel.photos);
  const uri = absoluteMediaUrl(cover?.url, API_BASE_URL);
  const rating = ratingDisplay(hostel.ratingSummary);
  const imageWidth = Math.round(width * IMAGE_RATIO);

  return (
    <Pressable
      accessibilityLabel={`${hostel.name}, ${locationLabel(hostel.location)}`}
      accessibilityRole="button"
      className="flex-row overflow-hidden rounded-3xl border border-border bg-card active:opacity-90"
      onPress={() => router.push(`/hostel/${hostel.slug}`)}
      style={{ height: CARD_HEIGHT, width }}
    >
      <View style={{ width: imageWidth }}>
        {uri ? (
          <Image
            cachePolicy="memory-disk"
            accessibilityLabel={cover?.alt || hostel.name}
            contentFit="cover"
            source={{ uri }}
            style={{ backgroundColor: colors.muted, height: "100%", width: "100%" }}
            transition={150}
          />
        ) : (
          <View
            className="h-full w-full items-center justify-center"
            style={{ backgroundColor: colors.muted }}
          >
            <Glyph color={colors.mutedForeground} name="image" size={32} />
          </View>
        )}

        {/*
          One pill, not two. The mockup draws a single category tag here, and the
          verified tick belongs inside it — a separate Verified chip alongside
          leaves two floating labels fighting for the same corner.

          Sized to match the same pill on `HostelCard` exactly — that card's
          `TYPE_TAG_SIZE`, `font-medium`, uppercase, in a `px-1.5` pill. The two
          sit one above the other on this screen, Top Picks over Nearby, and half
          a point of difference between them reads as a mistake rather than as a
          hierarchy — which is why the size is imported rather than repeated. See
          that card for why it is this small, and for why it is a `style` rather
          than a `text-[…]` class: it is a label on a photograph, not a headline.
        */}
        <View className="absolute left-2.5 top-2.5 flex-row items-center gap-1 rounded-full bg-primary px-1.5 py-0.5">
          {hostel.verificationStatus === "VERIFIED" ? (
            <Glyph color={colors.primaryForeground} name="shield-checkmark" size={8} />
          ) : null}
          <Text
            className="font-medium uppercase tracking-wide text-primary-foreground"
            style={{ fontSize: TYPE_TAG_SIZE }}
          >
            {HOSTEL_TYPE_LABELS[hostel.hostelType]}
          </Text>
        </View>

        <View className="absolute right-3 top-3">
          <SaveButton hostel={hostel} onToggle={onToggleSave} saved={saved} />
        </View>
      </View>

      <View className="flex-1 p-2.5">
        {/*
          `flex-1` on the text stack, and it is load-bearing rather than tidying.
          Without it the stack sizes to its contents and the View Details bar
          below is simply pushed past the card's fixed height — which is what
          happened the moment a listing had one more row than its neighbour: the
          bar rendered on one card in the carousel and was clipped away on the
          next. With it the stack is capped at what is left after the bar has
          taken its 36, so the bar is always drawn and it is the text that gives
          way. Same protection at large system font sizes, where every row here
          grows and the height cannot.
        */}
        <View className="flex-1 gap-1.5">
          {/*
            Sizes come off `TYPE_SCALE`, not the `<Text>` variant table — see the
            note on that constant for why the table could not be used here. The
            ranking it encodes is the point: the name leads, the price matches it
            because those are the two things being compared across cards, the
            address and campus distance sit a step down, and the facilities are
            the quietest line on the card rather than the same size as everything
            above them.
          */}
          <Text
            className="text-foreground"
            numberOfLines={1}
            style={{ fontSize: TYPE_SCALE.name, fontWeight: "700" }}
          >
            {hostel.name}
          </Text>

          <View className="flex-row items-center gap-1">
            <Glyph color={colors.mutedForeground} name="location" size={11} />
            <Text
              className="flex-1"
              numberOfLines={1}
              style={{ color: colors.mutedForeground, fontSize: TYPE_SCALE.place }}
            >
              {locationLabel(hostel.location) || "Location not published"}
            </Text>
          </View>

          {/*
            "New" rather than 0 star for an unreviewed hostel — see ratingDisplay.

            A soft brand fill with a brand-coloured star, which is how the design
            draws it, and it is also the only warm/cool decision on the card: an
            amber star is the one non-green accent on a screen whose palette is
            white, black and one green (docs/DESIGN.md), and at this size it read
            as a warning badge rather than a score. Painted from `colors` rather
            than `bg-brand-soft` for the reason every measured value here is
            inline — one token, one place it can fail.

          */}
          <View className="flex-row">
            <View
              className="flex-row items-center gap-1 rounded-lg px-2 py-0.5"
              style={{ backgroundColor: colors.brandSoft }}
            >
              {rating.kind === "rated" ? (
                <>
                  <Glyph color={colors.primary} name="star" size={10} />
                  <Text style={{ fontSize: TYPE_SCALE.meta, fontWeight: "700" }}>
                    {rating.value}
                  </Text>
                  <Text
                    style={{ color: colors.mutedForeground, fontSize: TYPE_SCALE.meta }}
                  >
                    {`(${rating.count})`}
                  </Text>
                </>
              ) : (
                <Text
                  style={{
                    color: colors.primary,
                    fontSize: TYPE_SCALE.meta,
                    fontWeight: "600",
                  }}
                >
                  New
                </Text>
              )}
            </View>
          </View>

          {/*
            Wraps, and the price carries no `numberOfLines`. A truncated price is
            the one piece of text on this card that is worse than useless — a
            reader cannot tell `NPR 10,000 – 1…` from 12,000 or 19,000 — so if
            the column is ever too narrow, `/month` drops to the next line and
            the number stays whole.
          */}
          <View className="flex-row flex-wrap items-baseline gap-0.5">
            <Text
              style={{
                color: colors.primary,
                fontSize: TYPE_SCALE.price,
                fontWeight: "700",
              }}
            >
              {priceRange(hostel.pricing)}
            </Text>
            <Text style={{ color: colors.mutedForeground, fontSize: TYPE_SCALE.meta }}>
              /month
            </Text>
          </View>

        </View>

        {/*
          Not a `<Button>`, and it has no `onPress`: this sits inside a card that
          is already one tap target for exactly this action. A nested pressable
          would be a second, smaller target doing the same thing, and a screen
          reader would announce the hostel twice. So it is drawn as the mockup's
          soft brand bar — an affordance, not a competing control.
        */}
        <View className="mt-1.5 h-9 flex-row items-center justify-center gap-1.5 rounded-xl bg-brand-soft">
          <Text
            style={{
              color: colors.primary,
              fontSize: TYPE_SCALE.cta,
              fontWeight: "700",
            }}
          >
            View Details
          </Text>
          <Glyph color={colors.primary} name="arrow-forward" size={14} />
        </View>
      </View>
    </Pressable>
  );
}

/**
 * Position, not navigation. The dots are not tappable: at six cards they are
 * 6px targets, well under the 44px minimum, and the carousel is already
 * swipeable in both directions.
 */
function Dots({ active, count }: { active: number; count: number }) {
  return (
    <View
      accessibilityElementsHidden
      className="flex-row items-center justify-center gap-1.5"
      importantForAccessibility="no-hide-descendants"
    >
      {Array.from({ length: count }, (_, position) => (
        <View
          className={`h-1.5 rounded-full ${
            position === active ? "w-5 bg-primary" : "w-1.5 bg-border"
          }`}
          key={position}
        />
      ))}
    </View>
  );
}

/**
 * The OS "Reduce Motion" switch, read once and then watched.
 *
 * Watched rather than read on mount because the setting is a shortcut on both
 * platforms — someone turning it on mid-session is doing it *because* something
 * is moving, and this is the thing that is moving.
 */
function useReduceMotion() {
  const [reduce, setReduce] = useState(false);

  useEffect(() => {
    let cancelled = false;

    void AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
      if (!cancelled) {
        setReduce(enabled);
      }
    });

    const subscription = AccessibilityInfo.addEventListener(
      "reduceMotionChanged",
      setReduce,
    );

    return () => {
      cancelled = true;
      subscription.remove();
    };
  }, []);

  return reduce;
}
