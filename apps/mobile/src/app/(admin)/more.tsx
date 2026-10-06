import { OverallTabScreen } from "@/components/overall-views";
import { useBranchesLock, useIsOverall } from "@/components/hostel-switcher";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useState } from "react";

import { AppRows, MenuGroup, MenuGroups, MenuProfile, MenuRow, MenuSearch, type MenuTone, SignOutRow } from "@/components/more-menu";
import { AdminSearchBar } from "@/components/admin-search-bar";
import { NotificationBell } from "@/components/notification-bell";
import { SupportContact } from "@/components/support-contact";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Screen } from "@/components/ui/screen";
import { useAppSelector } from "@/hooks/redux";
import { useResource } from "@/hooks/use-resource";
import type { AdminHostel } from "@/lib/admin-api";
import { adminQuery, prefetchAdminRoute } from "@/lib/admin-queries";
import { prefetchCommunity } from "@/lib/community-queries";
import { readableRole, ROLE } from "@/constants/roles";

/**
 * More — the doors that are not tabs.
 *
 * ## It used to be a browser
 *
 * This section was called *Manage on the web*: eight rows, each one
 * `WebBrowser.openBrowserAsync` into `/{slug}/admin/...`. The owner overruled it
 * on 2026-08-21 and was right — every one of them is now native, under
 * `app/manage/` (tasks.md §12). Before adding a link back to `lib/web-portal.ts`,
 * note that the argument it encodes has already been tried once.
 *
 * ## Same order as Home
 *
 * The first two groups are Home's money row and its Manage grid, in that order —
 * one map of the product, not two. The rest are the doors Home has no room for.
 */
type ManageRow = {
  href: string;
  icon: keyof typeof Ionicons.glyphMap;
  /** Routes are `requireHostelAdminPrincipal` — hidden from wardens. */
  ownerOnly?: boolean;
  title: string;
  tone?: MenuTone;
};

const MANAGE_GROUPS: ManageRow[][] = [
  [
    { href: "/manage/finance/statement", icon: "receipt-outline", title: "Statement" },
    { href: "/stock", icon: "cube-outline", title: "Stock", tone: "warning" },
    { href: "/manage/finance", icon: "cash-outline", title: "Finance" },
    { href: "/expenses", icon: "wallet-outline", title: "Expenses" },
  ],
  [
    { href: "/manage/rooms", icon: "bed-outline", title: "Rooms" },
    { href: "/manage/wardens", icon: "shield-checkmark-outline", ownerOnly: true, title: "Wardens" },
    { href: "/manage/cook", icon: "flame-outline", title: "Cooks", tone: "warning" },
    { href: "/manage/roll-call", icon: "moon-outline", title: "Night status", tone: "warning" },
    { href: "/manage/food", icon: "restaurant-outline", title: "Food", tone: "warning" },
    { href: "/manage/notices", icon: "megaphone-outline", title: "Notices", tone: "warning" },
    { href: "/manage/maintenance", icon: "construct-outline", title: "Repairs", tone: "danger" },
  ],
  [
    { href: "/(admin)/residents", icon: "people-outline", title: "Residents" },
    { href: "/manage/complaints", icon: "chatbox-ellipses-outline", title: "Complaints", tone: "danger" },
    { href: "/manage/bookings", icon: "calendar-outline", title: "Bookings" },
    { href: "/manage/attendance", icon: "location-outline", title: "Attendance" },
    { href: "/manage/move-history", icon: "swap-horizontal-outline", title: "Move in / out", tone: "neutral" },
    { href: "/manage/reports", icon: "bar-chart-outline", title: "Reports" },
  ],
  [
    { href: "/manage/push-notices", icon: "notifications-outline", title: "Push notices", tone: "warning" },
    { href: "/manage/announcements", icon: "send-outline", title: "Send a notification", tone: "warning" },
    { href: "/manage/invite-hostels", icon: "gift-outline", title: "Invite hostels" },
    { href: "/manage/kyc", icon: "ribbon-outline", ownerOnly: true, title: "Hostel KYC" },
    { href: "/manage/branches", icon: "business-outline", title: "Branches" },
    { href: "/manage/billing", icon: "card-outline", title: "Billing", tone: "danger" },
    { href: "/manage/settings", icon: "settings-outline", title: "Settings", tone: "neutral" },
  ],
];

function BranchAdminMoreScreen() {
  const account = useAppSelector((state) => state.auth.account);
  const [search, setSearch] = useState("");
  const query = adminQuery.hostel();
  const hostel = useResource<AdminHostel | null>(query.load, {
    cacheKey: query.key,
    topics: query.topics,
  });
  const branchesLock = useBranchesLock();

  const visible = (row: ManageRow) =>
    (!row.ownerOnly || account?.role === ROLE.HOSTEL_ADMIN) &&
    (row.href !== "/manage/branches" || branchesLock === null);

  const area = [hostel.data?.location.area, hostel.data?.location.city].filter(Boolean).join(", ");

  return (
    <Screen
      header={<AdminSearchBar actions={<NotificationBell />} onQueryChange={setSearch} placeholder="Search" query={search} title="More" />}
      insideTabs
      onRefresh={hostel.refresh}
      refreshing={hostel.refreshing}
      scroll
    >
      <MenuSearch query={search}>
        <MenuProfile
          avatar={<Avatar name={hostel.data?.name ?? account?.name} size="xl" />}
          lines={[
            [account ? readableRole(account.role) : null, account?.email].filter(Boolean).join(" · "),
            area,
          ]}
          title={hostel.data?.name ?? account?.name ?? "Your hostel"}
        >
          {hostel.data ? (
            <>
              <Badge
                label={hostel.data.status === "PUBLISHED" ? "Published" : "Draft"}
                tone={hostel.data.status === "PUBLISHED" ? "success" : "warning"}
              />
              <Badge
                label={
                  hostel.data.verificationStatus === "VERIFIED" ? "Verified" : "Awaiting verification"
                }
                tone={hostel.data.verificationStatus === "VERIFIED" ? "success" : "warning"}
              />
            </>
          ) : null}
        </MenuProfile>

        <MenuGroups>
          {MANAGE_GROUPS.map((group) => (
            <MenuGroup key={group[0].href}>
              {group.filter(visible).map((row) => (
                <MenuRow
                  icon={row.icon}
                  key={row.href}
                  onPress={() => router.push(row.href)}
                  onPressIn={() => prefetchAdminRoute(row.href)}
                  title={row.title}
                  tone={row.tone}
                />
              ))}
            </MenuGroup>
          ))}

          <MenuGroup>
            <MenuRow icon="search-outline" onPress={() => router.push("/hostels")} title="Browse hostels" />
            <MenuRow
              icon="people-outline"
              onPress={() => router.push("/community")}
              onPressIn={prefetchCommunity}
              title="Community"
              tone="warning"
            />
          </MenuGroup>

          <AppRows />
          <SupportContact />
          <SignOutRow />
        </MenuGroups>
      </MenuSearch>
    </Screen>
  );
}

/**
 * With Overall picked in the switcher this tab answers for every branch at
 * once (`components/overall-views.tsx`); otherwise it is the one branch's screen.
 */
export default function AdminMoreScreen() {
  return useIsOverall() ? <OverallTabScreen tab="more" /> : <BranchAdminMoreScreen />;
}
