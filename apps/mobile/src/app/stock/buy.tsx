import { Ionicons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import { useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";

import {
  BillPhotoBox,
  ItemAvatar,
  NoStockAccess,
  readQty,
  stockChanged,
  unitLabel,
  useBillPhoto,
  useStock,
} from "@/components/stock/stock-parts";
import { AppBar } from "@/components/ui/app-bar";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Screen } from "@/components/ui/screen";
import { Sheet } from "@/components/ui/sheet";
import { SkeletonCard } from "@/components/ui/skeleton";
import { EmptyCard, ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { adminQuery } from "@/lib/admin-queries";
import { readApiError } from "@/lib/api-contract";
import { groupDigits, newClientRequestId, parseAmountInput } from "@/lib/expenses";
import { expenseQuery } from "@/lib/expenses-api";
import { formatMoney } from "@/lib/format";
import { invalidateQuery } from "@/lib/query-cache";
import {
  addStockEntry,
  addStockItem,
  findStockItem,
  guessStockKind,
  STOCK_ITEM_NAME_MAX,
  STOCK_UNITS,
  type StockItem,
  type StockUnit,
} from "@/lib/stock-api";
import { toastError, toastSuccess } from "@/lib/toast";

/**
 * Add stock — what came in, on one screen (docs/INVENTORY_PLAN.md).
 *
 * Each line is three things a person can say standing next to the sack: what it
 * is, how much, and what it cost. Nothing else is asked. An item the hostel
 * already has is one tap on its chip; a new name becomes an item on Save, kept
 * in the store or used daily as its name suggests (`guessStockKind`).
 *
 * It lands in the building chosen in the switcher. The prices add up to one
 * expense there when this person may spend, so Money Out is never typed twice.
 */

type Line = { key: string; name: string; price: string; qty: string; unit: StockUnit };

let lineKey = 0;

function blankLine(name = "", unit: StockUnit = "KG"): Line {
  lineKey += 1;
  return { key: `line-${lineKey}`, name, price: "", qty: "", unit };
}

export default function AddStockScreen() {
  const params = useLocalSearchParams<{ itemId?: string }>();
  const { denied, here, home, overall, resource } = useStock();

  const [lines, setLines] = useState<Line[]>(() => [blankLine()]);
  const [seeded, setSeeded] = useState(false);
  const [unitFor, setUnitFor] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);
  const bill = useBillPhoto();
  const requestId = useRef(newClientRequestId());
  // Names made into items by an earlier Save that then failed, so a retry reuses them.
  const made = useRef(new Map<string, StockItem["id"]>());

  const allItems = useMemo(() => home?.items ?? [], [home]);
  const quickPicks = useMemo(() => allItems.filter((item) => item.active).slice(0, 8), [allItems]);

  // Opened from an item's page: that item is the first line.
  if (!seeded && home && params.itemId) {
    const item = allItems.find((entry) => entry.id === params.itemId);
    setSeeded(true);
    if (item) setLines([blankLine(item.name, item.unit)]);
  }

  const known = (line: Line) => findStockItem(allItems, line.name);
  const qtyOf = (line: Line) => readQty(line.qty);
  const priceOf = (line: Line) => (line.price.trim() ? parseAmountInput(line.price) : 0);

  const errorsOf = (line: Line) => ({
    name: line.name.trim() ? null : "Write the name",
    price: priceOf(line) === null ? "Whole rupees" : null,
    qty: (() => {
      const qty = qtyOf(line);
      return qty === null || qty === false || qty <= 0 ? "How much?" : null;
    })(),
  });

  const total = lines.reduce((sum, line) => sum + (priceOf(line) ?? 0), 0);
  const money = home?.canSpend === true && total > 0;
  const photoNeeded = money && home?.proofRequired === true;

  const update = (key: string, change: Partial<Line>) =>
    setLines((prev) => prev.map((line) => (line.key === key ? { ...line, ...change } : line)));

  const save = async () => {
    setTried(true);

    const broken = lines.some((line) => Object.values(errorsOf(line)).some(Boolean));

    if (broken || !here) {
      toastError("Not saved yet", here ? "Fill the red boxes." : "Pick a building first.");
      return;
    }

    if (photoNeeded && !bill.photo?.assetId) {
      toastError("Not saved yet", bill.uploading ? "The photo is still adding." : "Add a photo of the bill.");
      return;
    }

    setSaving(true);

    try {
      // One line per item: two lines of rice become one.
      const byItem = new Map<string, { price: number; qty: number }>();

      for (const line of lines) {
        const name = line.name.trim();
        const lower = name.toLowerCase();
        let itemId = known(line)?.id ?? made.current.get(lower);

        if (!itemId) {
          const created = await addStockItem({ kind: guessStockKind(name), name, unit: line.unit });
          itemId = created.id;
          made.current.set(lower, itemId);
        }

        const sum = byItem.get(itemId) ?? { price: 0, qty: 0 };
        byItem.set(itemId, { price: sum.price + (priceOf(line) ?? 0), qty: sum.qty + (qtyOf(line) as number) });
      }

      await addStockEntry({
        amount: money ? total : undefined,
        clientRequestId: requestId.current,
        hostelId: here.id,
        kind: "BUY",
        lines: [...byItem].map(([itemId, { price, qty }]) => ({
          itemId,
          qty,
          ...(price > 0 ? { rate: Math.round(price / qty) } : {}),
        })),
        photoAssetId: money ? (bill.photo?.assetId ?? undefined) : undefined,
      });

      toastSuccess("Saved", `In ${here.name}`);
      stockChanged();

      if (money) {
        invalidateQuery(expenseQuery("staff", null).key);
        invalidateQuery(adminQuery.ledger().key);
      }

      router.back();
    } catch (error) {
      stockChanged();
      toastError("Not saved", readApiError(error, "Check your internet and tap Save again."));
    } finally {
      setSaving(false);
    }
  };

  const header = <AppBar centerTitle showBack subtitle={here?.name} title="Add stock" />;

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
        <EmptyCard description="Switch to the building the goods came to." title="Pick a building" />
      </Screen>
    );
  }

  const editing = lines.find((line) => line.key === unitFor) ?? null;

  return (
    <>
      <Screen
        footer={
          <Button
            disabled={bill.uploading}
            label={total > 0 ? `Save · ${formatMoney(total)}` : "Save"}
            loading={saving}
            onPress={() => void save()}
            size="lg"
          />
        }
        header={header}
        scroll
      >
        <View className="gap-4 pb-4 pt-3">
          {lines.map((line) => (
            <LineCard
              errors={tried ? errorsOf(line) : null}
              item={known(line)}
              key={line.key}
              line={line}
              onChange={(change) => update(line.key, change)}
              onPickUnit={() => setUnitFor(line.key)}
              onRemove={
                lines.length > 1 ? () => setLines((prev) => prev.filter((entry) => entry.key !== line.key)) : undefined
              }
              picks={quickPicks.filter((item) => !lines.some((other) => findStockItem([item], other.name)))}
            />
          ))}

          <Button
            label="Add more"
            onPress={() => setLines((prev) => [...prev, blankLine()])}
            variant="outline"
          />

          {photoNeeded ? (
            <BillPhotoBox bill={bill} error={tried && !bill.photo ? "Add a photo of the bill." : null} required />
          ) : null}
        </View>
      </Screen>

      <Sheet onClose={() => setUnitFor(null)} open={editing !== null} title="Unit">
        <View className="flex-row flex-wrap gap-2 pb-4">
          {STOCK_UNITS.map((unit) => {
            const active = editing?.unit === unit;

            return (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                className={`min-w-20 items-center rounded-xl px-4 py-3 active:opacity-70 ${
                  active ? "bg-primary" : "bg-muted"
                }`}
                key={unit}
                onPress={() => {
                  if (editing) update(editing.key, { unit });
                  setUnitFor(null);
                }}
              >
                <Text
                  className={`text-base font-semibold ${active ? "text-primary-foreground" : "text-foreground"}`}
                >
                  {unitLabel(unit)}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </Sheet>
    </>
  );
}

/**
 * One thing that came: its picture, its name, how much, what it cost.
 *
 * With the name still empty, the hostel's own items sit under it as chips — a
 * tap fills the name and its unit. A known item keeps the unit it was first
 * counted in; a new one picks it from the chip beside the quantity.
 */
function LineCard({
  errors,
  item,
  line,
  onChange,
  onPickUnit,
  onRemove,
  picks,
}: {
  errors: { name: string | null; price: string | null; qty: string | null } | null;
  item: StockItem | null;
  line: Line;
  onChange: (change: Partial<Line>) => void;
  onPickUnit: () => void;
  onRemove?: () => void;
  picks: StockItem[];
}) {
  const { colors } = useAppTheme();
  const unit = item?.unit ?? line.unit;
  const typed = line.name.trim().toLowerCase();
  const chips = item
    ? []
    : typed
      ? picks.filter((pick) => pick.name.toLowerCase().includes(typed)).slice(0, 4)
      : picks;

  return (
    <Card className="gap-3">
      <View className="flex-row items-center gap-3">
        <ItemAvatar item={{ kind: item?.kind ?? guessStockKind(line.name), name: line.name }} size={44} />
        <View className="flex-1">
          <Input
            autoCapitalize="words"
            error={errors?.name}
            maxLength={STOCK_ITEM_NAME_MAX}
            onChangeText={(name) => onChange({ name })}
            placeholder="Rice, oil, gas…"
            value={line.name}
          />
        </View>
        {onRemove ? (
          <Pressable accessibilityLabel="Remove" accessibilityRole="button" hitSlop={8} onPress={onRemove}>
            <Ionicons color={colors.mutedForeground} name="close-circle" size={24} />
          </Pressable>
        ) : null}
      </View>

      {chips.length > 0 ? (
        <ScrollView contentContainerClassName="gap-2" horizontal keyboardShouldPersistTaps="handled" showsHorizontalScrollIndicator={false}>
          {chips.map((pick) => (
            <Pressable
              accessibilityRole="button"
              className="flex-row items-center gap-1.5 rounded-full bg-muted py-1.5 pl-1.5 pr-3 active:opacity-70"
              key={pick.id}
              onPress={() => onChange({ name: pick.name, unit: pick.unit })}
            >
              <ItemAvatar item={pick} size={24} />
              <Text className="text-sm font-medium">{pick.name}</Text>
            </Pressable>
          ))}
        </ScrollView>
      ) : null}

      <View className="flex-row gap-3">
        <View className="flex-1">
          <Input
            error={errors?.qty}
            inputMode="decimal"
            keyboardType="decimal-pad"
            label="Quantity"
            onChangeText={(qty) => onChange({ qty })}
            placeholder="0"
            selectTextOnFocus
            trailing={
              item ? (
                <Text variant="muted">{unitLabel(unit)}</Text>
              ) : (
                <Pressable
                  accessibilityLabel={`Unit, ${unitLabel(unit)}`}
                  accessibilityRole="button"
                  className="flex-row items-center gap-0.5 rounded-lg bg-muted px-2 py-1 active:opacity-70"
                  hitSlop={6}
                  onPress={onPickUnit}
                >
                  <Text className="text-sm font-semibold">{unitLabel(unit)}</Text>
                  <Ionicons color={colors.mutedForeground} name="chevron-down" size={14} />
                </Pressable>
              )
            }
            value={line.qty}
          />
        </View>
        <View className="flex-1">
          <Input
            error={errors?.price}
            inputMode="numeric"
            keyboardType="number-pad"
            label="Price"
            leading={<Text variant="muted">Rs</Text>}
            onChangeText={(price) => onChange({ price: groupDigits(price) })}
            placeholder="0"
            value={line.price}
          />
        </View>
      </View>
    </Card>
  );
}
