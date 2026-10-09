import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { type ReactNode, useMemo, useState } from "react";
import { Pressable, View } from "react-native";

import { HostelSwitcher } from "@/components/hostel-switcher";
import { FLOAT_SHADOW } from "@/components/portal-shared";
import { categoryLabel, ItemAvatar, NoStockAccess, Pill, useStock } from "@/components/stock/stock-parts";
import { type ActionTile, ActionTiles } from "@/components/ui/action-grid";
import { AppBar } from "@/components/ui/app-bar";
import { Button } from "@/components/ui/button";
import { Card, SectionHeader } from "@/components/ui/card";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { RowDivider } from "@/components/ui/list-row";
import { Money } from "@/components/ui/money";
import { Screen } from "@/components/ui/screen";
import { Skeleton, SkeletonRows } from "@/components/ui/skeleton";
import { EmptyCard, ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { formatMoney } from "@/lib/format";
import { countGap, formatQty, namesSummary, type StockHome, type StockItem } from "@/lib/stock-api";

/**
 * Stock — home (docs/INVENTORY_PLAN.md).
 *
 * Three bands, top to bottom, and nothing else:
 *
 * 1. **The number** on a card straddling the green header: what the store is
 *    worth (for someone who sees money), how many items, how many low.
 * 2. **The jobs** as one grid of tiles — Use first, because it is the one done
 *    every day. A tile with something waiting carries its count.
 * 3. **What needs a tap** (goods arriving, counts to approve), then **running
 *    low**, then **everything in store**, grouped by what it is.
 *
 * Every write belongs to the building chosen in the switcher; Overall shows
 * every building at once and only reads.
 */

const STRADDLE = 34;
const SEARCH_FROM = 8;

export default function StockScreen() {
  const { colors } = useAppTheme();
  const { denied, here, home, overall, resource } = useStock();
  const [query, setQuery] = useState("");

  const items = useMemo(
    () => (home?.items ?? []).filter((item) => item.active).sort((left, right) => left.name.localeCompare(right.name)),
    [home],
  );
  const low = items.filter(isLow);
  const typed = query.trim().toLowerCase();
  const shown = typed ? items.filter((item) => item.name.toLowerCase().includes(typed)) : items;
  const groups = useMemo(() => {
    const byCategory = new Map<string, StockItem[]>();

    for (const item of shown) byCategory.set(item.category, [...(byCategory.get(item.category) ?? []), item]);

    return [...byCategory].sort((a, b) => categoryLabel(a[0]).localeCompare(categoryLabel(b[0])));
  }, [shown]);

  const header = (
    <View className="bg-background">
      <AppBar
        accent
        actions={
          <View className="flex-row items-center gap-2">
            <HostelSwitcher compact />
            <IconButton label="History" name="time-outline" onPress={() => router.push("/stock/history")} size="sm" />
          </View>
        }
        showBack
        straddle={denied ? 0 : STRADDLE}
        subtitle={overall ? "All buildings" : here?.name}
        title="Stock"
      />
      {denied ? null : (
        <View className="px-5" style={{ marginTop: -STRADDLE }}>
          <View className="rounded-2xl border border-border bg-card p-4" style={FLOAT_SHADOW}>
            {!home ? (
              <View className="flex-row gap-3">
                <Skeleton height={40} width="30%" />
                <Skeleton height={40} width="30%" />
                <Skeleton height={40} width="30%" />
              </View>
            ) : (
              <View className="flex-row">
                {home.money ? (
                  <>
                    <Figure label="Stock value">
                      <Money value={home.summary.stockValue ?? 0} />
                    </Figure>
                    <View className="w-px bg-border" />
                  </>
                ) : null}
                <Figure label="Items">
                  <Text variant="subtitle">{items.length}</Text>
                </Figure>
                <View className="w-px bg-border" />
                <Figure label="Running low">
                  <Text className={low.length > 0 ? "text-destructive" : undefined} variant="subtitle">
                    {low.length}
                  </Text>
                </Figure>
              </View>
            )}
          </View>
        </View>
      )}
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
    <Screen header={header} onRefresh={resource.refresh} refreshing={resource.refreshing} scroll>
      {!home ? (
        <View className="gap-4 pt-5">
          <Skeleton height={180} width="100%" />
          <SkeletonRows rows={5} />
        </View>
      ) : (
        <View className="gap-6 pb-8 pt-5">
          <ActionTiles tiles={tilesFor(home, overall, colors)} />

          <Waiting home={home} overall={overall} />

          {low.length > 0 ? (
            <View>
              <SectionHeader
                action={<Pill color={colors.destructive} label={`${low.length} low`} />}
                subtitle="Buy these soon"
                title="Running low"
              />
              <Card padding="px-4 py-0">
                {low.map((item, index) => (
                  <View key={item.id}>
                    {index > 0 ? <RowDivider inset /> : null}
                    <StockRow home={home} item={item} />
                  </View>
                ))}
              </Card>
            </View>
          ) : null}

          {items.length === 0 ? (
            <EmptyCard
              description={
                overall
                  ? "Nothing in any building yet."
                  : home.owner
                    ? "Tap Buy when goods come, or Opening to enter what is already on the shelf."
                    : "Tap Buy when goods come."
              }
              title="No stock yet"
            />
          ) : (
            <View className="gap-4">
              {items.length >= SEARCH_FROM ? (
                <Input
                  leading={<Ionicons color={colors.mutedForeground} name="search" size={18} />}
                  onChangeText={setQuery}
                  placeholder="Search items"
                  value={query}
                />
              ) : null}
              {groups.length === 0 ? (
                <Text className="px-1" variant="muted">
                  Nothing called that.
                </Text>
              ) : (
                groups.map(([category, rows]) => (
                  <View key={category}>
                    <GroupHeading
                      label={categoryLabel(category)}
                      value={
                        home.money
                          ? formatMoney(rows.reduce((sum, item) => sum + (item.value ?? 0), 0))
                          : `${rows.length} item${rows.length === 1 ? "" : "s"}`
                      }
                    />
                    <Card padding="px-4 py-0">
                      {rows.map((item, index) => (
                        <View key={item.id}>
                          {index > 0 ? <RowDivider inset /> : null}
                          <StockRow home={home} item={item} />
                        </View>
                      ))}
                    </Card>
                  </View>
                ))
              )}
            </View>
          )}
        </View>
      )}
    </Screen>
  );
}

function isLow(item: StockItem) {
  return item.at.some((at) => at.low);
}

function Figure({ children, label }: { children: ReactNode; label: string }) {
  return (
    <View className="flex-1 items-center gap-1 px-1">
      <Text variant="caption">{label}</Text>
      {children}
    </View>
  );
}

/** A group's name outside its card, small capitals, with its total on the right. */
function GroupHeading({ label, value }: { label: string; value: string }) {
  return (
    <View className="mb-2 flex-row items-center justify-between px-1">
      <Text className="font-semibold uppercase tracking-wider text-muted-foreground" style={{ fontSize: 11 }}>
        {label}
      </Text>
      <Text className="text-muted-foreground" style={{ fontSize: 12 }}>
        {value}
      </Text>
    </View>
  );
}

/**
 * The jobs, in the order they are done: Use every day, Buy when goods come,
 * Waste when something spoils, Count at month end. Then the doors: Send,
 * Suppliers, Reports, Opening stock. Overall only reads, so only the doors.
 */
function tilesFor(
  home: StockHome,
  overall: boolean,
  colors: { destructive: string; primary: string; success: string; warning: string },
): ActionTile[] {
  const go = (pathname: Parameters<typeof router.push>[0]) => () => router.push(pathname);
  const tiles: ActionTile[] = [];

  if (!overall) {
    tiles.push(
      { glyph: colors.primary, icon: "restaurant-outline", key: "use", label: "Use", onPress: go("/stock/use"), tone: "brand" },
      { glyph: colors.success, icon: "cart-outline", key: "buy", label: "Buy", onPress: go("/stock/buy"), tone: "success" },
      {
        glyph: colors.destructive,
        icon: "trash-outline",
        key: "waste",
        label: "Waste",
        onPress: go({ params: { mode: "waste" }, pathname: "/stock/use" }),
        tone: "danger",
      },
      {
        badge: home.canApprove && home.toApprove.length > 0 ? home.toApprove.length : undefined,
        glyph: colors.warning,
        icon: "clipboard-outline",
        key: "count",
        label: "Count",
        onPress: go("/stock/count"),
        tone: "warning",
      },
    );

    if (home.places.length > 1) {
      tiles.push({
        badge: home.waiting.length > 0 ? home.waiting.length : undefined,
        glyph: colors.primary,
        icon: "arrow-redo-outline",
        key: "send",
        label: "Send",
        onPress: go("/stock/send"),
        tone: "brand",
      });
    }
  }

  tiles.push({
    glyph: colors.success,
    icon: "storefront-outline",
    key: "suppliers",
    label: "Suppliers",
    onPress: go("/stock/suppliers"),
    tone: "success",
  });

  if (home.money) {
    tiles.push({
      glyph: colors.primary,
      icon: "bar-chart-outline",
      key: "reports",
      label: "Reports",
      onPress: go("/stock/reports"),
      tone: "brand",
    });
  }

  if (home.owner && !overall) {
    tiles.push({
      glyph: colors.warning,
      icon: "archive-outline",
      key: "opening",
      label: "Opening",
      onPress: go({ params: { mode: "opening" }, pathname: "/stock/buy" }),
      tone: "warning",
    });
  }

  return tiles;
}

/** Goods coming in and counts to approve: the two things another person is waiting on. */
function Waiting({ home, overall }: { home: StockHome; overall: boolean }) {
  const { colors } = useAppTheme();

  if (overall || (home.waiting.length === 0 && home.toApprove.length === 0)) return null;

  return (
    <View>
      <SectionHeader title="Waiting for you" />
      <View className="gap-3 rounded-2xl border border-warning bg-warning-soft p-4">
        {home.waiting.map((entry) => (
          <WaitRow
            action="Got it"
            detail={namesSummary(entry.lines)}
            icon="cube-outline"
            iconColor={colors.warning}
            key={entry.id}
            onPress={() => router.push({ params: { id: entry.id }, pathname: "/stock/receive/[id]" })}
            title={`From ${entry.hostelName}`}
          />
        ))}
        {home.toApprove.map((entry) => {
          const off = entry.lines.filter((line) => line.systemQty !== null && line.qty !== line.systemQty);

          return (
            <WaitRow
              action="Check"
              detail={off.length === 1 ? countGap(off[0]!) : `${off.length} items different`}
              icon="clipboard-outline"
              iconColor={colors.warning}
              key={entry.id}
              onPress={() => router.push({ params: { id: entry.id }, pathname: "/stock/entry/[id]" })}
              title={`Count by ${entry.recordedByName}`}
            />
          );
        })}
      </View>
    </View>
  );
}

function WaitRow({
  action,
  detail,
  icon,
  iconColor,
  onPress,
  title,
}: {
  action: string;
  detail: string;
  icon: keyof typeof Ionicons.glyphMap;
  iconColor: string;
  onPress: () => void;
  title: string;
}) {
  return (
    <View className="flex-row items-center gap-3">
      <Ionicons color={iconColor} name={icon} size={24} />
      <View className="flex-1">
        <Text variant="label">{title}</Text>
        <Text numberOfLines={1} variant="caption">
          {detail}
        </Text>
      </View>
      <Button label={action} onPress={onPress} size="sm" />
    </View>
  );
}

/**
 * One item: picture, name, and how much — what is left for store goods, what
 * came this month for daily ones. A second line only when it says something:
 * low, more on the way, its value, or each building's share in Overall.
 */
function StockRow({ home, item }: { home: StockHome; item: StockItem }) {
  const { colors } = useAppTheme();
  const store = item.kind === "STORE";
  const amount = (at: StockItem["at"][number]) => (store ? at.left : at.in);
  const total = item.at.reduce((sum, at) => sum + amount(at), 0);
  const onWay = item.at.reduce((sum, at) => sum + at.onWay, 0);
  const low = isLow(item);

  const line =
    item.at.length > 1
      ? item.at
          .map((at) => `${home.places.find((place) => place.id === at.hostelId)?.name ?? "Hostel"} ${formatQty(amount(at), item.unit)}`)
          .join(" · ")
      : low
        ? `Low · below ${formatQty(item.lowAt ?? 0, item.unit)}`
        : onWay > 0
          ? `+${formatQty(onWay, item.unit)} coming`
          : !store
            ? "Daily · came this month"
            : home.money && item.value
              ? formatMoney(item.value)
              : item.location || null;

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
        {line ? (
          <Text className={low ? "font-semibold text-destructive" : undefined} numberOfLines={1} variant="caption">
            {line}
          </Text>
        ) : null}
      </View>
      <Text className={low ? "text-destructive" : undefined} variant="subtitle">
        {formatQty(total, item.unit)}
      </Text>
      <Ionicons color={colors.mutedForeground} name="chevron-forward" size={18} />
    </Pressable>
  );
}
