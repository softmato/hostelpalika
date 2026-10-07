import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useMemo, useState } from "react";
import { Pressable, View } from "react-native";

import { HostelSwitcher } from "@/components/hostel-switcher";
import { ItemAvatar, NoStockAccess, useStock } from "@/components/stock/stock-parts";
import { AppBar } from "@/components/ui/app-bar";
import { Button } from "@/components/ui/button";
import { Card, SectionHeader } from "@/components/ui/card";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { RowDivider } from "@/components/ui/list-row";
import { Screen } from "@/components/ui/screen";
import { SkeletonRows } from "@/components/ui/skeleton";
import { EmptyCard, ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { formatQty, namesSummary, type StockHome, type StockItem } from "@/lib/stock-api";

/**
 * Stock — home (docs/INVENTORY_PLAN.md).
 *
 * Made for the person carrying the sack, not the person reading the ledger:
 * two big buttons — **Add stock**, **Send** — and what is in the store, with
 * its number on the right. Goods coming from another building sit on top with
 * their **Got it** button. Counting and the history are the two icons in the
 * bar; they are the owner's jobs, not the daily one.
 *
 * Every write belongs to the building chosen in the switcher; Overall shows
 * every building at once and only reads.
 */

const SEARCH_FROM = 8;

export default function StockScreen() {
  const { colors } = useAppTheme();
  const { denied, here, home, overall, resource } = useStock();
  const [query, setQuery] = useState("");

  const items = useMemo(
    () =>
      (home?.items ?? [])
        .filter((item) => item.active)
        .sort((left, right) => Number(isLow(right)) - Number(isLow(left)) || left.name.localeCompare(right.name)),
    [home],
  );
  const shown = query.trim()
    ? items.filter((item) => item.name.toLowerCase().includes(query.trim().toLowerCase()))
    : items;
  const canSend = (home?.places.length ?? 0) > 1;

  const header = (
    <AppBar
      actions={
        <View className="flex-row items-center gap-2">
          <HostelSwitcher compact />
          {home && !overall ? (
            <IconButton label="Count" name="clipboard-outline" onPress={() => router.push("/stock/count")} size="sm" />
          ) : null}
          <IconButton label="History" name="time-outline" onPress={() => router.push("/stock/history")} size="sm" />
        </View>
      }
      large
      showBack
      subtitle={overall ? "All buildings" : here?.name}
      title="Stock"
    />
  );

  if (denied) {
    return (
      <Screen header={<AppBar large showBack title="Stock" />}>
        <NoStockAccess />
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

  return (
    <Screen header={header} onRefresh={resource.refresh} refreshing={resource.refreshing} scroll>
      {!home ? (
        <View className="pt-4">
          <SkeletonRows rows={6} />
        </View>
      ) : (
        <View className="gap-6 pb-6 pt-3">
          {!overall && home.waiting.length > 0 ? (
            <View className="gap-3 rounded-2xl border border-warning bg-warning-soft p-4">
              {home.waiting.map((entry) => (
                <View className="flex-row items-center gap-3" key={entry.id}>
                  <Ionicons color={colors.warning} name="cube-outline" size={24} />
                  <View className="flex-1">
                    <Text variant="label">From {entry.hostelName}</Text>
                    <Text numberOfLines={1} variant="caption">
                      {namesSummary(entry.lines)}
                    </Text>
                  </View>
                  <Button
                    label="Got it"
                    onPress={() => router.push({ params: { id: entry.id }, pathname: "/stock/receive/[id]" })}
                    size="sm"
                  />
                </View>
              ))}
            </View>
          ) : null}

          {overall ? null : (
            <View className="flex-row gap-3">
              <BigButton icon="add" label="Add stock" onPress={() => router.push("/stock/buy")} primary />
              {canSend ? (
                <BigButton icon="arrow-forward" label="Send" onPress={() => router.push("/stock/send")} />
              ) : null}
            </View>
          )}

          {items.length === 0 ? (
            <EmptyCard
              description={overall ? "Nothing in any building yet." : "Tap Add stock when goods come."}
              title="No stock yet"
            />
          ) : (
            <View>
              <SectionHeader title="In store" />
              {items.length >= SEARCH_FROM ? (
                <View className="mb-3">
                  <Input
                    leading={<Ionicons color={colors.mutedForeground} name="search" size={18} />}
                    onChangeText={setQuery}
                    placeholder="Search"
                    value={query}
                  />
                </View>
              ) : null}
              {shown.length === 0 ? (
                <Text className="px-1" variant="muted">
                  Nothing called that.
                </Text>
              ) : (
                <Card padding="px-4 py-0">
                  {shown.map((item, index) => (
                    <View key={item.id}>
                      {index > 0 ? <RowDivider inset /> : null}
                      <StockRow home={home} item={item} />
                    </View>
                  ))}
                </Card>
              )}
            </View>
          )}
        </View>
      )}
    </Screen>
  );
}

function isLow(item: StockItem) {
  return item.at.some((at) => at.low);
}

/** The two jobs, as big as a thumb: a picture and one word each. */
function BigButton({
  icon,
  label,
  onPress,
  primary = false,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  primary?: boolean;
}) {
  const { colors } = useAppTheme();

  return (
    <Pressable
      accessibilityRole="button"
      className={`h-28 flex-1 items-center justify-center gap-2 rounded-2xl active:opacity-80 ${
        primary ? "bg-primary" : "border border-border bg-card"
      }`}
      onPress={onPress}
    >
      <View
        className={`h-12 w-12 items-center justify-center rounded-full ${primary ? "bg-white/20" : "bg-brand-soft"}`}
      >
        <Ionicons color={primary ? colors.primaryForeground : colors.primary} name={icon} size={28} />
      </View>
      <Text className={`text-base font-semibold ${primary ? "text-primary-foreground" : "text-foreground"}`}>
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * One item: picture, name, and how much — what is left for store goods, what
 * came this month for daily ones. A second line only when it says something:
 * low, more on the way, or each building's share in Overall.
 */
function StockRow({ home, item }: { home: StockHome; item: StockItem }) {
  const { colors } = useAppTheme();
  const store = item.kind === "STORE";
  const amount = (at: StockItem["at"][number]) => (store ? at.left : at.in);
  const total = item.at.reduce((sum, at) => sum + amount(at), 0);
  const onWay = item.at.reduce((sum, at) => sum + at.onWay, 0);
  const low = isLow(item);

  const line =
    item.at.length > 1
      ? item.at
          .map((at) => `${home.places.find((place) => place.id === at.hostelId)?.name ?? "Hostel"} ${formatQty(amount(at), item.unit)}`)
          .join(" · ")
      : low
        ? "Low"
        : onWay > 0
          ? `+${formatQty(onWay, item.unit)} coming`
          : store
            ? null
            : "This month";

  return (
    <Pressable
      accessibilityRole="button"
      className="min-h-16 flex-row items-center gap-3 py-3 active:opacity-70"
      onPress={() => router.push({ params: { id: item.id }, pathname: "/stock/item/[id]" })}
    >
      <ItemAvatar item={item} />
      <View className="flex-1">
        <Text numberOfLines={1} variant="label">
          {item.name}
        </Text>
        {line ? (
          <Text className={low ? "font-semibold text-destructive" : undefined} numberOfLines={1} variant="caption">
            {line}
          </Text>
        ) : null}
      </View>
      <Text className={low ? "text-destructive" : undefined} variant="subtitle">
        {formatQty(total, item.unit)}
      </Text>
      <Ionicons color={colors.mutedForeground} name="chevron-forward" size={18} />
    </Pressable>
  );
}
