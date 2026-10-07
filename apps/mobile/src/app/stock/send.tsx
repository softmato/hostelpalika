import { Ionicons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import { useMemo, useRef, useState } from "react";
import { Pressable, View } from "react-native";

import { ItemAvatar, NoStockAccess, readQty, stockChanged, unitLabel, useStock } from "@/components/stock/stock-parts";
import { AppBar } from "@/components/ui/app-bar";
import { Button } from "@/components/ui/button";
import { Card, SectionHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { RowDivider } from "@/components/ui/list-row";
import { Screen } from "@/components/ui/screen";
import { SkeletonCard } from "@/components/ui/skeleton";
import { EmptyCard, ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { readApiError } from "@/lib/api-contract";
import { newClientRequestId } from "@/lib/expenses";
import { addStockEntry, formatQty, type StockItem } from "@/lib/stock-api";
import { toastError, toastSuccess } from "@/lib/toast";

/**
 * Send — stock carried to another building, on one screen
 * (docs/INVENTORY_PLAN.md).
 *
 * Tap where it goes, write how much beside each thing that is going, Send. The
 * store's own number sits under each name so nobody has to remember it. It
 * counts at the other end only when they tap Got it.
 */

const SEARCH_FROM = 8;

export default function SendScreen() {
  const { colors } = useAppTheme();
  const params = useLocalSearchParams<{ itemId?: string }>();
  const { denied, here, home, overall, resource } = useStock();

  const [toPick, setTo] = useState<string | null>(null);
  const [qty, setQty] = useState<Record<string, string>>({});
  const [query, setQuery] = useState("");
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);
  const requestId = useRef(newClientRequestId());

  const leftHere = (item: StockItem) => item.at.find((at) => at.hostelId === here?.id)?.left ?? 0;
  const items = useMemo(
    () =>
      (home?.items ?? [])
        .filter((item) => item.active)
        // The one it was opened from first, then what the store actually holds.
        .sort(
          (left, right) =>
            Number(right.id === params.itemId) - Number(left.id === params.itemId) ||
            Number((right.at.find((at) => at.hostelId === here?.id)?.left ?? 0) > 0) -
              Number((left.at.find((at) => at.hostelId === here?.id)?.left ?? 0) > 0) ||
            left.name.localeCompare(right.name),
        ),
    [home, here, params.itemId],
  );
  const shown = query.trim()
    ? items.filter((item) => item.name.toLowerCase().includes(query.trim().toLowerCase()) || qty[item.id])
    : items;
  const others = (home?.places ?? []).filter((place) => place.id !== here?.id);
  const to = others.find((place) => place.id === toPick) ?? (others.length === 1 ? others[0] : null);

  const going = items.filter((item) => (qty[item.id] ?? "").trim());
  const badQty = (item: StockItem) => {
    const value = readQty(qty[item.id]);
    return value === false || (typeof value === "number" && value <= 0);
  };

  const send = async () => {
    setTried(true);

    const problem = !to
      ? "Tap where it goes."
      : going.length === 0
        ? "Write how much of something."
        : going.some(badQty)
          ? "Fix the red box."
          : null;

    if (problem || !here || !to) {
      toastError("Not sent yet", problem ?? "Pick a building.");
      return;
    }

    setSaving(true);

    try {
      await addStockEntry({
        clientRequestId: requestId.current,
        hostelId: here.id,
        kind: "SEND",
        lines: going.map((item) => ({ itemId: item.id, qty: readQty(qty[item.id]) as number })),
        toHostelId: to.id,
      });
      toastSuccess(`Sent to ${to.name}`, "They tap Got it when it comes.");
      stockChanged();
      router.back();
    } catch (error) {
      toastError("Not sent", readApiError(error, "Check your internet and tap Send again."));
    } finally {
      setSaving(false);
    }
  };

  const header = (
    <AppBar centerTitle showBack subtitle={here ? `From ${here.name}` : undefined} title="Send" />
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

  if (!home) {
    return (
      <Screen header={header}>
        <SkeletonCard rows={5} />
      </Screen>
    );
  }

  if (overall || !here) {
    return (
      <Screen header={header}>
        <EmptyCard description="Switch to the building the goods leave from." title="Pick a building" />
      </Screen>
    );
  }

  if (others.length === 0) {
    return (
      <Screen header={header}>
        <EmptyCard description="Send works between your main hostel and its branches." title="No other building" />
      </Screen>
    );
  }

  return (
    <Screen
      footer={
        <Button
          disabled={!to || going.length === 0}
          label={going.length > 0 && to ? `Send ${going.length} to ${to.name}` : "Send"}
          loading={saving}
          onPress={() => void send()}
          size="lg"
        />
      }
      header={header}
      scroll
    >
      <View className="gap-6 pb-4 pt-3">
        <View>
          <SectionHeader title="To" />
          <View className="flex-row flex-wrap gap-3">
            {others.map((place) => {
              const active = to?.id === place.id;

              return (
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  className={`min-w-32 flex-1 flex-row items-center gap-3 rounded-2xl border p-4 active:opacity-80 ${
                    active ? "border-primary bg-brand-soft" : tried && !to ? "border-destructive bg-card" : "border-border bg-card"
                  }`}
                  key={place.id}
                  onPress={() => setTo(place.id)}
                >
                  <Ionicons
                    color={active ? colors.primary : colors.mutedForeground}
                    name={active ? "checkmark-circle" : "business-outline"}
                    size={24}
                  />
                  <Text className="flex-1" numberOfLines={2} variant="label">
                    {place.name}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        <View>
          <SectionHeader title="What" />
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
          {items.length === 0 ? (
            <EmptyCard description="Add stock first, then send it." title="Nothing in store" />
          ) : (
            <Card padding="px-4 py-0">
              {shown.map((item, index) => (
                <View key={item.id}>
                  {index > 0 ? <RowDivider inset /> : null}
                  <View className="min-h-16 flex-row items-center gap-3 py-3">
                    <ItemAvatar item={item} />
                    <View className="flex-1">
                      <Text numberOfLines={1} variant="label">
                        {item.name}
                      </Text>
                      {item.kind === "STORE" ? (
                        <Text variant="caption">{formatQty(leftHere(item), item.unit)} here</Text>
                      ) : null}
                    </View>
                    <View className="w-32">
                      <Input
                        accessibilityLabel={`How much ${item.name}`}
                        inputMode="decimal"
                        keyboardType="decimal-pad"
                        onChangeText={(value) => setQty((prev) => ({ ...prev, [item.id]: value }))}
                        placeholder="0"
                        selectTextOnFocus
                        tone={tried && badQty(item) ? "danger" : undefined}
                        trailing={<Text variant="muted">{unitLabel(item.unit)}</Text>}
                        value={qty[item.id] ?? ""}
                      />
                    </View>
                  </View>
                </View>
              ))}
            </Card>
          )}
        </View>
      </View>
    </Screen>
  );
}
