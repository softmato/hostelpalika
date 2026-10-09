import { Ionicons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import { useMemo, useRef, useState } from "react";
import { Pressable, TextInput, View } from "react-native";

import {
  ItemAvatar,
  NoStockAccess,
  QuickQty,
  qtyText,
  readQty,
  stockChanged,
  unitLabel,
  useStock,
} from "@/components/stock/stock-parts";
import { AppBar } from "@/components/ui/app-bar";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Chip, Grid } from "@/components/ui/layout";
import { Screen } from "@/components/ui/screen";
import { Segmented } from "@/components/ui/segmented";
import { SkeletonCard } from "@/components/ui/skeleton";
import { EmptyCard, ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { readApiError } from "@/lib/api-contract";
import { newClientRequestId } from "@/lib/expenses";
import {
  addStockEntry,
  formatQty,
  STOCK_USE_FOR,
  STOCK_USE_FOR_LABELS,
  STOCK_WASTE_LABELS,
  STOCK_WASTE_REASONS,
  type StockItem,
  type StockUseFor,
  type StockWasteReason,
} from "@/lib/stock-api";
import { toastError, toastSuccess } from "@/lib/toast";

/**
 * Use / Waste — goods leaving the store (docs/INVENTORY_PLAN.md).
 *
 * Built to take five seconds, because a slow one stops being used by the third
 * day: the items this building uses most are tiles at the top, a tap puts one
 * on the list with its box already focused, the `+1 / +5 / +1 sack` buttons do
 * the typing, and Save is the only button. Who it was for (or why it was
 * thrown away) is one chip, Kitchen already picked.
 *
 * Only store items: a daily item is used the day it comes and is never entered
 * twice.
 */

type Mode = "use" | "waste";

const TILES = 8;

export default function UseStockScreen() {
  const { colors } = useAppTheme();
  const params = useLocalSearchParams<{ itemId?: string; mode?: string }>();
  const { denied, here, home, overall, resource } = useStock();

  const [mode, setMode] = useState<Mode>(params.mode === "waste" ? "waste" : "use");
  const [useFor, setUseFor] = useState<StockUseFor>("KITCHEN");
  const [reason, setReason] = useState<StockWasteReason>("SPOILED");
  const [lines, setLines] = useState<{ itemId: string; qty: string }[]>(() =>
    params.itemId ? [{ itemId: params.itemId, qty: "" }] : [],
  );
  const [focus, setFocus] = useState<string | null>(params.itemId ?? null);
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const requestId = useRef(newClientRequestId());

  const store = useMemo(
    () => (home?.items ?? []).filter((item) => item.active && item.kind === "STORE"),
    [home],
  );
  const byId = useMemo(() => new Map(store.map((item) => [item.id, item])), [store]);
  /** Most used lately first, then the rest by name. */
  const ordered = useMemo(() => {
    const rank = new Map((home?.recentUse ?? []).map((id, index) => [id, index]));

    return [...store].sort(
      (a, b) => (rank.get(a.id) ?? 999) - (rank.get(b.id) ?? 999) || a.name.localeCompare(b.name),
    );
  }, [home, store]);
  const typed = query.trim().toLowerCase();
  const tiles = typed
    ? ordered.filter((item) => item.name.toLowerCase().includes(typed))
    : showAll
      ? ordered
      : ordered.slice(0, TILES);

  const leftOf = (item: StockItem) => item.at.find((at) => at.hostelId === here?.id)?.left ?? 0;
  const waste = mode === "waste";

  const pick = (itemId: string) => {
    setLines((prev) => (prev.some((line) => line.itemId === itemId) ? prev : [...prev, { itemId, qty: "" }]));
    setFocus(itemId);
  };

  const setQty = (itemId: string, qty: string) =>
    setLines((prev) => prev.map((line) => (line.itemId === itemId ? { ...line, qty } : line)));

  const filled = lines.filter((line) => {
    const qty = readQty(line.qty);
    return typeof qty === "number" && qty > 0;
  });
  const bad = lines.find((line) => line.qty.trim() !== "" && readQty(line.qty) === false);

  const save = async () => {
    if (!here || filled.length === 0 || bad) {
      toastError(
        "Not saved yet",
        bad ? `Check the number for ${byId.get(bad.itemId)?.name ?? "an item"}.` : "Tap an item and write how much.",
      );
      return;
    }

    setSaving(true);

    try {
      await addStockEntry({
        clientRequestId: requestId.current,
        hostelId: here.id,
        kind: waste ? "WASTE" : "USE",
        lines: filled.map((line) => ({ itemId: line.itemId, qty: readQty(line.qty) as number })),
        note: note.trim() || undefined,
        ...(waste ? { wasteReason: reason } : { useFor }),
      });
      toastSuccess(
        waste ? "Waste saved" : "Saved",
        filled.map((line) => byId.get(line.itemId)?.name).filter(Boolean).join(", "),
      );
      stockChanged();
      router.back();
    } catch (error) {
      toastError("Not saved", readApiError(error, "Check your internet and tap Save again."));
    } finally {
      setSaving(false);
    }
  };

  const header = <AppBar centerTitle showBack subtitle={here?.name} title={waste ? "Waste" : "Use stock"} />;

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

  if (overall || !here) {
    return (
      <Screen header={header}>
        <EmptyCard description="Switch to the building the goods left from." title="Pick a building" />
      </Screen>
    );
  }

  if (store.length === 0) {
    return (
      <Screen header={header}>
        <EmptyCard description="Add what came in with Buy first. Daily items are used the day they come." title="Nothing in store" />
      </Screen>
    );
  }

  return (
    <Screen
      footer={
        <Button
          disabled={filled.length === 0}
          label={
            filled.length > 0
              ? `${waste ? "Save waste" : "Save"} · ${filled.length} item${filled.length === 1 ? "" : "s"}`
              : waste
                ? "Save waste"
                : "Save"
          }
          loading={saving}
          onPress={() => void save()}
          size="lg"
          variant={waste ? "danger" : "primary"}
        />
      }
      header={header}
      scroll
    >
      <View className="gap-5 pb-4 pt-3">
        <Segmented
          onChange={setMode}
          options={[
            { label: "Used", value: "use" as const },
            { label: "Wasted", value: "waste" as const },
          ]}
          value={mode}
        />

        <View className="gap-2">
          <Text variant="caption">{waste ? "Why?" : "For"}</Text>
          <View className="flex-row flex-wrap gap-2">
            {waste
              ? STOCK_WASTE_REASONS.map((value) => (
                  <Chip
                    key={value}
                    label={STOCK_WASTE_LABELS[value]}
                    onPress={() => setReason(value)}
                    tone={reason === value ? "brand" : "neutral"}
                  />
                ))
              : STOCK_USE_FOR.map((value) => (
                  <Chip
                    key={value}
                    label={STOCK_USE_FOR_LABELS[value]}
                    onPress={() => setUseFor(value)}
                    tone={useFor === value ? "brand" : "neutral"}
                  />
                ))}
          </View>
        </View>

        <View className="gap-2">
          <Text variant="caption">Tap what you took</Text>
          {store.length > TILES ? (
            <Input
              leading={<Ionicons color={colors.mutedForeground} name="search" size={18} />}
              onChangeText={setQuery}
              placeholder="Search items"
              value={query}
            />
          ) : null}
          <Grid gap={8} maxColumns={4} minCellWidth={76}>
            {tiles.map((item) => (
              <ItemTile
                item={item}
                key={item.id}
                left={leftOf(item)}
                onPress={() => pick(item.id)}
                picked={lines.some((line) => line.itemId === item.id)}
              />
            ))}
          </Grid>
          {!typed && store.length > TILES ? (
            <Pressable accessibilityRole="button" className="items-center py-2 active:opacity-70" onPress={() => setShowAll((value) => !value)}>
              <Text className="font-semibold text-primary" variant="label">
                {showAll ? "Show fewer" : `Show all ${store.length}`}
              </Text>
            </Pressable>
          ) : null}
        </View>

        {lines.length > 0 ? (
          <View className="gap-3">
            {lines.map((line) => {
              const item = byId.get(line.itemId);

              if (!item) return null;

              const left = leftOf(item);
              const qty = readQty(line.qty);
              const over = typeof qty === "number" && qty > left;

              return (
                <Card className="gap-3" key={line.itemId}>
                  <View className="flex-row items-center gap-3">
                    <ItemAvatar item={item} size={40} />
                    <View className="flex-1">
                      <Text numberOfLines={1} variant="label">
                        {item.name}
                      </Text>
                      <Text className={over ? "text-warning" : undefined} variant="caption">
                        {over ? `More than the ${formatQty(left, item.unit)} left` : `${formatQty(left, item.unit)} left`}
                      </Text>
                    </View>
                    <View
                      className={`flex-row items-center rounded-xl border bg-card px-3 ${
                        qty === false ? "border-destructive" : line.qty.trim() ? "border-primary" : "border-border"
                      }`}
                    >
                      <TextInput
                        accessibilityLabel={`${item.name}, how much`}
                        autoFocus={focus === line.itemId}
                        className="w-16 py-2.5 text-right text-lg font-semibold text-foreground"
                        inputMode="decimal"
                        keyboardType="decimal-pad"
                        onChangeText={(next) => setQty(line.itemId, next)}
                        placeholder="0"
                        placeholderTextColor={colors.mutedForeground}
                        selectTextOnFocus
                        value={line.qty}
                      />
                      <Text className="ml-1.5" variant="muted">
                        {unitLabel(item.unit)}
                      </Text>
                    </View>
                    <Pressable
                      accessibilityLabel={`Remove ${item.name}`}
                      accessibilityRole="button"
                      hitSlop={8}
                      onPress={() => setLines((prev) => prev.filter((entry) => entry.itemId !== line.itemId))}
                    >
                      <Ionicons color={colors.mutedForeground} name="close-circle" size={24} />
                    </Pressable>
                  </View>
                  <QuickQty
                    item={item}
                    onAdd={(step) => setQty(line.itemId, qtyText((typeof qty === "number" ? qty : 0) + step))}
                  />
                </Card>
              );
            })}

            <Input
              label="Note (optional)"
              maxLength={200}
              onChangeText={setNote}
              placeholder={waste ? "e.g. rats got into the sack" : "e.g. for the picnic"}
              value={note}
            />
          </View>
        ) : null}
      </View>
    </Screen>
  );
}

/** A thumb-sized item: picture, name, what is left. Ticked once it is on the list. */
function ItemTile({
  item,
  left,
  onPress,
  picked,
}: {
  item: StockItem;
  left: number;
  onPress: () => void;
  picked: boolean;
}) {
  const { colors } = useAppTheme();
  const low = item.lowAt !== null && left < item.lowAt;

  return (
    <Pressable
      accessibilityLabel={`${item.name}, ${formatQty(left, item.unit)} left`}
      accessibilityRole="button"
      accessibilityState={{ selected: picked }}
      className={`items-center gap-1 rounded-2xl border px-1 py-2.5 active:opacity-70 ${
        picked ? "border-primary bg-brand-soft" : "border-border bg-card"
      }`}
      onPress={onPress}
    >
      <ItemAvatar item={item} size={36} />
      <Text className="text-center text-xs font-semibold" numberOfLines={1}>
        {item.name}
      </Text>
      <Text className={low ? "text-destructive" : "text-muted-foreground"} numberOfLines={1} style={{ fontSize: 10 }}>
        {formatQty(left, item.unit)}
      </Text>
      {picked ? (
        <View className="absolute right-1 top-1">
          <Ionicons color={colors.primary} name="checkmark-circle" size={16} />
        </View>
      ) : null}
    </Pressable>
  );
}
