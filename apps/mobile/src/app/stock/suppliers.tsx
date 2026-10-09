import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { type ReactNode, useState } from "react";
import { Linking, Pressable, View } from "react-native";

import { FLOAT_SHADOW } from "@/components/portal-shared";
import { MoneyInput, NoStockAccess, readRupees, useStock } from "@/components/stock/stock-parts";
import { AppBar } from "@/components/ui/app-bar";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { RowDivider } from "@/components/ui/list-row";
import { Money } from "@/components/ui/money";
import { Screen } from "@/components/ui/screen";
import { Sheet } from "@/components/ui/sheet";
import { Skeleton, SkeletonRows } from "@/components/ui/skeleton";
import { EmptyCard, ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { readApiError } from "@/lib/api-contract";
import { bsDayMonth } from "@/lib/expenses";
import { formatMoney } from "@/lib/format";
import { addStockSupplier, STOCK_SUPPLIER_NAME_MAX, type StockSupplier } from "@/lib/stock-api";
import { toastError, toastSuccess } from "@/lib/toast";

/**
 * Suppliers — who the hostel buys from, and what it owes each
 * (docs/INVENTORY_PLAN.md).
 *
 * The number that matters sits on the card over the header: **you owe**, all
 * suppliers together. Below, one row per shop, the ones owed most first, with
 * what is owed on the right. A row opens that supplier's ledger.
 *
 * Someone who does not see money gets the same list as a phone book: name,
 * number, call.
 */

const STRADDLE = 34;

export default function SuppliersScreen() {
  const { colors } = useAppTheme();
  const { denied, home, resource } = useStock();
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);

  const money = home?.money === true;
  const suppliers = [...(home?.suppliers ?? [])]
    .filter((supplier) => supplier.active)
    .sort((a, b) => (b.due ?? 0) - (a.due ?? 0) || a.name.localeCompare(b.name));
  const typed = query.trim().toLowerCase();
  const shown = typed ? suppliers.filter((supplier) => supplier.name.toLowerCase().includes(typed)) : suppliers;
  const owed = suppliers.filter((supplier) => (supplier.due ?? 0) > 0).length;

  const header = (
    <View className="bg-background">
      <AppBar accent centerTitle showBack straddle={money ? STRADDLE : 0} title="Suppliers" />
      {money ? (
        <View className="px-5" style={{ marginTop: -STRADDLE }}>
          <View className="rounded-2xl border border-border bg-card p-4" style={FLOAT_SHADOW}>
            {!home ? (
              <Skeleton height={40} width="60%" />
            ) : (
              <View className="flex-row">
                <Figure label="You owe">
                  <Money owed={(home.summary.dueTotal ?? 0) > 0} value={home.summary.dueTotal ?? 0} />
                </Figure>
                <View className="w-px bg-border" />
                <Figure label="Suppliers owed">
                  <Text variant="subtitle">{owed}</Text>
                </Figure>
              </View>
            )}
          </View>
        </View>
      ) : null}
    </View>
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

  return (
    <>
      <Screen
        footer={home ? <Button label="New supplier" onPress={() => setAdding(true)} size="lg" variant="outline" /> : undefined}
        header={header}
        onRefresh={resource.refresh}
        refreshing={resource.refreshing}
        scroll
      >
        {!home ? (
          <View className="pt-5">
            <SkeletonRows rows={6} />
          </View>
        ) : suppliers.length === 0 ? (
          <View className="pt-5">
            <EmptyCard
              description="Add the shops you buy from. Then pick one on a bill, and what you still owe shows here."
              title="No suppliers yet"
            />
          </View>
        ) : (
          <View className="gap-4 pb-6 pt-5">
            {suppliers.length > 8 ? (
              <Input
                leading={<Ionicons color={colors.mutedForeground} name="search" size={18} />}
                onChangeText={setQuery}
                placeholder="Search suppliers"
                value={query}
              />
            ) : null}
            <Card padding="px-4 py-0">
              {shown.map((supplier, index) => (
                <View key={supplier.id}>
                  {index > 0 ? <RowDivider inset /> : null}
                  <SupplierRow money={money} supplier={supplier} />
                </View>
              ))}
            </Card>
            {shown.length === 0 ? <Text variant="muted">Nobody called that.</Text> : null}
          </View>
        )}
      </Screen>

      <NewSupplierSheet
        canSetDue={home?.owner === true}
        onClose={() => setAdding(false)}
        onSaved={() => {
          setAdding(false);
          resource.refresh();
        }}
        open={adding}
      />
    </>
  );
}

function Figure({ children, label }: { children: ReactNode; label: string }) {
  return (
    <View className="flex-1 items-center gap-1 px-1">
      <Text variant="caption">{label}</Text>
      {children}
    </View>
  );
}

function SupplierRow({ money, supplier }: { money: boolean; supplier: StockSupplier }) {
  const { colors } = useAppTheme();
  const due = supplier.due ?? 0;
  const sub = [supplier.phone, supplier.lastBillOn ? `Last bill ${bsDayMonth(supplier.lastBillOn)}` : null]
    .filter(Boolean)
    .join(" · ");

  return (
    <Pressable
      accessibilityRole="button"
      className="min-h-16 flex-row items-center gap-3 py-3 active:opacity-70"
      disabled={!money}
      onPress={() => router.push({ params: { id: supplier.id }, pathname: "/stock/supplier/[id]" })}
    >
      <View className="h-10 w-10 items-center justify-center rounded-full bg-brand-soft">
        <Ionicons color={colors.primary} name="storefront-outline" size={20} />
      </View>
      <View className="flex-1">
        <Text numberOfLines={1} variant="label">
          {supplier.name}
        </Text>
        {sub ? (
          <Text numberOfLines={1} variant="caption">
            {sub}
          </Text>
        ) : null}
      </View>
      {money ? (
        <View className="items-end">
          {due > 0 ? (
            <>
              <Text className="text-destructive" variant="label">
                {formatMoney(due)}
              </Text>
              <Text variant="caption">due</Text>
            </>
          ) : due < 0 ? (
            <>
              <Text className="text-success" variant="label">
                {formatMoney(-due)}
              </Text>
              <Text variant="caption">paid ahead</Text>
            </>
          ) : (
            <Text className="text-success" variant="caption">
              Settled
            </Text>
          )}
        </View>
      ) : supplier.phone ? (
        <Pressable
          accessibilityLabel={`Call ${supplier.name}`}
          accessibilityRole="button"
          className="h-10 w-10 items-center justify-center rounded-full bg-brand-soft active:opacity-70"
          onPress={() => void Linking.openURL(`tel:${supplier.phone}`)}
        >
          <Ionicons color={colors.primary} name="call-outline" size={18} />
        </Pressable>
      ) : null}
      {money ? <Ionicons color={colors.mutedForeground} name="chevron-forward" size={18} /> : null}
    </Pressable>
  );
}

function NewSupplierSheet({
  canSetDue,
  onClose,
  onSaved,
  open,
}: {
  canSetDue: boolean;
  onClose: () => void;
  onSaved: () => void;
  open: boolean;
}) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [due, setDue] = useState("");
  const [busy, setBusy] = useState(false);
  const [seen, setSeen] = useState(open);

  if (open !== seen) {
    setSeen(open);
    if (open) {
      setName("");
      setPhone("");
      setDue("");
    }
  }

  const dueValue = readRupees(due);

  const save = async () => {
    if (!name.trim()) return toastError("Name the shop", "Like Ram Kirana Pasal.");
    if (dueValue === false) return toastError("Check the amount", "Whole rupees.");

    setBusy(true);

    try {
      const saved = await addStockSupplier({
        name: name.trim(),
        openingDue: canSetDue && dueValue ? dueValue : undefined,
        phone: phone.trim() || undefined,
      });

      toastSuccess(`${saved.name} added`);
      onSaved();
    } catch (error) {
      toastError("Not saved", readApiError(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet footer={<Button label="Add supplier" loading={busy} onPress={() => void save()} />} onClose={onClose} open={open} title="New supplier">
      <View className="gap-4 pb-2">
        <Input autoFocus label="Shop or person" maxLength={STOCK_SUPPLIER_NAME_MAX} onChangeText={setName} placeholder="e.g. Ram Kirana Pasal" value={name} />
        <Input keyboardType="phone-pad" label="Phone (optional)" maxLength={20} onChangeText={setPhone} placeholder="98XXXXXXXX" value={phone} />
        {canSetDue ? (
          <MoneyInput
            error={dueValue === false ? "Whole rupees" : null}
            hint="What you owed them before you started using Stock."
            label="Already owed (optional)"
            onChangeText={setDue}
            value={due}
          />
        ) : null}
      </View>
    </Sheet>
  );
}
