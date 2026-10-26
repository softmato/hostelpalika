import { Image } from "expo-image";
import { useCallback, useEffect, useRef } from "react";
import { Pressable, useWindowDimensions } from "react-native";
import Animated, {
  Extrapolation,
  interpolate,
  runOnJS,
  type SharedValue,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
} from "react-native-reanimated";

import { Text } from "@/components/ui/text";
import { tradeArt, tradeArtUri } from "@/lib/trade-art";

/**
 * A deck of services you flick through, one at a time.
 *
 * ## Why a carousel here and nowhere else in the app
 *
 * `docs/DESIGN.md` and `NOTES.md` are consistent that a menu of destinations is
 * a **grid of tiles**, never a carousel — a carousel hides most of its options
 * off-screen and makes counting them impossible, which is exactly wrong for
 * navigation. This is not navigation. Picking the trade for a maintenance
 * request is a single choice from a short mutually-exclusive list, made once,
 * where the *chosen* one wants to be large enough to carry a price and a
 * sentence. That is the one shape a deck is better at than a grid, and it is
 * what the owner's sketch asked for.
 *
 * It is still list-shaped underneath: a horizontal `ScrollView` with snapping,
 * so the platform's own scrolling, momentum and accessibility all work. Nothing
 * here reimplements a gesture.
 *
 * ## Each card is a person, and each is a different colour
 *
 * Asked for directly (2026-09-02): *"the box with vector images of doctors,
 * plumber card, colourful card, swappable"*. The drawings are inline SVG through
 * `expo-image` — see `lib/trade-art.ts` for why that and not `react-native-svg`,
 * and for the note about the palette, which this deck is the app's one
 * deliberate exception to.
 *
 * The colour is doing a job: eleven identical grey glyphs mean the label has to
 * be *read* on every card, and the whole reason for a deck is that the card
 * under your thumb is recognised without reading. Selection is still the brand
 * green ring, so nothing here competes with `--primary` for meaning.
 *
 * ## The motion
 *
 * Cards to either side sit back — smaller and dimmer — so the centre card is
 * unambiguously the selection without needing a tick on it. `interpolate` runs
 * on the UI thread off the scroll offset, so it tracks the finger rather than
 * animating after it; a `withTiming` on every card as the index changed would
 * lag behind a fast flick and read as the list fighting you.
 *
 * Snapping is `snapToInterval`, not `pagingEnabled`: the cards are narrower than
 * the screen on purpose — the neighbours have to be visible, or nothing tells
 * you the deck continues — and paging snaps to screen widths.
 *
 * ## Selection is committed on settle, not on every frame
 *
 * `onSelect` fires when the deck comes to rest on a new card, once, with a
 * selection tick. Firing per frame would refetch and re-render the confirm
 * figures dozens of times during a single flick.
 */

export type ServiceCard = {
  /** The category enum — also the key into the illustration set. */
  id: string;
  label: string;
  /** One line under the label — the agreed charge, or that there is not one. */
  note: string;
};

/** Card width as a fraction of the window, so the neighbours stay visible. */
const CARD_FRACTION = 0.62;
const GAP = 12;

export function ServiceCarousel({
  cards,
  onSelect,
  selectedId,
}: {
  cards: ServiceCard[];
  onSelect: (id: string) => void;
  selectedId: string | null;
}) {
  const { width } = useWindowDimensions();
  const cardWidth = Math.round(width * CARD_FRACTION);
  const interval = cardWidth + GAP;
  /* Half the leftover, so the first and last cards can still centre. */
  const sidePad = Math.max(0, Math.round((width - cardWidth) / 2));

  const offset = useSharedValue(0);
  const listRef = useRef<Animated.ScrollView>(null);

  const index = Math.max(
    0,
    cards.findIndex((card) => card.id === selectedId),
  );

  const commit = useCallback(
    (next: number) => {
      const card = cards[next];

      if (!card || card.id === selectedId) {
        return;
      }
      onSelect(card.id);
    },
    [cards, onSelect, selectedId],
  );

  const scrollHandler = useAnimatedScrollHandler({
    /*
     * A slow drag that stops without flinging never fires `onMomentumEnd`, and
     * the card under the thumb would then stay unselected — the deck looking
     * like it had ignored the gesture. This is the case that is easy to miss on
     * a simulator, where every scroll is a fling.
     *
     * Both handlers can fire for one gesture (drag, then momentum); `commit`
     * ignores a selection that is already current, so the second is a no-op.
     */
    onEndDrag: (event) => {
      runOnJS(commit)(Math.round(event.contentOffset.x / interval));
    },
    onMomentumEnd: (event) => {
      runOnJS(commit)(Math.round(event.contentOffset.x / interval));
    },
    onScroll: (event) => {
      offset.value = event.contentOffset.x;
    },
  });

  /*
   * Keep the deck under the selection when it is changed from outside — the
   * search field below filters the cards, and the chosen one has to still be the
   * one on screen afterwards.
   */
  useEffect(() => {
    listRef.current?.scrollTo({ animated: true, x: index * interval, y: 0 });
  }, [index, interval]);

  if (cards.length === 0) {
    return null;
  }

  return (
    <Animated.ScrollView
      contentContainerStyle={{ gap: GAP, paddingHorizontal: sidePad }}
      decelerationRate="fast"
      horizontal
      onScroll={scrollHandler}
      ref={listRef}
      scrollEventThrottle={16}
      showsHorizontalScrollIndicator={false}
      snapToInterval={interval}
    >
      {cards.map((card, position) => (
        <DeckCard
          card={card}
          interval={interval}
          key={card.id}
          offset={offset}
          onPress={() => commit(position)}
          position={position}
          selected={card.id === selectedId}
          width={cardWidth}
        />
      ))}
    </Animated.ScrollView>
  );
}

function DeckCard({
  card,
  interval,
  offset,
  onPress,
  position,
  selected,
  width,
}: {
  card: ServiceCard;
  interval: number;
  offset: SharedValue<number>;
  onPress: () => void;
  position: number;
  selected: boolean;
  width: number;
}) {
  const { tint } = tradeArt(card.id);

  const style = useAnimatedStyle(() => {
    const distance = offset.value / interval - position;

    return {
      opacity: interpolate(
        Math.abs(distance),
        [0, 1],
        [1, 0.45],
        Extrapolation.CLAMP,
      ),
      transform: [
        {
          scale: interpolate(
            Math.abs(distance),
            [0, 1],
            [1, 0.88],
            Extrapolation.CLAMP,
          ),
        },
      ],
    };
  });

  return (
    <Animated.View style={[{ width }, style]}>
      <Pressable
        accessibilityLabel={`${card.label}. ${card.note}`}
        accessibilityRole="button"
        accessibilityState={{ selected }}
        className={`items-center gap-2 overflow-hidden rounded-3xl border-2 px-4 py-5 active:opacity-80 ${
          selected ? "border-primary" : "border-transparent"
        }`}
        onPress={onPress}
        /*
          The trade's own tint, as a resolved value rather than a class.

          There is no Tailwind class for eleven runtime colours, and this is the
          one surface in the app painted from `lib/trade-art.ts` rather than from
          the theme. The selected *border* is still `--primary` through a class,
          so the two never disagree about which card is chosen.
        */
        style={{ backgroundColor: tint }}
      >
        <Image
          cachePolicy="memory-disk"
          accessibilityIgnoresInvertColors
          contentFit="contain"
          source={{ uri: tradeArtUri(card.id) }}
          style={{ height: 88, width: 88 }}
          /*
            No transition and no placeholder: the source is a `data:` URI that is
            already in memory, so a fade would be animating something that was
            never loading.
          */
          transition={0}
        />

        <Text
          className="text-center text-sm font-bold text-foreground"
          numberOfLines={1}
        >
          {card.label}
        </Text>

        {/*
          Dark ink on the tint rather than `--muted-foreground`: the card is
          painted, so the theme's muted grey — which is chosen against
          `--background` — is the one colour here that could fail contrast.
        */}
        <Text
          className="text-center text-xs font-semibold text-foreground/70"
          numberOfLines={2}
        >
          {card.note}
        </Text>
      </Pressable>
    </Animated.View>
  );
}
