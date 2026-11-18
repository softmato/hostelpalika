import { router } from "expo-router";
import { View } from "react-native";

import { NotificationBell } from "@/components/notification-bell";
import { Figures, Quiet, Rows, Section, type Tint, TintRow } from "@/components/platform-ui";
import { FLOAT_SHADOW } from "@/components/portal-shared";
import { ActionTiles, type ActionTile } from "@/components/ui/action-grid";
import { AppBar } from "@/components/ui/app-bar";
import { Screen } from "@/components/ui/screen";
import { SkeletonRows } from "@/components/ui/skeleton";
import { type GlyphName } from "@hostel/constants/glyphs";
import { useAppSelector } from "@/hooks/redux";
import { useResource } from "@/hooks/use-resource";
import { getActiveUsers } from "@/lib/platform-api";
import {
  getPlatformDashboard,
  listAccountDeletions,
  listBookingPayments,
  listBookingTransfers,
  listFeedback,
  listFieldCash,
  listHostelLeaves,
  listPlanClaims,
  listPlatformStoreOrders,
  listProviders,
} from "@/lib/platform-admin-api";

/**
 * Platform Home — the owner's inbox. Three figures on the green header, then
 * every queue that is waiting on a decision (each row opens the screen that
 * clears it; an empty queue is not drawn), then the doors used most. Owner,
 * 2026-11-17: clean, not boxy — rows sit on the page, not in cards.
 */

const STRADDLE = 34;

const openOrders = () => listPlatformStoreOrders("open");
const pendingDeletions = () => listAccountDeletions("PENDING");
const pendingLeaves = () => listHostelLeaves("PENDING");
const pendingProviders = () => listProviders("PENDING_APPROVAL");
const newFeedback = () => listFeedback("NEW");

const TILES: Omit<ActionTile, "onPress">[] = [
  { glyph: "H", icon: "hostel", key: "/(platform)/approvals", label: "Hostels", tone: "brand" },
  { glyph: "U", icon: "people", key: "/manage/platform/users", label: "Users", tone: "admin" },
  { glyph: "B", icon: "bed", key: "/manage/platform/bookings", label: "Bookings", tone: "success" },
  { glyph: "T", icon: "briefcase", key: "/manage/platform/team", label: "Field team", tone: "warning" },
  { glyph: "P", icon: "receipt", key: "/manage/platform/plan-billing", label: "Billing", tone: "success" },
  { glyph: "F", icon: "chatbubbles", key: "/manage/platform/feedback", label: "Feedback", tone: "brand" },
  { glyph: "N", icon: "megaphone", key: "/manage/platform/push", label: "Push", tone: "admin" },
  { glyph: "A", icon: "stats-chart", key: "/manage/system/analytics", label: "Analytics", tone: "warning" },
];

const tiles: ActionTile[] = TILES.map((tile) => ({ ...tile, onPress: () => router.push(tile.key as never) }));

type Queue = { count: number; href: string; icon: GlyphName; subtitle: string; title: string; tone: Tint };

export default function PlatformHomeScreen() {
  const account = useAppSelector((state) => state.auth.account);
  const dashboard = useResource(getPlatformDashboard, { cacheKey: "platform:dashboard" });
  const active = useResource(getActiveUsers, { cacheKey: "platform:active-users:today" });
  const claims = useResource(listPlanClaims, { cacheKey: "platform:plan-claims" });
  const cash = useResource(listFieldCash, { cacheKey: "platform:field-cash" });
  const orders = useResource(openOrders, { cacheKey: "platform:store-orders:open" });
  const bookingPayments = useResource(listBookingPayments, { cacheKey: "platform:bookings:payments" });
  const transfers = useResource(listBookingTransfers, { cacheKey: "platform:bookings:transfers" });
  const deletions = useResource(pendingDeletions, { cacheKey: "platform:account-deletions:PENDING" });
  const leaves = useResource(pendingLeaves, { cacheKey: "platform:hostel-leaves:PENDING" });
  const providers = useResource(pendingProviders, { cacheKey: "platform:providers:PENDING_APPROVAL" });
  const feedback = useResource(newFeedback, { cacheKey: "platform:feedback:NEW" });

  const all = [dashboard, active, claims, cash, orders, bookingPayments, transfers, deletions, leaves, providers, feedback];
  const refresh = () => all.forEach((resource) => resource.refresh());
  const data = dashboard.data;

  const queue: Queue[] = [
    { count: data?.pendingApprovals ?? 0, href: "/(platform)/approvals", icon: "hostel", subtitle: "Check KYC, then approve", title: "Hostels to review", tone: "warning" },
    { count: bookingPayments.data?.length ?? 0, href: "/manage/platform/bookings", icon: "bed", subtitle: "Booking screenshots, 24 h promise", title: "Booking payments", tone: "warning" },
    { count: transfers.data?.length ?? 0, href: "/manage/platform/bookings", icon: "send", subtitle: "Refunds and hostel payouts", title: "Money to send", tone: "warning" },
    { count: claims.data?.length ?? 0, href: "/(platform)/money", icon: "receipt", subtitle: "Plan payments by QR", title: "Plan payment proofs", tone: "warning" },
    { count: cash.data?.length ?? 0, href: "/(platform)/money", icon: "cash", subtitle: "Collected by the field team", title: "Field cash", tone: "brand" },
    { count: orders.data?.summary.open ?? 0, href: "/manage/platform/store-orders", icon: "cart", subtitle: "Confirm, pack, ship", title: "Store orders", tone: "brand" },
    { count: leaves.data?.length ?? 0, href: "/manage/platform/hostel-leaves", icon: "log-out", subtitle: "Owners asking to leave", title: "Hostel leaves", tone: "danger" },
    { count: deletions.data?.pendingCount ?? 0, href: "/manage/platform/account-deletions", icon: "person-remove", subtitle: "Close and erase in 60 days", title: "Account deletions", tone: "danger" },
    { count: providers.data?.length ?? 0, href: "/manage/platform/providers", icon: "build", subtitle: "Applications to list", title: "Service providers", tone: "brand" },
    { count: data?.openListingFlags ?? 0, href: "/manage/platform/listing-flags", icon: "flag", subtitle: "Duplicate or ghost listings", title: "Abuse flags", tone: "warning" },
    { count: feedback.data?.counts.NEW ?? 0, href: "/manage/platform/feedback", icon: "chatbubbles", subtitle: "Bugs and ideas from users", title: "New feedback", tone: "brand" },
  ];
  const waiting = queue.filter((row) => row.count > 0);
  const loadingQueue = dashboard.loading || claims.loading || bookingPayments.loading;

  const header = (
    <View className="bg-background">
      <AppBar accent actions={<NotificationBell tone="onAccent" />} large straddle={STRADDLE} subtitle={account?.name ?? undefined} title="Platform" />
      <View className="px-5" style={{ marginTop: -STRADDLE }}>
        <View className="rounded-2xl bg-card px-4 py-3" style={FLOAT_SHADOW}>
          <Figures
            items={[
              { label: "Hostels", loading: dashboard.loading, value: data?.totalHostels },
              { label: "Residents", loading: dashboard.loading, value: data?.activeResidents },
              { label: "Active today", loading: active.loading, tone: "brand", value: active.data?.dau },
            ]}
          />
        </View>
      </View>
    </View>
  );

  return (
    <Screen header={header} insideTabs onRefresh={refresh} refreshing={dashboard.refreshing} scroll>
      <View className="gap-7 pt-5">
        <Section count={waiting.reduce((sum, row) => sum + row.count, 0)} title="Waiting on you">
          {loadingQueue ? (
            <SkeletonRows rows={3} />
          ) : waiting.length === 0 ? (
            <Quiet>{dashboard.error ?? "Nothing is waiting. All clear."}</Quiet>
          ) : (
            <Rows>
              {waiting.map((row) => (
                <TintRow
                  count={row.count}
                  icon={row.icon}
                  key={row.title}
                  onPress={() => router.push(row.href as never)}
                  subtitle={row.subtitle}
                  title={row.title}
                  tone={row.tone}
                />
              ))}
            </Rows>
          )}
        </Section>

        <Section title="Go to">
          <View className="pt-3">
            <ActionTiles bare tiles={tiles} />
          </View>
        </Section>
      </View>
    </Screen>
  );
}
