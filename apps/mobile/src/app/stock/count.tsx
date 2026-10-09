import { Ionicons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import { useMemo, useRef, useState } from "react";
import { Pressable, TextInput, View } from "react-native";

import {
  DateField,
  ItemAvatar,
  ItemPicker,
  ItemSheet,
  NoStockAccess,
  readQty,
  stockChanged,
  unitLabel,
  useStock,
} from "@/components/stock/stock-parts";
import { AppBar } from "@/components/ui/app-bar";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Chip } from "@/components/ui/layout";
import { RowDivider } from "@/components/ui/list-row";
import { Screen } from "@/components/ui/screen";
import { SkeletonCard } from "@/components/ui/skeleton";
import { EmptyCard, ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { readApiError } from "@/lib/api-contract";
import { newClientRequestId, todayKey } from "@/lib/expenses";
import { addStockEntry, formatQty } from "@/lib/stock-api";
import { toastError, toastSuccess } from "@/lib/toast";

/**
 * Count Stock (docs/INVENTORY_PLAN.md).
 *
 * The store items this building holds, each with what the book says is left
 * and a box for what is really there. A box left empty is not counted. The gap
 * shows the moment a number is typed — `2 kg missing`, `1 kg extra` — and a
 * count that differs needs a reason.
 *
 * The gap is the adjustment. The owner's count (or that of a warden allowed to
 * approve) corrects the book at once; anyone else's waits for approval.
 */

const REASONS = ["Used, not entered", "Spoiled", "Book was wrong", "Missing"];

export default function CountScreen() {
  const { colors } = useAppTheme();
  const params = useLocalSearchParams<{ itemId?: string }>();
  const { denied, here, home, overall, resource } = useStock();

  const [day, setDay] = useState(() => todayKey());
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [added, setAdded] = useState<string[]>(() => (params.itemId ? [params.itemId] : []));
  const [picking, setPicking] = useState(false);
  const [newItem, setNewItem] = useState(false);
  const [saving, setSaving] = useState(false);
  const [why, setWhy] = useState("");
  const requestId = useRef(newClientRequestId());

  const store = useMemo(() => (home?.items ?? []).filter((item) => item.active && item.kind === "STORE"), [home]);
  /** What this building has handled, plus anything picked with Add Item. */
  const rows = store.filter((item) => {
    const at = item.at.find((row) => row.hostelId === here?.id);

    return (
      added.includes(item.id) ||
      (at !== undefined && (at.left !== 0 || at.counted !== null || at.in > 0 || at.onWay > 0))
    );
  });
  const filled = rows.filter((item) => (counts[item.id] ?? "").trim() !== "");
  const bad = filled.find((item) => readQty(counts[item.id]) === false);
  const leftHere = (item: (typeof rows)[number]) => item.at.find((row) => row.hostelId === here?.id)?.left ?? 0;
  const differs = filled.some((item) => {
    const qty = readQty(counts[item.id]);
    return typeof qty === "number" && Math.round((qty - leftHere(item)) * 100) !== 0;
  });

  const save = async () => {
    if (filled.length === 0 || bad || !here) {
      toastError("Not saved yet", bad ? `Check the number for ${bad.name}.` : "Write what is left of at least one item.");
      return;
    }

    if (differs && !why.trim()) {
      toastError("Say why", "The count is different from the book.");
      return;
    }

    setSaving(true);

    try {
      await addStockEntry({
        clientRequestId: requestId.current,
        hostelId: here.id,
        kind: "COUNT",
        lines: filled.map((item) => ({ itemId: item.id, qty: readQty(counts[item.id]) as number })),
        note: why.trim() || undefined,
        on: day,
      });
      toastSuccess(
        differs && !home?.canApprove ? "Sent for approval" : "Count saved",
        `${filled.length} item${filled.length === 1 ? "" : "s"}`,
      );
      stockChanged();
      router.back();
    } catch (error) {
      toastError("Not saved", readApiError(error, "Check your internet and tap Save again."));
    } finally {
      setSaving(false);
    }
  };

  const header = (
    <AppBar centerTitle showBack subtitle="What is really left in this building" title="Count Stock" />
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
        <EmptyCard description="Overall is view only. Switch to the building you are counting." title="Pick a building" />
      </Screen>
    );
  }

  return (
    <>
      <Screen
        footer={
          <View className="gap-2">
            {differs && !home.canApprove ? (
              <Text className="text-center" variant="caption">
                Different from the book · goes to the owner to approve
              </Text>
            ) : null}
            <Button
              disabled={filled.length === 0}
              label={filled.length > 0 ? `Save Count · ${filled.length} item${filled.length === 1 ? "" : "s"}` : "Save Count"}
              loading={saving}
              onPress={() => void save()}
              size="lg"
            />
          </View>
        }
        header={header}
        scroll
      >
        <View className="gap-5 pb-4 pt-3">
          <DateField onChange={setDay} value={day} />

          <View className="flex-row items-center justify-between">
            <View>
              <Text variant="subtitle">Items</Text>
              <Text variant="caption">Leave empty to skip</Text>
            </View>
            <Pressable
              accessibilityRole="button"
              className="flex-row items-center gap-1 rounded-full border border-primary px-3 py-1.5 active:bg-brand-soft"
              onPress={() => setPicking(true)}
            >
              <Ionicons color={colors.primary} name="add" size={18} />
              <Text className="font-semibold text-primary" variant="label">
                Add Item
              </Text>
            </Pressable>
          </View>

          {rows.length === 0 ? (
            <EmptyCard description="Tap Add Item to pick what you are counting." title="Nothing to count yet" />
          ) : (
            <Card padding="px-4 py-1">
              {rows.map((item, index) => {
                const at = item.at.find((row) => row.hostelId === here.id);
                const value = counts[item.id] ?? "";
                const wrong = value.trim() !== "" && readQty(value) === false;
                const counted = readQty(value);
                const gap = typeof counted === "number" ? Math.round((counted - (at?.left ?? 0)) * 100) / 100 : null;

                return (
                  <View key={item.id}>
                    {index > 0 ? <RowDivider inset /> : null}
                    <View className="min-h-16 flex-row items-center gap-3 py-3">
                      <ItemAvatar item={item} size={40} />
                      <View className="flex-1">
                        <Text numberOfLines={1} variant="label">
                          {item.name}
                        </Text>
                        <Text variant="caption">Book says {formatQty(at?.left ?? 0, item.unit)}</Text>
                        {gap === null ? null : gap === 0 ? (
                          <Text className="font-semibold text-success" variant="caption">
                            Matches
                          </Text>
                        ) : (
                          <Text className={`font-semibold ${gap < 0 ? "text-destructive" : "text-warning"}`} variant="caption">
                            {formatQty(Math.abs(gap), item.unit)} {gap < 0 ? "missing" : "extra"}
                          </Text>
                        )}
                      </View>
                      <View className="items-end gap-1">
                        <Text variant="caption">Count now</Text>
                        <View
                          className={`flex-row items-center rounded-xl border bg-card px-3 ${
                            wrong ? "border-destructive" : value.trim() ? "border-primary" : "border-border"
                          }`}
                        >
                          <TextInput
                            accessibilityLabel={`${item.name} left now`}
                            className="w-16 py-2.5 text-right text-base font-semibold text-foreground"
                            inputMode="decimal"
                            keyboardType="decimal-pad"
                            onChangeText={(next) => setCounts((prev) => ({ ...prev, [item.id]: next }))}
                            placeholder="—"
                            placeholderTextColor={colors.mutedForeground}
                            value={value}
                          />
                          <Text className="ml-1.5" variant="muted">
                            {unitLabel(item.unit)}
                          </Text>
                        </View>
                      </View>
                    </View>
                  </View>
                );
              })}
            </Card>
          )}

          {differs ? (
            <View className="gap-2">
              <Input
                error={null}
                label="Why is it different?"
                maxLength={200}
                onChangeText={setWhy}
                placeholder="e.g. used for guests, not entered"
                value={why}
              />
              <View className="flex-row flex-wrap gap-2">
                {REASONS.map((reason) => (
                  <Chip key={reason} label={reason} onPress={() => setWhy(reason)} tone={why === reason ? "brand" : "neutral"} />
                ))}
              </View>
            </View>
          ) : null}
        </View>
      </Screen>

      <ItemPicker
        items={store}
        onClose={() => setPicking(false)}
        onDone={(ids) => {
          setAdded((prev) => [...prev, ...ids]);
          setPicking(false);
        }}
        onNewItem={() => {
          setPicking(false);
          setNewItem(true);
        }}
        open={picking}
        taken={rows.map((item) => item.id)}
      />
      <ItemSheet
        existing={home.items.map((item) => item.name)}
        onClose={() => setNewItem(false)}
        onSaved={(id) => {
          setNewItem(false);
          setAdded((prev) => [...prev, id]);
          resource.refresh();
        }}
        open={newItem}
      />
    </>
  );
}
