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
 * More — every platform door, grouped as `PLATFORM_NAV` groups them, with the
 * account, App lock (PIN + biometric) and sign-out from `AppRows`. Only destinations with a native screen are listed: a row that opened the
 * browser is what `no-browser-handoffs` retired on the admin side.
 */
export default function PlatformMoreScreen() {
  const account = useAppSelector((state) => state.auth.account);
  const [search, setSearch] = useState("");

  return (
    <Screen header={<AdminSearchBar onQueryChange={setSearch} placeholder="Search" query={search} title="More" />} insideTabs scroll>
      <MenuSearch query={search}>
        <MenuProfile
          avatar={<PersonAvatar image={account?.image} name={account?.name} size="xl" />}
          lines={[account?.email ?? account?.phone, account ? readableRole(account.role) : null]}
          title={account?.name ?? "Your account"}
        />
        <MenuGroups>
          <MenuGroup title="Hostels & people">
            <MenuRow icon="hostel" onPress={() => router.push("/(platform)/approvals")} title="Hostel approvals & listings" />
            <MenuRow icon="people" onPress={() => router.push("/manage/platform/users")} title="Users" />
            <MenuRow icon="search" onPress={() => router.push("/hostels")} title="Explore hostels" />
            <MenuRow icon="chatbubbles" onPress={() => router.push("/community")} onPressIn={prefetchCommunity} title="Community" tone="warning" />
          </MenuGroup>
          <MenuGroup title="Money">
            <MenuRow icon="wallet" onPress={() => router.push("/(platform)/money")} title="Payment proofs & field cash" />
            <MenuRow icon="receipt" onPress={() => router.push("/manage/platform/plan-billing")} title="Plan billing" />
            <MenuRow icon="cart" onPress={() => router.push("/manage/platform/store-orders")} title="Store orders" />
          </MenuGroup>
          <MenuGroup title="Moderation">
            <MenuRow icon="chatbox-alert" onPress={() => router.push("/manage/platform/community-reports")} title="Community reports" />
            <MenuRow icon="flag" onPress={() => router.push("/manage/platform/listing-flags")} title="Abuse flags" />
          </MenuGroup>
          <MenuGroup title="Website & push">
            <MenuRow icon="megaphone" onPress={() => router.push("/manage/platform/push")} title="Push notifications" />
            <MenuRow icon="toggle" onPress={() => router.push("/manage/platform/site-config")} title="Feature flags & announcement" />
          </MenuGroup>
          <MenuGroup title="System">
            {SYSTEM_TILES.map((tile) => (
              <MenuRow icon={tile.icon} key={tile.href} onPress={() => router.push(tile.href)} title={tile.label} />
            ))}
          </MenuGroup>
          <AppRows />
          <SignOutRow />
        </MenuGroups>
      </MenuSearch>
    </Screen>
  );
}
