import { Ionicons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import { useMemo, useRef, useState } from "react";
import { Pressable, View } from "react-native";

import {
  AddItemButton,
  BillPhotoBox,
  DateField,
  FormSection,
  ItemAvatar,
  ItemPicker,
  ItemSheet,
  NoStockAccess,
  PaidByChips,
  QtyInput,
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
import { SkeletonCard } from "@/components/ui/skeleton";
import { EmptyCard, ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { adminQuery } from "@/lib/admin-queries";
import { readApiError } from "@/lib/api-contract";
import {
  EXPENSE_PAID_BY,
  EXPENSE_PAID_BY_LABELS,
  type ExpensePaidBy,
  groupDigits,
  newClientRequestId,
  parseAmountInput,
  todayKey,
} from "@/lib/expenses";
import { expenseQuery } from "@/lib/expenses-api";
import { formatMoney } from "@/lib/format";
import { invalidateQuery } from "@/lib/query-cache";
import { addStockEntry } from "@/lib/stock-api";
import { toastError, toastSuccess } from "@/lib/toast";

/**
 * Buy Goods — two steps (docs/INVENTORY_PLAN.md).
 *
 * 1. **The bill**: the day, where from, how much and how it was paid, its photo.
 * 2. **The items**: picked from the list with "+ Add Item", a quantity each and
 *    the rate if the bill shows one.
 *
 * Lands in the building chosen in the switcher. A bill amount also writes one
 * expense there, so Money Out is never typed twice.
 */

type Line = { itemId: string; qty: string; rate: string };

const PAID_BY = EXPENSE_PAID_BY.map((value) => ({ label: EXPENSE_PAID_BY_LABELS[value], value }));

export default function BuyGoodsScreen() {
  const { colors } = useAppTheme();
  const params = useLocalSearchParams<{ daily?: string; itemId?: string }>();
  const { denied, here, home, overall, resource } = useStock();

  const [step, setStep] = useState<1 | 2>(1);
  const [day, setDay] = useState(() => todayKey());
  const [supplier, setSupplier] = useState("");
  const [amountText, setAmountText] = useState("");
  const [paidBy, setPaidBy] = useState<ExpensePaidBy>("CASH");
  const bill = useBillPhoto();
  const [lines, setLines] = useState<Line[]>(() => (params.itemId ? [{ itemId: params.itemId, qty: "", rate: "" }] : []));
  const [picking, setPicking] = useState(false);
  const [newItem, setNewItem] = useState(false);
  const [tried, setTried] = useState(false);
  const [triedNext, setTriedNext] = useState(false);
  const [saving, setSaving] = useState(false);
  const requestId = useRef(newClientRequestId());

  const items = useMemo(() => {
    const active = (home?.items ?? []).filter((item) => item.active);
    // "Buy Daily Items" opens the list with the daily ones first.
    return params.daily ? [...active].sort((a, b) => Number(b.kind === "DAILY") - Number(a.kind === "DAILY")) : active;
  }, [home, params.daily]);
  const byId = new Map(items.map((item) => [item.id, item]));
  const shownLines = lines.filter((line) => byId.has(line.itemId));

  const amount = parseAmountInput(amountText);
  const money = home?.canSpend === true;
  const photoNeeded = money && amount !== null && home?.proofRequired === true;

  const stepOneError =
    amountText.trim() && amount === null
      ? "Check the bill amount."
      : photoNeeded && !bill.photo?.assetId && !bill.uploading
        ? "Add a photo of the bill."
        : null;

  const lineErrors = new Map(
    shownLines.map((line) => {
      const qty = readQty(line.qty);
      const rate = line.rate.trim() ? parseAmountInput(line.rate) : 0;

      return [
        line.itemId,
        qty === null || qty === false || qty <= 0 ? "Write how much." : rate === null ? "Rate in whole rupees." : null,
      ] as const;
    }),
  );
  const itemsTotal = shownLines.reduce((sum, line) => {
    const qty = readQty(line.qty);
    const rate = parseAmountInput(line.rate);

    return typeof qty === "number" && rate ? sum + qty * rate : sum;
  }, 0);

  const update = (itemId: string, change: Partial<Line>) =>
    setLines((prev) => prev.map((line) => (line.itemId === itemId ? { ...line, ...change } : line)));

  const save = async () => {
    setTried(true);

    const firstError =
      shownLines.length === 0 ? "Add at least one item." : [...lineErrors.values()].find(Boolean) ?? null;

    if (firstError || !here) {
      toastError("Not saved yet", firstError ?? "Pick a building first.");
      return;
    }

    setSaving(true);

    try {
      await addStockEntry({
        amount: money && amount ? amount : undefined,
        clientRequestId: requestId.current,
        hostelId: here.id,
        kind: "BUY",
        lines: shownLines.map((line) => ({
          itemId: line.itemId,
          qty: readQty(line.qty) as number,
          ...(line.rate.trim() ? { rate: parseAmountInput(line.rate) ?? 0 } : {}),
        })),
        on: day,
        paidBy: money && amount ? paidBy : undefined,
        photoAssetId: money && amount ? (bill.photo?.assetId ?? undefined) : undefined,
        supplier: supplier.trim() || undefined,
      });

      toastSuccess(
        "Bought saved",
        money && amount ? `${formatMoney(amount)} added to Expenses too` : `${shownLines.length} item${shownLines.length === 1 ? "" : "s"}`,
      );
      stockChanged();

      if (money && amount) {
        invalidateQuery(expenseQuery("staff", null).key);
        invalidateQuery(adminQuery.ledger().key);
      }

      router.back();
    } catch (error) {
      toastError("Not saved", readApiError(error, "Check your internet and tap Save again."));
    } finally {
      setSaving(false);
    }
  };

  const header = (
    <AppBar
      actions={<Text variant="label">{step}/2</Text>}
      centerTitle
      onBack={step === 2 ? () => setStep(1) : undefined}
      showBack
      subtitle={here?.name}
      title="Buy Goods"
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
        <SkeletonCard rows={5} />
      </Screen>
    );
  }

  if (overall || !here) {
    return (
      <Screen header={header}>
        <EmptyCard description="Overall is view only. Switch to the building the goods came to." title="Pick a building" />
      </Screen>
    );
  }

  return (
    <>
      <Screen
        footer={
          step === 1 ? (
            <Button
              disabled={bill.uploading}
              label={bill.uploading ? "Adding photo…" : "Next"}
              onPress={() => {
                setTriedNext(true);

                if (stepOneError) {
                  toastError("Check this first", stepOneError);
                  return;
                }

                setStep(2);
              }}
              size="lg"
            />
          ) : (
            <Button
              disabled={shownLines.length === 0}
              label={shownLines.length > 0 ? `Save Bought · ${shownLines.length} item${shownLines.length === 1 ? "" : "s"}` : "Save Bought"}
              loading={saving}
              onPress={() => void save()}
              size="lg"
            />
          )
        }
        header={header}
        scroll
      >
        {step === 1 ? (
          <View className="gap-5 pb-4 pt-3">
            <Text variant="title">Basic Details</Text>
            <DateField onChange={setDay} value={day} />
            <Input
              label="Supplier (optional)"
              maxLength={80}
              onChangeText={setSupplier}
              placeholder="e.g. Local Store"
              value={supplier}
            />
            {money ? (
              <>
                <Input
                  error={amountText.trim() && amount === null ? "Whole rupees, like 2400." : null}
                  hint="Also saved in Expenses, so it is never added twice."
                  inputMode="numeric"
                  keyboardType="number-pad"
                  label="Bill amount (optional)"
                  leading={<Text variant="muted">Rs</Text>}
                  onChangeText={(value) => setAmountText(groupDigits(value))}
                  placeholder="0"
                  value={amountText}
                />
                {amount ? (
                  <>
                    <View className="gap-1.5">
                      <Text variant="caption">Paid by</Text>
                      <PaidByChips onChange={setPaidBy} options={PAID_BY} value={paidBy} />
                    </View>
                    <BillPhotoBox
                      bill={bill}
                      error={triedNext && photoNeeded && !bill.photo ? "Add a photo of the bill." : null}
                      required={photoNeeded}
                    />
                  </>
                ) : null}
              </>
            ) : null}
          </View>
        ) : (
          <View className="gap-5 pb-4 pt-3">
            <FormSection title="Items">
              <Text className="-mt-2" variant="caption">
                Add every item on this bill
              </Text>
              <AddItemButton onPress={() => setPicking(true)} />
            </FormSection>

            {shownLines.length === 0 ? (
              <Text className="text-center" variant="muted">
                No items yet. Tap Add Item.
              </Text>
            ) : null}

            {shownLines.map((line) => {
              const item = byId.get(line.itemId)!;
              const error = tried ? lineErrors.get(line.itemId) : null;

              return (
                <Card className="gap-3" key={line.itemId}>
                  <View className="flex-row items-center gap-3">
                    <ItemAvatar item={item} size={36} />
                    <Text className="flex-1" variant="label">
                      {item.name}
                    </Text>
                    <Pressable
                      accessibilityLabel={`Remove ${item.name}`}
                      accessibilityRole="button"
                      hitSlop={8}
                      onPress={() => setLines((prev) => prev.filter((entry) => entry.itemId !== line.itemId))}
                    >
                      <Ionicons color={colors.mutedForeground} name="trash-outline" size={20} />
                    </Pressable>
                  </View>
                  <View className="flex-row gap-3">
                    <View className="flex-1">
                      <QtyInput
                        error={error}
                        label="Quantity"
                        onChangeText={(qty) => update(line.itemId, { qty })}
                        unit={item.unit}
                        value={line.qty}
                      />
                    </View>
                    <View className="flex-1">
                      <Input
                        inputMode="numeric"
                        keyboardType="number-pad"
                        label="Rate (optional)"
                        leading={<Text variant="muted">Rs</Text>}
                        onChangeText={(rate) => update(line.itemId, { rate: rate.replace(/\D/g, "") })}
                        placeholder="0"
                        trailing={<Text variant="muted">/{unitLabel(item.unit)}</Text>}
                        value={line.rate}
                      />
                    </View>
                  </View>
                </Card>
              );
            })}

            {itemsTotal > 0 ? (
              <View className="flex-row items-center justify-between px-1">
                <Text variant="muted">Items total</Text>
                <Text variant="label">{formatMoney(Math.round(itemsTotal))}</Text>
              </View>
            ) : null}
            {amount ? (
              <View className="flex-row items-center justify-between px-1">
                <Text variant="muted">Bill amount</Text>
                <Text variant="label">{formatMoney(amount)}</Text>
              </View>
            ) : null}
          </View>
        )}
      </Screen>

      <ItemPicker
        items={items}
        onClose={() => setPicking(false)}
        onDone={(ids) => {
          setLines((prev) => [...prev, ...ids.map((itemId) => ({ itemId, qty: "", rate: "" }))]);
          setPicking(false);
        }}
        onNewItem={() => {
          setPicking(false);
          setNewItem(true);
        }}
        open={picking}
        taken={shownLines.map((line) => line.itemId)}
      />
      <ItemSheet
        defaultKind={params.daily ? "DAILY" : "STORE"}
        existing={home.items.map((item) => item.name)}
        onClose={() => setNewItem(false)}
        onSaved={(id) => {
          setNewItem(false);
          setLines((prev) => [...prev, { itemId: id, qty: "", rate: "" }]);
          resource.refresh();
        }}
        open={newItem}
      />
    </>
  );
}
