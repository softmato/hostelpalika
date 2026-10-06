import { useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { ScrollView, View } from "react-native";

import {
  HISTORY_FILTERS,
  type HistoryFilter,
  HistoryMonths,
  NoStockAccess,
  useStock,
} from "@/components/stock/stock-parts";
import { AppBar } from "@/components/ui/app-bar";
import { Chip } from "@/components/ui/layout";
import { Screen } from "@/components/ui/screen";
import { SkeletonRows } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/states";

/**
 * History — every Bought, Send, Got it and Count, month by month
 * (docs/INVENTORY_PLAN.md). Filter chips across the top; each row opens the
 * entry.
 */
export default function StockHistoryScreen() {
  const params = useLocalSearchParams<{ filter?: string }>();
  const { denied, home, overall, here, resource } = useStock();
  const [filter, setFilter] = useState<HistoryFilter>(
    HISTORY_FILTERS.some((option) => option.value === params.filter) ? (params.filter as HistoryFilter) : "ALL",
  );

  const header = (
    <View className="bg-background">
      <AppBar centerTitle showBack subtitle={overall ? "Every building" : here?.name} title="History" />
      <ScrollView contentContainerClassName="gap-2 px-5 pb-3" horizontal showsHorizontalScrollIndicator={false}>
        {HISTORY_FILTERS.map((option) => (
          <Chip
            key={option.value}
            label={option.label}
            onPress={() => setFilter(option.value)}
            tone={filter === option.value ? "brand" : "neutral"}
          />
        ))}
      </ScrollView>
    </View>
  );

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

  return (
    <Screen header={header} onRefresh={resource.refresh} refreshing={resource.refreshing} scroll>
      <View className="pb-6 pt-3">{home ? <HistoryMonths filter={filter} /> : <SkeletonRows rows={6} />}</View>
    </Screen>
  );
}
