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
 * More — the platform doors that are not tabs, grouped as `PLATFORM_NAV` groups
 * them. Only destinations with a native screen are listed: a row that opened the
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
          <MenuGroup title="System">
            {SYSTEM_TILES.map((tile) => (
              <MenuRow icon={tile.icon} key={tile.href} onPress={() => router.push(tile.href)} title={tile.label} />
            ))}
          </MenuGroup>
          <MenuGroup title="Hostels">
            <MenuRow icon="search" onPress={() => router.push("/hostels")} title="Explore hostels" />
            <MenuRow icon="people" onPress={() => router.push("/community")} onPressIn={prefetchCommunity} title="Community" tone="warning" />
          </MenuGroup>
          <AppRows />
          <SignOutRow />
        </MenuGroups>
      </MenuSearch>
    </Screen>
  );
}
