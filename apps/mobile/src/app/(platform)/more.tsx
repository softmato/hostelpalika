import { router } from "expo-router";
import { useState } from "react";

import { AdminSearchBar } from "@/components/admin-search-bar";
import { SYSTEM_TILES } from "@/components/platform-system";
import { AppRows, MenuGroup, MenuGroups, MenuProfile, MenuRow, MenuSearch, SignOutRow } from "@/components/more-menu";
import { PersonAvatar } from "@/components/ui/avatar";
import { Screen } from "@/components/ui/screen";
import { readableRole } from "@/constants/roles";
import { useAppSelector } from "@/hooks/redux";
import { prefetchCommunity } from "@/lib/community-queries";

/**
 * More — every platform door with a native screen, grouped the way the owner
 * works (`PLATFORM_NAV` groups, reordered): hostels, people, money, the inbox
 * of things users sent, the website, the server. Then account, App lock and
 * sign-out from `AppRows`. A row that opened the browser is what
 * `no-browser-handoffs` retired.
 */
export default function PlatformMoreScreen() {
  const account = useAppSelector((state) => state.auth.account);
  const [search, setSearch] = useState("");
  const go = (href: string) => () => router.push(href as never);

  return (
    <Screen header={<AdminSearchBar onQueryChange={setSearch} placeholder="Search" query={search} title="More" />} insideTabs scroll>
      <MenuSearch query={search}>
        <MenuProfile
          avatar={<PersonAvatar image={account?.image} name={account?.name} size="xl" />}
          lines={[account?.email ?? account?.phone, account ? readableRole(account.role) : null]}
          title={account?.name ?? "Your account"}
        />
        <MenuGroups>
          <MenuGroup title="Hostels">
            <MenuRow icon="hostel" onPress={go("/(platform)/approvals")} title="Approvals & listings" />
            <MenuRow icon="log-out" onPress={go("/manage/platform/hostel-leaves")} title="Hostel leaves" tone="danger" />
            <MenuRow icon="flag" onPress={go("/manage/platform/listing-flags")} title="Abuse flags" tone="warning" />
            <MenuRow icon="search" onPress={go("/hostels")} title="Explore hostels" tone="neutral" />
          </MenuGroup>
          <MenuGroup title="People">
            <MenuRow icon="people" onPress={go("/manage/platform/users")} title="Users" />
            <MenuRow icon="briefcase" onPress={go("/manage/platform/team")} title="Field team" />
            <MenuRow icon="build" onPress={go("/manage/platform/providers")} title="Service providers" />
            <MenuRow icon="person-remove" onPress={go("/manage/platform/account-deletions")} title="Account deletions" tone="danger" />
          </MenuGroup>
          <MenuGroup title="Money">
            <MenuRow icon="wallet" onPress={go("/(platform)/money")} title="Payment proofs & field cash" />
            <MenuRow icon="bed" onPress={go("/manage/platform/bookings")} title="Bookings, refunds & payouts" />
            <MenuRow icon="receipt" onPress={go("/manage/platform/plan-billing")} title="Plan billing" />
            <MenuRow icon="cart" onPress={go("/manage/platform/store-orders")} title="Store orders" />
          </MenuGroup>
          <MenuGroup title="Inbox">
            <MenuRow icon="chatbubbles" onPress={go("/manage/platform/feedback")} title="Feedback" />
            <MenuRow icon="star" onPress={go("/manage/platform/reviews")} title="Reviews" tone="warning" />
            <MenuRow icon="chatbox-alert" onPress={go("/manage/platform/complaints")} title="Complaints" tone="warning" />
            <MenuRow icon="chatbox-alert" onPress={go("/manage/platform/community-reports")} title="Community reports" tone="warning" />
            <MenuRow icon="chatbubbles" onPress={go("/community")} onPressIn={prefetchCommunity} title="Community" tone="neutral" />
          </MenuGroup>
          <MenuGroup title="Website & push">
            <MenuRow icon="megaphone" onPress={go("/manage/platform/push")} title="Push notifications" />
            <MenuRow icon="toggle" onPress={go("/manage/platform/site-config")} title="Feature flags & announcement" />
          </MenuGroup>
          <MenuGroup title="System">
            {SYSTEM_TILES.map((tile) => (
              <MenuRow icon={tile.icon} key={tile.href} onPress={() => router.push(tile.href)} title={tile.label} tone="neutral" />
            ))}
            <MenuRow icon="shield-checkmark" onPress={go("/manage/platform/audit-log")} title="Audit log" tone="neutral" />
          </MenuGroup>
          <AppRows />
          <SignOutRow />
        </MenuGroups>
      </MenuSearch>
    </Screen>
  );
}
