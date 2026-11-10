import { router } from "expo-router";
import { View } from "react-native";

import { NotificationBell } from "@/components/notification-bell";
import { SYSTEM_TILES } from "@/components/platform-system";
import { FLOAT_SHADOW } from "@/components/portal-shared";
import { ActionTiles, type ActionTile } from "@/components/ui/action-grid";
import { AppBar } from "@/components/ui/app-bar";
import { Card, SectionHeader } from "@/components/ui/card";
import { CardRow } from "@/components/ui/list-row";
import { Screen } from "@/components/ui/screen";
import { Skeleton, SkeletonRows } from "@/components/ui/skeleton";
import { Text } from "@/components/ui/text";
import { type GlyphName } from "@hostel/constants/glyphs";
import { useAppSelector } from "@/hooks/redux";
import { useResource } from "@/hooks/use-resource";
import { getActiveUsers } from "@/lib/platform-api";
import { getPlatformDashboard, listFieldCash, listPlanClaims, listPlatformStoreOrders } from "@/lib/platform-admin-api";

/**
 * Platform Home — the platform at a glance on the card pulled up onto the
 * header, then only what is waiting on a decision (each row opens the queue that
 * clears it), then the doors.
 */

const STRADDLE = 34;

const openOrders = () => listPlatformStoreOrders("open");

const TILES: Omit<ActionTile, "onPress">[] = [
  { glyph: "H", icon: "hostel", key: "/(platform)/approvals", label: "Hostels", tone: "brand" },
  { glyph: "U", icon: "people", key: "/manage/platform/users", label: "Users", tone: "admin" },
  { glyph: "B", icon: "receipt", key: "/manage/platform/plan-billing", label: "Plan billing", tone: "success" },
  { glyph: "S", icon: "cart", key: "/manage/platform/store-orders", label: "Store orders", tone: "warning" },
  ...SYSTEM_TILES.filter((tile) => tile.label === "Active users" || tile.label === "Analytics").map((tile) => ({
    glyph: tile.glyph,
    icon: tile.icon,
    key: tile.href,
    label: tile.label,
    tone: tile.tone,
  })),
];

const tiles: ActionTile[] = TILES.map((tile) => ({ ...tile, onPress: () => router.push(tile.key as never) }));

export default function PlatformHomeScreen() {
  const account = useAppSelector((state) => state.auth.account);
  const dashboard = useResource(getPlatformDashboard, { cacheKey: "platform:dashboard" });
  const active = useResource(getActiveUsers, { cacheKey: "platform:active-users:today" });
  const claims = useResource(listPlanClaims, { cacheKey: "platform:plan-claims" });
  const cash = useResource(listFieldCash, { cacheKey: "platform:field-cash" });
  const orders = useResource(openOrders, { cacheKey: "platform:store-orders:open" });

  const refresh = () => [dashboard, active, claims, cash, orders].forEach((resource) => resource.refresh());
  const data = dashboard.data;

  const queue: { count: number; icon: GlyphName; href: string; subtitle: string; title: string; tone: "warning" | "brand" }[] = [
    { count: data?.pendingApprovals ?? 0, href: "/(platform)/approvals", icon: "hostel", subtitle: "Check KYC, then approve", title: "Hostels to review", tone: "warning" },
    { count: claims.data?.length ?? 0, href: "/(platform)/money", icon: "receipt", subtitle: "Plan payments by QR", title: "Payment proofs", tone: "warning" },
    { count: cash.data?.length ?? 0, href: "/(platform)/money", icon: "cash", subtitle: "Collected by the field team", title: "Field cash to confirm", tone: "brand" },
    { count: orders.data?.summary.open ?? 0, href: "/manage/platform/store-orders", icon: "cart", subtitle: "Confirm, pack, ship", title: "Store orders", tone: "brand" },
    { count: data?.openListingFlags ?? 0, href: "/manage/platform/listing-flags", icon: "flag", subtitle: "Duplicate or ghost listings", title: "Abuse flags", tone: "warning" },
  ];
  const waiting = queue.filter((row) => row.count > 0);
  const loadingQueue = dashboard.loading || claims.loading || cash.loading || orders.loading;

  const header = (
    <View className="bg-background">
      <AppBar accent actions={<NotificationBell tone="onAccent" />} large straddle={STRADDLE} subtitle={account?.name ?? undefined} title="Platform" />
      <View className="px-5" style={{ marginTop: -STRADDLE }}>
        <View className="flex-row gap-3 rounded-2xl border border-border bg-card p-4" style={FLOAT_SHADOW}>
          {[
            { label: "Hostels", loading: dashboard.loading, value: data?.totalHostels },
            { label: "Residents", loading: dashboard.loading, value: data?.activeResidents },
            { label: "Active today", loading: active.loading, value: active.data?.dau },
          ].map((cell) => (
            <View className="flex-1 gap-1" key={cell.label}>
              {cell.loading ? <Skeleton className="h-7 w-12" /> : <Text variant="title">{cell.value ?? "—"}</Text>}
              <Text className="text-xs" variant="muted">
                {cell.label}
              </Text>
            </View>
          ))}
        </View>
      </View>
    </View>
  );

  return (
    <Screen header={header} insideTabs onRefresh={refresh} refreshing={dashboard.refreshing} scroll>
      <View className="gap-5 pt-4">
        <View>
          <SectionHeader title="Waiting on you" />
          {loadingQueue ? (
            <SkeletonRows rows={2} />
          ) : waiting.length === 0 ? (
            <Card>
              <Text variant="muted">{dashboard.error ?? "Nothing is waiting. All clear."}</Text>
            </Card>
          ) : (
            <View className="gap-3">
              {waiting.map((row) => (
                <CardRow
                  icon={row.icon}
                  key={row.title}
                  onPress={() => router.push(row.href as never)}
                  subtitle={row.subtitle}
                  title={row.title}
                  tone={row.tone}
                  value={String(row.count)}
                />
              ))}
            </View>
          )}
        </View>

        <ActionTiles tiles={tiles} />
      </View>
    </Screen>
  );
}
