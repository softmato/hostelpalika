import { Ionicons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { TextInput, View } from "react-native";

import { ItemAvatar, NoStockAccess, readQty, stockChanged, unitLabel, useStock } from "@/components/stock/stock-parts";
import { AppBar } from "@/components/ui/app-bar";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { RowDivider } from "@/components/ui/list-row";
import { Screen } from "@/components/ui/screen";
import { SkeletonCard } from "@/components/ui/skeleton";
import { EmptyCard, ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { readApiError } from "@/lib/api-contract";
import { bsDayLong } from "@/lib/expenses";
import { formatQty, receiveStock, roundQty } from "@/lib/stock-api";
import { toastError, toastSuccess } from "@/lib/toast";

/**
 * Got It — the receiving building confirms a Send (docs/INVENTORY_PLAN.md).
 *
 * Every box starts at what was sent; the person changes only what fell short.
 * The difference shows in red as it is typed, so "1 kg short" is seen before
 * it is saved.
 */
export default function GotItScreen() {
  const { colors } = useAppTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { denied, home, resource } = useStock();
  const entry = home?.waiting.find((row) => row.id === id) ?? null;

  const [got, setGot] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const header = (
    <AppBar
      centerTitle
      showBack
      subtitle={entry ? `Confirm what arrived from ${entry.hostelName}` : undefined}
      title="Got It"
    />
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
        <SkeletonCard rows={4} />
      </Screen>
    );
  }

  if (!entry || !entry.canReceive) {
    return (
      <Screen header={header}>
        <EmptyCard
          action={
            <Button
              label="See it"
              onPress={() => router.replace({ params: { id }, pathname: "/stock/entry/[id]" })}
              size="sm"
              variant="outline"
            />
          }
          description="It was already confirmed, cancelled, or is for another building."
          title="Nothing to confirm"
        />
      </Screen>
    );
  }

  const value = (itemId: string, sent: number) => got[itemId] ?? String(sent);
  const bad = entry.lines.find((line) => readQty(value(line.itemId, line.qty)) === false || readQty(value(line.itemId, line.qty)) === null);

  const confirm = async () => {
    if (bad) {
      toastError("Check the numbers", `Write how much ${bad.name} came — 0 if none.`);
      return;
    }

    setSaving(true);

    try {
      await receiveStock(
        entry.id,
        entry.lines.map((line) => ({ itemId: line.itemId, receivedQty: readQty(value(line.itemId, line.qty)) as number })),
      );
      toastSuccess("Got it", `Added to ${home.places.find((place) => place.id === entry.toHostelId)?.name ?? "your store"}`);
      stockChanged();
      router.back();
    } catch (error) {
      toastError("Not saved", readApiError(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Screen
      footer={<Button label="Confirm Received" loading={saving} onPress={() => void confirm()} size="lg" />}
      header={header}
      scroll
    >
      <View className="gap-5 pb-4 pt-3">
        <View className="flex-row items-center gap-3 rounded-2xl bg-info-soft p-4">
          <View className="h-10 w-10 items-center justify-center rounded-full bg-card">
            <Ionicons color={colors.info} name="arrow-down-circle-outline" size={22} />
          </View>
          <View className="flex-1">
            <Text variant="label">Sent on {bsDayLong(entry.on)}</Text>
            <Text variant="caption">
              From {entry.hostelName} · by {entry.recordedByName}
            </Text>
            {entry.note ? <Text variant="caption">“{entry.note}”</Text> : null}
          </View>
        </View>

        <View className="gap-2">
          <Text variant="subtitle">Items</Text>
          <Card padding="px-4 py-1">
            {entry.lines.map((line, index) => {
              const text = value(line.itemId, line.qty);
              const qty = readQty(text);
              const short = typeof qty === "number" && qty < line.qty ? roundQty(line.qty - qty) : 0;

              return (
                <View key={line.itemId}>
                  {index > 0 ? <RowDivider inset /> : null}
                  <View className="min-h-16 flex-row items-center gap-3 py-3">
                    <ItemAvatar item={{ kind: "STORE", name: line.name }} size={40} />
                    <View className="flex-1">
                      <Text variant="label">{line.name}</Text>
                      <Text variant="caption">Sent: {formatQty(line.qty, line.unit)}</Text>
                    </View>
                    <View className="items-end gap-1">
                      <Text variant="caption">Received</Text>
                      <View
                        className={`flex-row items-center rounded-xl border bg-card px-3 ${
                          short > 0 || qty === false ? "border-destructive" : "border-border"
                        }`}
                      >
                        <TextInput
                          accessibilityLabel={`${line.name} received`}
                          className="w-16 py-2.5 text-right text-base font-semibold text-foreground"
                          inputMode="decimal"
                          keyboardType="decimal-pad"
                          onChangeText={(next) => setGot((prev) => ({ ...prev, [line.itemId]: next }))}
                          selectTextOnFocus
                          value={text}
                        />
                        <Text className="ml-1.5" variant="muted">
                          {unitLabel(line.unit)}
                        </Text>
                      </View>
                      {short > 0 ? (
                        <Text className="text-destructive" variant="caption">
                          {formatQty(short, line.unit)} short
                        </Text>
                      ) : null}
                    </View>
                  </View>
                </View>
              );
            })}
          </Card>
        </View>
      </View>
    </Screen>
  );
}
