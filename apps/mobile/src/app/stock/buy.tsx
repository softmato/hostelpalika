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
import { Card, SectionHeader } from "@/components/ui/card";
import { Glyph } from "@/components/ui/glyph";
import { Input } from "@/components/ui/input";
import { Stagger } from "@/components/ui/layout";
import { Screen } from "@/components/ui/screen";
import { Segmented } from "@/components/ui/segmented";
import { Sheet } from "@/components/ui/sheet";
import { SkeletonCard } from "@/components/ui/skeleton";
import { EmptyCard, ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { adminQuery } from "@/lib/admin-queries";
import { readApiError } from "@/lib/api-contract";
import { groupDigits, newClientRequestId, todayKey } from "@/lib/expenses";
import { expenseQuery } from "@/lib/expenses-api";
import { formatMoney } from "@/lib/format";
import { invalidateQuery } from "@/lib/query-cache";
import {
  addStockEntry,
  addStockItem,
  findStockItem,
  guessStockKind,
  splitBill,
  STOCK_STARTERS,
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
 * **lines** (what, how much, and — if the bill shows it — what each cost), the
 * **bill total**, and **how much was paid**. Whatever was not paid is owed to
 * the supplier and shows on their page.
 *
 * Prices are optional; the bill total is the one figure that matters. Type only
 * the total and it is shared by the items by their usual price (`splitBill`),
 * shown in each blank box before Save. Type every price and leave the total
 * blank, and the total is their sum. Type both, and the gap is the bill's
 * discount or VAT.
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
  const [totalText, setTotalText] = useState("");
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
  /** Typed price, `null` blank, `false` not whole rupees. */
  const priceOf = (line: Line) => readRupees(line.price);
  /** How big a line usually is in money: quantity in the item's unit × its average cost. */
  const weightOf = (line: Line) => {
    const item = known(line);
    const qty = qtyOf(line);

    if (!item?.avgCost || typeof qty !== "number") return null;

    return (line.inPacks && item.packSize ? qty * item.packSize : qty) * item.avgCost;
  };

  const errorsOf = (line: Line) => ({
    name: line.name.trim() ? null : "Write the name",
    price: priceOf(line) === false ? "Whole rupees" : null,
    qty: (() => {
      const qty = qtyOf(line);
      return qty === null || qty === false || qty <= 0 ? "How much?" : null;
    })(),
  });

  const priced = home?.canSpend === true;
  const typedPrices = lines.map((line) => (priced ? priceOf(line) || null : null));
  const itemsSum = typedPrices.reduce<number>((sum, price) => sum + (price ?? 0), 0);
  const unpriced = lines.filter((_, index) => typedPrices[index] === null);
  const billTyped = !opening && priced ? readRupees(totalText) : null;
  const billTotal = typeof billTyped === "number" ? billTyped : null;
  // Every line's money: typed, or its share of what the bill total leaves over.
  const amounts = splitBill(
    billTotal,
    lines.map((line, index) => ({ amount: typedPrices[index]!, weight: weightOf(line) })),
  );
  const total = billTotal ?? itemsSum;
  const gap = billTotal !== null && unpriced.length === 0 ? billTotal - itemsSum : 0;
  const pricesOver = billTotal !== null && unpriced.length > 0 && itemsSum > billTotal;
  const paidPart = readRupees(paidText);
  const paid = opening ? 0 : payment === "all" ? total : payment === "none" ? 0 : Math.min(paidPart || 0, total);
  const due = total - paid;
  const money = !opening && priced && total > 0;
  const shared = billTotal !== null && unpriced.length > 0 && billTotal > itemsSum;
  const totalHint = pricesOver
    ? undefined
    : gap < 0
      ? `Items add up to ${formatMoney(itemsSum)} · ${formatMoney(-gap)} discount`
      : gap > 0
        ? `Items add up to ${formatMoney(itemsSum)} · ${formatMoney(gap)} VAT or extra`
        : shared
          ? `${formatMoney(billTotal - itemsSum)} shared by ${unpriced.map((line) => line.name.trim() || "the new item").join(", ")}${
              unpriced.length < 2 ? "" : unpriced.every((line) => (weightOf(line) ?? 0) > 0) ? " by their usual price" : " equally"
            }`
          : itemsSum > 0 || billTotal !== null
            ? undefined
            : "Type the bill total, or a price on each item";
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

    if (billTyped === false || (money && payment === "part" && !paidPart)) {
      toastError("Not saved yet", billTyped === false ? "The bill total is whole rupees." : "Write how much was paid.");
      return;
    }

    if (pricesOver) {
      toastError("Check the prices", "The item prices add up to more than the bill total.");
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

      for (const [index, line] of lines.entries()) {
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
        const price = priced ? (amounts[index] ?? 0) : 0;
        const packs = line.inPacks && item?.packUnit && item.packSize ? qty : null;

        // The server merges two lines of the same item, and works packs out to kg.
        out.push({
          itemId,
          qty: packs !== null ? qty * item!.packSize! : qty,
          ...(packs !== null ? { packQty: packs } : {}),
          ...(price > 0 ? { amount: price } : {}),
        });
      }

      // Sent as discount / VAT rather than as the total, so a server from before the bill total reads it the same.
      await addStockEntry({
        billNo: opening ? undefined : billNo.trim() || undefined,
        clientRequestId: requestId.current,
        discount: money && gap < 0 ? -gap : undefined,
        hostelId: here.id,
        kind: opening ? "OPENING" : "BUY",
        lines: opening
          ? out.map(({ amount, ...line }) => ({ ...line, ...(amount ? { rate: amount / line.qty } : {}) }))
          : out,
        on: day,
        paid: money ? paid : undefined,
        photoAssetId: opening ? undefined : (bill.photo?.assetId ?? undefined),
        supplierId: opening ? undefined : (supplierId ?? undefined),
        tax: money && gap > 0 ? gap : undefined,
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
        <Stagger className="gap-4 pb-4 pt-3">
          {opening ? (
            <Text variant="muted">Already on the shelf before you started.</Text>
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

          <View className="gap-3">
            <SectionHeader
              subtitle={priced && !opening ? "Amounts are optional — the bill total is enough" : undefined}
              title={`Items · ${lines.length}`}
            />
            {lines.map((line, index) => (
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
                priceLabel={opening ? "Value" : "Amount"}
                share={typedPrices[index] === null ? amounts[index]! : null}
              />
            ))}
            <Button label="Add another item" onPress={() => setLines((prev) => [...prev, blankLine()])} variant="outline" />
          </View>

          {!opening && priced ? (
            <View>
              <SectionHeader title="Bill" />
              <Card className="gap-4">
                <MoneyInput
                  error={billTyped === false ? "Whole rupees" : pricesOver ? "Less than the item prices" : null}
                  hint={totalHint}
                  label="Bill total"
                  onChangeText={setTotalText}
                  placeholder={itemsSum > 0 ? groupDigits(String(itemsSum)) : "0"}
                  value={totalText}
                />

                {total > 0 ? (
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
                ) : null}

                {due > 0 ? (
                  <View className="flex-row items-center justify-between rounded-xl bg-warning-soft px-3 py-2.5">
                    <Text className="text-warning" variant="label">
                      {supplierName ? `Owed to ${supplierName}` : "Still owed"}
                    </Text>
                    <Text className="font-amount tabular-nums text-warning" variant="subtitle">
                      {formatMoney(due)}
                    </Text>
                  </View>
                ) : null}
              </Card>
            </View>
          ) : null}

          {opening ? null : (
            <BillPhotoBox
              bill={bill}
              error={tried && photoNeeded && !bill.photo ? "Add a photo of the bill." : null}
              required={photoNeeded}
            />
          )}
        </Stagger>
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
  share,
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
  /** This line's part of the bill total, when its own box is blank. */
  share: number | null;
}) {
  const { colors } = useAppTheme();
  const unit = item?.unit ?? line.unit;
  const pack = item?.packUnit && item.packSize ? { size: item.packSize, unit: item.packUnit } : null;
  const inPacks = Boolean(pack && line.inPacks);
  const typed = line.name.trim().toLowerCase();
  // The hostel's own items first, then the kitchen starters it has not bought yet (D3).
  const offered = [
    ...picks.map((pick) => ({ inPacks: Boolean(pick.packUnit), item: pick, name: pick.name, unit: pick.unit })),
    ...STOCK_STARTERS.filter((starter) => !findStockItem(picks, starter.name)).map((starter) => ({
      inPacks: false,
      item: { kind: guessStockKind(starter.name), name: starter.name },
      name: starter.name,
      unit: starter.unit,
    })),
  ];
  const qty = readQty(line.qty);
  const base = typeof qty === "number" && qty > 0 ? (inPacks && pack ? qty * pack.size : qty) : null;
  const money = readRupees(line.price) || share;
  const rate =
    money && base
      ? `${share !== null && !line.price.trim() ? "≈ " : ""}${formatMoney(Math.round((money / base) * 100) / 100)} / ${STOCK_UNIT_LABELS[unit].one}`
      : undefined;
  const chips = item ? [] : typed ? offered.filter((pick) => pick.name.toLowerCase().includes(typed)).slice(0, 6) : offered;

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
            <Glyph color={colors.mutedForeground} name="close-circle" size={24} />
          </Pressable>
        ) : null}
      </View>

      {chips.length > 0 ? (
        <ScrollView contentContainerClassName="gap-2" horizontal keyboardShouldPersistTaps="handled" showsHorizontalScrollIndicator={false}>
          {chips.map((pick) => (
            <Pressable
              accessibilityRole="button"
              className="flex-row items-center gap-1.5 rounded-full bg-muted py-1.5 pl-1.5 pr-3 active:opacity-70"
              key={pick.name}
              onPress={() => onChange({ inPacks: pick.inPacks, name: pick.name, unit: pick.unit })}
            >
              <ItemAvatar item={pick.item} size={24} />
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
                  <Glyph color={colors.primary} name="swap-vertical" size={14} />
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
                  <Glyph color={colors.mutedForeground} name="chevron-down" size={14} />
                </Pressable>
              )
            }
            value={line.qty}
          />
        </View>
        {priced ? (
          <View className="flex-1">
            <MoneyInput
              error={errors?.price}
              hint={rate}
              label={priceLabel}
              onChangeText={(price) => onChange({ price })}
              placeholder={share !== null ? groupDigits(String(share)) : "Optional"}
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
