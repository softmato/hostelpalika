import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useCallback, useState } from "react";
import { Image, Pressable, View } from "react-native";

import { useStoreCart } from "@/components/store/store-cart";
import {
  FreeDeliveryBar,
  QuantityStepper,
  productImageUri,
} from "@/components/store/store-ui";
import { AppBar } from "@/components/ui/app-bar";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Money } from "@/components/ui/money";
import { Screen } from "@/components/ui/screen";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { SkeletonRows } from "@/components/ui/skeleton";
import { Text } from "@/components/ui/text";

import { useAppTheme } from "@/hooks/use-app-theme";
import { useResource } from "@/hooks/use-resource";
import { readApiError } from "@/lib/api-contract";
import { openConfirm } from "@/lib/confirm";
import {
  removeFromCart,
  setCartQuantity,
  type CartLine,
  type CartResult,
} from "@/lib/store-api";
import { freeDeliveryNote, freeDeliveryProgress, limitNote, rupees, stepperBounds } from "@/lib/store-format";
import { toastError } from "@/lib/toast";
import { storeQuery } from "@/lib/store-queries";

/**
 * The basket.
 *
 * Laid out like the third panel of the second reference board: the free-delivery
 * strip at the top, image-led rows with a stepper on the right, then a summary
 * block and one full-width action. What is not taken from it is the promo-code
 * field — there are no promo codes, and a dead input above the total is worse
 * than no input at all.
 *
 * ## The totals are never computed here
 *
 * `cart.totals` comes from the server and is rendered as-is. The delivery rule
 * is a commercial setting the platform owner edits from a form, so a client that
 * added its own fee would be wrong the moment they changed it — and it would be
 * wrong *quietly*, showing one number here and charging another at checkout.
 *
 * ## Every write replaces the whole basket
 *
 * `setCartQuantity` and `removeFromCart` return the full cart, so the row does
 * not patch state locally and hope. That is what makes a clamp visible: ask for
 * twelve with four in stock and the row comes back showing four with "Only 4
 * left" under it, rather than showing twelve until checkout refuses.
 */
export default function StoreCartScreen() {
  const [busyProductId, setBusyProductId] = useState<string | null>(null);
  const storeCart = useStoreCart();

  const cartQuery = storeQuery.cart();
  const cart = useResource(cartQuery.load, {
    cacheKey: cartQuery.key,
    topics: cartQuery.topics,
  });

  const { setData } = cart;

  const apply = useCallback(
    async (productId: string, run: () => Promise<CartResult>) => {
      setBusyProductId(productId);

      try {
        const result = await run();

        setData(() => result);

        if (result.clamped === "stock") {
          toastError("Not that many in stock", "The quantity was reduced to what is left.");
        }
      } catch (error) {
        toastError("Could not update the cart", readApiError(error));
      } finally {
        setBusyProductId(null);
        storeCart.refresh();
      }
    },
    [setData, storeCart],
  );

  const header = <AppBar accent centerTitle showBack title="Your cart" />;

  if (cart.error && !cart.data) {
    return (
      <Screen header={header} insideTabs>
        <ErrorState message={cart.error} onRetry={cart.reload} />
      </Screen>
    );
  }

  if (cart.loading) {
    return (
      <Screen header={header} insideTabs scroll>
        <View className="pt-4">
          <SkeletonRows rows={4} />
        </View>
      </Screen>
    );
  }

  const basket = cart.data?.cart;
  const lines = basket?.items ?? [];
  const totals = basket?.totals;

  if (lines.length === 0) {
    return (
      <Screen header={header} insideTabs onRefresh={cart.refresh} refreshing={cart.refreshing} scroll>
        <EmptyState
          action={
            <Button
              label="Browse the store"
              onPress={() => router.replace("/(store)")}
              variant="outline"
            />
          }
          description="Add something from the shop and it will show up here."
          title="Your cart is empty"
        />
      </Screen>
    );
  }

  const note = totals ? freeDeliveryNote(totals) : null;

  return (
    <Screen
      footer={
        <View className="gap-3 px-5 pt-3">
          {/*
            The summary sits in the sticky footer with the button, not in the
            scroll. A total that scrolls away is a total somebody has to hunt
            for at the exact moment they are deciding whether to commit.
          */}
          <View>
            <View className="gap-2">
              <SummaryRow label="Subtotal" value={totals?.subtotal ?? 0} />
              <SummaryRow
                free={totals?.deliveryFee === 0}
                label="Delivery"
                value={totals?.deliveryFee ?? 0}
              />
            </View>
            <View className="mt-3 flex-row items-center justify-between border-t border-border pt-3">
              <Text variant="subtitle">Total</Text>
              <Money size="large" value={rupees(totals?.total ?? 0)} />
            </View>
          </View>

          {/*
            The promise is the server's sentence, and the separator only exists
            when there is one to separate — an older API build that does not
            send it would otherwise leave "Cash on delivery · " trailing off.
          */}
          <Text variant="caption">
            {basket?.config.deliveryPromise?.arrivesText
              ? `Cash on delivery · ${basket.config.deliveryPromise.arrivesText}`
              : "Cash on delivery"}
          </Text>

          <Button
            label={`Continue to place order · NPR ${(
              (totals?.total ?? 0) / 100
            ).toLocaleString("en-NP")}`}
            onPress={() => router.push("/store/checkout")}
            size="lg"
          />
        </View>
      }
      header={header}
      insideTabs
      onRefresh={cart.refresh}
      refreshing={cart.refreshing}
      scroll
    >
      <View className="gap-3 pb-2 pt-4">
        {note && totals ? (
          <FreeDeliveryBar note={note} progress={freeDeliveryProgress(totals)} />
        ) : null}

        {(cart.data?.removed.length ?? 0) > 0 ? (
          <Card className="gap-1" padding="p-3.5">
            <Text variant="label">Some items are no longer sold</Text>
            <Text variant="caption">
              They were taken out of your cart. Everything below is still available.
            </Text>
          </Card>
        ) : null}

        {lines.map((line) => (
          <CartRow
            busy={busyProductId === line.product.id}
            key={line.product.id}
            line={line}
            onChange={(next) =>
              void apply(line.product.id, () => setCartQuantity(line.product.id, next))
            }
            onRemove={() =>
              openConfirm({
                cancelLabel: "Keep",
                confirmLabel: "Remove",
                destructive: true,
                message: line.product.name,
                onConfirm: () => apply(line.product.id, () => removeFromCart(line.product.id)),
                title: "Remove this item?",
              })
            }
          />
        ))}
      </View>
    </Screen>
  );
}

function SummaryRow({
  free = false,
  label,
  value,
}: {
  free?: boolean;
  label: string;
  value: number;
}) {
  return (
    <View className="flex-row items-center justify-between">
      <Text variant="muted">{label}</Text>
      {free ? (
        <Text className="text-sm font-semibold text-success">Free</Text>
      ) : (
        <Money size="inline" value={rupees(value)} />
      )}
    </View>
  );
}

/**
 * One basket line: thumbnail, name, unit price, stepper, line total.
 *
 * The limit caption under the name only appears when something is actually
 * limiting the row — see `limitNote`. A row that always carries a caption trains
 * people to stop reading captions.
 */
function CartRow({
  busy,
  line,
  onChange,
  onRemove,
}: {
  busy: boolean;
  line: CartLine;
  onChange: (next: number) => void;
  onRemove: () => void;
}) {
  const { colors } = useAppTheme();
  const uri = productImageUri(line.product);
  const bounds = stepperBounds(line.product);
  const note = limitNote(line.limitedBy, bounds);

  return (
    <Card className="flex-row gap-3" padding="p-3">
      <Pressable
        accessibilityLabel={line.product.name}
        accessibilityRole="button"
        className="h-[76px] w-[76px] overflow-hidden rounded-xl bg-brand-soft"
        onPress={() => router.push(`/store/product/${line.product.id}`)}
      >
        {uri ? (
          <Image className="h-full w-full" resizeMode="cover" source={{ uri }} />
        ) : (
          <View className="h-full w-full items-center justify-center">
            <Ionicons color={colors.primary} name="cube-outline" size={22} />
          </View>
        )}
      </Pressable>

      <View className="min-w-0 flex-1 gap-1.5">
        <View className="flex-row items-start justify-between gap-2">
          <Text className="flex-1 text-sm font-semibold text-foreground" numberOfLines={2}>
            {line.product.name}
          </Text>
          <Pressable
            accessibilityLabel={`Remove ${line.product.name}`}
            accessibilityRole="button"
            hitSlop={10}
            onPress={onRemove}
          >
            <Ionicons color={colors.mutedForeground} name="trash-outline" size={16} />
          </Pressable>
        </View>

        <Text className="text-[11px] text-muted-foreground">
          {`NPR ${(line.unitPrice / 100).toLocaleString("en-NP")} / ${line.product.unit}`}
          {note ? ` · ${note}` : ""}
        </Text>

        <View className="mt-0.5 flex-row items-center justify-between gap-2">
          <QuantityStepper
            busy={busy}
            onChange={onChange}
            onRemove={onRemove}
            product={line.product}
            quantity={line.quantity}
          />
          <Money size="inline" value={rupees(line.lineTotal)} />
        </View>
      </View>
    </Card>
  );
}
