import { Ionicons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { View } from "react-native";

import { palette } from "@/constants/theme";
import { ItemAvatar, NoStockAccess, stockChanged, unitLabel, useStock } from "@/components/stock/stock-parts";
import { AppBar } from "@/components/ui/app-bar";
import { Button } from "@/components/ui/button";
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
import { bsDayLong } from "@/lib/expenses";
import { formatMoney } from "@/lib/format";
import { cancelStockEntry, formatQty, type StockEntry } from "@/lib/stock-api";
import { toastError, toastSuccess } from "@/lib/toast";

/**
 * One entry, whole (docs/INVENTORY_PLAN.md): what it carried, where, who, and —
 * for a Send — the two steps it goes through, with Got it or Cancel at the
 * bottom when this person may do either.
 */

const TITLES = { BUY: "Bought", COUNT: "Count", SEND: "Send Details" } as const;

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

  return entry.kind === "BUY"
    ? { color: palette.light.primary, icon: "cart-outline" as const, line: `At ${entry.hostelName} · ${day}`, title: "Bought" }
    : { color: palette.light.mutedForeground, icon: "clipboard-outline" as const, line: `At ${entry.hostelName} · ${day}`, title: "Counted" };
}

export default function EntryDetailScreen() {
  const { colors } = useAppTheme();
  const { id, period } = useLocalSearchParams<{ id: string; period?: string }>();
  const { denied, home, resource } = useStock(period ?? null);
  const entry =
    [...(home?.waiting ?? []), ...(home?.sentWaiting ?? []), ...(home?.entries ?? [])].find((row) => row.id === id) ?? null;

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
    entry.canReceive || entry.canCancel ? (
      <View className="gap-2">
        {entry.canReceive ? (
          <Button
            label="Got it"
            onPress={() => router.push({ params: { id: entry.id }, pathname: "/stock/receive/[id]" })}
            size="lg"
          />
        ) : null}
        {entry.canCancel ? (
          <Button
            label={isSend && entry.status === "PENDING" ? "Cancel Send" : "Cancel this entry"}
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

                return (
                  <View key={line.itemId}>
                    {index > 0 ? <RowDivider inset /> : null}
                    <View className="min-h-14 flex-row items-center gap-3 py-2">
                      <ItemAvatar item={{ kind: "STORE", name: line.name }} size={36} />
                      <View className="flex-1">
                        <Text variant="label">{line.name}</Text>
                        {line.rate ? (
                          <Text variant="caption">
                            {formatMoney(line.rate)}/{unitLabel(line.unit)}
                          </Text>
                        ) : null}
                        {came ? (
                          <Text className="text-destructive" variant="caption">
                            {formatQty(line.receivedQty ?? 0, line.unit)} came
                          </Text>
                        ) : null}
                      </View>
                      <Text variant="label">
                        {entry.kind === "COUNT" ? `Left ${formatQty(line.qty, line.unit)}` : formatQty(line.qty, line.unit)}
                      </Text>
                    </View>
                  </View>
                );
              })}
            </Card>
          </View>

          <Card className="gap-2">
            <FactRow label="Date" value={bsDayLong(entry.on)} />
            {entry.supplier ? <FactRow label="Supplier" value={entry.supplier} /> : null}
            {entry.amount ? <FactRow label="Bill" value={formatMoney(entry.amount)} /> : null}
            <FactRow label="Added by" value={entry.mine ? "You" : entry.recordedByName} />
            {entry.note ? <FactRow label="Note" value={entry.note} /> : null}
          </Card>

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
          <Button label={isSend ? "Cancel Send" : "Cancel entry"} loading={busy} onPress={() => void cancel()} variant="danger" />
        }
        onClose={() => setCancelling(false)}
        open={cancelling}
        title="Cancel this?"
      >
        <View className="gap-3 pb-2">
          <Text variant="muted">
            {entry.kind === "BUY" && entry.amount
              ? "Its expense is cancelled too. Nothing is deleted — it stays in History as cancelled."
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
