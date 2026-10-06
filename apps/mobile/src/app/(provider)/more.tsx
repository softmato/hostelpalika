import { router } from "expo-router";
import { useState } from "react";

import { AppRows, MenuGroup, MenuGroups, MenuProfile, MenuRow, MenuSearch, SignOutRow } from "@/components/more-menu";
import { AdminSearchBar } from "@/components/admin-search-bar";
import { SupportContact } from "@/components/support-contact";
import { PersonAvatar } from "@/components/ui/avatar";
import { Screen } from "@/components/ui/screen";
import { useAppSelector } from "@/hooks/redux";
import { prefetchCommunity } from "@/lib/community-queries";

/**
 * A provider's account, and the rest of the product.
 *
 * A provider is a `PUBLIC` account with an approved record behind it, so
 * everything a signed-out visitor can do — browse hostels, read the community —
 * they can do too. Those rows are here rather than in a tab because a plumber
 * opens this app to see today's work, not to shop for a room.
 */
export default function ProviderMoreScreen() {
  const account = useAppSelector((state) => state.auth.account);

  const [search, setSearch] = useState("");

  return (
    <Screen header={<AdminSearchBar onQueryChange={setSearch} placeholder="Search" query={search} title="More" />} insideTabs scroll>
      <MenuSearch query={search}>
        <MenuProfile
          avatar={<PersonAvatar image={account?.image} name={account?.name} size="xl" />}
          lines={[account?.email ?? account?.phone]}
          title={account?.name ?? "Your account"}
        />

        <MenuGroups>
          <MenuGroup>
            <MenuRow icon="search-outline" onPress={() => router.push("/hostels")} title="Explore hostels" />
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
