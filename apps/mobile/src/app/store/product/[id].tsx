import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Image, Pressable, ScrollView, View } from "react-native";

import { useAddToCart, useStoreCart } from "@/components/store/store-cart";
import {
  ProductCard,
  QuantityStepper,
  productImageUri,
} from "@/components/store/store-ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, SectionHeader } from "@/components/ui/card";
import { Glyph, type GlyphName } from "@/components/ui/glyph";
import { FactRow } from "@/components/ui/layout";
import { Money } from "@/components/ui/money";
import { Screen } from "@/components/ui/screen";
import { Skeleton, SkeletonCard } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useResource } from "@/hooks/use-resource";
import { useSystemInsets } from "@/hooks/use-system-insets";

import { discountPercent, rupees, stepperBounds } from "@/lib/store-format";
import { storeQuery } from "@/lib/store-queries";

/**
 * One product.
 *
 * ## It is on the root stack, not in `(store)`
 *
 * Two reasons, and the second is the one that decided it. A folder nested under
 * a `<Tabs>` layout becomes another tab unless it is named in `hidden`, which is
 * the trap `(admin)` documents. But more importantly the reference board draws
 * this screen **full-bleed** — the photograph runs to the top of the display with
 * a floating back button on it and no bar — and a screen inside the tab group
 * would be drawing that under a tab bar it has no use for.
 *
 * ## The picture is the header
 *
 * No `AppBar`. The image occupies the top of the screen and the back and cart
 * controls float on it as circular glass buttons, which is what both product
 * boards do. A green bar above a photograph would be two headers.
 *
 * ## The quantity is chosen here, before adding
 *
 * The shop grid adds one at a time because the decision there is *which*. Here
 * the decision is *how many* — this is where somebody works out they need eleven
 * buckets — so the stepper is on the sticky footer beside the price, and the
 * button adds all of them in one request.
 */
export default function StoreProductScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSystemInsets();
  const { colors } = useAppTheme();
  const cart = useStoreCart();
  const { add, addingProductId, setQuantity: setCartQuantity } = useAddToCart();

  const [quantity, setQuantity] = useState(1);

  const productQuery = storeQuery.product(String(id));
  const resource = useResource(productQuery.load, {
    cacheKey: productQuery.key,
    topics: productQuery.topics,
  });

  const product = resource.data?.product;

  if (resource.loading) {
    return (
      <Screen>
        <View className="gap-4">
          <Skeleton height={260} radius={16} />
          <SkeletonCard rows={3} />
        </View>
      </Screen>
    );
  }

  if (resource.error || !product) {
    return (
      <Screen>
        <ErrorState
          message={resource.error ?? "That product is no longer available."}
          onRetry={resource.reload}
        />
      </Screen>
    );
  }

  const uri = productImageUri(product);
  const discount = discountPercent(product.price, product.compareAtPrice);
  const bounds = stepperBounds(product);

  return (
    <Screen
      bleedTop
      footer={
        <View className="flex-row items-center gap-3 px-5 pt-3">
          <QuantityStepper
            busy={addingProductId === product.id}
            onChange={setQuantity}
            product={product}
            quantity={quantity}
          />

          <Button
            className="flex-1"
            disabled={!product.inStock}
            label={
              product.inStock
                ? `${cart.lineQuantities[product.id] ? `In cart · ${cart.lineQuantities[product.id]} · ` : ""}Add · NPR ${(
                    (product.price * quantity) /
                    100
                  ).toLocaleString("en-NP")}`
                : "Out of stock"
            }
            loading={addingProductId === product.id}
            onPress={() => void add(product, quantity)}
            size="lg"
          />
        </View>
      }
      padded={false}
      scroll
    >
      <View className="h-[320px] w-full bg-brand-soft">
        {uri ? (
          <Image className="h-full w-full" resizeMode="cover" source={{ uri }} />
        ) : (
          <View className="h-full w-full items-center justify-center">
            <Glyph color={colors.primary} name="cube" size={56} />
          </View>
        )}

        {/*
          Floating controls, inset by the status bar rather than pushed below it.
          The photograph is meant to run under the clock — that is the whole
          point of a bleeding header — so the buttons take the inset and the
          image does not.
        */}
        <View
          className="absolute left-0 right-0 flex-row items-center justify-between px-4"
          style={{ top: insets.top + 8 }}
        >
          <GlassButton icon="chevron-back" label="Go back" onPress={() => router.back()} />
          <GlassButton
            badge={cart.itemCount}
            icon="cart"
            label="Open the cart"
            onPress={() => router.push("/(store)/cart")}
          />
        </View>

        {discount ? (
          <View className="absolute bottom-4 left-4">
            <Badge label={`${discount}% off`} tone="danger" />
          </View>
        ) : null}
      </View>

      <View className="gap-5 px-5 pt-5">
        <View className="gap-2">
          <Text className="text-xs font-semibold uppercase tracking-wide text-primary">
            {product.categoryName}
          </Text>
          <Text variant="title">{product.name}</Text>
          {product.summary ? <Text variant="muted">{product.summary}</Text> : null}

          <View className="mt-1 flex-row items-end gap-2">
            <Money size="large" value={rupees(product.price)} />
            {product.compareAtPrice ? (
              <Text className="pb-1 text-sm text-muted-foreground line-through">
                {`NPR ${(product.compareAtPrice / 100).toLocaleString("en-NP")}`}
              </Text>
            ) : null}
            <Text className="pb-1 text-xs text-muted-foreground">per {product.unit}</Text>
          </View>
        </View>

        {product.description ? (
          <View>
            <SectionHeader title="Description" />
            <Card>
              <Text variant="muted">{product.description}</Text>
            </Card>
          </View>
        ) : null}

        <View>
          <SectionHeader title="Details" />
          <Card padding="px-4 py-1">
            <FactRow label="Sold by" value="the unit" />
            <FactRow label="Unit" value={product.unit} />
            <FactRow
              label="Availability"
              value={
                product.stockQuantity === null
                  ? "Made to order"
                  : product.stockQuantity > 0
                    ? `${product.stockQuantity} in stock`
                    : "Out of stock"
              }
            />
            <FactRow
              label="Minimum per order"
              value={`${product.minOrderQuantity} ${product.unit}`}
            />
            {bounds.max !== Number.POSITIVE_INFINITY ? (
              <FactRow label="Maximum per order" value={`${bounds.max} ${product.unit}`} />
            ) : null}
          </Card>
        </View>

        {(resource.data?.related.length ?? 0) > 0 ? (
          <View className="pb-2">
            <SectionHeader
              subtitle={`More from ${product.categoryName}`}
              title="You might also need"
            />

            {/*
              No `onAdd` on these. A tap here should open the product — two tap
              targets in a 158dp tile beside a sticky Add-to-cart bar is how
              somebody adds the wrong thing.
            */}
            <ScrollView
              contentContainerClassName="gap-3"
              horizontal
              showsHorizontalScrollIndicator={false}
            >
              {(resource.data?.related ?? []).map((related) => (
                <View key={related.id} style={{ width: 186 }}>
                  <ProductCard
                    inCart={cart.lineQuantities[related.id]}
                    onAdd={() => void add(related, 1)}
                    onSetQuantity={(next) => void setCartQuantity(related, next)}
                    onPress={() => router.replace(`/store/product/${related.id}`)}
                    product={related}
                  />
                </View>
              ))}
            </ScrollView>
          </View>
        ) : null}
      </View>
    </Screen>
  );
}

/**
 * A circular control that floats on the photograph.
 *
 * Semi-opaque card fill rather than a tint of the image: a translucent white
 * circle is legible over a dark product shot *and* a light one, which a coloured
 * button is not — and the app has no blur primitive that works identically on
 * both platforms.
 */
function GlassButton({
  badge = 0,
  icon,
  label,
  onPress,
}: {
  badge?: number;
  icon: GlyphName;
  label: string;
  onPress: () => void;
}) {
  const { colors } = useAppTheme();

  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      className="h-10 w-10 items-center justify-center rounded-full bg-card/90 active:opacity-70"
      hitSlop={8}
      onPress={onPress}
    >
      <Glyph color={colors.foreground} name={icon} size={20} />
      {badge > 0 ? (
        <View
          className="absolute -right-0.5 -top-0.5 h-4 items-center justify-center rounded-full bg-primary px-1"
          style={{ minWidth: 16 }}
        >
          <Text className="text-[10px] font-bold text-primary-foreground">{badge}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}
