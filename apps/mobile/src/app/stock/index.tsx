import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { type ReactNode, useCallback, useMemo, useState } from "react";
import { Pressable, TextInput, View } from "react-native";

import { FLOAT_SHADOW } from "@/components/portal-shared";
import { useIsOverall } from "@/components/hostel-switcher";
import { ItemSheet, StockGlyph } from "@/components/stock/stock-parts";
import { ActionCard, ActionCell } from "@/components/ui/action-grid";
import { AppBar } from "@/components/ui/app-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, SectionHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { FactRow } from "@/components/ui/layout";
import { ListRow, RowDivider } from "@/components/ui/list-row";
import { Money } from "@/components/ui/money";
import { Screen } from "@/components/ui/screen";
import { Sheet } from "@/components/ui/sheet";
import { Skeleton, SkeletonRows } from "@/components/ui/skeleton";
import { EmptyCard, ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useResource } from "@/hooks/use-resource";
import { readApiError } from "@/lib/api-contract";
import { bsDayLong, bsDayMonth, relativeBsDay } from "@/lib/expenses";
import { formatMoney } from "@/lib/format";
import { invalidateQuery } from "@/lib/query-cache";
import {
  cancelStockEntry,
  ENTRY_GLYPHS,
  entryTitle,
  formatQty,
  linesSummary,
  parseQtyInput,
  receiveStock,
  shortLines,
  type StockEntry,
  type StockHome,
  type StockItem,
  type StockLoad,
  type StockPlace,
  stockQuery,
} from "@/lib/stock-api";
import { toastError, toastSuccess } from "@/lib/toast";
import { addBsMonths, bsMonthName, periodParts } from "@hostel/calendar/bs";

/**
 * Stock — what came, where it went, what is left (docs/INVENTORY_PLAN.md).
 *
 * The Finance screen's shape: an accent header with the month riding on it,
 * then sections of tinted icon rows, each opening a bottom sheet. Top to bottom
 * in the order things need doing — goods waiting for Got it, goods on their way
 * out, the store, the daily items, and the month's entries by day.
 *
 * Everyone sees the building picked in the switcher and can still send to the
 * others; only the owner's Overall shows every building side by side, read-only.
 * The server decides which.
 */

/** Room the bar paints under itself for the card that rides up onto it. */
const STRADDLE = 34;

function periodLabel(period: string) {
  const parts = periodParts(period);

  return parts ? `${bsMonthName(parts.month)} ${parts.year}` : period;
}

function placeName(home: StockHome, id: string) {
  return home.places.find((place) => place.id === id)?.name ?? "Hostel";
}

/** `Main 120 kg · Branch 60 kg` — or one building's own line for a warden. */
function itemSubtitle(home: StockHome, item: StockItem) {
  const many = item.at.length > 1;

  if (item.kind === "DAILY") {
    const parts = item.at
      .filter((at) => at.in > 0)
      .map((at) => (many ? `${placeName(home, at.hostelId)} ${formatQty(at.in, item.unit)}` : formatQty(at.in, item.unit)));

    return parts.length > 0 ? `This month · ${parts.join(" · ")}` : "Nothing this month";
  }

  if (many) {
    return item.at.map((at) => `${placeName(home, at.hostelId)} ${formatQty(at.left, item.unit)}`).join(" · ");
  }

  const at = item.at[0];

  if (!at) return "";
  if (at.onWay > 0) return `${formatQty(at.onWay, item.unit)} on the way`;

  return at.countedAt ? `Counted ${bsDayMonth(at.countedAt.slice(0, 10))}` : "Not counted yet";
}

export default function StockScreen() {
  const { colors } = useAppTheme();
  const [period, setPeriod] = useState<string | null>(null);
  const query = stockQuery(period);
  // Overall shows every building's shelves and acts on none: a write belongs to one branch.
  const overall = useIsOverall();
  const resource = useResource<StockLoad>(query.load, { cacheKey: query.key, topics: query.topics });

  const home = resource.data?.kind === "ok" ? resource.data.home : null;
  const denied = resource.data?.kind === "denied" ? resource.data : null;

  const [openItem, setOpenItem] = useState<StockItem | null>(null);
  const [editing, setEditing] = useState<StockItem | null>(null);
  const [itemSheet, setItemSheet] = useState(false);
  const [openEntry, setOpenEntry] = useState<StockEntry | null>(null);
  const [receiving, setReceiving] = useState<StockEntry | null>(null);

  const atCurrent = !home || home.period === home.currentPeriod;

  const step = useCallback(
    (delta: number) => {
      if (!home) return;

      const next = addBsMonths(home.period, delta);

      setPeriod(next === home.currentPeriod ? null : next);
    },
    [home],
  );

  const changed = useCallback(() => {
    invalidateQuery(stockQuery(null).key);
    resource.refresh();
  }, [resource]);

  const items = useMemo(() => (home?.items ?? []).filter((item) => item.active), [home]);
  const store = items.filter((item) => item.kind === "STORE");
  const daily = items.filter((item) => item.kind === "DAILY");
  const low = items.filter((item) => item.at.some((at) => at.low)).length;
  const spent = (home?.entries ?? [])
    .filter((entry) => entry.kind === "BUY" && entry.status !== "CANCELLED")
    .reduce((sum, entry) => sum + (entry.amount ?? 0), 0);
  const onWay = (home?.waiting.length ?? 0) + (home?.sentWaiting.length ?? 0);

  const days = useMemo(() => {
    const map = new Map<string, StockEntry[]>();

    for (const entry of home?.entries ?? []) {
      map.set(entry.on, [...(map.get(entry.on) ?? []), entry]);
    }

    return [...map.entries()];
  }, [home]);

  const go = (kind: "buy" | "send" | "count", itemId?: string) =>
    router.push({ params: { kind, ...(itemId ? { itemId } : {}) }, pathname: "/stock/entry" });

  /* ---------------------------------------------------------------- header */

  const mainName = home?.places.find((place) => place.mine)?.name;
  const header = (
    <View className="bg-background">
      <AppBar
        accent
        centerTitle
        showBack
        straddle={home || resource.loading ? STRADDLE : 0}
        subtitle={home ? (overall ? "Every building" : mainName) : undefined}
        title="Stock"
      />

      {home || resource.loading ? (
        <View className="px-5" style={{ marginTop: -STRADDLE }}>
          <View className="gap-3 rounded-2xl border border-border bg-card p-4" style={FLOAT_SHADOW}>
            <View className="flex-row items-center justify-between">
              <Pressable
                accessibilityLabel="Previous month"
                accessibilityRole="button"
                className="h-9 w-9 items-center justify-center rounded-full active:opacity-60"
                disabled={!home}
                hitSlop={6}
                onPress={() => step(-1)}
              >
                <Ionicons color={colors.foreground} name="chevron-back" size={18} />
              </Pressable>
              <Text variant="label">
                {home ? (atCurrent ? `This month · ${periodLabel(home.period)}` : periodLabel(home.period)) : " "}
              </Text>
              <Pressable
                accessibilityLabel="Next month"
                accessibilityRole="button"
                className={`h-9 w-9 items-center justify-center rounded-full active:opacity-60 ${atCurrent ? "opacity-30" : ""}`}
                disabled={atCurrent}
                hitSlop={6}
                onPress={() => step(1)}
              >
                <Ionicons color={colors.foreground} name="chevron-forward" size={18} />
              </Pressable>
            </View>

            {!home ? (
              <View className="flex-row gap-3">
                <Skeleton height={36} width="30%" />
                <Skeleton height={36} width="30%" />
                <Skeleton height={36} width="30%" />
              </View>
            ) : (
              <View className="flex-row">
                <Figure label="Bought for">
                  <Money tone="debit" value={spent} />
                </Figure>
                <View className="w-px bg-border" />
                <Figure label="On the way">
                  <Text className={onWay > 0 ? "text-warning" : "text-foreground"} variant="subtitle">
                    {onWay}
                  </Text>
                </Figure>
                <View className="w-px bg-border" />
                <Figure label="Running low">
                  <Text className={low > 0 ? "text-destructive" : "text-foreground"} variant="subtitle">
                    {low}
                  </Text>
                </Figure>
              </View>
            )}
          </View>
        </View>
      ) : null}
    </View>
  );

  /* ------------------------------------------------------------------ body */

  if (resource.error && !resource.data) {
    return (
      <Screen header={header}>
        <ErrorState message={resource.error} onRetry={resource.reload} />
      </Screen>
    );
  }

  if (denied) {
    return (
      <Screen header={<AppBar accent centerTitle showBack title="Stock" />}>
        <Card className="gap-1">
          <Text variant="label">You cannot handle stock yet</Text>
          <Text variant="muted">Your account does not have “Stock”. Ask the hostel owner to turn it on for you.</Text>
        </Card>
      </Screen>
    );
  }

  return (
    <>
      <Screen header={header} onRefresh={resource.refresh} padded={false} refreshing={resource.refreshing} scroll>
        <View className="gap-6 px-5 pt-5">
          {resource.loading ? <SkeletonRows rows={6} /> : null}

          {home && !overall ? (
            <ActionCard>
              <ActionCell glyph={colors.success} icon="bag-add-outline" label="Bought" onPress={() => go("buy")} tone="success" />
              <ActionCell
                glyph={colors.primary}
                icon="paper-plane-outline"
                label="Send"
                onPress={() => go("send")}
                tone="brand"
              />
              <ActionCell glyph={colors.warning} icon="clipboard-outline" label="Count" onPress={() => go("count")} tone="warning" />
              <ActionCell
                glyph={colors.mutedForeground}
                icon="add"
                label="New item"
                onPress={() => {
                  setEditing(null);
                  setItemSheet(true);
                }}
                tone="admin"
              />
            </ActionCard>
          ) : null}

          {home && home.waiting.length > 0 ? (
            <View>
              <SectionHeader subtitle="Check it came, then tap Got it" title={`Coming to you · ${home.waiting.length}`} />
              <Card padding="px-4 py-1">
                {home.waiting.map((entry, index) => (
                  <View key={entry.id}>
                    {index > 0 ? <RowDivider inset /> : null}
                    <ListRow
                      icon={ENTRY_GLYPHS.SEND.icon}
                      iconBgColor="#FF9500"
                      onPress={() => (overall ? setOpenEntry(entry) : setReceiving(entry))}
                      right={<Badge label="Got it?" tone="warning" />}
                      subtitle={linesSummary(entry.lines)}
                      title={`From ${entry.hostelName}`}
                    />
                  </View>
                ))}
              </Card>
            </View>
          ) : null}

          {home && home.sentWaiting.length > 0 ? (
            <View>
              <SectionHeader title={`On the way · ${home.sentWaiting.length}`} />
              <Card padding="px-4 py-1">
                {home.sentWaiting.map((entry, index) => (
                  <View key={entry.id}>
                    {index > 0 ? <RowDivider inset /> : null}
                    <ListRow
                      icon={ENTRY_GLYPHS.SEND.icon}
                      iconBgColor={ENTRY_GLYPHS.SEND.color}
                      onPress={() => setOpenEntry(entry)}
                      right={<Badge label="Waiting" tone="neutral" />}
                      subtitle={linesSummary(entry.lines)}
                      title={`To ${entry.toHostelName ?? ""}`}
                    />
                  </View>
                ))}
              </Card>
            </View>
          ) : null}

          {home && items.length === 0 ? (
            <EmptyCard
              action={
                overall ? undefined : <Button
                  label="Add your first item"
                  onPress={() => {
                    setEditing(null);
                    setItemSheet(true);
                  }}
                  size="sm"
                />
              }
              description="Rice, daal, oil, vegetables… Add what you buy, then record it each time it comes."
              title="Nothing in stock yet"
            />
          ) : null}

          {home && store.length > 0 ? (
            <ItemSection home={home} items={store} onOpen={setOpenItem} subtitle="Left in each store" title="Store" />
          ) : null}

          {home && daily.length > 0 ? (
            <ItemSection home={home} items={daily} onOpen={setOpenItem} subtitle="Used the day it comes" title="Daily" />
          ) : null}

          {days.map(([day, entries]) => (
            <View className="gap-2" key={day}>
              <Text className="font-semibold uppercase tracking-wider text-muted-foreground" style={{ fontSize: 11 }}>
                {relativeBsDay(day)}
              </Text>
              <Card padding="px-4 py-1">
                {entries.map((entry, index) => (
                  <View key={entry.id}>
                    {index > 0 ? <RowDivider inset /> : null}
                    <ListRow
                      icon={ENTRY_GLYPHS[entry.kind].icon}
                      iconBgColor={entry.status === "CANCELLED" ? "#8E8E93" : ENTRY_GLYPHS[entry.kind].color}
                      onPress={() => setOpenEntry(entry)}
                      right={entryBadge(entry)}
                      subtitle={linesSummary(entry.lines)}
                      title={entryTitle(entry)}
                    />
                  </View>
                ))}
              </Card>
            </View>
          ))}

          {home && home.entries.length === 0 && items.length > 0 ? (
            <EmptyCard
              description={atCurrent ? "Tap Bought when goods come in." : "Nothing was entered in this month."}
              title="No entries this month"
            />
          ) : null}
        </View>
      </Screen>

      {home ? (
        <>
          <ItemDetailSheet
            home={home}
            item={openItem}
            onAction={(kind) => {
              const id = openItem?.id;

              setOpenItem(null);
              go(kind, id);
            }}
            onClose={() => setOpenItem(null)}
            readOnly={overall}
            onEdit={() => {
              setEditing(openItem);
              setOpenItem(null);
              setItemSheet(true);
            }}
          />
          <EntrySheet entry={openEntry} onChanged={changed} onClose={() => setOpenEntry(null)} />
          <ReceiveSheet entry={receiving} onClose={() => setReceiving(null)} onDone={changed} />
          <ItemSheet
            existing={home.items.map((item) => item.name)}
            item={editing}
            onClose={() => setItemSheet(false)}
            onSaved={() => {
              setItemSheet(false);
              changed();
            }}
            open={itemSheet}
          />
        </>
      ) : null}
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

function entryBadge(entry: StockEntry) {
  if (entry.status === "CANCELLED") return <Badge label="Cancelled" tone="neutral" />;
  if (entry.status === "PENDING") return <Badge label="On the way" tone="warning" />;
  if (entry.kind === "SEND") {
    return shortLines(entry).length > 0 ? <Badge label="Short" tone="danger" /> : <Badge label="Got it" tone="success" />;
  }
  if (entry.amount) return <Text variant="muted">{formatMoney(entry.amount)}</Text>;

  return undefined;
}

function ItemSection({
  home,
  items,
  onOpen,
  subtitle,
  title,
}: {
  home: StockHome;
  items: StockItem[];
  onOpen: (item: StockItem) => void;
  subtitle: string;
  title: string;
}) {
  return (
    <View>
      <SectionHeader subtitle={subtitle} title={title} />
      <Card padding="px-4 py-1">
        {items.map((item, index) => {
          const total = item.at.reduce(
            (sum, at) => sum + (item.kind === "DAILY" ? at.in : at.left),
            0,
          );
          const isLow = item.at.some((at) => at.low);

          return (
            <View key={item.id}>
              {index > 0 ? <RowDivider inset /> : null}
              <ListRow
                left={<StockGlyph item={item} />}
                onPress={() => onOpen(item)}
                right={
                  <View className="items-end gap-1">
                    <Text className={isLow ? "text-destructive" : "text-foreground"} variant="label">
                      {formatQty(total, item.unit)}
                    </Text>
                    {isLow ? <Badge label="Low" tone="danger" /> : null}
                  </View>
                }
                subtitle={itemSubtitle(home, item)}
                title={item.name}
              />
            </View>
          );
        })}
      </Card>
    </View>
  );
}

/* -------------------------------------------------------------- one item */

function ItemDetailSheet({
  home,
  item,
  onAction,
  onClose,
  onEdit,
  readOnly,
}: {
  home: StockHome;
  item: StockItem | null;
  onAction: (kind: "buy" | "send" | "count") => void;
  onClose: () => void;
  onEdit: () => void;
  readOnly: boolean;
}) {
  const moves = item
    ? home.entries.filter(
        (entry) => entry.status !== "CANCELLED" && entry.lines.some((line) => line.itemId === item.id),
      )
    : [];

  return (
    <Sheet
      footer={
        item && !readOnly ? (
          <View className="gap-2">
            <View className="flex-row gap-2">
              <View className="flex-1">
                <Button label="Bought" onPress={() => onAction("buy")} />
              </View>
              <View className="flex-1">
                <Button label="Send" onPress={() => onAction("send")} variant="outline" />
              </View>
              {item.kind === "STORE" ? (
                <View className="flex-1">
                  <Button label="Count" onPress={() => onAction("count")} variant="outline" />
                </View>
              ) : null}
            </View>
            {home.owner ? <Button label="Edit item" onPress={onEdit} variant="ghost" /> : null}
          </View>
        ) : undefined
      }
      onClose={onClose}
      open={item !== null}
      title={item?.name ?? ""}
    >
      {item ? (
        <View className="gap-4 pb-2">
          {item.at.map((at) => {
            const place = home.places.find((entry) => entry.id === at.hostelId) as StockPlace | undefined;
            const perResident =
              place?.residents && at.used > 0 ? `${formatQty(at.used / place.residents, item.unit)} each` : null;

            return (
              <Card className="gap-3" key={at.hostelId}>
                <View className="flex-row items-center gap-3">
                  <StockGlyph item={item} size={40} />
                  <View className="flex-1">
                    <Text variant="label">{place?.name ?? "Hostel"}</Text>
                    <Text variant="caption">
                      {item.kind === "DAILY"
                        ? "Daily item"
                        : at.countedAt
                          ? `Counted ${formatQty(at.counted ?? 0, item.unit)} on ${bsDayMonth(at.countedAt.slice(0, 10))}`
                          : "Not counted yet"}
                    </Text>
                  </View>
                  {item.kind === "STORE" ? (
                    <View className="items-end">
                      <Text className={at.low ? "text-destructive" : "text-foreground"} variant="subtitle">
                        {formatQty(at.left, item.unit)}
                      </Text>
                      <Text variant="caption">left</Text>
                    </View>
                  ) : null}
                </View>

                <View className="flex-row gap-2">
                  <Tile label="Came in" value={formatQty(at.in, item.unit)} />
                  <Tile label="Sent out" value={formatQty(at.out, item.unit)} />
                  <Tile label="Used" sub={perResident} value={formatQty(at.used, item.unit)} />
                </View>

                {at.onWay > 0 || at.short > 0 ? (
                  <View className="flex-row flex-wrap gap-2">
                    {at.onWay > 0 ? <Badge label={`${formatQty(at.onWay, item.unit)} on the way`} tone="warning" /> : null}
                    {at.short > 0 ? <Badge label={`${formatQty(at.short, item.unit)} short`} tone="danger" /> : null}
                  </View>
                ) : null}
              </Card>
            );
          })}

          {moves.length > 0 ? (
            <View>
              <SectionHeader title="This month" />
              <Card padding="px-4 py-1">
                {moves.map((entry, index) => {
                  const line = entry.lines.find((row) => row.itemId === item.id)!;

                  return (
                    <View key={entry.id}>
                      {index > 0 ? <RowDivider inset /> : null}
                      <ListRow
                        icon={ENTRY_GLYPHS[entry.kind].icon}
                        iconBgColor={ENTRY_GLYPHS[entry.kind].color}
                        subtitle={`${bsDayMonth(entry.on)} · ${entry.recordedByName}`}
                        title={entryTitle(entry)}
                        value={formatQty(line.qty, line.unit)}
                      />
                    </View>
                  );
                })}
              </Card>
            </View>
          ) : null}
        </View>
      ) : null}
    </Sheet>
  );
}

function Tile({ label, sub, value }: { label: string; sub?: string | null; value: string }) {
  return (
    <View className="flex-1 gap-0.5 rounded-2xl bg-muted px-3 py-2">
      <Text variant="caption">{label}</Text>
      <Text numberOfLines={1} variant="label">
        {value}
      </Text>
      {sub ? (
        <Text numberOfLines={1} variant="caption">
          {sub}
        </Text>
      ) : null}
    </View>
  );
}

/* ------------------------------------------------------------- one entry */

function EntrySheet({
  entry,
  onChanged,
  onClose,
}: {
  entry: StockEntry | null;
  onChanged: () => void;
  onClose: () => void;
}) {
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [seen, setSeen] = useState(entry);

  if (entry !== seen) {
    setSeen(entry);
    setCancelling(false);
    setReason("");
  }

  const confirm = async () => {
    if (!entry) return;

    if (reason.trim().length < 3) {
      toastError("Say why", "A few words, like “wrong amount”.");
      return;
    }

    setBusy(true);

    try {
      await cancelStockEntry(entry.id, reason.trim());
      toastSuccess("Cancelled", entry.kind === "BUY" && entry.amount ? "Its expense was cancelled too." : undefined);
      onClose();
      onChanged();
    } catch (error) {
      toastError("Could not cancel", readApiError(error));
    } finally {
      setBusy(false);
    }
  };

  const short = entry ? shortLines(entry) : [];

  return (
    <Sheet
      footer={
        entry?.canCancel ? (
          cancelling ? (
            <View className="flex-row gap-3">
              <View className="flex-1">
                <Button label="Back" onPress={() => setCancelling(false)} variant="outline" />
              </View>
              <View className="flex-1">
                <Button label="Cancel entry" loading={busy} onPress={() => void confirm()} variant="danger" />
              </View>
            </View>
          ) : (
            <Button label="Cancel this entry" onPress={() => setCancelling(true)} variant="outline" />
          )
        ) : undefined
      }
      onClose={onClose}
      open={entry !== null}
      title={entry ? entryTitle(entry) : ""}
    >
      {entry ? (
        <View className="gap-4 pb-2">
          <Card padding="px-4 py-1">
            {entry.lines.map((line, index) => (
              <View key={line.itemId}>
                {index > 0 ? <RowDivider inset /> : null}
                <ListRow
                  left={<StockGlyph item={{ kind: "STORE", name: line.name }} />}
                  subtitle={
                    line.receivedQty !== null && line.receivedQty !== line.qty
                      ? `${formatQty(line.receivedQty, line.unit)} came`
                      : undefined
                  }
                  title={line.name}
                  value={formatQty(line.qty, line.unit)}
                />
              </View>
            ))}
          </Card>

          <View className="gap-2">
            <FactRow label="Date" value={bsDayLong(entry.on)} />
            {entry.kind === "SEND" ? (
              <>
                <FactRow label="From" value={entry.hostelName} />
                <FactRow label="To" value={entry.toHostelName ?? ""} />
              </>
            ) : (
              <FactRow label={entry.kind === "BUY" ? "Came to" : "Counted at"} value={entry.hostelName} />
            )}
            {entry.amount ? <FactRow label="Bill" value={formatMoney(entry.amount)} /> : null}
            <FactRow label="Added by" value={entry.mine ? "You" : entry.recordedByName} />
            {entry.receivedByName ? <FactRow label="Got it" value={entry.receivedByName} /> : null}
            {short.length > 0 ? <FactRow label="Short" value={short.join(", ")} /> : null}
            {entry.note ? <FactRow label="Note" value={entry.note} /> : null}
            {entry.cancelReason ? <FactRow label="Why cancelled" value={entry.cancelReason} /> : null}
          </View>

          {cancelling ? (
            <Input
              autoFocus
              hint={entry.kind === "BUY" && entry.amount ? "Its expense is cancelled too." : undefined}
              label="Why cancel it?"
              onChangeText={setReason}
              placeholder="e.g. Wrong quantity"
              value={reason}
            />
          ) : null}
        </View>
      ) : null}
    </Sheet>
  );
}

/* ---------------------------------------------------------------- Got it */

function ReceiveSheet({
  entry,
  onClose,
  onDone,
}: {
  entry: StockEntry | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const { colors } = useAppTheme();
  const [got, setGot] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [seen, setSeen] = useState<StockEntry | null>(null);

  // Every line starts at what was sent; the warden changes only what fell short.
  if (entry !== seen) {
    setSeen(entry);
    setGot(Object.fromEntries((entry?.lines ?? []).map((line) => [line.itemId, String(line.qty)])));
  }

  const save = async () => {
    if (!entry) return;

    const lines = entry.lines.map((line) => ({ itemId: line.itemId, receivedQty: parseQtyInput(got[line.itemId] ?? "") }));

    if (lines.some((line) => line.receivedQty === null)) {
      toastError("Check the amounts", "Write how much came of each, 0 if nothing.");
      return;
    }

    setBusy(true);

    try {
      await receiveStock(
        entry.id,
        lines.map((line) => ({ itemId: line.itemId, receivedQty: line.receivedQty ?? 0 })),
      );
      toastSuccess("Got it", linesSummary(entry.lines));
      onClose();
      onDone();
    } catch (error) {
      toastError("Not saved", readApiError(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      footer={<Button label="Got it" loading={busy} onPress={() => void save()} />}
      onClose={onClose}
      open={entry !== null}
      title={entry ? `From ${entry.hostelName}` : ""}
    >
      {entry ? (
        <View className="gap-3 pb-2">
          <Text variant="muted">Change a number if less came.</Text>
          <Card padding="px-4 py-1">
            {entry.lines.map((line, index) => (
              <View key={line.itemId}>
                {index > 0 ? <RowDivider inset /> : null}
                <View className="min-h-14 flex-row items-center gap-3 py-2">
                  <StockGlyph item={{ kind: "STORE", name: line.name }} />
                  <View className="flex-1">
                    <Text variant="label">{line.name}</Text>
                    <Text variant="caption">Sent {formatQty(line.qty, line.unit)}</Text>
                  </View>
                  <TextInput
                    accessibilityLabel={`${line.name} that came`}
                    className="min-w-16 rounded-xl border border-border bg-background px-3 py-2 text-right text-base font-semibold text-foreground"
                    inputMode="decimal"
                    keyboardType="decimal-pad"
                    onChangeText={(value) => setGot((prev) => ({ ...prev, [line.itemId]: value }))}
                    placeholderTextColor={colors.mutedForeground}
                    selectTextOnFocus
                    value={got[line.itemId] ?? ""}
                  />
                </View>
              </View>
            ))}
          </Card>
        </View>
      ) : null}
    </Sheet>
  );
}
