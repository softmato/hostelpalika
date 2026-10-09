import { router, useLocalSearchParams } from "expo-router";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { FLOAT_SHADOW } from "@/components/portal-shared";
import { ItemAvatar, NoStockAccess, useStock } from "@/components/stock/stock-parts";
import { AppBar } from "@/components/ui/app-bar";
import { Card } from "@/components/ui/card";
import { Chip } from "@/components/ui/layout";
import { RowDivider } from "@/components/ui/list-row";
import { Money } from "@/components/ui/money";
import { Screen } from "@/components/ui/screen";
import { Segmented } from "@/components/ui/segmented";
import { Skeleton, SkeletonRows } from "@/components/ui/skeleton";
import { EmptyCard, ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useResource } from "@/hooks/use-resource";
import { bsDayLong } from "@/lib/expenses";
import { formatMoney } from "@/lib/format";
import { formatQty, type UsageRange, usageQuery, type UsageTotal, usageTotals } from "@/lib/stock-api";

/**
 * Used — how much went, today, this week, this month (docs/INVENTORY_PLAN.md).
 *
 * The warden's daily question, answered in one screen:
 *
 * - **Today · Week · Month** on the card over the header, with the total under
 *   it (what it cost, for someone who sees money).
 * - **What was used**: one line per item, the most first, with how much the
 *   kitchen entered and how much staff did, and anything thrown away in red.
 * - **Day by day** for a week or a month, each day's name outside its card.
 *
 * With more than one building, chips across the top pick one or all.
 */

const STRADDLE = 34;

const RANGES: { label: string; value: UsageRange }[] = [
  { label: "Today", value: "today" },
  { label: "This week", value: "week" },
  { label: "This month", value: "month" },
];

export default function StockUsageScreen() {
  const params = useLocalSearchParams<{ range?: string }>();
  const { denied, here, overall } = useStock();
  const [range, setRange] = useState<UsageRange>(
    RANGES.some((option) => option.value === params.range) ? (params.range as UsageRange) : "today",
  );
  const [place, setPlace] = useState<string | null>(null);
  const query = usageQuery(range);
  const resource = useResource(query.load, { cacheKey: query.key, topics: query.topics });
  const usage = resource.data ?? null;

  const totals = useMemo(() => (usage ? usageTotals(usage, place) : []), [usage, place]);
  const days = useMemo(
    () =>
      usage && range !== "today"
        ? usage.days
            .map((day) => ({ day, totals: usageTotals(usage, place, day) }))
            .filter((entry) => entry.totals.length > 0)
        : [],
    [usage, place, range],
  );
  const value = totals.reduce((sum, row) => sum + (row.value ?? 0), 0);
  const byCook = totals.filter((row) => row.byCook > 0).length;

  const header = (
    <View className="bg-background">
      <AppBar
        accent
        centerTitle
        showBack
        straddle={denied ? 0 : STRADDLE}
        subtitle={overall ? "All buildings" : here?.name}
        title="Used"
      />
      {denied ? null : (
        <View className="px-5" style={{ marginTop: -STRADDLE }}>
          <View className="gap-4 rounded-2xl border border-border bg-card p-4" style={FLOAT_SHADOW}>
            <Segmented onChange={setRange} options={RANGES} value={range} />
            {!usage ? (
              <Skeleton height={40} width="60%" />
            ) : (
              <View className="items-center gap-0.5">
                <Text variant="caption">{range === "today" ? "Used today" : range === "week" ? "Used in 7 days" : "Used this month"}</Text>
                {usage.money ? (
                  <Money size="large" value={value} />
                ) : (
                  <Text variant="title">
                    {totals.length} item{totals.length === 1 ? "" : "s"}
                  </Text>
                )}
                <Text variant="caption">
                  {totals.length === 0
                    ? "Nothing yet"
                    : `${totals.length} item${totals.length === 1 ? "" : "s"} · the kitchen entered ${byCook}`}
                </Text>
              </View>
            )}
          </View>
        </View>
      )}
    </View>
  );

  if (denied) {
    return (
      <Screen header={header}>
        <NoStockAccess />
      </Screen>
    );
  }

  if (resource.error && !usage) {
    return (
      <Screen header={header}>
        <ErrorState message={resource.error} onRetry={resource.reload} />
      </Screen>
    );
  }

  return (
    <Screen header={header} onRefresh={resource.refresh} refreshing={resource.refreshing} scroll>
      {!usage ? (
        <View className="pt-5">
          <SkeletonRows rows={6} />
        </View>
      ) : (
        <View className="gap-6 pb-8 pt-5">
          {usage.places.length > 1 ? (
            <ScrollView contentContainerClassName="gap-2" horizontal showsHorizontalScrollIndicator={false}>
              <Chip label="All buildings" onPress={() => setPlace(null)} tone={place === null ? "brand" : "neutral"} />
              {usage.places.map((option) => (
                <Chip
                  key={option.id}
                  label={option.name}
                  onPress={() => setPlace(option.id)}
                  tone={place === option.id ? "brand" : "neutral"}
                />
              ))}
            </ScrollView>
          ) : null}

          {totals.length === 0 ? (
            <EmptyCard
              description="When the cook taps Kitchen stock, or you tap Use, it shows here."
              title={range === "today" ? "Nothing used yet today" : "Nothing used yet"}
            />
          ) : (
            <View>
              <Heading label="What was used" />
              <Card padding="px-4 py-0">
                {totals.map((row, index) => (
                  <View key={row.item.id}>
                    {index > 0 ? <RowDivider inset /> : null}
                    <TotalRow money={usage.money} row={row} />
                  </View>
                ))}
              </Card>
            </View>
          )}

          {days.length > 0 ? (
            <View className="gap-4">
              <Heading label="Day by day" />
              {days.map((entry) => (
                <View key={entry.day}>
                  <Text className="mb-2 px-1 font-semibold text-muted-foreground" style={{ fontSize: 12 }}>
                    {bsDayLong(entry.day)}
                  </Text>
                  <Card padding="px-4 py-2">
                    {entry.totals.map((row) => (
                      <View className="min-h-9 flex-row items-center justify-between" key={row.item.id}>
                        <Text numberOfLines={1} variant="body">
                          {row.item.name}
                        </Text>
                        <Text variant="label">
                          {formatQty(row.used, row.item.unit)}
                          {row.wasted > 0 ? ` · ${formatQty(row.wasted, row.item.unit)} bad` : ""}
                        </Text>
                      </View>
                    ))}
                  </Card>
                </View>
              ))}
            </View>
          ) : null}
        </View>
      )}
    </Screen>
  );
}

function Heading({ label }: { label: string }) {
  return (
    <Text className="mb-2 px-1 font-semibold uppercase tracking-wider text-muted-foreground" style={{ fontSize: 11 }}>
      {label}
    </Text>
  );
}

/**
 * One item: how much went, and who entered it. Daily items (vegetables, milk)
 * count as used the day they came, so they read "came in, used".
 */
function TotalRow({ money, row }: { money: boolean; row: UsageTotal }) {
  const staff = Math.max(0, row.used - row.byCook);
  const who =
    row.item.kind === "DAILY"
      ? "Daily · used the day it came"
      : [
          row.byCook > 0 ? `Kitchen ${formatQty(row.byCook, row.item.unit)}` : null,
          staff > 0 ? `Staff ${formatQty(staff, row.item.unit)}` : null,
        ]
          .filter(Boolean)
          .join(" · ");

  return (
    <Pressable
      accessibilityRole="button"
      className="min-h-16 flex-row items-center gap-3 py-3 active:opacity-70"
      onPress={() => router.push({ params: { id: row.item.id }, pathname: "/stock/item/[id]" })}
    >
      <ItemAvatar item={row.item} size={40} />
      <View className="flex-1">
        <Text numberOfLines={1} variant="label">
          {row.item.name}
        </Text>
        {who ? (
          <Text numberOfLines={1} variant="caption">
            {who}
          </Text>
        ) : null}
        {row.wasted > 0 ? (
          <Text className="text-destructive" numberOfLines={1} variant="caption">
            {formatQty(row.wasted, row.item.unit)} thrown away
          </Text>
        ) : null}
      </View>
      <View className="items-end">
        <Text variant="subtitle">{formatQty(row.used, row.item.unit)}</Text>
        {money && row.value ? <Text variant="caption">{formatMoney(row.value)}</Text> : null}
      </View>
    </Pressable>
  );
}
