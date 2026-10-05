import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useMemo, useState } from "react";
import { Pressable, View } from "react-native";

import { AppBar } from "@/components/ui/app-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, SectionHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Grid, InfoTile, StatTile } from "@/components/ui/layout";
import { ListRow, RowDivider } from "@/components/ui/list-row";
import { Screen } from "@/components/ui/screen";
import { Sheet, SheetRow } from "@/components/ui/sheet";
import { SkeletonCard, SkeletonRows } from "@/components/ui/skeleton";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useDates } from "@/hooks/use-dates";
import { useResource } from "@/hooks/use-resource";
import { readApiError } from "@/lib/api-contract";
import { formatMoney } from "@/lib/format";
import {
  type KhataEntry,
  khataIcon,
  type KhataItem,
  khataQuery,
  type ResidentKhata,
  residentKhataAction,
  type ResidentKhataAction,
} from "@/lib/khata-api";
import { toastError, toastSuccess } from "@/lib/toast";

/**
 * Khata — take things now, pay with next month's rent.
 *
 * Closed: one card and one button to ask for it. Open: what goes on the next
 * bill, the item tiles to ask from, and what was asked, by day. An ask waits
 * for the cook; given, it lands on the khata.
 */

const STATUS: Record<KhataEntry["status"], { label: string; tone: "success" | "warning" | "neutral" }> = {
  CANCELLED: { label: "Taken back", tone: "neutral" },
  DECLINED: { label: "Not available", tone: "neutral" },
  GIVEN: { label: "Given", tone: "success" },
  REQUESTED: { label: "Waiting", tone: "warning" },
};

export default function KhataScreen() {
  const dates = useDates();
  const { colors } = useAppTheme();
  const query = khataQuery.resident();
  const khata = useResource(query.load, { cacheKey: query.key, topics: query.topics });

  const [asking, setAsking] = useState<KhataItem | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [note, setNote] = useState("");
  const [entry, setEntry] = useState<KhataEntry | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (input: ResidentKhataAction, done: string) => {
    setBusy(true);

    try {
      const next: ResidentKhata = await residentKhataAction(input);

      khata.setData(() => next);
      toastSuccess(done);
      setAsking(null);
      setEntry(null);
    } catch (error) {
      toastError("Could not send", readApiError(error));
    } finally {
      setBusy(false);
    }
  };

  /* By day, newest first, heading outside the card. */
  const days = useMemo(() => {
    const groups = new Map<string, KhataEntry[]>();

    for (const row of khata.data?.entries ?? []) {
      const day = dates.date(row.createdAt);
      groups.set(day, [...(groups.get(day) ?? []), row]);
    }

    return [...groups];
  }, [dates, khata.data?.entries]);

  const header = <AppBar accent centerTitle showBack title="Khata" />;

  if (khata.loading) {
    return (
      <Screen header={header}>
        <View className="gap-4 pt-1">
          <SkeletonCard rows={2} />
          <SkeletonRows rows={4} />
        </View>
      </Screen>
    );
  }

  if (khata.error || !khata.data) {
    return (
      <Screen header={header}>
        <ErrorState message={khata.error ?? "Could not load"} onRetry={khata.reload} />
      </Screen>
    );
  }

  const { items, status, unbilled } = khata.data;
  const bills = khata.data.bills ?? [];
  const waiting = khata.data.entries.filter((row) => row.status === "REQUESTED").length;

  const tiles = (onPress?: (item: KhataItem) => void) => (
    <Grid maxColumns={3} minCellWidth={96}>
      {items.map((item) => (
        <InfoTile
          caption={formatMoney(item.price)}
          icon={khataIcon(item.name)}
          key={item.id}
          label={item.name}
          onPress={onPress ? () => onPress(item) : undefined}
          tone="brand"
        />
      ))}
    </Grid>
  );

  if (status !== "ACTIVE") {
    return (
      <Screen header={header} onRefresh={khata.refresh} refreshing={khata.refreshing} scroll>
        <View className="gap-5 pt-1">
          {status === "REQUESTED" ? (
            <EmptyState
              description="You'll get a notification when it opens."
              icon="hourglass-outline"
              title="Waiting for the warden"
              tone="warning"
            />
          ) : (
            <EmptyState
              action={
                <Button
                  disabled={items.length === 0}
                  label="Open my khata"
                  loading={busy}
                  onPress={() => void run({ action: "OPEN" }, "Asked the warden")}
                />
              }
              description={
                items.length === 0
                  ? "Your hostel hasn't listed anything yet."
                  : status === "DECLINED"
                    ? "Not opened last time — you can ask again."
                    : "Take now, pay with next month's rent."
              }
              icon="receipt-outline"
              title="Your khata"
              tone="success"
            />
          )}

          {items.length > 0 ? (
            <View>
              <SectionHeader title="On the list" />
              {tiles()}
            </View>
          ) : null}
        </View>
      </Screen>
    );
  }

  return (
    <Screen header={header} onRefresh={khata.refresh} refreshing={khata.refreshing} scroll>
      <View className="gap-5 pt-1">
        <View className="flex-row gap-3">
          <View className="flex-1">
            <StatTile icon="receipt-outline" label="On next bill" tone="brand" value={formatMoney(unbilled)} />
          </View>
          <View className="flex-1">
            <StatTile icon="hourglass-outline" label="Waiting" value={String(waiting)} />
          </View>
          <View className="flex-1">
            <StatTile icon="document-text-outline" label="Bills" value={String(bills.length)} />
          </View>
        </View>

        <View>
          <SectionHeader title="Ask for" />
          {items.length === 0 ? (
            <Text variant="muted">Nothing on the list right now.</Text>
          ) : (
            tiles((item) => {
              setQuantity(1);
              setNote("");
              setAsking(item);
            })
          )}
        </View>

        {bills.length > 0 ? (
          <View>
            <SectionHeader title="Bills" />
            <Card padding="px-4 py-1">
              {bills.map((bill, index) => (
                <View key={bill.invoiceId}>
                  {index > 0 ? <RowDivider inset /> : null}
                  <ListRow
                    icon="document-text-outline"
                    iconBgColor={bill.paid ? "#34C759" : "#FF9500"}
                    onPress={() => router.push(`/invoice/${bill.invoiceId}`)}
                    right={<Badge label={bill.paid ? "Paid" : "Due"} tone={bill.paid ? "success" : "warning"} />}
                    subtitle={`${bill.items} ${bill.items === 1 ? "item" : "items"} · ${formatMoney(bill.amount)}`}
                    title={bill.label}
                  />
                </View>
              ))}
            </Card>
          </View>
        ) : null}

        {days.map(([day, rows]) => (
          <View key={day}>
            <SectionHeader title={day} />
            <Card padding="px-4 py-1">
              {rows.map((row, index) => (
                <View key={row.id}>
                  {index > 0 ? <RowDivider inset /> : null}
                  <ListRow
                    icon={khataIcon(row.name)}
                    iconBgColor={row.status === "GIVEN" ? "#34C759" : row.status === "REQUESTED" ? "#FF9500" : "#8E8E93"}
                    onPress={row.status === "REQUESTED" ? () => setEntry(row) : undefined}
                    right={<Badge label={STATUS[row.status].label} tone={STATUS[row.status].tone} />}
                    subtitle={`${formatMoney(row.amount)}${row.billed ? " · on bill" : ""}`}
                    title={`${row.name} ×${row.quantity}`}
                  />
                </View>
              ))}
            </Card>
          </View>
        ))}
      </View>

      <Sheet
        footer={
          asking ? (
            <Button
              label={`Ask · ${formatMoney(asking.price * quantity)}`}
              loading={busy}
              onPress={() =>
                void run(
                  { action: "ASK", itemId: asking.id, note: note.trim() || undefined, quantity },
                  "Sent to the kitchen",
                )
              }
            />
          ) : null
        }
        onClose={() => setAsking(null)}
        open={asking !== null}
        title={asking?.name ?? ""}
      >
        {asking ? (
          <View className="gap-4 pb-2">
            <View className="flex-row items-center justify-center gap-6">
              <Pressable
                accessibilityLabel="Fewer"
                disabled={quantity <= 1}
                hitSlop={8}
                onPress={() => setQuantity((value) => Math.max(1, value - 1))}
              >
                <Ionicons
                  color={quantity <= 1 ? colors.mutedForeground : colors.primary}
                  name="remove-circle"
                  size={44}
                />
              </Pressable>
              <Text variant="display">{String(quantity)}</Text>
              <Pressable
                accessibilityLabel="More"
                disabled={quantity >= 20}
                hitSlop={8}
                onPress={() => setQuantity((value) => Math.min(20, value + 1))}
              >
                <Ionicons color={colors.primary} name="add-circle" size={44} />
              </Pressable>
            </View>
            <Text className="text-center" variant="caption">
              {`${formatMoney(asking.price)} each`}
            </Text>
            <Input
              label="Note"
              onChangeText={setNote}
              placeholder="Boiled, after 7 pm…"
              value={note}
            />
          </View>
        ) : null}
      </Sheet>

      <Sheet onClose={() => setEntry(null)} open={entry !== null} title={entry ? `${entry.name} ×${entry.quantity}` : ""}>
        {entry ? (
          <SheetRow
            label="Take back this ask"
            onPress={() => void run({ action: "CANCEL", entryId: entry.id }, "Taken back")}
            subtitle="Nothing is added to your khata"
          />
        ) : null}
      </Sheet>
    </Screen>
  );
}
