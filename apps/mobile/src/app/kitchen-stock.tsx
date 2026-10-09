import { Ionicons } from "@expo/vector-icons";
import { useMemo, useState } from "react";
import { Pressable, TextInput, View } from "react-native";

import { ItemAvatar, qtyText, readQty } from "@/components/stock/stock-parts";
import { AppBar } from "@/components/ui/app-bar";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Grid } from "@/components/ui/layout";
import { RowDivider } from "@/components/ui/list-row";
import { Screen } from "@/components/ui/screen";
import { Sheet } from "@/components/ui/sheet";
import { SkeletonTiles } from "@/components/ui/skeleton";
import { EmptyCard, ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useResource } from "@/hooks/use-resource";
import { readApiError } from "@/lib/api-contract";
import { openConfirm } from "@/lib/confirm";
import { newClientRequestId } from "@/lib/expenses";
import { formatTime } from "@/lib/format";
import { invalidateQuery } from "@/lib/query-cache";
import {
  addCookStock,
  type CookStockItem,
  cookStockQuery,
  formatQty,
  STOCK_UNIT_LABELS,
  undoCookStock,
} from "@/lib/stock-api";
import { toastError, toastSuccess } from "@/lib/toast";

/**
 * Kitchen stock — the cook's one stock screen (docs/INVENTORY_PLAN.md).
 *
 * Made for someone who reads little and has wet hands:
 *
 * 1. **Pictures, not a form.** Every store item is a big tile with its picture,
 *    its name and what is left. The ones this kitchen uses most come first.
 * 2. **One item at a time.** A tap opens one sheet: the picture again, a big
 *    number, `+½ +1 +2 +5 +1 sack` buttons, and one green **Used** button.
 * 3. **Today, underneath.** Everything taken out today — by the cook or by the
 *    warden — so nobody enters the same rice twice. A slip is undone the same
 *    day with **Undo**.
 *
 * No prices anywhere. The store's stock goes down the moment Used is tapped,
 * and the warden sees it on their Used screen.
 */

const SEARCH_FROM = 12;

export default function KitchenStockScreen() {
  const { colors } = useAppTheme();
  const query = cookStockQuery();
  const resource = useResource(query.load, { cacheKey: query.key, topics: query.topics });
  const stock = resource.data ?? null;
  const [picked, setPicked] = useState<CookStockItem | null>(null);
  const [search, setSearch] = useState("");

  const typed = search.trim().toLowerCase();
  const items = useMemo(
    () => (stock?.items ?? []).filter((item) => !typed || item.name.toLowerCase().includes(typed)),
    [stock, typed],
  );

  const changed = () => {
    invalidateQuery(query.key);
    resource.refresh();
  };

  const undo = (entryId: string, label: string) =>
    openConfirm({
      confirmLabel: "Undo",
      destructive: true,
      message: "It goes back into the store.",
      onConfirm: async () => {
        try {
          await undoCookStock(entryId);
          toastSuccess("Undone", label);
          changed();
        } catch (error) {
          toastError("Could not undo", readApiError(error));
        }
      },
      title: `Undo ${label}?`,
    });

  const header = <AppBar centerTitle showBack subtitle={stock?.hostelName} title="Kitchen stock" />;

  if (resource.error && !stock) {
    return (
      <Screen header={header}>
        <ErrorState message={resource.error} onRetry={resource.reload} />
      </Screen>
    );
  }

  return (
    <>
      <Screen header={header} onRefresh={resource.refresh} refreshing={resource.refreshing} scroll>
        {!stock ? (
          <View className="pt-4">
            <SkeletonTiles />
          </View>
        ) : stock.items.length === 0 ? (
          <View className="pt-4">
            <EmptyCard description="The warden adds rice, daal and oil first. Then they show here." title="Store is empty" />
          </View>
        ) : (
          <View className="gap-6 pb-8 pt-3">
            <View className="gap-3">
              <View className="flex-row items-center gap-2">
                <Ionicons color={colors.primary} name="hand-left-outline" size={20} />
                <Text variant="subtitle">Tap what you took</Text>
              </View>
              {stock.items.length >= SEARCH_FROM ? (
                <Input
                  leading={<Ionicons color={colors.mutedForeground} name="search" size={18} />}
                  onChangeText={setSearch}
                  placeholder="Search"
                  value={search}
                />
              ) : null}
              <Grid gap={10} maxColumns={3} minCellWidth={96}>
                {items.map((item) => (
                  <BigTile item={item} key={item.id} onPress={() => setPicked(item)} />
                ))}
              </Grid>
            </View>

            <View>
              <Text className="mb-2 px-1 font-semibold uppercase tracking-wider text-muted-foreground" style={{ fontSize: 11 }}>
                Today
              </Text>
              {stock.today.length === 0 ? (
                <Card>
                  <Text variant="muted">Nothing taken out yet today.</Text>
                </Card>
              ) : (
                <Card padding="px-4 py-0">
                  {stock.today.map((line, index) => {
                    const label = `${line.name} ${formatQty(line.qty, line.unit)}`;

                    return (
                      <View key={`${line.entryId}-${line.itemId}`}>
                        {index > 0 ? <RowDivider inset /> : null}
                        <View className="min-h-16 flex-row items-center gap-3 py-3">
                          <ItemAvatar item={{ kind: "STORE", name: line.name }} size={40} />
                          <View className="flex-1">
                            <Text numberOfLines={1} variant="label">
                              {label}
                            </Text>
                            <Text numberOfLines={1} variant="caption">
                              {line.kind === "WASTE" ? "Thrown away · " : ""}
                              {line.by} · {formatTime(line.at)}
                            </Text>
                          </View>
                          {line.canUndo ? (
                            <Button label="Undo" onPress={() => undo(line.entryId, label)} size="sm" variant="outline" />
                          ) : null}
                        </View>
                      </View>
                    );
                  })}
                </Card>
              )}
            </View>
          </View>
        )}
      </Screen>

      <UseSheet
        item={picked}
        onClose={() => setPicked(null)}
        onSaved={() => {
          setPicked(null);
          changed();
        }}
      />
    </>
  );
}

/** A thumb-and-a-half tile: big picture, name, what is left (red when low). */
function BigTile({ item, onPress }: { item: CookStockItem; onPress: () => void }) {
  return (
    <Pressable
      accessibilityLabel={`${item.name}, ${formatQty(item.left, item.unit)} left`}
      accessibilityRole="button"
      className={`items-center gap-1.5 rounded-2xl border bg-card px-2 py-3 active:opacity-70 ${
        item.low ? "border-destructive" : "border-border"
      }`}
      onPress={onPress}
    >
      <ItemAvatar item={{ kind: "STORE", name: item.name }} size={52} />
      <Text className="text-center text-sm font-semibold" numberOfLines={1}>
        {item.name}
      </Text>
      <Text className={item.low ? "font-semibold text-destructive" : "text-muted-foreground"} numberOfLines={1} style={{ fontSize: 12 }}>
        {formatQty(item.left, item.unit)} left
      </Text>
    </Pressable>
  );
}

/**
 * One item: how much was taken. The number is big, the buttons add to it, and
 * Used saves. "It went bad" is the quieter second choice for what was thrown away.
 */
function UseSheet({
  item,
  onClose,
  onSaved,
}: {
  item: CookStockItem | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { colors } = useAppTheme();
  const [qty, setQty] = useState("");
  const [busy, setBusy] = useState<"USE" | "WASTE" | null>(null);
  const [requestId, setRequestId] = useState(newClientRequestId);
  const [seen, setSeen] = useState<string | null>(item?.id ?? null);

  // Fresh each time an item is opened, set during render rather than in an effect.
  if ((item?.id ?? null) !== seen) {
    setSeen(item?.id ?? null);
    setQty("");
    setRequestId(newClientRequestId());
  }

  const value = readQty(qty);
  const amount = typeof value === "number" ? value : 0;
  const steps = item && (item.unit === "KG" || item.unit === "LITRE") ? [0.5, 1, 2, 5] : [1, 2, 5, 10];
  const over = item !== null && amount > item.left;

  const save = async (kind: "USE" | "WASTE") => {
    if (!item || amount <= 0) {
      toastError("How much?", "Tap the buttons or write the number.");
      return;
    }

    setBusy(kind);

    try {
      await addCookStock({ clientRequestId: requestId, itemId: item.id, kind, qty: amount });
      toastSuccess(kind === "USE" ? "Saved" : "Saved as thrown away", `${item.name} ${formatQty(amount, item.unit)}`);
      onSaved();
    } catch (error) {
      toastError("Not saved", readApiError(error, "Check your internet and tap again."));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Sheet
      footer={
        <View className="gap-2">
          <Button
            disabled={amount <= 0 || busy !== null}
            label={amount > 0 && item ? `Used · ${formatQty(amount, item.unit)}` : "Used"}
            loading={busy === "USE"}
            onPress={() => void save("USE")}
            size="lg"
          />
          <Button
            disabled={amount <= 0 || busy !== null}
            label="It went bad · thrown away"
            loading={busy === "WASTE"}
            onPress={() => void save("WASTE")}
            variant="ghost"
          />
        </View>
      }
      onClose={onClose}
      open={item !== null}
      title={item?.name ?? ""}
    >
      {item ? (
        <View className="items-center gap-4 pb-2">
          <ItemAvatar item={{ kind: "STORE", name: item.name }} size={72} />
          <Text className={item.low ? "text-destructive" : undefined} variant="muted">
            {formatQty(item.left, item.unit)} left in store
          </Text>

          <View
            className={`w-full flex-row items-center justify-center rounded-2xl border-2 px-4 ${
              value === false ? "border-destructive" : amount > 0 ? "border-primary" : "border-border"
            }`}
          >
            <TextInput
              accessibilityLabel={`${item.name}, how much`}
              className="min-w-24 py-3 text-center text-foreground"
              inputMode="decimal"
              keyboardType="decimal-pad"
              onChangeText={setQty}
              placeholder="0"
              placeholderTextColor={colors.mutedForeground}
              style={{ fontSize: 40, fontWeight: "700" }}
              value={qty}
            />
            <Text style={{ fontSize: 22 }} variant="muted">
              {STOCK_UNIT_LABELS[item.unit].many}
            </Text>
          </View>

          <View className="w-full flex-row flex-wrap justify-center gap-2">
            {steps.map((step) => (
              <Pressable
                accessibilityLabel={`Add ${step}`}
                accessibilityRole="button"
                className="h-14 min-w-16 items-center justify-center rounded-2xl bg-muted px-4 active:opacity-70"
                key={step}
                onPress={() => setQty(qtyText(amount + step))}
              >
                <Text className="text-lg font-bold">+{step === 0.5 ? "½" : step}</Text>
              </Pressable>
            ))}
            {item.packUnit && item.packSize ? (
              <Pressable
                accessibilityRole="button"
                className="h-14 items-center justify-center rounded-2xl bg-brand-soft px-4 active:opacity-70"
                onPress={() => setQty(qtyText(amount + item.packSize!))}
              >
                <Text className="text-lg font-bold text-primary">+1 {STOCK_UNIT_LABELS[item.packUnit].one}</Text>
              </Pressable>
            ) : null}
            {amount > 0 ? (
              <Pressable
                accessibilityLabel="Clear"
                accessibilityRole="button"
                className="h-14 w-14 items-center justify-center rounded-2xl active:opacity-70"
                onPress={() => setQty("")}
              >
                <Ionicons color={colors.mutedForeground} name="backspace-outline" size={26} />
              </Pressable>
            ) : null}
          </View>

          {over ? (
            <Text className="text-center text-warning" variant="caption">
              More than the store has. Check, then save if it is right.
            </Text>
          ) : null}
        </View>
      ) : null}
    </Sheet>
  );
}
