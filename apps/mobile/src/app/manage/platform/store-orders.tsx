import { useState } from "react";
import { Linking, View } from "react-native";

import { AppBar } from "@/components/ui/app-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, SectionHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { FactRow, Grid, StatTile } from "@/components/ui/layout";
import { ListRow, RowDivider } from "@/components/ui/list-row";
import { Screen } from "@/components/ui/screen";
import { Segmented } from "@/components/ui/segmented";
import { Sheet } from "@/components/ui/sheet";
import { SkeletonRows } from "@/components/ui/skeleton";
import { EmptyCard, ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useDates } from "@/hooks/use-dates";
import { useResource } from "@/hooks/use-resource";
import { readApiError } from "@/lib/api-contract";
import { openConfirm } from "@/lib/confirm";
import { formatMoney } from "@/lib/format";
import {
  listPlatformStoreOrders,
  NEXT_ORDER_STATUS,
  type PlatformStoreOrder,
  setStoreOrderStatus,
  statusLabel,
} from "@/lib/platform-admin-api";
import { invalidateQuery } from "@/lib/query-cache";
import { orderTone, rupees } from "@/lib/store-format";
import { toastError, toastSuccess } from "@/lib/toast";

/**
 * Supply store orders across every hostel (web `platform-store-orders-page`):
 * open first; an order opens in a sheet with its items, delivery and the one
 * next step (Confirm → Pack → Ship → Delivered), or Cancel with a reason.
 * Prices are paisa (`store-format.rupees`).
 */

const money = (paisa: number) => formatMoney(rupees(paisa));
const loadOpen = () => listPlatformStoreOrders("open");
const loadAll = () => listPlatformStoreOrders("all");

export default function PlatformStoreOrdersScreen() {
  const dates = useDates();
  const [scope, setScope] = useState<"open" | "all">("open");
  const orders = useResource(scope === "open" ? loadOpen : loadAll, { cacheKey: `platform:store-orders:${scope}` });
  const [openId, setOpenId] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const order = orders.data?.orders.find((row) => row.id === openId) ?? null;

  async function move(target: PlatformStoreOrder, status: Parameters<typeof setStoreOrderStatus>[1], reason?: string) {
    setBusy(true);
    try {
      await setStoreOrderStatus(target.id, status, reason);
      toastSuccess(`${target.orderNumber} · ${statusLabel(status)}`);
      setCancelling(false);
      setNote("");
      if (status === "DELIVERED" || status === "CANCELLED") setOpenId(null);
      invalidateQuery("platform:store-orders:open");
      invalidateQuery("platform:store-orders:all");
      orders.refresh();
    } catch (error) {
      toastError("Not updated", readApiError(error));
    } finally {
      setBusy(false);
    }
  }

  const summary = orders.data?.summary;
  const next = order ? NEXT_ORDER_STATUS[order.status] : undefined;

  return (
    <Screen header={<AppBar showBack title="Store orders" />} onRefresh={orders.refresh} refreshing={orders.refreshing} scroll>
      <View className="gap-4">
        {summary ? (
          <Grid maxColumns={3}>
            {[
              <StatTile icon="cart" key="open" label="Open" tone={summary.open ? "warning" : "success"} value={String(summary.open)} />,
              <StatTile icon="receipt" key="total" label="All orders" value={String(summary.total)} />,
              <StatTile icon="cash" key="rev" label="Delivered" value={money(summary.deliveredRevenue)} />,
            ]}
          </Grid>
        ) : null}

        <Segmented
          onChange={setScope}
          options={[
            { label: "Open", value: "open" },
            { label: "All", value: "all" },
          ]}
          value={scope}
        />

        {orders.loading ? (
          <SkeletonRows rows={5} />
        ) : orders.error || !orders.data ? (
          <ErrorState message={orders.error ?? "Orders could not be loaded."} onRetry={orders.reload} />
        ) : orders.data.orders.length === 0 ? (
          <EmptyCard description={scope === "open" ? "Every order is delivered or cancelled." : "No hostel has ordered yet."} title="No orders" />
        ) : (
          <Card padding="px-4 py-1">
            {orders.data.orders.map((row, index) => (
              <View key={row.id}>
                {index > 0 ? <RowDivider /> : null}
                <ListRow
                  icon="cart"
                  onPress={() => setOpenId(row.id)}
                  right={<Badge label={row.statusLabel || statusLabel(row.status)} tone={orderTone(row.status)} />}
                  subtitle={`${row.orderNumber} · ${row.itemCount} items · ${money(row.total)}${row.createdAt ? ` · ${dates.date(row.createdAt)}` : ""}`}
                  title={row.hostelName || "Hostel"}
                />
              </View>
            ))}
          </Card>
        )}
      </View>

      <Sheet
        footer={
          order && (next || cancelling || order.status !== "DELIVERED") ? (
            cancelling ? (
              <Button disabled={busy || note.trim().length < 3} label="Cancel the order" loading={busy} onPress={() => void move(order, "CANCELLED", note)} variant="danger" />
            ) : next ? (
              <Button
                disabled={busy}
                label={`Mark ${statusLabel(next).toLowerCase()}`}
                loading={busy}
                onPress={() =>
                  next === "DELIVERED"
                    ? (setOpenId(null), // the confirm host draws beneath a sheet
                      openConfirm({
                        confirmLabel: "Delivered",
                        message: `Cash on delivery: ${money(order.total)} collected.`,
                        onConfirm: () => move(order, next),
                        title: `Delivered to ${order.hostelName}?`,
                      }))
                    : void move(order, next)
                }
              />
            ) : null
          ) : null
        }
        onClose={() => {
          setOpenId(null);
          setCancelling(false);
        }}
        open={order !== null}
        tall
        title={order ? `${order.orderNumber} · ${order.hostelName}` : "Order"}
      >
        {order ? (
          <View className="gap-4 pb-2">
            <View className="flex-row items-center justify-between">
              <Badge label={order.statusLabel || statusLabel(order.status)} tone={orderTone(order.status)} />
              <Text variant="title">{money(order.total)}</Text>
            </View>

            <View>
              <SectionHeader title={`Items · ${order.itemCount}`} />
              <Card padding="px-4 py-1">
                {order.items.map((item, index) => (
                  <View key={`${item.productId}-${index}`}>
                    {index > 0 ? <RowDivider /> : null}
                    <ListRow subtitle={`${item.quantity} ${item.unit} × ${money(item.unitPrice)}`} title={item.name} value={money(item.lineTotal)} />
                  </View>
                ))}
              </Card>
            </View>

            <View>
              <SectionHeader title="Delivery" />
              <Card>
                <FactRow label="To" value={order.delivery.contactName} />
                <FactRow label="Address" value={[order.delivery.addressLine, order.delivery.city].filter(Boolean).join(", ")} />
                {order.delivery.note ? <FactRow label="Note" value={order.delivery.note} /> : null}
                <FactRow label="Fee" value={order.deliveryFee ? money(order.deliveryFee) : "Free"} />
                <FactRow label="Payment" value={`${statusLabel(order.paymentMethod)} · ${statusLabel(order.paymentStatus)}`} />
              </Card>
              {order.delivery.phone ? (
                <View className="pt-3">
                  <Button icon="call" label={`Call ${order.delivery.phone}`} onPress={() => void Linking.openURL(`tel:${order.delivery.phone}`)} variant="outline" />
                </View>
              ) : null}
            </View>

            {order.timeline.length ? (
              <View>
                <SectionHeader title="History" />
                <Card>
                  {order.timeline.map((step, index) => (
                    <FactRow key={`${step.status}-${index}`} label={step.statusLabel} value={[step.at ? dates.dateTime(step.at) : null, step.note].filter(Boolean).join(" · ") || "—"} />
                  ))}
                </Card>
              </View>
            ) : null}

            {order.status !== "DELIVERED" && order.status !== "CANCELLED" ? (
              cancelling ? (
                <Input label="Why it is cancelled (the hostel reads this)" maxLength={500} multiline onChangeText={setNote} value={note} />
              ) : (
                <Button label="Cancel order" onPress={() => setCancelling(true)} variant="ghost" />
              )
            ) : null}
          </View>
        ) : null}
      </Sheet>
    </Screen>
  );
}
