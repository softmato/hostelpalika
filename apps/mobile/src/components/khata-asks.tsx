import { useState } from "react";
import { View } from "react-native";

import { Button } from "@/components/ui/button";
import { Card, SectionHeader } from "@/components/ui/card";
import { FactRow } from "@/components/ui/layout";
import { ListRow, RowDivider } from "@/components/ui/list-row";
import { Sheet } from "@/components/ui/sheet";
import { EmptyCard } from "@/components/ui/states";
import { Badge } from "@/components/ui/badge";
import { readApiError } from "@/lib/api-contract";
import { formatMoney, formatTime } from "@/lib/format";
import { decideKhataOrder, type KhataEntry, type KhataOrders } from "@/lib/khata-api";
import { toastError, toastSuccess } from "@/lib/toast";

function who(entry: KhataEntry) {
  const resident = entry.resident;

  return resident ? `${resident.name}${resident.roomNumber ? ` · Room ${resident.roomNumber}` : ""}` : "";
}

/**
 * Khata asks: waiting ones to hand over, and the last day's answers.
 *
 * The kitchen's screen and the warden's Khata screen both draw this, so whoever
 * is at the counter can answer. A row opens a sheet with the two answers — Give
 * charges the khata, Not available charges nothing.
 */
export function KhataAsks({
  emptyHidden = false,
  onChanged,
  orders,
}: {
  /** The warden's screen hides the empty state — the kitchen's shows it. */
  emptyHidden?: boolean;
  onChanged: () => void;
  orders: KhataOrders;
}) {
  const [open, setOpen] = useState<KhataEntry | null>(null);
  const [busy, setBusy] = useState<"GIVE" | "DECLINE" | null>(null);

  const decide = async (action: "GIVE" | "DECLINE") => {
    if (!open) {
      return;
    }

    setBusy(action);

    try {
      await decideKhataOrder(open.id, action);
      toastSuccess(
        action === "GIVE" ? `${formatMoney(open.amount)} on ${open.resident?.name ?? "their"} khata` : "Marked not available",
      );
      setOpen(null);
      onChanged();
    } catch (error) {
      toastError("Could not save", readApiError(error));
      onChanged();
    } finally {
      setBusy(null);
    }
  };

  if (emptyHidden && orders.waiting.length === 0) {
    return null;
  }

  return (
    <View className="gap-5">
      <View>
        <SectionHeader title={`Waiting · ${orders.waiting.length}`} />
        {orders.waiting.length === 0 ? (
          <EmptyCard description="New asks show up here." title="Nothing waiting" />
        ) : (
          <Card padding="px-4 py-1">
            {orders.waiting.map((entry, index) => (
              <View key={entry.id}>
                {index > 0 ? <RowDivider inset /> : null}
                <ListRow
                  icon="fast-food-outline"
                  iconBgColor="#FF9500"
                  onPress={() => setOpen(entry)}
                  subtitle={`${who(entry)} · ${formatTime(entry.createdAt)}`}
                  title={`${entry.name} ×${entry.quantity}`}
                  value={formatMoney(entry.amount)}
                />
              </View>
            ))}
          </Card>
        )}
      </View>

      {!emptyHidden && orders.recent.length > 0 ? (
        <View>
          <SectionHeader title="Last 24 hours" />
          <Card padding="px-4 py-1">
            {orders.recent.map((entry, index) => (
              <View key={entry.id}>
                {index > 0 ? <RowDivider inset /> : null}
                <ListRow
                  icon={entry.status === "GIVEN" ? "checkmark-circle-outline" : "close-circle-outline"}
                  iconBgColor={entry.status === "GIVEN" ? "#34C759" : "#8E8E93"}
                  right={
                    <Badge
                      label={entry.status === "GIVEN" ? formatMoney(entry.amount) : "Not available"}
                      tone={entry.status === "GIVEN" ? "success" : "neutral"}
                    />
                  }
                  subtitle={who(entry)}
                  title={`${entry.name} ×${entry.quantity}`}
                />
              </View>
            ))}
          </Card>
        </View>
      ) : null}

      <Sheet
        footer={
          <View className="flex-row gap-3">
            <View className="flex-1">
              <Button
                disabled={busy === "GIVE"}
                label="Not available"
                loading={busy === "DECLINE"}
                onPress={() => void decide("DECLINE")}
                variant="outline"
              />
            </View>
            <View className="flex-1">
              <Button
                disabled={busy === "DECLINE"}
                label="Give"
                loading={busy === "GIVE"}
                onPress={() => void decide("GIVE")}
              />
            </View>
          </View>
        }
        onClose={() => setOpen(null)}
        open={open !== null}
        title={open ? `${open.name} ×${open.quantity}` : ""}
      >
        {open ? (
          <View className="gap-1 pb-2">
            <FactRow label="For" value={who(open)} />
            <FactRow label="Asked at" value={formatTime(open.createdAt)} />
            <FactRow label="Adds to khata" value={formatMoney(open.amount)} />
            {open.note ? <FactRow label="Note" value={open.note} /> : null}
          </View>
        ) : null}
      </Sheet>
    </View>
  );
}
