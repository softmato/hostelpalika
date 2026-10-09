import { Ionicons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import { type ReactNode, useMemo, useState } from "react";
import { Linking, Pressable, View } from "react-native";

import { FLOAT_SHADOW } from "@/components/portal-shared";
import {
  BillPhotoBox,
  DateField,
  MoneyInput,
  readRupees,
  stockChanged,
  useBillPhoto,
  useStock,
} from "@/components/stock/stock-parts";
import { AppBar } from "@/components/ui/app-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { Chip, FactRow } from "@/components/ui/layout";
import { ListRow, RowDivider } from "@/components/ui/list-row";
import { Money } from "@/components/ui/money";
import { Screen } from "@/components/ui/screen";
import { Sheet } from "@/components/ui/sheet";
import { Skeleton, SkeletonRows } from "@/components/ui/skeleton";
import { EmptyCard, ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { Toggle } from "@/components/ui/toggle";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useResource } from "@/hooks/use-resource";
import { readApiError } from "@/lib/api-contract";
import { adminQuery } from "@/lib/admin-queries";
import {
  bsDayLong,
  EXPENSE_PAID_BY,
  EXPENSE_PAID_BY_LABELS,
  type ExpensePaidBy,
  newClientRequestId,
  todayKey,
} from "@/lib/expenses";
import { expenseQuery } from "@/lib/expenses-api";
import { formatMoney } from "@/lib/format";
import { invalidateQuery } from "@/lib/query-cache";
import {
  cancelStockPayment,
  payStockSupplier,
  STOCK_BILL_STATUS_LABELS,
  STOCK_SUPPLIER_NAME_MAX,
  supplierQuery,
  type SupplierLedgerRow,
  updateStockSupplier,
} from "@/lib/stock-api";
import { toastError, toastSuccess } from "@/lib/toast";
import { bsPeriodOf } from "@hostel/calendar/bs";

/**
 * One supplier's ledger (docs/INVENTORY_PLAN.md).
 *
 * A bill adds what was not paid on it; a payment takes off. The card over the
 * header is the one number anyone opens this for — **what we owe now** — with
 * Pay one tap under it. Below, every bill and payment by day, newest first, the
 * balance after each on the right, like a bank statement.
 */

const STRADDLE = 34;

export default function SupplierScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { home } = useStock();
  const query = supplierQuery(id);
  const resource = useResource(query.load, { cacheKey: query.key, topics: query.topics });
  const ledger = resource.data ?? null;
  const [paying, setPaying] = useState(false);
  const [editing, setEditing] = useState(false);
  const [openPayment, setOpenPayment] = useState<SupplierLedgerRow | null>(null);

  const days = useMemo(() => {
    const byDay = new Map<string, SupplierLedgerRow[]>();

    for (const row of ledger?.rows ?? []) byDay.set(row.on, [...(byDay.get(row.on) ?? []), row]);

    return [...byDay];
  }, [ledger]);

  const refreshAll = () => {
    resource.refresh();
    stockChanged();
  };

  const header = (
    <View className="bg-background">
      <AppBar
        accent
        actions={
          ledger ? <IconButton label="Edit supplier" name="create-outline" onPress={() => setEditing(true)} size="sm" /> : undefined
        }
        centerTitle
        showBack
        straddle={STRADDLE}
        subtitle={ledger?.supplier.phone || undefined}
        title={ledger?.supplier.name ?? "Supplier"}
      />
      <View className="px-5" style={{ marginTop: -STRADDLE }}>
        <View className="gap-4 rounded-2xl border border-border bg-card p-4" style={FLOAT_SHADOW}>
          {!ledger ? (
            <Skeleton height={48} width="70%" />
          ) : (
            <>
              <View className="items-center gap-1">
                <Text variant="caption">{ledger.due < 0 ? "Paid ahead" : "You owe now"}</Text>
                <Money owed={ledger.due > 0} size="large" value={Math.abs(ledger.due)} />
              </View>
              <View className="flex-row">
                <Figure label="Bills">
                  <Text variant="label">{formatMoney(ledger.billed)}</Text>
                </Figure>
                <View className="w-px bg-border" />
                <Figure label="Paid">
                  <Text variant="label">{formatMoney(ledger.paid)}</Text>
                </Figure>
              </View>
              <View className="flex-row gap-2">
                <View className="flex-1">
                  <Button disabled={!home?.canSpend} label="Pay" onPress={() => setPaying(true)} />
                </View>
                {ledger.supplier.phone ? (
                  <View className="flex-1">
                    <Button label="Call" onPress={() => void Linking.openURL(`tel:${ledger.supplier.phone}`)} variant="outline" />
                  </View>
                ) : null}
              </View>
            </>
          )}
        </View>
      </View>
    </View>
  );

  if (resource.error && !ledger) {
    return (
      <Screen header={header}>
        <ErrorState message={resource.error} onRetry={resource.reload} />
      </Screen>
    );
  }

  return (
    <>
      <Screen header={header} onRefresh={resource.refresh} refreshing={resource.refreshing} scroll>
        {!ledger ? (
          <View className="pt-5">
            <SkeletonRows rows={6} />
          </View>
        ) : days.length === 0 ? (
          <View className="pt-5">
            <EmptyCard description="Pick this supplier on a bill in Buy, and it shows here." title="No bills yet" />
          </View>
        ) : (
          <View className="gap-5 pb-8 pt-5">
            {days.map(([day, rows]) => (
              <View key={day}>
                <Text className="mb-2 px-1 font-semibold uppercase tracking-wider text-muted-foreground" style={{ fontSize: 11 }}>
                  {bsDayLong(day)}
                </Text>
                <Card padding="px-4 py-0">
                  {rows.map((row, index) => (
                    <View key={row.id}>
                      {index > 0 ? <RowDivider inset /> : null}
                      <LedgerRow
                        onPress={
                          row.kind === "BILL"
                            ? () =>
                                router.push({
                                  params: { id: row.id, period: bsPeriodOf(new Date(`${row.on}T00:00:00Z`)) },
                                  pathname: "/stock/entry/[id]",
                                })
                            : row.kind === "PAYMENT"
                              ? () => setOpenPayment(row)
                              : undefined
                        }
                        row={row}
                      />
                    </View>
                  ))}
                </Card>
              </View>
            ))}
          </View>
        )}
      </Screen>

      {ledger ? (
        <>
          <PaySheet
            due={ledger.due}
            name={ledger.supplier.name}
            onClose={() => setPaying(false)}
            onSaved={() => {
              setPaying(false);
              refreshAll();
            }}
            open={paying}
            proofRequired={home?.proofRequired === true}
            supplierId={ledger.supplier.id}
          />
          <EditSheet
            canSetDue={home?.owner === true}
            onClose={() => setEditing(false)}
            onSaved={() => {
              setEditing(false);
              refreshAll();
            }}
            open={editing}
            supplier={ledger.supplier}
          />
          <PaymentSheet
            onClose={() => setOpenPayment(null)}
            onSaved={() => {
              setOpenPayment(null);
              refreshAll();
            }}
            row={openPayment}
          />
        </>
      ) : null}
    </>
  );
}

function Figure({ children, label }: { children: ReactNode; label: string }) {
  return (
    <View className="flex-1 items-center gap-0.5 px-1">
      <Text variant="caption">{label}</Text>
      {children}
    </View>
  );
}

function LedgerRow({ onPress, row }: { onPress?: () => void; row: SupplierLedgerRow }) {
  const { colors } = useAppTheme();
  const isPayment = row.kind === "PAYMENT";
  const title =
    row.kind === "OPENING"
      ? "Owed before"
      : isPayment
        ? `Paid · ${EXPENSE_PAID_BY_LABELS[(row.payment?.paidBy ?? "CASH") as ExpensePaidBy] ?? "Cash"}`
        : row.bill?.billNo
          ? `Bill ${row.bill.billNo}`
          : "Bill";
  const detail = isPayment
    ? [row.payment?.recordedByName, row.payment?.note].filter(Boolean).join(" · ")
    : row.bill
      ? `${row.bill.items} · ${formatMoney(row.bill.total)}${row.bill.paid ? `, ${formatMoney(row.bill.paid)} paid` : ""}`
      : "";

  return (
    <Pressable accessibilityRole="button" className="min-h-16 flex-row items-center gap-3 py-3 active:opacity-70" disabled={!onPress} onPress={onPress}>
      <View className={`h-10 w-10 items-center justify-center rounded-full ${isPayment ? "bg-success-soft" : "bg-warning-soft"}`}>
        <Ionicons
          color={isPayment ? colors.success : colors.warning}
          name={isPayment ? "arrow-up-outline" : row.kind === "OPENING" ? "flag-outline" : "receipt-outline"}
          size={20}
        />
      </View>
      <View className="flex-1">
        <View className="flex-row items-center gap-2">
          <Text numberOfLines={1} variant="label">
            {title}
          </Text>
          {row.bill && row.bill.status !== "PAID" ? (
            <Badge label={STOCK_BILL_STATUS_LABELS[row.bill.status]} tone={row.bill.status === "DUE" ? "danger" : "warning"} />
          ) : null}
        </View>
        {detail ? (
          <Text numberOfLines={1} variant="caption">
            {detail}
          </Text>
        ) : null}
      </View>
      <View className="items-end">
        <Text className={row.change < 0 ? "text-success" : "text-foreground"} variant="label">
          {row.change < 0 ? "−" : "+"}
          {formatMoney(Math.abs(row.change))}
        </Text>
        <Text variant="caption">Owe {formatMoney(row.balance)}</Text>
      </View>
    </Pressable>
  );
}

/** Pay this supplier: the amount (what is owed, already filled), how, when. */
function PaySheet({
  due,
  name,
  onClose,
  onSaved,
  open,
  proofRequired,
  supplierId,
}: {
  due: number;
  name: string;
  onClose: () => void;
  onSaved: () => void;
  open: boolean;
  proofRequired: boolean;
  supplierId: string;
}) {
  const [amount, setAmount] = useState("");
  const [paidBy, setPaidBy] = useState<ExpensePaidBy>("CASH");
  const [day, setDay] = useState(() => todayKey());
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [seen, setSeen] = useState(open);
  const photo = useBillPhoto();
  // A fresh id each time the sheet opens: a retried tap is one payment, a second payment is not.
  const [requestId, setRequestId] = useState(newClientRequestId);

  if (open !== seen) {
    setSeen(open);
    if (open) {
      setAmount(due > 0 ? due.toLocaleString("en-IN") : "");
      setPaidBy("CASH");
      setDay(todayKey());
      setNote("");
      setRequestId(newClientRequestId());
    }
  }

  const value = readRupees(amount);

  const save = async () => {
    if (!value) return toastError("Write the amount", "Whole rupees.");
    if (proofRequired && !photo.photo?.assetId) {
      return toastError("Add a photo", photo.uploading ? "The photo is still adding." : "A photo of the receipt is needed.");
    }

    setBusy(true);

    try {
      await payStockSupplier({
        amount: value,
        clientRequestId: requestId,
        note: note.trim() || undefined,
        on: day,
        paidBy,
        photoAssetId: photo.photo?.assetId ?? undefined,
        supplierId,
      });
      toastSuccess(`Paid ${name}`, formatMoney(value));
      invalidateQuery(expenseQuery("staff", null).key);
      invalidateQuery(adminQuery.ledger().key);
      onSaved();
    } catch (error) {
      toastError("Not saved", readApiError(error, "Check your internet and tap Pay again."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      footer={<Button disabled={photo.uploading} label={value ? `Pay ${formatMoney(value)}` : "Pay"} loading={busy} onPress={() => void save()} />}
      onClose={onClose}
      open={open}
      tall
      title={`Pay ${name}`}
    >
      <View className="gap-4 pb-2">
        <MoneyInput
          error={value === false ? "Whole rupees" : null}
          hint={due > 0 ? `${formatMoney(due)} owed now` : undefined}
          label="Amount"
          onChangeText={setAmount}
          value={amount}
        />
        <View className="gap-1.5">
          <Text variant="caption">Paid by</Text>
          <View className="flex-row flex-wrap gap-2">
            {EXPENSE_PAID_BY.map((mode) => (
              <Chip key={mode} label={EXPENSE_PAID_BY_LABELS[mode]} onPress={() => setPaidBy(mode)} tone={paidBy === mode ? "brand" : "neutral"} />
            ))}
          </View>
        </View>
        <DateField onChange={setDay} value={day} />
        <Input label="Note (optional)" maxLength={200} onChangeText={setNote} placeholder="e.g. for Bhadra bills" value={note} />
        <BillPhotoBox bill={photo} required={proofRequired} />
      </View>
    </Sheet>
  );
}

/** Name, phone, what was owed before (owner), and switched off. */
function EditSheet({
  canSetDue,
  onClose,
  onSaved,
  open,
  supplier,
}: {
  canSetDue: boolean;
  onClose: () => void;
  onSaved: () => void;
  open: boolean;
  supplier: { active: boolean; id: string; name: string; openingDue: number | null; phone: string };
}) {
  const { colors } = useAppTheme();
  const [name, setName] = useState(supplier.name);
  const [phone, setPhone] = useState(supplier.phone);
  const [due, setDue] = useState(supplier.openingDue ? String(supplier.openingDue) : "");
  const [active, setActive] = useState(supplier.active);
  const [busy, setBusy] = useState(false);
  const [seen, setSeen] = useState(open);

  if (open !== seen) {
    setSeen(open);
    if (open) {
      setName(supplier.name);
      setPhone(supplier.phone);
      setDue(supplier.openingDue ? String(supplier.openingDue) : "");
      setActive(supplier.active);
    }
  }

  const dueValue = readRupees(due);

  const save = async () => {
    if (!name.trim()) return toastError("Name the shop", "Like Ram Kirana Pasal.");
    if (dueValue === false) return toastError("Check the amount", "Whole rupees.");

    setBusy(true);

    try {
      await updateStockSupplier(supplier.id, {
        active,
        name: name.trim(),
        phone: phone.trim(),
        ...(canSetDue ? { openingDue: dueValue || 0 } : {}),
      });
      toastSuccess("Supplier saved");
      onSaved();
    } catch (error) {
      toastError("Not saved", readApiError(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet footer={<Button label="Save" loading={busy} onPress={() => void save()} />} onClose={onClose} open={open} title="Edit supplier">
      <View className="gap-4 pb-2">
        <Input label="Shop or person" maxLength={STOCK_SUPPLIER_NAME_MAX} onChangeText={setName} value={name} />
        <Input keyboardType="phone-pad" label="Phone" maxLength={20} onChangeText={setPhone} value={phone} />
        {canSetDue ? (
          <MoneyInput
            error={dueValue === false ? "Whole rupees" : null}
            hint="What you owed them before you started using Stock."
            label="Already owed"
            onChangeText={setDue}
            value={due}
          />
        ) : null}
        <Card padding="px-4 py-1">
          <ListRow
            icon="eye-outline"
            iconBgColor={colors.primary}
            right={<Toggle accessibilityLabel="Still buying from them" onChange={setActive} value={active} />}
            subtitle="Off hides them from Buy. Their bills and payments stay."
            title="Still buying from them"
          />
        </Card>
      </View>
    </Sheet>
  );
}

/** A payment, opened: what, how, who — and Cancel for the owner or whoever paid. */
function PaymentSheet({
  onClose,
  onSaved,
  row,
}: {
  onClose: () => void;
  onSaved: () => void;
  row: SupplierLedgerRow | null;
}) {
  const [reason, setReason] = useState("");
  const [cancelling, setCancelling] = useState(false);
  const [busy, setBusy] = useState(false);
  const [seen, setSeen] = useState<string | null>(row?.id ?? null);

  if ((row?.id ?? null) !== seen) {
    setSeen(row?.id ?? null);
    setReason("");
    setCancelling(false);
  }

  const payment = row?.payment ?? null;

  const cancel = async () => {
    if (!row || reason.trim().length < 3) return toastError("Say why", "A few words, like “typed twice”.");

    setBusy(true);

    try {
      await cancelStockPayment(row.id, reason.trim());
      toastSuccess("Payment cancelled", "Its expense was cancelled too.");
      invalidateQuery(expenseQuery("staff", null).key);
      invalidateQuery(adminQuery.ledger().key);
      onSaved();
    } catch (error) {
      toastError("Could not cancel", readApiError(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      footer={
        payment?.canCancel ? (
          cancelling ? (
            <Button label="Cancel payment" loading={busy} onPress={() => void cancel()} variant="danger" />
          ) : (
            <Button label="Cancel this payment" onPress={() => setCancelling(true)} variant="outline" />
          )
        ) : undefined
      }
      onClose={onClose}
      open={row !== null}
      title="Payment"
    >
      {row && payment ? (
        <View className="gap-3 pb-2">
          <Card className="gap-2">
            <FactRow label="Amount" value={formatMoney(payment.amount)} />
            <FactRow label="Paid by" value={EXPENSE_PAID_BY_LABELS[payment.paidBy as ExpensePaidBy] ?? payment.paidBy} />
            <FactRow label="Date" value={bsDayLong(row.on)} />
            <FactRow label="Added by" value={payment.recordedByName} />
            {payment.note ? <FactRow label="Note" value={payment.note} /> : null}
          </Card>
          {cancelling ? (
            <Input autoFocus label="Why cancel?" onChangeText={setReason} placeholder="e.g. Typed twice" value={reason} />
          ) : null}
        </View>
      ) : null}
    </Sheet>
  );
}
