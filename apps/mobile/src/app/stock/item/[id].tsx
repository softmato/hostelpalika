import { Ionicons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Pressable, View } from "react-native";

import {
  HistoryMonths,
  ItemAvatar,
  ItemSettings,
  NoStockAccess,
  Pill,
  UnderlineTabs,
  useStock,
} from "@/components/stock/stock-parts";
import { AppBar } from "@/components/ui/app-bar";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Screen } from "@/components/ui/screen";
import { SkeletonCard } from "@/components/ui/skeleton";
import { EmptyCard, ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { bsDayLong } from "@/lib/expenses";
import { formatQty, type StockAt, type StockItem, type StockPlace } from "@/lib/stock-api";

/**
 * One item (docs/INVENTORY_PLAN.md): **Overview** — what is left now and what
 * this month did to it, per building; **History** — every entry it was on;
 * **Settings** — the owner's name, kind, unit and low mark.
 */

type Tab = "history" | "overview" | "settings";

export default function StockItemScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { denied, home, overall, resource } = useStock();
  const [tab, setTab] = useState<Tab>("overview");
  const item = home?.items.find((row) => row.id === id) ?? null;
  const canEdit = home?.owner === true && !overall;

  const header = <AppBar centerTitle showBack title={item?.name ?? "Item"} />;

  if (denied) {
    return (
      <Screen header={header}>
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

  if (!home) {
    return (
      <Screen header={header}>
        <SkeletonCard rows={4} />
      </Screen>
    );
  }

  if (!item) {
    return (
      <Screen header={header}>
        <EmptyCard description="It may have been removed from the list." title="Item not found" />
      </Screen>
    );
  }

  const tabs = [
    { label: "Overview", value: "overview" as const },
    { label: "History", value: "history" as const },
    ...(canEdit ? [{ label: "Settings", value: "settings" as const }] : []),
  ];

  return (
    <Screen
      header={
        <View className="bg-background">
          {header}
          <View className="flex-row items-center gap-3 px-5 pb-4 pt-1">
            <ItemAvatar item={item} size={56} />
            <View className="flex-1">
              <Text variant="title">{item.name}</Text>
              <Text variant="muted">
                {item.kind === "STORE" ? "Store item" : "Daily item"}
                {item.active ? "" : " · not buying any more"}
              </Text>
            </View>
          </View>
          <UnderlineTabs onChange={setTab} tabs={tabs} value={tab} />
        </View>
      }
      onRefresh={resource.refresh}
      refreshing={resource.refreshing}
      scroll
    >
      <View className="pb-6 pt-4">
        {tab === "overview" ? (
          <Overview
            item={item}
            onEditLow={canEdit ? () => setTab("settings") : undefined}
            places={home.places}
            readOnly={overall}
          />
        ) : tab === "history" ? (
          <HistoryMonths filter="ALL" itemId={item.id} />
        ) : (
          <ItemSettings item={item} key={item.id} onSaved={resource.refresh} />
        )}
      </View>
    </Screen>
  );
}

function Overview({
  item,
  onEditLow,
  places,
  readOnly,
}: {
  item: StockItem;
  onEditLow?: () => void;
  places: StockPlace[];
  readOnly: boolean;
}) {
  const many = item.at.length > 1;
  const go = (pathname: "/stock/buy" | "/stock/count" | "/stock/send") =>
    router.push({ params: { itemId: item.id }, pathname });

  return (
    <View className="gap-6">
      {item.at.map((at) => {
        const place = places.find((entry) => entry.id === at.hostelId);

        return (
          <View className="gap-3" key={at.hostelId}>
            {many ? <Text variant="subtitle">{place?.name ?? "Hostel"}</Text> : null}
            {item.kind === "STORE" ? <LeftNow at={at} item={item} onEditLow={onEditLow} /> : null}
            <ThisMonth at={at} item={item} residents={place?.residents ?? null} />
          </View>
        );
      })}

      {readOnly ? null : (
        <View className="flex-row gap-2">
          <View className="flex-1">
            <Button label="Buy" onPress={() => go("/stock/buy")} variant="outline" />
          </View>
          <View className="flex-1">
            <Button label="Send" onPress={() => go("/stock/send")} variant="outline" />
          </View>
          {item.kind === "STORE" ? (
            <View className="flex-1">
              <Button label="Count" onPress={() => go("/stock/count")} variant="outline" />
            </View>
          ) : null}
        </View>
      )}
    </View>
  );
}

function LeftNow({ at, item, onEditLow }: { at: StockAt; item: StockItem; onEditLow?: () => void }) {
  const { colors } = useAppTheme();

  return (
    <Card className="gap-3">
      <Text variant="subtitle">Left now</Text>
      <View className="flex-row">
        <View className="flex-1 gap-0.5">
          <Text variant="caption">Left now</Text>
          <Text className={at.low ? "text-destructive" : "text-foreground"} variant="title">
            {formatQty(at.left, item.unit)}
          </Text>
        </View>
        <View className="flex-1 gap-0.5">
          <Text variant="caption">Last count</Text>
          <Text variant="label">{at.countedAt ? bsDayLong(at.countedAt.slice(0, 10)) : "Not counted yet"}</Text>
        </View>
      </View>
      <View className="flex-row items-center justify-between rounded-xl bg-muted px-3 py-2.5">
        <Text variant="muted">
          {item.lowAt !== null ? `Running low below ${formatQty(item.lowAt, item.unit)}` : "No low mark set"}
        </Text>
        <View className="flex-row items-center gap-2">
          {at.low ? <Pill color="#FF3B30" label="Low" /> : null}
          {onEditLow ? (
            <Pressable accessibilityLabel="Change the low mark" accessibilityRole="button" hitSlop={8} onPress={onEditLow}>
              <Ionicons color={colors.mutedForeground} name="pencil" size={16} />
            </Pressable>
          ) : null}
        </View>
      </View>
      {at.onWay > 0 ? <Pill color="#007AFF" label={`+${formatQty(at.onWay, item.unit)} on the way`} /> : null}
    </Card>
  );
}

function ThisMonth({ at, item, residents }: { at: StockAt; item: StockItem; residents: number | null }) {
  const perResident = residents && at.used > 0 ? formatQty(at.used / residents, item.unit) : null;

  return (
    <View className="gap-2">
      <Text variant="subtitle">This month</Text>
      <View className="flex-row gap-2">
        <Tile label="Came in" value={formatQty(at.in, item.unit)} />
        <Tile label="Sent out" value={formatQty(at.out, item.unit)} />
        <Tile label="Used" value={formatQty(at.used, item.unit)} />
      </View>
      {perResident || at.short > 0 ? (
        <View className="flex-row gap-2">
          {perResident ? <Tile label="Per resident" value={`${perResident} each`} /> : null}
          {residents ? <Tile label="Residents" value={String(residents)} /> : null}
          {at.short > 0 ? <Tile danger label="Short" value={formatQty(at.short, item.unit)} /> : null}
        </View>
      ) : null}
    </View>
  );
}

function Tile({ danger = false, label, value }: { danger?: boolean; label: string; value: string }) {
  return (
    <View className={`flex-1 gap-0.5 rounded-2xl px-3 py-2.5 ${danger ? "bg-destructive-soft" : "bg-muted"}`}>
      <Text variant="caption">{label}</Text>
      <Text className={danger ? "text-destructive" : "text-foreground"} numberOfLines={1} variant="label">
        {value}
      </Text>
    </View>
  );
}
