import { router } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { View } from "react-native";

import { useStoreCart } from "@/components/store/store-cart";
import { AppBar } from "@/components/ui/app-bar";
import { Button } from "@/components/ui/button";
import { Card, SectionHeader } from "@/components/ui/card";
import { Glyph } from "@/components/ui/glyph";
import { Input } from "@/components/ui/input";
import { Money } from "@/components/ui/money";
import { Screen } from "@/components/ui/screen";
import { SkeletonCard } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useResource } from "@/hooks/use-resource";
import { readApiError } from "@/lib/api-contract";
import { placeStoreOrder, type StoreDelivery } from "@/lib/store-api";
import { rupees } from "@/lib/store-format";
import { toastError, toastSuccess } from "@/lib/toast";
import { storeQuery } from "@/lib/store-queries";

/**
 * Where it goes, what it costs, and the one button that commits it.
 *
 * ## The address arrives filled in
 *
 * `GET /store/checkout` returns the last order's delivery details, falling back
 * to the hostel record. A monthly restock is the same address every time, and a
 * form that makes somebody retype it is a form that gets abandoned — so the
 * fields are pre-populated and editable rather than empty and required.
 *
 * ## Payment is a list with one member
 *
 * Cash on delivery, drawn as a selected row rather than as a sentence. The row
 * is what makes it obvious that this is a *choice the platform made*, and it is
 * where eSewa goes when it is added — `paymentMethods` already comes from the
 * server as an array so that day is a data change, not a screen rewrite.
 *
 * ## The totals are the server's, again
 *
 * Same rule as the cart: nothing here adds a delivery fee or recomputes a
 * subtotal. What is shown is what will be charged, because it is literally the
 * number the order will be written with.
 */
export default function StoreCheckoutScreen() {
  const { colors } = useAppTheme();
  const cart = useStoreCart();
  const [placing, setPlacing] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<keyof StoreDelivery, string>>>({});

  const checkoutQuery = storeQuery.checkout();
  const checkout = useResource(checkoutQuery.load, {
    cacheKey: checkoutQuery.key,
    topics: checkoutQuery.topics,
  });

  /*
   * The form is **derived**, not seeded.
   *
   * The obvious build is `useState(null)` plus an effect that copies the fetched
   * address in once it arrives — and that is a synchronous `setState` inside an
   * effect body, which is a real extra render on a screen that already has one
   * and is what `react-hooks/set-state-in-effect` exists to catch.
   *
   * Holding only the *edits* removes the problem rather than suppressing it:
   * before the fetch lands there is nothing to overlay, after it lands the
   * suggestion shows through, and a field somebody has typed in wins over both.
   * A later refetch therefore cannot overwrite what is being typed either, which
   * is the bug the effect version would have needed a guard for.
   */
  const [edits, setEdits] = useState<Partial<StoreDelivery>>({});
  const suggested = checkout.data?.delivery;

  const delivery = useMemo<StoreDelivery | null>(
    () => (suggested ? { ...suggested, ...edits } : null),
    [edits, suggested],
  );

  const set = useCallback((field: keyof StoreDelivery, value: string) => {
    setEdits((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
  }, []);

  const place = useCallback(async () => {
    if (!delivery) {
      return;
    }

    /*
     * Checked here as well as by the server's zod schema, and that is not
     * duplication for its own sake: a 422 arrives as one toast naming one field,
     * where this puts the message under the field it is about. The server stays
     * the authority — this only saves a round trip on the obvious cases.
     */
    const next: Partial<Record<keyof StoreDelivery, string>> = {};

    if (!delivery.contactName.trim()) {
      next.contactName = "Who should the courier ask for?";
    }

    if (delivery.phone.trim().length < 7) {
      next.phone = "A number the courier can call.";
    }

    if (!delivery.addressLine.trim()) {
      next.addressLine = "Where should it be delivered?";
    }

    if (Object.keys(next).length > 0) {
      setErrors(next);
      return;
    }

    setPlacing(true);

    try {
      const order = await placeStoreOrder({ delivery });

      toastSuccess("Order placed", `${order.orderNumber} — pay on delivery.`);
      cart.refresh();
      // `replace`, not `push`: the back gesture from a placed order must not
      // land on a checkout screen for a basket that no longer exists.
      router.replace(`/store/order/${order.id}`);
    } catch (error) {
      toastError("Could not place the order", readApiError(error));
    } finally {
      setPlacing(false);
    }
  }, [cart, delivery]);

  const header = <AppBar accent centerTitle showBack title="Checkout" />;

  if (checkout.loading || !delivery) {
    return (
      <Screen header={header}>
        <View className="gap-4 pt-1">
          <SkeletonCard rows={3} />
          <SkeletonCard rows={3} />
        </View>
      </Screen>
    );
  }

  if (checkout.error) {
    return (
      <Screen header={header}>
        <ErrorState message={checkout.error} onRetry={checkout.reload} />
      </Screen>
    );
  }

  const totals = checkout.data?.cart.totals;
  const lines = checkout.data?.cart.items ?? [];

  if (lines.length === 0) {
    return (
      <Screen header={header}>
        <ErrorState
          message="Your cart is empty. Add something to the basket first."
          onRetry={() => router.replace("/(store)")}
        />
      </Screen>
    );
  }

  return (
    <Screen
      footer={
        <View className="gap-3 px-5 pt-3">
          <View>
            <Text variant="caption">
              Cash on delivery · {checkout.data?.deliveryPromise?.arrivesText}
            </Text>
            <Money size="large" value={rupees(totals?.total ?? 0)} />
          </View>

          <Button
            className="w-full"
            label="Place order"
            loading={placing}
            onPress={() => void place()}
            size="lg"
          />
        </View>
      }
      header={header}
      scroll
    >
      <View className="gap-6 pb-2 pt-4">
        <View>
          <SectionHeader
            subtitle={
              checkout.data?.deliveryPromise?.cutoffText ?? checkout.data?.deliveryEstimate
            }
            title="Delivery details"
          />

          <Card className="gap-3">
            <Input
              autoCapitalize="words"
              error={errors.contactName}
              label="Contact name"
              onChangeText={(value) => set("contactName", value)}
              placeholder="Who the courier should ask for"
              value={delivery.contactName}
            />
            <Input
              error={errors.phone}
              keyboardType="phone-pad"
              label="Phone"
              onChangeText={(value) => set("phone", value)}
              placeholder="98…"
              value={delivery.phone}
            />
            <Input
              error={errors.addressLine}
              label="Address"
              multiline
              onChangeText={(value) => set("addressLine", value)}
              placeholder="Street, tole, landmark"
              value={delivery.addressLine}
            />
            <Input
              label="City"
              onChangeText={(value) => set("city", value)}
              placeholder="Kathmandu"
              value={delivery.city}
            />
            <Input
              hint="Optional. Anything the rider needs to know."
              label="Note for the courier"
              onChangeText={(value) => set("note", value)}
              placeholder="Ring the bell on the left, after 5pm"
              value={delivery.note}
            />
          </Card>
        </View>

        <View>
          <SectionHeader title="Payment" />

          {(checkout.data?.paymentMethods ?? []).map((method) => (
            <Card className="flex-row items-center gap-3" key={method.id}>
              <View className="h-10 w-10 items-center justify-center rounded-2xl bg-brand-soft">
                <Glyph color={colors.primary} name="cash" size={20} />
              </View>

              <View className="flex-1">
                <Text variant="label">{method.label}</Text>
                <Text variant="caption">{method.description}</Text>
              </View>

              <Glyph color={colors.primary} name="radio-button-on" size={20} />
            </Card>
          ))}
        </View>

        <View>
          <SectionHeader title={`${totals?.itemCount ?? 0} items`} />

          <Card className="gap-2.5">
            {lines.map((line) => (
              <View className="flex-row items-start gap-2" key={line.product.id}>
                <Text className="flex-1 text-sm text-foreground" numberOfLines={2}>
                  {line.quantity} × {line.product.name}
                </Text>
                <Money size="inline" value={rupees(line.lineTotal)} />
              </View>
            ))}

            <View className="mt-1 gap-1.5 border-t border-border pt-3">
              <Row label="Subtotal" value={totals?.subtotal ?? 0} />
              <Row
                free={totals?.deliveryFee === 0}
                label="Delivery"
                value={totals?.deliveryFee ?? 0}
              />
              <View className="mt-1 flex-row items-center justify-between border-t border-border pt-2">
                <Text variant="subtitle">Total</Text>
                <Money size="inline" value={rupees(totals?.total ?? 0)} />
              </View>
            </View>
          </Card>
        </View>
      </View>
    </Screen>
  );
}

function Row({ free = false, label, value }: { free?: boolean; label: string; value: number }) {
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
