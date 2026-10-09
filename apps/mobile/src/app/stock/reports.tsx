import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { type ReactNode, useState } from "react";
import { Pressable, Share, View } from "react-native";

import { FLOAT_SHADOW } from "@/components/portal-shared";
import { categoryLabel, monthLabel, NoStockAccess, useStock } from "@/components/stock/stock-parts";
import { AppBar } from "@/components/ui/app-bar";
import { Button } from "@/components/ui/button";
import { Card, SectionHeader } from "@/components/ui/card";
import { DataCard } from "@/components/ui/data-card";
import { RowDivider } from "@/components/ui/list-row";
import { Meter } from "@/components/ui/meter";
import { Money } from "@/components/ui/money";
import { Screen } from "@/components/ui/screen";
import { Skeleton, SkeletonRows } from "@/components/ui/skeleton";
import { EmptyCard, ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { formatMoney } from "@/lib/format";
import { formatQty, type StockHome, type StockItem } from "@/lib/stock-api";
import { addBsMonths } from "@hostel/calendar/bs";

/**
 * Stock reports — one month at a time (docs/INVENTORY_PLAN.md §5).
 *
 * The number an owner opens this for is on the card over the header: **what
 * food and supplies cost per student per day**. Under it, in the order the
 * question usually goes — where did the money go (used, wasted, missing), what
 * is sitting in the store, who we bought from, and each item's month:
 * opening → in → out → closing. Share sends the item table as plain rows any
 * spreadsheet opens.
 *
 * Owner and money staff only; the tile is not shown to anyone else.
 */

const STRADDLE = 34;

export default function StockReportsScreen() {
  const { colors } = useAppTheme();
  const current = useStock();
  const [period, setPeriod] = useState<string | null>(null);
  const { denied, home, resource } = useStock(period);
  const shown = home?.period ?? current.home?.period ?? null;
  const atCurrent = !period || period === current.home?.currentPeriod;
  const summary = home?.summary;

  const step = (delta: number) => {
    if (!shown || !current.home) return;

    const next = addBsMonths(shown, delta);

    if (next > current.home.currentPeriod) return;

    setPeriod(next === current.home.currentPeriod ? null : next);
  };

  const header = (
    <View className="bg-background">
      <AppBar accent centerTitle showBack straddle={STRADDLE} subtitle={current.here?.name ?? "All buildings"} title="Stock reports" />
      <View className="px-5" style={{ marginTop: -STRADDLE }}>
        <View className="gap-3 rounded-2xl border border-border bg-card p-4" style={FLOAT_SHADOW}>
          <View className="flex-row items-center justify-between">
            <Arrow disabled={!home} label="Previous month" name="chevron-back" onPress={() => step(-1)} />
            <Text variant="label">{shown ? (atCurrent ? `This month · ${monthLabel(shown)}` : monthLabel(shown)) : " "}</Text>
            <Arrow disabled={atCurrent} label="Next month" name="chevron-forward" onPress={() => step(1)} />
          </View>
          {!summary ? (
            <Skeleton height={44} width="60%" />
          ) : (
            <View className="items-center gap-0.5">
              <Text variant="caption">Cost per student per day</Text>
              {summary.costPerResidentDay !== null ? (
                <Money size="large" value={summary.costPerResidentDay} />
              ) : (
                <Text variant="subtitle">—</Text>
              )}
              <Text variant="caption">
                {summary.residents} student{summary.residents === 1 ? "" : "s"} · {summary.days} day{summary.days === 1 ? "" : "s"}
              </Text>
            </View>
          )}
        </View>
      </View>
    </View>
  );

  if (denied || (home && !home.money)) {
    return (
      <Screen header={header}>
        {denied ? <NoStockAccess /> : <EmptyCard description="Reports show money. Ask the owner." title="Not for this account" />}
      </Screen>
    );
  }

  if (resource.error && !home) {
    return (
      <Screen header={header}>
        <ErrorState message={resource.error} onRetry={resource.reload} />
      </Screen>
    );
  }

  if (!home || !summary) {
    return (
      <Screen header={header}>
        <View className="pt-5">
          <SkeletonRows rows={6} />
        </View>
      </Screen>
    );
  }

  const spent = summary.spentValue ?? 0;
  const stockItems = home.items.filter((item) => item.kind === "STORE" && item.active);
  const categoryMax = Math.max(1, ...summary.byCategory.map((row) => row.stockValue));
  const lowItems = home.items.filter((item) => item.at.some((at) => at.low));

  return (
    <Screen
      footer={<Button label="Share item table" onPress={() => void shareTable(home)} size="lg" variant="outline" />}
      header={header}
      onRefresh={resource.refresh}
      refreshing={resource.refreshing}
      scroll
    >
      <View className="gap-6 pb-8 pt-5">
        <DataCard
          meta="What left the store this month, at what it cost"
          segments={[
            { label: `Used ${formatMoney(summary.usedValue)}`, tone: "brand", value: summary.usedValue ?? 0 },
            { label: `Wasted ${formatMoney(summary.wastedValue)}`, tone: "danger", value: summary.wastedValue ?? 0 },
            { label: `Missing ${formatMoney(summary.missingValue)}`, tone: "warning", value: summary.missingValue ?? 0 },
          ]}
          stats={[
            { label: "Bought", value: formatMoney(summary.boughtValue) },
            { label: "Used", value: formatMoney(summary.usedValue) },
            { label: "Wasted", value: formatMoney(summary.wastedValue) },
          ]}
          title={`Spent from store · ${formatMoney(spent)}`}
          total={Math.max(1, spent)}
        />

        <View>
          <SectionHeader subtitle={`Worth ${formatMoney(summary.stockValue)} now`} title="In the store" />
          {summary.byCategory.length === 0 ? (
            <Text variant="muted">Add prices on bills to see what the store is worth.</Text>
          ) : (
            <Card className="gap-4">
              {summary.byCategory.map((row) => (
                <View className="gap-1.5" key={row.category}>
                  <View className="flex-row justify-between">
                    <Text variant="label">{categoryLabel(row.category)}</Text>
                    <Text variant="label">{formatMoney(row.stockValue)}</Text>
                  </View>
                  <Meter label={`${formatMoney(row.usedValue)} used this month`} percent={Math.round((row.stockValue / categoryMax) * 100)} reading="share" />
                </View>
              ))}
            </Card>
          )}
        </View>

        <View>
          <SectionHeader
            action={
              <Pressable accessibilityRole="button" className="active:opacity-70" onPress={() => router.push("/stock/suppliers")}>
                <Text className="font-semibold text-primary" variant="label">
                  {formatMoney(summary.dueTotal)} owed
                </Text>
              </Pressable>
            }
            title="Bought from"
          />
          {summary.bySupplier.length === 0 ? (
            <Text variant="muted">No priced bills this month.</Text>
          ) : (
            <Card padding="px-4 py-0">
              {summary.bySupplier.map((row, index) => (
                <View key={row.supplierId ?? row.name}>
                  {index > 0 ? <RowDivider inset /> : null}
                  <Pressable
                    accessibilityRole="button"
                    className="min-h-16 flex-row items-center gap-3 py-3 active:opacity-70"
                    disabled={!row.supplierId}
                    onPress={() => row.supplierId && router.push({ params: { id: row.supplierId }, pathname: "/stock/supplier/[id]" })}
                  >
                    <View className="h-10 w-10 items-center justify-center rounded-full bg-brand-soft">
                      <Ionicons color={colors.primary} name="storefront-outline" size={20} />
                    </View>
                    <View className="flex-1">
                      <Text numberOfLines={1} variant="label">
                        {row.name}
                      </Text>
                      <Text variant="caption">
                        {row.bills} bill{row.bills === 1 ? "" : "s"} · {formatMoney(row.paid)} paid
                      </Text>
                    </View>
                    <Text variant="label">{formatMoney(row.billed)}</Text>
                  </Pressable>
                </View>
              ))}
            </Card>
          )}
        </View>

        <View>
          <SectionHeader subtitle="Opening → in → out → closing" title="Each item this month" />
          {stockItems.length === 0 ? (
            <EmptyCard description="Store items show here once something is bought." title="No store items" />
          ) : (
            <Card padding="px-4 py-0">
              {stockItems.map((item, index) => (
                <View key={item.id}>
                  {index > 0 ? <RowDivider inset /> : null}
                  <ItemLedger item={item} />
                </View>
              ))}
            </Card>
          )}
        </View>

        {lowItems.length > 0 && atCurrent ? (
          <View>
            <SectionHeader title="Running low" />
            <Card padding="px-4 py-0">
              {lowItems.map((item, index) => (
                <View key={item.id}>
                  {index > 0 ? <RowDivider inset /> : null}
                  <View className="min-h-12 flex-row items-center justify-between py-3">
                    <Text variant="label">{item.name}</Text>
                    <Text className="text-destructive" variant="label">
                      {formatQty(item.at.reduce((sum, at) => sum + at.left, 0), item.unit)} left
                    </Text>
                  </View>
                </View>
              ))}
            </Card>
          </View>
        ) : null}
      </View>
    </Screen>
  );
}

function Arrow({
  disabled,
  label,
  name,
  onPress,
}: {
  disabled: boolean;
  label: string;
  name: "chevron-back" | "chevron-forward";
  onPress: () => void;
}) {
  const { colors } = useAppTheme();

  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      className={`h-9 w-9 items-center justify-center rounded-full active:opacity-60 ${disabled ? "opacity-30" : ""}`}
      disabled={disabled}
      hitSlop={6}
      onPress={onPress}
    >
      <Ionicons color={colors.foreground} name={name} size={18} />
    </Pressable>
  );
}

/** Everything that left: used, wasted, sent, and what a Count found missing. */
function outOf(at: StockItem["at"][number]) {
  return at.used + at.wasted + at.out + Math.max(0, -at.adjusted);
}

function ItemLedger({ item }: { item: StockItem }) {
  const sum = (pick: (at: StockItem["at"][number]) => number) => item.at.reduce((total, at) => total + pick(at), 0);
  const opening = sum((at) => at.opening);
  const came = sum((at) => at.in + Math.max(0, at.adjusted));
  const went = sum(outOf);
  const closing = sum((at) => at.closing);
  const cost = sum((at) => at.usedValue + at.wastedValue);

  return (
    <View className="gap-1.5 py-3">
      <View className="flex-row items-center justify-between">
        <Text numberOfLines={1} variant="label">
          {item.name}
        </Text>
        {cost > 0 ? <Text variant="caption">{formatMoney(cost)} used</Text> : null}
      </View>
      <View className="flex-row">
        <Cell label="Opening">{formatQty(opening, item.unit)}</Cell>
        <Cell label="In">+{formatQty(came, item.unit)}</Cell>
        <Cell label="Out">−{formatQty(went, item.unit)}</Cell>
        <Cell label="Closing" strong>
          {formatQty(closing, item.unit)}
        </Cell>
      </View>
    </View>
  );
}

function Cell({ children, label, strong = false }: { children: ReactNode; label: string; strong?: boolean }) {
  return (
    <View className="flex-1 gap-0.5">
      <Text style={{ fontSize: 10 }} variant="caption">
        {label}
      </Text>
      <Text className={strong ? "font-semibold" : undefined} numberOfLines={1} style={{ fontSize: 13 }}>
        {children}
      </Text>
    </View>
  );
}

/** The item table as comma-separated rows: pasted into a sheet, it is a sheet. */
async function shareTable(home: StockHome) {
  const rows = [
    ["Item", "Unit", "Opening", "In", "Used", "Wasted", "Sent", "Count +/-", "Closing", "Avg cost", "Value now"],
    ...home.items
      .filter((item) => item.kind === "STORE" && item.active)
      .map((item) => {
        const sum = (pick: (at: StockItem["at"][number]) => number) => item.at.reduce((total, at) => total + pick(at), 0);

        return [
          item.name,
          item.unit.toLowerCase(),
          sum((at) => at.opening),
          sum((at) => at.in),
          sum((at) => at.used),
          sum((at) => at.wasted),
          sum((at) => at.out),
          sum((at) => at.adjusted),
          sum((at) => at.closing),
          item.avgCost ?? "",
          item.value ?? "",
        ].map(String);
      }),
  ];
  const csv = rows.map((row) => row.map((cell) => (/[",\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell)).join(",")).join("\n");

  await Share.share({ message: `Stock · ${monthLabel(home.period)}\n\n${csv}`, title: `Stock ${home.period}` });
}
