import { Ionicons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import { useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";

import {
  BillPhotoBox,
  DateField,
  ItemAvatar,
  MoneyInput,
  NoStockAccess,
  readQty,
  readRupees,
  stockChanged,
  SupplierField,
  unitLabel,
  useBillPhoto,
  useStock,
} from "@/components/stock/stock-parts";
import { AppBar } from "@/components/ui/app-bar";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Screen } from "@/components/ui/screen";
import { Segmented } from "@/components/ui/segmented";
import { Sheet } from "@/components/ui/sheet";
import { SkeletonCard } from "@/components/ui/skeleton";
import { EmptyCard, ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { adminQuery } from "@/lib/admin-queries";
import { readApiError } from "@/lib/api-contract";
import { groupDigits, newClientRequestId, parseAmountInput, todayKey } from "@/lib/expenses";
import { expenseQuery } from "@/lib/expenses-api";
import { formatMoney } from "@/lib/format";
import { invalidateQuery } from "@/lib/query-cache";
import {
  addStockEntry,
  addStockItem,
  findStockItem,
  guessStockKind,
  STOCK_ITEM_NAME_MAX,
  STOCK_UNIT_LABELS,
  STOCK_UNITS,
  type StockItem,
  type StockUnit,
} from "@/lib/stock-api";
import { toastError, toastSuccess } from "@/lib/toast";

/**
 * Buy — a bill, on one screen (docs/INVENTORY_PLAN.md).
 *
 * Top to bottom in the order the paper bill is read: **who** it is from, the
 * **lines** (what, how much, what it cost — per kg or per sack, as the bill
 * says), the **total** with any discount or VAT, and **how much was paid**.
 * Whatever was not paid is owed to the supplier and shows on their page.
 *
 * Each line is what a person can say standing next to the sack. An item the
 * hostel already has is one tap on its chip; a new name becomes an item on
 * Save, kept in the store or used daily as its name suggests
 * (`guessStockKind`).
 *
 * Saving is one write on the server — bill, lines, stock and the supplier's due
 * succeed or fail together. What was paid becomes one expense, so Money Out is
 * never typed twice. Someone without money rights sees no prices at all.
 *
 * `?mode=opening` is the owner's Opening stock: what was already on the shelf
 * on day one, with its value, and no supplier or payment.
 */

type Line = { inPacks: boolean; key: string; name: string; price: string; qty: string; unit: StockUnit };

type Payment = "all" | "none" | "part";

let lineKey = 0;

function blankLine(name = "", unit: StockUnit = "KG"): Line {
  lineKey += 1;
  return { inPacks: false, key: `line-${lineKey}`, name, price: "", qty: "", unit };
}

export default function AddStockScreen() {
  const params = useLocalSearchParams<{ itemId?: string; mode?: string }>();
  const { denied, here, home, overall, resource } = useStock();
  const opening = params.mode === "opening";

  const [lines, setLines] = useState<Line[]>(() => [blankLine()]);
  const [seeded, setSeeded] = useState(false);
  const [unitFor, setUnitFor] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);
  const [day, setDay] = useState(() => todayKey());
  const [supplierId, setSupplierId] = useState<string | null>(null);
  const [billNo, setBillNo] = useState("");
  const [extras, setExtras] = useState(false);
  const [discount, setDiscount] = useState("");
  const [tax, setTax] = useState("");
  const [payment, setPayment] = useState<Payment>("all");
  const [paidText, setPaidText] = useState("");
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
    if (item) setLines([{ ...blankLine(item.name, item.unit), inPacks: Boolean(item.packUnit) }]);
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

  const priced = home?.canSpend === true;
  const subtotal = priced ? lines.reduce((sum, line) => sum + (priceOf(line) ?? 0), 0) : 0;
  const discountValue = readRupees(discount);
  const taxValue = readRupees(tax);
  const total = Math.max(0, subtotal - (discountValue || 0) + (taxValue || 0));
  const paidPart = readRupees(paidText);
  const paid = opening ? 0 : payment === "all" ? total : payment === "none" ? 0 : Math.min(paidPart || 0, total);
  const due = total - paid;
  const money = !opening && priced && total > 0;
  const photoNeeded = money && paid > 0 && home?.proofRequired === true;
  const supplierName = home?.suppliers.find((supplier) => supplier.id === supplierId)?.name ?? null;
  const supplierMissing = money && due > 0 && !supplierId;

  const update = (key: string, change: Partial<Line>) =>
    setLines((prev) => prev.map((line) => (line.key === key ? { ...line, ...change } : line)));

  const save = async () => {
    setTried(true);

    const broken = lines.some((line) => Object.values(errorsOf(line)).some(Boolean));

    if (broken || !here) {
      toastError("Not saved yet", here ? "Fill the red boxes." : "Pick a building first.");
      return;
    }

    if (discountValue === false || taxValue === false || (payment === "part" && !paidPart)) {
      toastError("Not saved yet", payment === "part" && !paidPart ? "Write how much was paid." : "Whole rupees only.");
      return;
    }

    if (supplierMissing) {
      toastError("Pick the supplier", "Someone is owed the rest. Pick who.");
      return;
    }

    if (photoNeeded && !bill.photo?.assetId) {
      toastError("Not saved yet", bill.uploading ? "The photo is still adding." : "Add a photo of the bill.");
      return;
    }

    setSaving(true);

    try {
      const out: { amount?: number; itemId: string; packQty?: number; qty: number }[] = [];

      for (const line of lines) {
        const name = line.name.trim();
        const lower = name.toLowerCase();
        const item = known(line);
        let itemId = item?.id ?? made.current.get(lower);

        if (!itemId) {
          const created = await addStockItem({ kind: guessStockKind(name), name, unit: line.unit });
          itemId = created.id;
          made.current.set(lower, itemId);
        }

        const qty = qtyOf(line) as number;
        const price = priced ? (priceOf(line) ?? 0) : 0;
        const packs = line.inPacks && item?.packUnit && item.packSize ? qty : null;

        // The server merges two lines of the same item, and works packs out to kg.
        out.push({
          itemId,
          qty: packs !== null ? qty * item!.packSize! : qty,
          ...(packs !== null ? { packQty: packs } : {}),
          ...(price > 0 ? { amount: price } : {}),
        });
      }

      await addStockEntry({
        billNo: opening ? undefined : billNo.trim() || undefined,
        clientRequestId: requestId.current,
        discount: money && discountValue ? discountValue : undefined,
        hostelId: here.id,
        kind: opening ? "OPENING" : "BUY",
        lines: opening
          ? out.map(({ amount, ...line }) => ({ ...line, ...(amount ? { rate: amount / line.qty } : {}) }))
          : out,
        on: day,
        paid: money ? paid : undefined,
        photoAssetId: opening ? undefined : (bill.photo?.assetId ?? undefined),
        supplierId: opening ? undefined : (supplierId ?? undefined),
        tax: money && taxValue ? taxValue : undefined,
      });

      toastSuccess(
        "Saved",
        opening ? `Opening stock in ${here.name}` : due > 0 && supplierName ? `${formatMoney(due)} owed to ${supplierName}` : `In ${here.name}`,
      );
      stockChanged();

      if (money && paid > 0) {
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

  const header = <AppBar centerTitle showBack subtitle={here?.name} title={opening ? "Opening stock" : "Buy"} />;

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
            label={money ? `Save bill · ${formatMoney(total)}` : opening ? "Save opening stock" : "Save"}
            loading={saving}
            onPress={() => void save()}
            size="lg"
          />
        }
        header={header}
        scroll
      >
        <View className="gap-4 pb-4 pt-3">
          {opening ? (
            <Text variant="muted">What was already on the shelf before you started. Write its value to know what the store is worth.</Text>
          ) : (
            <Card className="gap-4">
              <SupplierField
                error={tried && supplierMissing ? "Pick who is owed the rest." : null}
                money={home.money}
                onChange={setSupplierId}
                onCreated={resource.refresh}
                suppliers={home.suppliers}
                value={supplierId}
              />
              <View className="flex-row gap-3">
                <View className="flex-1">
                  <Input label="Bill no. (optional)" maxLength={40} onChangeText={setBillNo} placeholder="e.g. 1452" value={billNo} />
                </View>
                <View className="flex-1">
                  <DateField onChange={setDay} value={day} />
                </View>
              </View>
            </Card>
          )}

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
              priced={priced}
              priceLabel={opening ? "Value" : "Price"}
            />
          ))}

          <Button
            label="Add another item"
            onPress={() => setLines((prev) => [...prev, blankLine()])}
            variant="outline"
          />

          {money ? (
            <Card className="gap-4">
              <TotalRow label="Items" value={formatMoney(subtotal)} />
              {extras ? (
                <View className="flex-row gap-3">
                  <View className="flex-1">
                    <MoneyInput error={discountValue === false ? "Whole rupees" : null} label="Discount" onChangeText={setDiscount} value={discount} />
                  </View>
                  <View className="flex-1">
                    <MoneyInput error={taxValue === false ? "Whole rupees" : null} label="VAT / tax" onChangeText={setTax} value={tax} />
                  </View>
                </View>
              ) : (
                <Pressable accessibilityRole="button" className="active:opacity-70" onPress={() => setExtras(true)}>
                  <Text className="font-semibold text-primary" variant="label">
                    + Discount or VAT
                  </Text>
                </Pressable>
              )}
              <View className="h-px bg-border" />
              <TotalRow bold label="Bill total" value={formatMoney(total)} />

              <View className="gap-2">
                <Text variant="caption">Paid</Text>
                <Segmented
                  onChange={setPayment}
                  options={[
                    { label: "Paid all", value: "all" as const },
                    { label: "Part", value: "part" as const },
                    { label: "Not paid", value: "none" as const },
                  ]}
                  value={payment}
                />
                {payment === "part" ? (
                  <MoneyInput
                    error={tried && !paidPart ? "How much was paid?" : null}
                    label="Paid now"
                    onChangeText={setPaidText}
                    value={paidText}
                  />
                ) : null}
              </View>

              {due > 0 ? (
                <View className="flex-row items-center justify-between rounded-xl bg-warning-soft px-3 py-2.5">
                  <Text className="text-warning" variant="label">
                    {supplierName ? `Owed to ${supplierName}` : "Still owed"}
                  </Text>
                  <Text className="text-warning" variant="subtitle">
                    {formatMoney(due)}
                  </Text>
                </View>
              ) : null}
            </Card>
          ) : null}

          {opening ? null : (
            <BillPhotoBox
              bill={bill}
              error={tried && photoNeeded && !bill.photo ? "Add a photo of the bill." : null}
              required={photoNeeded}
            />
          )}
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
  priceLabel,
  priced,
}: {
  errors: { name: string | null; price: string | null; qty: string | null } | null;
  item: StockItem | null;
  line: Line;
  onChange: (change: Partial<Line>) => void;
  onPickUnit: () => void;
  onRemove?: () => void;
  picks: StockItem[];
  priceLabel: string;
  priced: boolean;
}) {
  const { colors } = useAppTheme();
  const unit = item?.unit ?? line.unit;
  const pack = item?.packUnit && item.packSize ? { size: item.packSize, unit: item.packUnit } : null;
  const inPacks = Boolean(pack && line.inPacks);
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
              onPress={() => onChange({ inPacks: Boolean(pick.packUnit), name: pick.name, unit: pick.unit })}
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
              pack ? (
                <Pressable
                  accessibilityLabel={`In ${inPacks ? STOCK_UNIT_LABELS[pack.unit].many : unitLabel(unit)}. Switch`}
                  accessibilityRole="button"
                  className="flex-row items-center gap-0.5 rounded-lg bg-brand-soft px-2 py-1 active:opacity-70"
                  hitSlop={6}
                  onPress={() => onChange({ inPacks: !line.inPacks })}
                >
                  <Text className="text-sm font-semibold text-primary">
                    {inPacks ? STOCK_UNIT_LABELS[pack.unit].many : unitLabel(unit)}
                  </Text>
                  <Ionicons color={colors.primary} name="swap-vertical" size={14} />
                </Pressable>
              ) : item ? (
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
        {priced ? (
          <View className="flex-1">
            <Input
              error={errors?.price}
              inputMode="numeric"
              keyboardType="number-pad"
              label={priceLabel}
              leading={<Text variant="muted">Rs</Text>}
              onChangeText={(price) => onChange({ price: groupDigits(price) })}
              placeholder="0"
              value={line.price}
            />
          </View>
        ) : null}
      </View>

      {inPacks && pack ? (
        <Text variant="caption">
          1 {STOCK_UNIT_LABELS[pack.unit].one} = {pack.size} {unitLabel(unit)}
        </Text>
      ) : null}
    </Card>
  );
}

function TotalRow({ bold = false, label, value }: { bold?: boolean; label: string; value: string }) {
  return (
    <View className="flex-row items-center justify-between">
      <Text variant={bold ? "subtitle" : "muted"}>{label}</Text>
      <Text variant={bold ? "title" : "label"}>{value}</Text>
    </View>
  );
}
