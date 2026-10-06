import { Ionicons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import { useMemo, useState } from "react";
import { Pressable, View } from "react-native";

import { HostelSwitcher } from "@/components/hostel-switcher";
import { NotificationBell } from "@/components/notification-bell";
import {
  ActionTile,
  EntryRow,
  ItemAvatar,
  ItemSheet,
  NoStockAccess,
  Pill,
  StatCard,
  UnderlineTabs,
  useStock,
} from "@/components/stock/stock-parts";
import { AppBar } from "@/components/ui/app-bar";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Chip } from "@/components/ui/layout";
import { RowDivider } from "@/components/ui/list-row";
import { Screen } from "@/components/ui/screen";
import { SkeletonRows } from "@/components/ui/skeleton";
import { EmptyCard, ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { bsDayLong, bsDayMonth } from "@/lib/expenses";
import { formatMoney } from "@/lib/format";
import { formatQty, namesSummary, type StockHome, type StockItem } from "@/lib/stock-api";

/**
 * Stock — home (docs/INVENTORY_PLAN.md).
 *
 * Three tabs. **Overview** answers "what must I do now" (goods waiting for Got
 * it, items running low) and "what happened" (recent activity), with the four
 * jobs one tap away. **Store Items** and **Daily Items** are the shelves.
 *
 * Every write belongs to the building chosen in the switcher; Overall shows
 * every building at once and offers no jobs.
 */

type Tab = "daily" | "overview" | "store";

const TABS = [
  { label: "Overview", value: "overview" as const },
  { label: "Store Items", value: "store" as const },
  { label: "Daily Items", value: "daily" as const },
];

function placeName(home: StockHome, id: string) {
  return home.places.find((place) => place.id === id)?.name ?? "Hostel";
}

export default function StockScreen() {
  const { colors } = useAppTheme();
  const params = useLocalSearchParams<{ tab?: string }>();
  const { denied, here, home, mine, overall, resource } = useStock();
  const [tab, setTab] = useState<Tab>(params.tab === "store" || params.tab === "daily" ? params.tab : "overview");
  const [lowOnly, setLowOnly] = useState(false);
  const [newItem, setNewItem] = useState(false);

  const items = useMemo(() => (home?.items ?? []).filter((item) => item.active), [home]);
  const lowCount = items.filter((item) => item.at.some((at) => at.low)).length;
  const onTheWay = new Set([...(home?.waiting ?? []), ...(home?.sentWaiting ?? [])].map((entry) => entry.id)).size;
  const lastCount = items
    .flatMap((item) => item.at.map((at) => at.countedAt))
    .filter((at): at is string => Boolean(at))
    .sort()
    .at(-1);
  const boughtFor = (home?.entries ?? [])
    .filter((entry) => entry.kind === "BUY" && entry.status !== "CANCELLED")
    .reduce((sum, entry) => sum + (entry.amount ?? 0), 0);
  const canSend = (home?.places.length ?? 0) > 1;

  const header = (
    <View className="bg-background">
      <AppBar
        actions={
          <View className="flex-row items-center gap-1">
            <HostelSwitcher compact />
            <NotificationBell />
          </View>
        }
        large
        showBack
        subtitle={overall ? "Every building · view only" : here?.name}
        title="Stock"
      />
      <UnderlineTabs onChange={setTab} tabs={TABS} value={tab} />
    </View>
  );

  if (denied) {
    return (
      <Screen header={<AppBar large showBack title="Stock" />}>
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

  const footer =
    home && !overall && tab !== "overview" ? (
      <Button
        label={tab === "daily" ? "+ Buy Daily Items" : "+ Buy Goods"}
        onPress={() => router.push({ params: tab === "daily" ? { daily: "1" } : {}, pathname: "/stock/buy" })}
        size="lg"
      />
    ) : undefined;

  return (
    <>
      <Screen footer={footer} header={header} onRefresh={resource.refresh} refreshing={resource.refreshing} scroll>
        {!home ? (
          <View className="pt-4">
            <SkeletonRows rows={6} />
          </View>
        ) : tab === "overview" ? (
          <View className="gap-6 pb-4 pt-4">
            {/* --------------------------------------------- waiting for me */}
            {!overall && home.waiting.length > 0 ? (
              <View className="gap-3 rounded-2xl border border-warning bg-warning-soft p-4">
                <View className="flex-row items-center gap-2">
                  <Ionicons color={colors.warning} name="time-outline" size={20} />
                  <Text variant="label">
                    {home.waiting.length === 1 ? "1 send is coming to you" : `${home.waiting.length} sends are coming to you`}
                  </Text>
                </View>
                {home.waiting.slice(0, 3).map((entry) => (
                  <View className="flex-row items-center gap-3" key={entry.id}>
                    <View className="flex-1">
                      <Text variant="label">From {entry.hostelName}</Text>
                      <Text numberOfLines={1} variant="caption">
                        {namesSummary(entry.lines)} · {bsDayMonth(entry.on)}
                      </Text>
                    </View>
                    <Button
                      label="Got it"
                      onPress={() => router.push({ params: { id: entry.id }, pathname: "/stock/receive/[id]" })}
                      size="sm"
                    />
                  </View>
                ))}
              </View>
            ) : null}

            {/* ------------------------------------------------ first time */}
            {items.length === 0 && !overall ? (
              <EmptyCard
                action={<Button label="Add your items" onPress={() => setNewItem(true)} size="sm" />}
                description="Rice, daal, oil, vegetables… Add what you buy. It takes a few seconds each."
                title="No items yet"
              />
            ) : null}

            {/* --------------------------------------------------- figures */}
            <View className="gap-3">
              <View className="flex-row gap-3">
                <StatCard
                  color="#FF3B30"
                  icon="alert-circle-outline"
                  label="Low in stock"
                  onPress={() => {
                    setLowOnly(true);
                    setTab("store");
                  }}
                  value={lowCount === 1 ? "1 item" : `${lowCount} items`}
                />
                <StatCard
                  color="#007AFF"
                  icon="arrow-redo-outline"
                  label="On the way"
                  onPress={() => router.push({ params: { filter: "SEND" }, pathname: "/stock/history" })}
                  value={onTheWay === 1 ? "1 send" : `${onTheWay} sends`}
                />
              </View>
              <View className="flex-row gap-3">
                <StatCard
                  color="#34C759"
                  icon="clipboard-outline"
                  label="Last count"
                  onPress={overall ? undefined : () => router.push("/stock/count")}
                  value={lastCount ? bsDayLong(lastCount.slice(0, 10)) : "Not yet"}
                />
                <StatCard
                  color="#0a8a4b"
                  icon="wallet-outline"
                  label="Bought this month"
                  onPress={() => router.push({ params: { filter: "BOUGHT" }, pathname: "/stock/history" })}
                  value={formatMoney(boughtFor)}
                />
              </View>
            </View>

            {/* --------------------------------------------- quick actions */}
            {overall ? (
              <Card className="flex-row items-center gap-3">
                <Ionicons color={colors.mutedForeground} name="eye-outline" size={20} />
                <Text className="flex-1" variant="muted">
                  Overall is view only. Switch to a building to buy, send or count.
                </Text>
              </Card>
            ) : (
              <View className="gap-3">
                <Text variant="subtitle">Quick Actions</Text>
                <View className="flex-row gap-3">
                  <ActionTile icon="cart-outline" label="Buy Goods" onPress={() => router.push("/stock/buy")} />
                  <ActionTile
                    caption={canSend ? undefined : "No other building"}
                    disabled={!canSend}
                    icon="arrow-redo-outline"
                    label="Send to Building"
                    onPress={() => router.push("/stock/send")}
                  />
                </View>
                <View className="flex-row gap-3">
                  <ActionTile icon="clipboard-outline" label="Count Stock" onPress={() => router.push("/stock/count")} />
                  <ActionTile icon="time-outline" label="Recent Activity" onPress={() => router.push("/stock/history")} />
                </View>
              </View>
            )}

            {/* ------------------------------------------- recent activity */}
            <View className="gap-2">
              <View className="flex-row items-center justify-between">
                <Text variant="subtitle">Recent Activity</Text>
                <Pressable accessibilityRole="link" hitSlop={8} onPress={() => router.push("/stock/history")}>
                  <Text className="font-semibold text-primary" variant="label">
                    View all
                  </Text>
                </Pressable>
              </View>
              {home.entries.length === 0 ? (
                <Text variant="muted">Nothing yet this month.</Text>
              ) : (
                <Card padding="px-4 py-0">
                  {home.entries.slice(0, 5).map((entry, index) => (
                    <View key={entry.id}>
                      {index > 0 ? <RowDivider inset /> : null}
                      <EntryRow
                        entry={entry}
                        mine={mine}
                        onPress={() => router.push({ params: { id: entry.id }, pathname: "/stock/entry/[id]" })}
                      />
                    </View>
                  ))}
                </Card>
              )}
            </View>
          </View>
        ) : (
          <Shelf
            home={home}
            items={items.filter((item) => item.kind === (tab === "store" ? "STORE" : "DAILY"))}
            kind={tab === "store" ? "STORE" : "DAILY"}
            lowOnly={lowOnly}
            onAddItem={overall ? undefined : () => setNewItem(true)}
            setLowOnly={setLowOnly}
          />
        )}
      </Screen>

      {home ? (
        <ItemSheet
          defaultKind={tab === "daily" ? "DAILY" : "STORE"}
          existing={home.items.map((item) => item.name)}
          onClose={() => setNewItem(false)}
          onSaved={() => {
            setNewItem(false);
            resource.refresh();
          }}
          open={newItem}
        />
      ) : null}
    </>
  );
}

/* ------------------------------------------------------------- shelves */

function Shelf({
  home,
  items,
  kind,
  lowOnly,
  onAddItem,
  setLowOnly,
}: {
  home: StockHome;
  items: StockItem[];
  kind: "DAILY" | "STORE";
  lowOnly: boolean;
  onAddItem?: () => void;
  setLowOnly: (value: boolean) => void;
}) {
  const { colors } = useAppTheme();
  const [query, setQuery] = useState("");
  const [thisMonth, setThisMonth] = useState(false);
  const store = kind === "STORE";
  const low = items.filter((item) => item.at.some((at) => at.low));

  const shown = items
    .filter((item) => item.name.toLowerCase().includes(query.trim().toLowerCase()))
    .filter((item) => (store ? !lowOnly || item.at.some((at) => at.low) : !thisMonth || item.at.some((at) => at.in > 0)));

  return (
    <View className="gap-4 pb-4 pt-4">
      <View className="gap-1">
        <Text variant="title">{store ? "Store Items" : "Daily Items"}</Text>
        <Text variant="muted">{store ? "Long-use items you keep in store" : "Bought often, used the same day"}</Text>
      </View>

      <Input
        leading={<Ionicons color={colors.mutedForeground} name="search" size={18} />}
        onChangeText={setQuery}
        placeholder="Search items…"
        value={query}
      />

      <View className="flex-row gap-2">
        {store ? (
          <>
            <Chip label="All" onPress={() => setLowOnly(false)} tone={lowOnly ? "neutral" : "brand"} />
            <Chip label={`Low stock · ${low.length}`} onPress={() => setLowOnly(true)} tone={lowOnly ? "brand" : "neutral"} />
          </>
        ) : (
          <>
            <Chip label="All" onPress={() => setThisMonth(false)} tone={thisMonth ? "neutral" : "brand"} />
            <Chip label="This month" onPress={() => setThisMonth(true)} tone={thisMonth ? "brand" : "neutral"} />
          </>
        )}
      </View>

      {shown.length === 0 ? (
        <EmptyCard
          action={onAddItem && items.length === 0 ? <Button label="Add an item" onPress={onAddItem} size="sm" /> : undefined}
          description={items.length === 0 ? "Add the first one to start." : "Nothing matches."}
          title={items.length === 0 ? `No ${store ? "store" : "daily"} items yet` : "No items here"}
        />
      ) : (
        <Card padding="px-4 py-0">
          {shown.map((item, index) => (
            <View key={item.id}>
              {index > 0 ? <RowDivider inset /> : null}
              <ShelfRow home={home} item={item} />
            </View>
          ))}
        </Card>
      )}
    </View>
  );
}

/**
 * One item on a shelf: picture, name, the number that matters (Left for store,
 * came in this month for daily) and the line under it — when it was counted,
 * or each building's share in Overall.
 */
function ShelfRow({ home, item }: { home: StockHome; item: StockItem }) {
  const { colors } = useAppTheme();
  const store = item.kind === "STORE";
  const many = item.at.length > 1;
  const total = item.at.reduce((sum, at) => sum + (store ? at.left : at.in), 0);
  const isLow = item.at.some((at) => at.low);
  const one = item.at[0];

  const detail = many
    ? item.at.map((at) => `${placeName(home, at.hostelId)} ${formatQty(store ? at.left : at.in, item.unit)}`).join(" · ")
    : !store
      ? "came in this month"
      : one && one.onWay > 0
        ? `+${formatQty(one.onWay, item.unit)} on the way`
        : one?.countedAt
          ? `Counted ${bsDayMonth(one.countedAt.slice(0, 10))}`
          : "Not counted yet";

  return (
    <Pressable
      accessibilityRole="button"
      className="min-h-16 flex-row items-center gap-3 py-3 active:opacity-70"
      onPress={() => router.push({ params: { id: item.id }, pathname: "/stock/item/[id]" })}
    >
      <ItemAvatar item={item} />
      <View className="flex-1">
        <Text numberOfLines={1} variant="label">
          {item.name}
        </Text>
        <Text className={isLow ? "font-semibold text-destructive" : "text-foreground"} variant="muted">
          {formatQty(total, item.unit)}
        </Text>
        <Text numberOfLines={1} variant="caption">
          {detail}
        </Text>
      </View>
      {isLow ? <Pill color="#FF3B30" label="Low" /> : null}
      <Ionicons color={colors.mutedForeground} name="chevron-forward" size={18} />
    </Pressable>
  );
}
