import { Ionicons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { View } from "react-native";

import { palette } from "@/constants/theme";
import { ItemAvatar, NoStockAccess, stockChanged, unitLabel, useStock } from "@/components/stock/stock-parts";
import { AppBar } from "@/components/ui/app-bar";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { FactRow } from "@/components/ui/layout";
import { RowDivider } from "@/components/ui/list-row";
import { Screen } from "@/components/ui/screen";
import { Sheet } from "@/components/ui/sheet";
import { SkeletonCard } from "@/components/ui/skeleton";
import { EmptyCard, ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { readApiError } from "@/lib/api-contract";
import { openAssetViewer } from "@/lib/asset-viewer";
import { bsDayLong } from "@/lib/expenses";
import { formatMoney } from "@/lib/format";
import {
  approveStockCount,
  cancelStockEntry,
  formatPackQty,
  formatQty,
  STOCK_BILL_STATUS_LABELS,
  STOCK_USE_FOR_LABELS,
  STOCK_WASTE_LABELS,
  type StockEntry,
} from "@/lib/stock-api";
import { toastError, toastSuccess } from "@/lib/toast";

/**
 * One entry, whole (docs/INVENTORY_PLAN.md): what it carried, where, who, and —
 * for a bill, its money; for a Count, the book against the shelf; for a Send,
 * the two steps it goes through. Got it, Approve or Cancel sit at the bottom
 * when this person may do them.
 */

const TITLES = {
  BUY: "Bill",
  COUNT: "Count",
  OPENING: "Opening stock",
  SEND: "Send Details",
  USE: "Used",
  WASTE: "Wasted",
} as const;

function banner(entry: StockEntry) {
  const day = bsDayLong(entry.on);
  const short = entry.lines.some((line) => line.receivedQty !== null && line.receivedQty < line.qty);

  if (entry.status === "CANCELLED") {
    return { color: palette.light.mutedForeground, icon: "close-circle-outline" as const, line: entry.cancelReason ?? day, title: "Cancelled" };
  }

  if (entry.kind === "SEND") {
    if (entry.status === "PENDING") {
      return { color: palette.light.warning, icon: "arrow-redo-outline" as const, line: `Sent to ${entry.toHostelName} · ${day}`, title: "On the way" };
    }

    return short
      ? { color: palette.light.destructive, icon: "alert-circle-outline" as const, line: `Less came at ${entry.toHostelName}`, title: "Short" }
      : { color: palette.light.primary, icon: "checkmark-done-outline" as const, line: `Arrived at ${entry.toHostelName}`, title: "Got it" };
  }

  const at = `At ${entry.hostelName} · ${day}`;

  switch (entry.kind) {
    case "BUY":
      return { color: palette.light.primary, icon: "cart-outline" as const, line: at, title: entry.supplier || "Bought" };
    case "OPENING":
      return { color: palette.light.primary, icon: "archive-outline" as const, line: at, title: "Opening stock" };
    case "USE":
      return {
        color: palette.light.foreground,
        icon: "restaurant-outline" as const,
        line: at,
        title: `Used · ${STOCK_USE_FOR_LABELS[entry.useFor ?? "KITCHEN"]}`,
      };
    case "WASTE":
      return {
        color: palette.light.destructive,
        icon: "trash-outline" as const,
        line: at,
        title: `Wasted · ${STOCK_WASTE_LABELS[entry.wasteReason ?? "OTHER"]}`,
      };
    default:
      return entry.status === "PENDING"
        ? { color: palette.light.warning, icon: "hourglass-outline" as const, line: at, title: "Count · waiting for approval" }
        : { color: palette.light.mutedForeground, icon: "clipboard-outline" as const, line: at, title: "Counted" };
  }
}

export default function EntryDetailScreen() {
  const { colors } = useAppTheme();
  const { id, period } = useLocalSearchParams<{ id: string; period?: string }>();
  const { denied, home, resource } = useStock(period ?? null);
  const entry =
    [...(home?.waiting ?? []), ...(home?.sentWaiting ?? []), ...(home?.toApprove ?? []), ...(home?.entries ?? [])].find(
      (row) => row.id === id,
    ) ?? null;

  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const header = <AppBar centerTitle showBack title={entry ? TITLES[entry.kind] : "Details"} />;

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

  if (!entry) {
    return (
      <Screen header={header}>
        <EmptyCard description="It may be from another month, or for another building." title="Not found" />
      </Screen>
    );
  }

  const look = banner(entry);
  const isSend = entry.kind === "SEND";
  const pendingCount = entry.kind === "COUNT" && entry.status === "PENDING";
  const bill = entry.bill;

  const approve = async () => {
    setBusy(true);

    try {
      await approveStockCount(entry.id);
      toastSuccess("Count approved", "The book now matches the shelf.");
      stockChanged();
      resource.refresh();
    } catch (error) {
      toastError("Could not approve", readApiError(error));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (reason.trim().length < 3) {
      toastError("Say why", "A few words, like “wrong building”.");
      return;
    }

    setBusy(true);

    try {
      await cancelStockEntry(entry.id, reason.trim());
      toastSuccess("Cancelled", entry.kind === "BUY" && entry.amount ? "Its expense was cancelled too." : undefined);
      stockChanged();
      setCancelling(false);
      resource.refresh();
    } catch (error) {
      toastError("Could not cancel", readApiError(error));
    } finally {
      setBusy(false);
    }
  };

  const footer =
    entry.canReceive || entry.canCancel || entry.canApprove ? (
      <View className="gap-2">
        {entry.canApprove ? (
          <Button label="Approve count" loading={busy} onPress={() => void approve()} size="lg" />
        ) : null}
        {entry.canReceive ? (
          <Button
            label="Got it"
            onPress={() => router.push({ params: { id: entry.id }, pathname: "/stock/receive/[id]" })}
            size="lg"
          />
        ) : null}
        {entry.canCancel ? (
          <Button
            label={
              entry.canApprove ? "Turn down" : isSend && entry.status === "PENDING" ? "Cancel Send" : "Cancel this entry"
            }
            onPress={() => setCancelling(true)}
            variant="outline"
          />
        ) : null}
      </View>
    ) : undefined;

  return (
    <>
      <Screen footer={footer} header={header} onRefresh={resource.refresh} refreshing={resource.refreshing} scroll>
        <View className="gap-5 pb-4 pt-3">
          <View className="flex-row items-center gap-3 rounded-2xl p-4" style={{ backgroundColor: `${look.color}1A` }}>
            <View className="h-11 w-11 items-center justify-center rounded-full bg-card">
              <Ionicons color={look.color} name={look.icon} size={22} />
            </View>
            <View className="flex-1">
              <Text style={{ color: look.color }} variant="subtitle">
                {look.title}
              </Text>
              <Text variant="caption">{look.line}</Text>
            </View>
          </View>

          <View className="gap-2">
            <Text variant="subtitle">Items</Text>
            <Card padding="px-4 py-1">
              {entry.lines.map((line, index) => {
                const came = line.receivedQty !== null && line.receivedQty !== line.qty;
                const gap = line.systemQty !== null ? Math.round((line.qty - line.systemQty) * 100) / 100 : null;

                return (
                  <View key={line.itemId}>
                    {index > 0 ? <RowDivider inset /> : null}
                    <View className="min-h-14 flex-row items-center gap-3 py-2">
                      <ItemAvatar item={{ kind: "STORE", name: line.name }} size={36} />
                      <View className="flex-1">
                        <Text variant="label">{line.name}</Text>
                        {entry.kind === "COUNT" && line.systemQty !== null ? (
                          <Text
                            className={gap === 0 ? "text-success" : gap !== null && gap < 0 ? "text-destructive" : "text-warning"}
                            variant="caption"
                          >
                            Book {formatQty(line.systemQty, line.unit)} ·{" "}
                            {gap === 0 ? "matches" : `${formatQty(Math.abs(gap ?? 0), line.unit)} ${gap! < 0 ? "missing" : "extra"}`}
                          </Text>
                        ) : line.rate ? (
                          <Text variant="caption">
                            {formatMoney(line.rate)}/{unitLabel(line.unit)}
                            {line.amount ? ` · ${formatMoney(line.amount)}` : ""}
                          </Text>
                        ) : null}
                        {came ? (
                          <Text className="text-destructive" variant="caption">
                            {formatQty(line.receivedQty ?? 0, line.unit)} came
                          </Text>
                        ) : null}
                      </View>
                      <Text variant="label">
                        {entry.kind === "COUNT"
                          ? `Found ${formatQty(line.qty, line.unit)}`
                          : formatPackQty(line.qty, line.unit, line)}
                      </Text>
                    </View>
                  </View>
                );
              })}
            </Card>
          </View>

          {bill && bill.total !== null ? (
            <Card className="gap-2">
              <View className="flex-row items-center justify-between">
                <Text variant="subtitle">Bill</Text>
                {bill.status ? (
                  <Badge
                    label={STOCK_BILL_STATUS_LABELS[bill.status]}
                    tone={bill.status === "PAID" ? "success" : bill.status === "PARTIAL" ? "warning" : "danger"}
                  />
                ) : null}
              </View>
              {bill.discount ? <FactRow label="Discount" value={`− ${formatMoney(bill.discount)}`} /> : null}
              {bill.tax ? <FactRow label="VAT / tax" value={formatMoney(bill.tax)} /> : null}
              <FactRow label="Total" value={formatMoney(bill.total)} />
              <FactRow label="Paid" value={formatMoney(bill.paid ?? 0)} />
              {bill.due ? <FactRow label="Still owed" value={formatMoney(bill.due)} /> : null}
            </Card>
          ) : null}

          <Card className="gap-2">
            <FactRow label="Date" value={bsDayLong(entry.on)} />
            {entry.supplier ? <FactRow label="Supplier" value={entry.supplier} /> : null}
            {bill?.billNo ? <FactRow label="Bill no." value={bill.billNo} /> : null}
            <FactRow label="Added by" value={entry.mine ? "You" : entry.recordedByName} />
            {entry.approvedByName && entry.kind === "COUNT" && entry.status === "DONE" ? (
              <FactRow label="Approved by" value={entry.approvedByName} />
            ) : null}
            {entry.note ? <FactRow label={entry.kind === "COUNT" ? "Why different" : "Note"} value={entry.note} /> : null}
          </Card>

          {bill?.supplierId && home.money ? (
            <Button
              label="Open supplier"
              onPress={() => router.push({ params: { id: bill.supplierId! }, pathname: "/stock/supplier/[id]" })}
              variant="outline"
            />
          ) : null}

          {bill?.photoAssetId ? (
            <Button
              label="See bill photo"
              onPress={() => openAssetViewer([{ assetId: bill.photoAssetId ?? undefined, caption: entry.supplier, title: "Bill" }])}
              variant="outline"
            />
          ) : null}

          {pendingCount && !entry.canApprove ? (
            <View className="flex-row items-center gap-2 rounded-xl bg-muted px-3 py-2.5">
              <Ionicons color={colors.mutedForeground} name="information-circle-outline" size={18} />
              <Text className="flex-1" variant="caption">
                The book changes only when the owner approves this count.
              </Text>
            </View>
          ) : null}

          {isSend ? (
            <View className="gap-3">
              {entry.status === "PENDING" ? (
                <View className="flex-row items-center gap-2 rounded-xl bg-muted px-3 py-2.5">
                  <Ionicons color={colors.mutedForeground} name="information-circle-outline" size={18} />
                  <Text className="flex-1" variant="caption">
                    The receiving building confirms when the stock arrives.
                  </Text>
                </View>
              ) : null}
              <Card className="gap-0">
                <Step
                  color={colors.primary}
                  done
                  line={`Sent from ${entry.hostelName} by ${entry.mine ? "you" : entry.recordedByName}`}
                  title={bsDayLong(entry.on)}
                />
                <Step
                  color={entry.status === "RECEIVED" ? colors.primary : colors.border}
                  done={entry.status === "RECEIVED"}
                  last
                  line={
                    entry.status === "RECEIVED"
                      ? `Got it at ${entry.toHostelName}${entry.receivedByName ? ` by ${entry.receivedByName}` : ""}`
                      : entry.status === "CANCELLED"
                        ? "Cancelled before it arrived"
                        : `Waiting for confirmation at ${entry.toHostelName}`
                  }
                  title={
                    entry.status === "RECEIVED" && entry.receivedAt
                      ? bsDayLong(entry.receivedAt.slice(0, 10))
                      : entry.status === "CANCELLED"
                        ? "Cancelled"
                        : "Not yet"
                  }
                />
              </Card>
            </View>
          ) : null}
        </View>
      </Screen>

      <Sheet
        footer={
          <Button
            label={pendingCount && entry.canApprove ? "Turn down count" : isSend ? "Cancel Send" : "Cancel entry"}
            loading={busy}
            onPress={() => void cancel()}
            variant="danger"
          />
        }
        onClose={() => setCancelling(false)}
        open={cancelling}
        title={pendingCount && entry.canApprove ? "Turn down this count?" : "Cancel this?"}
      >
        <View className="gap-3 pb-2">
          <Text variant="muted">
            {pendingCount && entry.canApprove
              ? "The book stays as it is. The person who counted sees your reason."
              : entry.kind === "BUY" && entry.amount
                ? "What was paid on it is cancelled in Money Out too, and the supplier is owed less. Nothing is deleted."
                : "Nothing is deleted — it stays in History as cancelled."}
          </Text>
          <Input
            autoFocus
            label="Why?"
            onChangeText={setReason}
            placeholder={isSend ? "e.g. Wrong building" : "e.g. Wrong quantity"}
            value={reason}
          />
        </View>
      </Sheet>
    </>
  );
}

/** One point on the Send timeline: a dot, a line down to the next, two lines of text. */
function Step({
  color,
  done,
  last = false,
  line,
  title,
}: {
  color: string;
  done: boolean;
  last?: boolean;
  line: string;
  title: string;
}) {
  return (
    <View className="flex-row gap-3">
      <View className="items-center">
        <View
          className="mt-1 h-3.5 w-3.5 rounded-full"
          style={{ backgroundColor: done ? color : "transparent", borderColor: color, borderWidth: 2 }}
        />
        {last ? null : <View className="w-0.5 flex-1 bg-border" style={{ minHeight: 28 }} />}
      </View>
      <View className={`flex-1 ${last ? "" : "pb-4"}`}>
        <Text variant="label">{title}</Text>
        <Text variant="caption">{line}</Text>
      </View>
    </View>
  );
}
