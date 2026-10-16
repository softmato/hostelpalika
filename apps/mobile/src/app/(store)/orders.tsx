import { router } from "expo-router";
import { useMemo, useState } from "react";
import { View } from "react-native";

import { AppBar } from "@/components/ui/app-bar";
import { Badge } from "@/components/ui/badge";
import { Card, SectionHeader } from "@/components/ui/card";
import { ListRow } from "@/components/ui/list-row";
import { Money } from "@/components/ui/money";
import { Screen } from "@/components/ui/screen";
import { Segmented } from "@/components/ui/segmented";
import { SkeletonRows } from "@/components/ui/skeleton";
import { EmptyCard, ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";

import { useDates } from "@/hooks/use-dates";
import { useResource } from "@/hooks/use-resource";
import { type StoreOrder } from "@/lib/store-api";
import { orderTone, rupees } from "@/lib/store-format";
import { storeQuery } from "@/lib/store-queries";

/**
 * Everything this hostel has ordered.
 *
 * ## Grouped by day, with the heading outside the card
 *
 * `NOTES.md` §5, and it is the single most useful thing taken from the banking
 * references: `Sun, 16 Aug` sits on the page background in bold and the orders
 * for that day are a card underneath. A flat list with a date on every row reads
 * far slower, and an order list is almost always scanned by *when*.
 *
 * ## Two filters, not five
 *
 * "In progress" and "All". The status vocabulary has six members and a segmented
 * control's own doc puts its ceiling at five — but more to the point, the only
 * question anybody asks a list like this is "what is still coming", and the
 * other five answers are one tap away on the order itself.
 */
export default function StoreOrdersScreen() {
  const dates = useDates();

  const [filter, setFilter] = useState<"open" | "all">("open");

  const ordersQuery = storeQuery.orders(filter);
  const orders = useResource(ordersQuery.load, {
    cacheKey: ordersQuery.key,
    topics: ordersQuery.topics,
  });

  const groups = useMemo(() => groupByDay(orders.data?.orders ?? []), [orders.data]);

  const header = <AppBar accent centerTitle showBack title="Your orders" />;

  if (orders.error && !orders.data) {
    return (
      <Screen header={header} insideTabs>
        <ErrorState message={orders.error} onRetry={orders.reload} />
      </Screen>
    );
  }

  return (
    <Screen
      header={header}
      insideTabs
      onRefresh={orders.refresh}
      refreshing={orders.refreshing}
      scroll
    >
      <View className="gap-5 pb-2 pt-4">
        <Segmented
          onChange={(value) => setFilter(value as typeof filter)}
          options={[
            { label: "In progress", value: "open" },
            { label: "All", value: "all" },
          ]}
          value={filter}
        />

        {orders.loading ? <SkeletonRows rows={4} /> : null}

        {!orders.loading && groups.length === 0 ? (
          <EmptyCard
            description={
              filter === "open"
                ? "Nothing is on its way. Anything you order will show up here."
                : "You have not ordered anything from the store yet."
            }
            title="No orders"
          />
        ) : null}

        {groups.map((group) => (
          <View key={group.key}>
            <SectionHeader title={group.day ? dates.date(group.day) : "Earlier"} />

            <Card padding="px-4 py-1">
              {group.orders.map((order) => (
                <ListRow
                  icon="cube"
                  key={order.id}
                  onPress={() => router.push(`/store/order/${order.id}`)}
                  subtitle={`${order.orderNumber} · ${order.itemCount} ${
                    order.itemCount === 1 ? "item" : "items"
                  }`}
                  right={
                    <View className="items-end gap-1">
                      <Money size="inline" value={rupees(order.total)} />
                      <Badge label={order.statusLabel} tone={orderTone(order.status)} />
                    </View>
                  }
                  title={summarise(order)}
                />
              ))}
            </Card>
          </View>
        ))}

        {orders.data && orders.data.summary.open > 0 && filter === "all" ? (
          <Text variant="caption">
            {orders.data.summary.open} of these are still on their way.
          </Text>
        ) : null}
      </View>
    </Screen>
  );
}

/**
 * "3 × Cotton mattress" or "Cotton mattress + 2 more".
 *
 * Naming the first product rather than printing "Order SO-2608-0004" as the
 * title: an order number is how the platform refers to it, and what the person
 * who placed it remembers is what was in it.
 */
function summarise(order: StoreOrder) {
  const first = order.items[0];

  if (!first) {
    return order.orderNumber;
  }

  if (order.items.length === 1) {
    return first.quantity > 1 ? `${first.quantity} × ${first.name}` : first.name;
  }

  return `${first.name} + ${order.items.length - 1} more`;
}

/**
 * Orders bucketed by calendar day, newest first.
 *
 * Keyed on the ISO date rather than on the rendered label, so two orders on the
 * same day cannot land in different groups because one of them formatted at
 * 23:59 and the other at 00:01 in a different timezone.
 *
 * It hands back the group's `day` instant rather than a formatted heading. The
 * heading is written in whichever calendar the reader chose, and that lives in a
 * hook — so formatting here would mean either passing the whole `useDates()`
 * bundle into a pure grouping function or freezing the heading into Gregorian.
 * The screen formats it at render instead.
 */
function groupByDay(orders: readonly StoreOrder[]) {
  const buckets = new Map<string, StoreOrder[]>();

  for (const order of orders) {
    const key = (order.createdAt ?? "").slice(0, 10) || "unknown";

    buckets.set(key, [...(buckets.get(key) ?? []), order]);
  }

  return [...buckets.entries()]
    .sort((left, right) => right[0].localeCompare(left[0]))
    .map(([key, group]) => ({
      day: group[0]?.createdAt ?? null,
      key,
      orders: group,
    }));
}
