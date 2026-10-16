import { useEffect, useRef } from "react";
import {
  Image,
  Pressable,
  ScrollView,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";

import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Glyph } from "@/components/ui/glyph";
import { Grid } from "@/components/ui/layout";
import { Money } from "@/components/ui/money";
import { Skeleton } from "@/components/ui/skeleton";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useSystemInsets } from "@/hooks/use-system-insets";
import { API_BASE_URL } from "@/lib/api";
import { absoluteMediaUrl } from "@/lib/media";
import type { StoreCategory, StoreProduct } from "@/lib/store-api";
import { discountPercent, rupees, stepperBounds } from "@/lib/store-format";

/**
 * The shop's own vocabulary — the parts a hostel-supply catalogue needs that
 * the rest of the app has no use for.
 *
 * ## What was reused instead of rebuilt
 *
 * `Card`, `Badge`, `Money`, `Skeleton` and `Text` are the app's, unchanged. What
 * is here is only what a catalogue actually adds: a product tile with a
 * photograph and a price, a quantity stepper, a search field, the featured
 * banner and the department filter. Everything else on these screens — the app
 * bar, the sheets, the empty states, the list rows — is `components/ui/`.
 *
 * ## Colour
 *
 * The reference boards this was drawn from are an orange grocery app and a blue
 * fashion app. Neither colour appears here: prices, badges and the "add"
 * controls are `--primary`, and the semantic tones carry meaning only
 * (`ui_inspiration_folder/app_recordings/NOTES.md`, "take layout, never
 * colour"). The layouts *are* theirs — the two-up product grid, the horizontal
 * deals rail, the image-led cart row with a stepper on the right.
 */

/** Corner radius on product artwork. Matches `Card`'s `rounded-2xl` at 16. */
const IMAGE_RADIUS = 14;

/**
 * Resolves a product image to something `<Image>` can actually load.
 *
 * Products carry either an uploaded `assetId` or a supplier's absolute URL, so
 * this has to handle both — and `absoluteMediaUrl` is what turns the relative
 * `/api/v1/files/…` form into an origin the phone has. Returns `null` when
 * there is nothing, which is a real case: a catalogue is stocked before it is
 * photographed.
 */
export function productImageUri(product: {
  images: { assetId: string; url: string }[];
}): string | null {
  const image = product.images[0];

  if (!image) {
    return null;
  }

  const raw =
    image.url || (image.assetId ? `/api/v1/files/${image.assetId}/url` : "");

  return raw ? absoluteMediaUrl(raw, API_BASE_URL) : null;
}

/**
 * The placeholder behind a product with no photograph.
 *
 * A tinted block with a glyph rather than a grey rectangle: the grid reads as a
 * shop either way, and a column of empty grey boxes reads as a failed load.
 */
function ProductArtwork({
  product,
  radius = IMAGE_RADIUS,
}: {
  product: StoreProduct;
  radius?: number;
}) {
  const { colors } = useAppTheme();
  const uri = productImageUri(product);

  if (!uri) {
    return (
      <View
        className="h-full w-full items-center justify-center bg-brand-soft"
        style={{ borderRadius: radius }}
      >
        <Glyph color={colors.primary} name="cube" size={26} />
      </View>
    );
  }

  return (
    <Image
      className="h-full w-full"
      resizeMode="cover"
      source={{ uri }}
      style={{ borderRadius: radius }}
    />
  );
}

/**
 * The in-basket control on a shop card: a filled brand pill that takes the exact
 * place the `Add` button had.
 *
 * ## Not `QuantityStepper`
 *
 * That one is the cart screen's: a bordered box on a white row, sized for a
 * screen whose whole job is adjusting quantities. Dropped onto a product tile it
 * read as a stray form field — an outlined widget floating under a price, with
 * no visual tie to the button it replaced.
 *
 * This is the same *behaviour* wearing the `Add` button's clothes: same height,
 * same radius, same `--primary` fill, so a product moving in and out of the
 * basket changes what the control says and never where it sits or how big it is.
 * Grocery references do exactly this, and it is the reason the swap does not
 * make the card jump.
 *
 * ## The minus removes at the floor, and stays a minus
 *
 * Stepping to zero is how everyone expects to empty a line, and a minus that
 * simply stops responding at one is the most common complaint about this
 * control — so `onRemove` is required here, unlike on `QuantityStepper`.
 *
 * It used to turn into a **bin** at quantity one, to spell out what the next tap
 * would do. On the cart screen that reads fine; in a two-up grid it drew a row
 * of waste baskets across the shop, which is an alarming thing to hang on the
 * products somebody has just chosen. The glyph is a minus at every quantity now
 * and the behaviour is unchanged — the accessibility label still says "Remove
 * from cart", so a screen reader is told the part the icon stopped saying.
 *
 * ## Nothing here disables on `busy`
 *
 * The quantity shown is already optimistic — see `useAddToCart` — so a second
 * tap has a correct number to work from, and blocking it would put back exactly
 * the lag the optimism removed. `accessibilityState` still reports `busy`, so a
 * screen reader is told what the eye can see.
 */
function CartStepper({
  busy,
  fullWidth = false,
  onChange,
  onRemove,
  product,
  quantity,
}: {
  busy: boolean;
  /** Spans the card. Off for a list row, where the control sits beside content. */
  fullWidth?: boolean;
  onChange: (next: number) => void;
  onRemove: () => void;
  product: Pick<StoreProduct, "maxOrderQuantity" | "minOrderQuantity" | "stockQuantity">;
  quantity: number;
}) {
  const { colors } = useAppTheme();
  const bounds = stepperBounds(product);
  const atFloor = quantity <= bounds.min;
  const atCeiling = quantity >= bounds.max;

  return (
    <View
      accessibilityState={{ busy }}
      className={`h-9 flex-row items-center overflow-hidden rounded-xl bg-primary ${
        fullWidth ? "w-full" : ""
      }`}
      style={fullWidth ? undefined : { width: 104 }}
    >
      <Pressable
        accessibilityLabel={atFloor ? "Remove from cart" : "Decrease quantity"}
        accessibilityRole="button"
        className="h-full w-9 items-center justify-center active:opacity-70"
        hitSlop={4}
        onPress={() => {
          if (atFloor) {
            onRemove();
            return;
          }

          onChange(quantity - 1);
        }}
      >
        <Glyph color={colors.primaryForeground} name="remove" size={16} />
      </Pressable>

      <Text
        className="flex-1 text-center text-sm font-bold"
        // The digits hold their own column so the pill does not shift a pixel
        // every time the count crosses ten.
        style={{ color: colors.primaryForeground, minWidth: 24 }}
      >
        {quantity}
      </Text>

      <Pressable
        accessibilityLabel="Increase quantity"
        accessibilityRole="button"
        className={`h-full w-9 items-center justify-center active:opacity-70 ${
          atCeiling ? "opacity-40" : ""
        }`}
        disabled={atCeiling}
        hitSlop={4}
        onPress={() => {
          onChange(quantity + 1);
        }}
      >
        <Glyph color={colors.primaryForeground} name="add" size={16} />
      </Pressable>
    </View>
  );
}

/**
 * A product as a tile, for the two-up grid.
 *
 * ## The card is four fixed bands, and that is the whole design
 *
 * Artwork, a two-line name, a price line, and a **control row that is always
 * there**. Every one of them occupies the same height on every card, so a row of
 * two tiles has its names, its prices and its buttons on the same three lines
 * whatever the products are. The earlier cut had none of that: the name grew to
 * two lines when it felt like it, the struck-through "was" price added a fourth
 * line to discounted products only, and the control appeared *below* the price
 * once the product was in the basket. Three independent reasons for one card in
 * a row to be taller than its neighbour.
 *
 * ## Adding must not resize the card
 *
 * This is the part that was actually wrong. The `+` was a 36dp square tucked
 * beside the price; tapping it swapped in a full-width stepper on a **new row**,
 * so the card grew by about 44dp, the grid re-flowed, and the tile you had just
 * touched shoved its neighbour up the screen. Adding something to a basket is
 * the most-repeated action on this screen and it was the one that made the
 * screen move.
 *
 * So the control row exists in both states and is the same height in both. `Add`
 * is a quiet brand-tinted pill; once the product is in the basket the same
 * rectangle becomes the filled stepper. Nothing above it moves, and the fill is
 * what tells you, across a grid of eight, which four are already in the cart.
 *
 * `onAdd` is optional. On the shop grid it is the whole point; on the "related"
 * rail of a product screen it is absent — a tap there should open the product,
 * and two tap targets in a 150dp tile is how people add the wrong thing — and
 * the control row goes with it, so those tiles are simply shorter, all of them
 * equally.
 */
export function ProductCard({
  busy = false,
  inCart,
  onAdd,
  onPress,
  onSetQuantity,
  product,
}: {
  busy?: boolean;
  inCart?: number;
  onAdd?: () => void;
  onPress: () => void;
  /** Absolute quantity, `0` to remove. Without it the card never shows a stepper. */
  onSetQuantity?: (next: number) => void;
  product: StoreProduct;
}) {
  const { colors } = useAppTheme();
  const discount = discountPercent(product.price, product.compareAtPrice);
  const stepping = (inCart ?? 0) > 0 && Boolean(onSetQuantity);

  return (
    <Pressable
      accessibilityLabel={product.name}
      accessibilityRole="button"
      className="active:opacity-80"
      onPress={onPress}
    >
      <Card className="gap-2" padding="p-2.5">
        <View className="aspect-square w-full">
          <ProductArtwork product={product} />

          {/*
            Its own pill rather than `<Badge tone="danger">`. That tone is a 10%
            destructive wash, which on the tinted artwork ground came out as dark
            text on almost nothing — unreadable at 10 points, and claiming an
            error tone for what is good news. A price cut is the accent's job.
          */}
          {discount ? (
            <View
              className="absolute left-1.5 top-1.5 rounded-full px-2 py-0.5"
              style={{ backgroundColor: colors.primary }}
            >
              <Text
                className="text-[10px] font-bold"
                style={{ color: colors.primaryForeground }}
              >
                {`${discount}% off`}
              </Text>
            </View>
          ) : null}

          {/*
            The out-of-stock veil sits over the artwork rather than replacing the
            card. A shop that hides what it has run out of looks smaller than it
            is, and somebody looking for the thing they bought last month needs
            to find it and be told, not to conclude it was never sold here.
          */}
          {product.inStock ? null : (
            <View
              className="absolute inset-0 items-center justify-center bg-background/70"
              style={{ borderRadius: IMAGE_RADIUS }}
            >
              <Badge label="Out of stock" tone="neutral" />
            </View>
          )}
        </View>

        <View className="gap-0.5">
          {/*
            Two lines of name whether or not the name needs two, and `medium`
            rather than `semibold`: at 13 points semibold on the system rounded
            face every tile shouted, and the price — the thing a restocking
            hostel actually compares — was the lightest text on the card.
          */}
          <View style={{ minHeight: 34 }}>
            <Text
              className="text-[12.5px] font-medium text-foreground"
              numberOfLines={2}
              style={{ lineHeight: 16.5 }}
            >
              {product.name}
            </Text>
          </View>
          <Text className="text-[10.5px] text-muted-foreground" numberOfLines={1}>
            per {product.unit}
          </Text>
        </View>

        {/*
          The "was" price sits beside the price, not under it, and drops the
          `NPR` — it is the same currency as the figure two characters to its
          left, and spelling it twice is what pushed the strike onto a row of its
          own and made every discounted card taller than its neighbour.
        */}
        <View className="flex-row items-baseline gap-1.5">
          <Money size="inline" value={rupees(product.price)} />
          {product.compareAtPrice ? (
            <Text
              className="text-[10.5px] text-muted-foreground line-through"
              numberOfLines={1}
            >
              {((product.compareAtPrice ?? 0) / 100).toLocaleString("en-NP")}
            </Text>
          ) : null}
        </View>

        {onAdd ? (
          stepping ? (
            <CartStepper
              busy={busy}
              fullWidth
              onChange={(next) => onSetQuantity?.(next)}
              onRemove={() => onSetQuantity?.(0)}
              product={product}
              quantity={inCart ?? 0}
            />
          ) : (
            <Pressable
              accessibilityLabel={`Add ${product.name} to cart`}
              accessibilityRole="button"
              accessibilityState={{ busy, disabled: !product.inStock }}
              /*
                No busy styling and no busy disable. The control swaps to the
                stepper on the same frame as the tap — see `useAddToCart` — so
                there is no in-flight moment left to draw, and dimming one would
                only put back the flicker this replaced.
              */
              className={`h-9 flex-row items-center justify-center gap-1 rounded-xl border active:opacity-70 ${
                product.inStock
                  ? "border-primary/35 bg-brand-soft"
                  : "border-border bg-muted"
              }`}
              disabled={!product.inStock}
              onPress={() => {
                onAdd();
              }}
            >
              {product.inStock ? (
                <Glyph color={colors.primary} name="add" size={15} />
              ) : null}
              <Text
                className={`text-[12.5px] font-semibold ${
                  product.inStock ? "text-primary" : "text-muted-foreground"
                }`}
              >
                {product.inStock ? "Add" : "Sold out"}
              </Text>
            </Pressable>
          )
        ) : null}
      </Card>
    </Pressable>
  );
}

/**
 * A product as a full-width row — the "Crazy Offer" list in the first reference
 * board, and what a search result should be.
 *
 * A row rather than a tile whenever the list is long and the decision is
 * "is this the one I meant": a 96dp thumbnail beside two lines of text is read
 * faster than a grid of squares, and it leaves room for the summary line that a
 * tile has to drop.
 */
export function ProductRow({
  busy = false,
  inCart,
  onAdd,
  onPress,
  onSetQuantity,
  product,
}: {
  busy?: boolean;
  inCart?: number;
  onAdd?: () => void;
  onPress: () => void;
  /** Absolute quantity, `0` to remove — see `ProductCard`. */
  onSetQuantity?: (next: number) => void;
  product: StoreProduct;
}) {
  const { colors } = useAppTheme();
  const stepping = (inCart ?? 0) > 0 && Boolean(onSetQuantity);

  return (
    <Pressable
      accessibilityLabel={product.name}
      accessibilityRole="button"
      className="active:opacity-80"
      onPress={onPress}
    >
      <Card className="flex-row items-center gap-3" padding="p-3">
        <View className="h-20 w-20">
          <ProductArtwork product={product} radius={12} />
        </View>

        <View className="min-w-0 flex-1 gap-1">
          <Text
            className="text-sm font-semibold text-foreground"
            numberOfLines={2}
          >
            {product.name}
          </Text>
          {product.summary ? (
            <Text
              className="text-[11px] text-muted-foreground"
              numberOfLines={1}
            >
              {product.summary}
            </Text>
          ) : null}
          <View className="flex-row items-center gap-2">
            <Money size="inline" value={rupees(product.price)} />
            <Text className="text-[11px] text-muted-foreground">
              / {product.unit}
            </Text>
          </View>
        </View>

        {stepping ? (
          <CartStepper
            busy={busy}
            onChange={(next) => onSetQuantity?.(next)}
            onRemove={() => onSetQuantity?.(0)}
            product={product}
            quantity={inCart ?? 0}
          />
        ) : onAdd ? (
          <Pressable
            accessibilityLabel={`Add ${product.name} to cart`}
            accessibilityRole="button"
            accessibilityState={{ busy, disabled: !product.inStock }}
            className={`h-9 items-center justify-center rounded-xl border px-3 active:opacity-70 ${
              product.inStock
                ? "border-primary/40 bg-brand-soft"
                : "border-border bg-muted"
            }`}
            disabled={!product.inStock}
            onPress={() => {
              onAdd();
            }}
          >
            <Text
              className={`text-xs font-semibold ${
                product.inStock ? "text-primary" : "text-muted-foreground"
              }`}
            >
              {product.inStock ? "Add" : "Sold out"}
            </Text>
          </Pressable>
        ) : (
          <Glyph
            color={colors.mutedForeground}
            name="chevron-forward"
            size={16}
          />
        )}
      </Card>
    </Pressable>
  );
}

/**
 * `#rrggbb` with an alpha channel bolted on.
 *
 * The one thing the token set cannot express: a colour that has to sit
 * *translucently over itself* — the plate behind a product photo on a block of
 * `--primary`, where the only two colours in play are the accent and its
 * foreground. Every palette value is a six-digit hex (`constants/theme.ts`), so
 * this is safe; it is deliberately not exported, because anywhere else the
 * answer is a token, not an opacity.
 */
function alpha(hex: string, fraction: number) {
  return `${hex}${Math.round(fraction * 255)
    .toString(16)
    .padStart(2, "0")}`;
}

/** The gutter the shop's content sits in (`px-5`), and the gap between banners. */
const BANNER_GUTTER = 20;
const BANNER_GAP = 12;

/**
 * The featured product, drawn as the reference board's promo banner: a block of
 * `--primary` with the artwork riding on the right of it.
 *
 * ## This is the banner slot, and it is not a marketing row
 *
 * The reference puts a painted "Clearance Sales" card between the search field
 * and the grid, and this screen previously had nothing there on purpose —
 * invented offer copy is exactly what the project cut from the public home.
 * What goes in it here is a **real row of the catalogue**: a product the
 * platform owner flagged `isFeatured`, with its own name, its own price and its
 * own discount if it has one. Tapping it opens that product. Nothing written on
 * it comes from the client.
 *
 * It replaced the horizontal card rail that used to carry the same list. A rail
 * of 186dp tiles under a "Featured" heading was a third product presentation on
 * a screen that now has two, and the weakest of them: too small to be the lead,
 * too loud to be part of the grid.
 */
export function FeaturedBanner({
  onPress,
  product,
  width,
}: {
  onPress: () => void;
  product: StoreProduct;
  /** Fixed by the rail, so the row snaps a whole card at a time. */
  width: number;
}) {
  const { colors } = useAppTheme();
  const discount = discountPercent(product.price, product.compareAtPrice);
  const uri = productImageUri(product);
  const plate = alpha(colors.primaryForeground, 0.16);

  return (
    <Pressable
      accessibilityLabel={`Featured: ${product.name}`}
      accessibilityRole="button"
      className="active:opacity-90"
      onPress={() => {
        onPress();
      }}
      style={{ width }}
    >
      <View
        className="h-[172px] flex-row items-center gap-3 overflow-hidden p-4"
        // Resolved rather than `bg-primary`, for the reason `StoreHeader`
        // documents: this block is big enough that a class which fails to
        // resolve reads as a black slab rather than as a missing tint.
        style={{ backgroundColor: colors.primary, borderRadius: 22 }}
      >
        <View className="min-w-0 flex-1 gap-1.5">
          <Text
            className="text-[10px] font-bold uppercase"
            style={{
              color: colors.primaryForeground,
              letterSpacing: 0.8,
              opacity: 0.8,
            }}
          >
            Featured
          </Text>

          <Text
            className="text-[17px] font-semibold"
            numberOfLines={2}
            style={{ color: colors.primaryForeground }}
          >
            {product.name}
          </Text>

          {/*
            The discount if there is one, the price if there is not — never both
            and never neither. A banner whose pill is empty is a banner with no
            reason to be looked at.
          */}
          <View
            className="mt-0.5 flex-row items-center gap-1.5 self-start rounded-full px-3 py-1"
            style={{ backgroundColor: plate }}
          >
            <Glyph
              color={colors.primaryForeground}
              name={discount ? "pricetag" : "cube"}
              size={12}
            />
            <Text
              className="text-[12px] font-bold"
              style={{ color: colors.primaryForeground }}
            >
              {discount
                ? `Up to ${discount}% off`
                : `NPR ${(product.price / 100).toLocaleString("en-NP")}`}
            </Text>
          </View>
        </View>

        <View
          className="h-[132px] w-[132px] items-center justify-center overflow-hidden"
          style={{ backgroundColor: plate, borderRadius: 18 }}
        >
          {uri ? (
            <Image
              className="h-full w-full"
              resizeMode="cover"
              source={{ uri }}
              style={{ borderRadius: 18 }}
            />
          ) : (
            <Glyph
              color={colors.primaryForeground}
              name="cube"
              size={34}
            />
          )}
        </View>
      </View>
    </Pressable>
  );
}

/**
 * The featured banners as one snapping row.
 *
 * A carousel rather than a single banner because `isFeatured` is a flag on any
 * number of products, and drawing only the first would silently hide the rest
 * of what the platform is pushing. It snaps a whole card at a time so a half
 * banner never comes to rest on screen — the thing that makes a free-scrolling
 * promo strip look broken.
 *
 * The card is the screen's full content width, so with one featured product
 * this is a plain banner with nothing to scroll, which is the common case.
 */
const AUTO_SCROLL_MS = 3500;

export function FeaturedRail({
  onPressProduct,
  products,
}: {
  onPressProduct: (product: StoreProduct) => void;
  products: readonly StoreProduct[];
}) {
  const { width } = useWindowDimensions();
  const cardWidth = Math.max(240, width - BANNER_GUTTER * 2);
  const step = cardWidth + BANNER_GAP;

  const listRef = useRef<ScrollView>(null);
  const indexRef = useRef(0);
  const pausedRef = useRef(false);

  /*
   * Advances one card every few seconds and loops back to the first once it
   * runs out — the same "cycle while you're not touching it" behaviour every
   * banking-app promo rail on the phones in `NOTES.md` already has, and the
   * reason a single-product shop still needs this: `pausedRef` is set for the
   * whole gesture so a mid-drag timer tick cannot fight the finger on screen.
   */
  useEffect(() => {
    if (products.length < 2) {
      return;
    }

    const timer = setInterval(() => {
      if (pausedRef.current) {
        return;
      }

      indexRef.current = (indexRef.current + 1) % products.length;
      listRef.current?.scrollTo({ animated: true, x: indexRef.current * step });
    }, AUTO_SCROLL_MS);

    return () => clearInterval(timer);
  }, [products.length, step]);

  if (products.length === 0) {
    return null;
  }

  return (
    <ScrollView
      contentContainerStyle={{
        gap: BANNER_GAP,
        paddingHorizontal: BANNER_GUTTER,
      }}
      decelerationRate="fast"
      horizontal
      onMomentumScrollEnd={(event) => {
        pausedRef.current = false;
        indexRef.current = Math.round(
          event.nativeEvent.contentOffset.x / step,
        );
      }}
      onScrollBeginDrag={() => {
        pausedRef.current = true;
      }}
      ref={listRef}
      showsHorizontalScrollIndicator={false}
      snapToAlignment="start"
      snapToInterval={step}
    >
      {products.map((product) => (
        <FeaturedBanner
          key={product.id}
          onPress={() => onPressProduct(product)}
          product={product}
          width={cardWidth}
        />
      ))}
    </ScrollView>
  );
}

/**
 * The departments, as a scrolling row of filter pills with `All` at the head.
 *
 * ## Why this replaced the tile grid
 *
 * The shop used to open on a 4-up grid of square department tiles above a list
 * of products that ignored them — tapping a tile pushed a different screen
 * entirely. So the top third of the shop was a menu, and the shop itself
 * started below the fold.
 *
 * These pills are the same departments doing a different job: they **filter the
 * grid in place**, which is what the reference board does and what makes the
 * products the subject of the screen rather than the thing under the menu. The
 * tiles are not gone — the Departments tab is still a grid of shelves, because
 * comparing departments is a real task and a rail of pills is a poor way to do
 * it.
 *
 * ## Selected is filled, not tinted
 *
 * `NOTES.md` §7: the selected chip is **filled with the accent**. That is why
 * this is not `<Chip tone="brand">` — `Chip`'s brand tone is a soft tinted pill,
 * right for a static label (a sort order, a tag) and far too quiet for the one
 * pill in a row of twelve that says which list you are currently looking at.
 */
export function CategoryChips({
  categories,
  onChange,
  value,
}: {
  categories: readonly StoreCategory[];
  onChange: (slug: string | null) => void;
  /** A category slug, or `null` for `All`. */
  value: string | null;
}) {
  const { colors } = useAppTheme();

  const options: { label: string; slug: string | null }[] = [
    { label: "All", slug: null },
    ...categories.map((category) => ({
      label: category.name,
      slug: category.slug,
    })),
  ];

  return (
    <ScrollView
      contentContainerStyle={{ gap: 8, paddingHorizontal: BANNER_GUTTER }}
      horizontal
      showsHorizontalScrollIndicator={false}
    >
      {options.map((option) => {
        const selected = option.slug === value;

        return (
          <Pressable
            accessibilityLabel={option.label}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            className="active:opacity-70"
            key={option.slug ?? "all"}
            onPress={() => {
              onChange(option.slug);
            }}
          >
            <View
              className={`h-9 justify-center rounded-full border px-4 ${
                selected ? "border-primary" : "border-border bg-card"
              }`}
              style={selected ? { backgroundColor: colors.primary } : undefined}
            >
              <Text
                className={`text-[12.5px] ${selected ? "font-semibold" : "font-medium"}`}
                numberOfLines={1}
                style={{
                  color: selected
                    ? colors.primaryForeground
                    : colors.foreground,
                }}
              >
                {option.label}
              </Text>
            </View>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

/**
 * The search field that rides on the painted header.
 *
 * A white pill on the accent block, straddling nothing — it sits *inside* the
 * colour, which is where both reference boards put it. It is a plain
 * `TextInput` rather than `<Input>`: that component draws a bordered card field
 * with a label above it, which is the right thing in a form and the wrong thing
 * on a coloured bar.
 */
export function StoreSearchField({
  autoFocus = false,
  onChangeText,
  onSubmit,
  placeholder = "Search the store",
  value,
}: {
  autoFocus?: boolean;
  onChangeText: (next: string) => void;
  onSubmit?: () => void;
  placeholder?: string;
  value: string;
}) {
  const { colors } = useAppTheme();

  return (
    <View className="h-11 flex-row items-center gap-2 rounded-2xl bg-card px-3.5">
      <Glyph color={colors.mutedForeground} name="search" size={17} />
      <TextInput
        autoCapitalize="none"
        autoCorrect={false}
        autoFocus={autoFocus}
        className="flex-1 text-sm text-foreground"
        onChangeText={onChangeText}
        onSubmitEditing={onSubmit}
        placeholder={placeholder}
        placeholderTextColor={colors.mutedForeground}
        returnKeyType="search"
        value={value}
      />
      {value.length > 0 ? (
        <Pressable
          accessibilityLabel="Clear search"
          accessibilityRole="button"
          hitSlop={10}
          onPress={() => onChangeText("")}
        >
          <Glyph
            color={colors.mutedForeground}
            name="close-circle"
            size={17}
          />
        </Pressable>
      ) : null}
    </View>
  );
}

/**
 * Minus, a number, plus.
 *
 * The bounds come from `stepperBounds`, which reads the server's own vocabulary
 * — `maxOrderQuantity: 0` is "no cap", `stockQuantity: null` is "not tracked" —
 * so a disabled plus button here always has a reason the server would give too.
 *
 * At the floor the minus turns into a **bin**. Stepping to zero is how everyone
 * expects to empty a cart line, and a minus that simply stops working at one is
 * the most common complaint about this control.
 */
export function QuantityStepper({
  busy = false,
  onChange,
  onRemove,
  product,
  quantity,
}: {
  busy?: boolean;
  onChange: (next: number) => void;
  onRemove?: () => void;
  product: Pick<
    StoreProduct,
    "maxOrderQuantity" | "minOrderQuantity" | "stockQuantity"
  >;
  quantity: number;
}) {
  const { colors } = useAppTheme();
  const bounds = stepperBounds(product);
  const atFloor = quantity <= bounds.min;
  const atCeiling = quantity >= bounds.max;

  return (
    <View className="h-9 flex-row items-center rounded-xl border border-border bg-card">
      <Pressable
        accessibilityLabel={
          atFloor && onRemove ? "Remove from cart" : "Decrease quantity"
        }
        accessibilityRole="button"
        className="h-full w-9 items-center justify-center active:opacity-60"
        disabled={busy || (atFloor && !onRemove)}
        onPress={() => {
          if (atFloor) {
            onRemove?.();
            return;
          }

          onChange(quantity - 1);
        }}
      >
        <Glyph
          color={
            busy || (atFloor && !onRemove)
              ? colors.mutedForeground
              : colors.foreground
          }
          name={atFloor && onRemove ? "trash" : "remove"}
          size={16}
        />
      </Pressable>

      <Text
        className="min-w-8 text-center text-sm font-semibold text-foreground"
        // A style, not `min-w-8` alone: the digits have to hold their column so
        // the row does not jump a pixel every time it crosses ten.
        style={{ minWidth: 32 }}
      >
        {quantity}
      </Text>

      <Pressable
        accessibilityLabel="Increase quantity"
        accessibilityRole="button"
        className="h-full w-9 items-center justify-center active:opacity-60"
        disabled={busy || atCeiling}
        onPress={() => {
          onChange(quantity + 1);
        }}
      >
        <Glyph
          color={busy || atCeiling ? colors.mutedForeground : colors.foreground}
          name="add"
          size={16}
        />
      </Pressable>
    </View>
  );
}

/**
 * The free-delivery progress bar from the reference cart screen.
 *
 * The number and the phrasing both come from the server — see
 * `freeDeliveryNote` — because the threshold is a commercial rule the platform
 * owner edits from a form, and a client that recomputed it would go stale the
 * moment they did.
 */
export function FreeDeliveryBar({
  note,
  progress,
}: {
  note: string;
  progress: number;
}) {
  // A resolved token, never a literal. `#0a8a4b` is the light-mode brand green
  // and would stay that exact green in dark mode, where `--primary` is `#12a95d`.
  const { colors } = useAppTheme();

  return (
    <View className="gap-2 rounded-2xl border border-primary/25 bg-brand-soft px-3.5 py-3">
      <View className="flex-row items-center gap-2">
        <Glyph color={colors.primary} name="bicycle" size={16} />
        <Text className="flex-1 text-xs font-semibold text-primary">
          {note}
        </Text>
      </View>

      {/* Hidden at 1 — a full bar under "delivery is free" is a bar with
          nothing left to say. */}
      {progress < 1 ? (
        <View className="h-1.5 overflow-hidden rounded-full bg-primary/15">
          <View
            className="h-full rounded-full bg-primary"
            style={{ width: `${Math.round(progress * 100)}%` }}
          />
        </View>
      ) : null}
    </View>
  );
}

/**
 * Skeleton cards shaped like the product grid, for the first load.
 *
 * `NOTES.md` §9: loading is skeletons, not spinners. A shop is the screen where
 * that matters most — a spinner on a grid gives no sense of how much is coming.
 */
export function ProductGridSkeleton({ count = 4 }: { count?: number }) {
  return (
    <Grid gap={12} maxColumns={2} minCellWidth={148}>
      {Array.from({ length: count }, (_, index) => (
        <View key={index}>
          <Card className="gap-2.5" padding="p-2.5">
            <Skeleton height={120} radius={IMAGE_RADIUS} />
            <Skeleton height={12} width="80%" />
            <Skeleton height={12} width="45%" />
          </Card>
        </View>
      ))}
    </Grid>
  );
}

/**
 * The store's painted header: a block of `--primary` with rounded bottom
 * corners, holding the back arrow, the title, a cart shortcut and the search
 * field.
 *
 * Not `<AppBar accent>` plus a search field underneath it, and the difference is
 * the whole point. `AppBar` paints a block and ends; a field placed after it
 * lands on the page background, which is the flat-strip-plus-toolbar look the
 * references specifically do not have. Here the field sits *inside* the colour —
 * `ebl-03` and both product boards do exactly this — and the block's rounded
 * bottom is what turns the header into an object rather than browser chrome.
 *
 * The radius and the inset handling are `AppBar`'s own (`HEADER_RADIUS`, and the
 * bar extending into the status bar rather than being pushed below it), restated
 * here because this is the one screen family that needs a taller version of the
 * same block.
 */
export function StoreHeader({
  cartCount = 0,
  onBack,
  onCart,
  onChangeSearch,
  onSubmitSearch,
  search,
  subtitle,
  title,
}: {
  cartCount?: number;
  onBack: () => void;
  onCart?: () => void;
  onChangeSearch: (next: string) => void;
  onSubmitSearch?: () => void;
  search: string;
  subtitle?: string;
  title: string;
}) {
  const insets = useSystemInsets();
  const { colors } = useAppTheme();

  return (
    <View
      // A resolved colour rather than `bg-primary`, for the reason `AppBar`
      // documents: this strip is the one surface with nothing behind it but the
      // window, so a class that fails to resolve renders it as a black bar under
      // the clock.
      style={{
        backgroundColor: colors.primary,
        borderBottomLeftRadius: 20,
        borderBottomRightRadius: 20,
        paddingTop: insets.top,
      }}
    >
      <View className="gap-3 px-5 pb-4 pt-2">
        <View className="h-11 flex-row items-center gap-3">
          <Pressable
            accessibilityLabel="Go back"
            accessibilityRole="button"
            hitSlop={12}
            onPress={onBack}
          >
            <Glyph
              color={colors.primaryForeground}
              name="chevron-back"
              size={26}
            />
          </Pressable>

          <View className="flex-1">
            <Text
              className="font-semibold"
              style={{ color: colors.primaryForeground, fontSize: 17 }}
            >
              {title}
            </Text>
            {subtitle ? (
              <Text
                style={{
                  color: colors.primaryForeground,
                  fontSize: 11,
                  opacity: 0.85,
                }}
              >
                {subtitle}
              </Text>
            ) : null}
          </View>

          {onCart ? (
            <Pressable
              accessibilityLabel={`Cart, ${cartCount} ${cartCount === 1 ? "item" : "items"}`}
              accessibilityRole="button"
              hitSlop={12}
              onPress={onCart}
            >
              <Glyph
                color={colors.primaryForeground}
                name="cart"
                size={22}
              />
              {cartCount > 0 ? (
                <View
                  className="absolute -right-2 -top-1.5 h-4 items-center justify-center rounded-full bg-card px-1"
                  style={{ minWidth: 16 }}
                >
                  <Text className="text-[10px] font-bold text-primary">
                    {cartCount}
                  </Text>
                </View>
              ) : null}
            </Pressable>
          ) : null}
        </View>

        <StoreSearchField
          onChangeText={onChangeSearch}
          onSubmit={onSubmitSearch}
          value={search}
        />
      </View>
    </View>
  );
}
