import { router } from "expo-router";
import { useState } from "react";
import { View } from "react-native";

import { AppRows, MenuGroup, MenuGroups, MenuProfile, MenuRow, MenuSearch, SignOutRow } from "@/components/more-menu";
import { AdminSearchBar } from "@/components/admin-search-bar";
import { NotificationBell } from "@/components/notification-bell";
import { SupportContact } from "@/components/support-contact";
import { PersonAvatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { FactRow } from "@/components/ui/layout";
import { ListRow } from "@/components/ui/list-row";
import { Screen } from "@/components/ui/screen";
import { Skeleton, SkeletonRows } from "@/components/ui/skeleton";
import { Text } from "@/components/ui/text";
import { useAppSelector } from "@/hooks/redux";
import { useDates } from "@/hooks/use-dates";
import { useResource } from "@/hooks/use-resource";
import { prefetchCommunity } from "@/lib/community-queries";
import {
  GUARDIAN_PERMISSION_LABELS,
  permissionsOf,
  sharedSections,
} from "@/lib/guardian";
import type { GuardianDashboard } from "@/lib/guardian-api";
import { guardianQuery } from "@/lib/guardian-queries";

/**
 * The guardian's own account, and — the reason this tab is worth a slot — an
 * itemised list of what they can and cannot see.
 *
 * A guardian who does not know a section exists reads its absence as the app
 * being thin. A guardian who is told "night status is not shared" knows to ask
 * their ward rather than the hostel. That list belongs here, on the account
 * screen, and nowhere else: repeating it beside each hidden section would turn
 * the resident's private choices into six prompts to argue about.
 *
 * Community is the one destination a guardian has beyond their ward's record,
 * and the notification feed's row is the reason the bell went onto every bar.
 */
export default function GuardianMoreScreen() {
  const dates = useDates();
  const account = useAppSelector((state) => state.auth.account);
  // The portal's one key — see `lib/guardian-queries.ts`.
  const [search, setSearch] = useState("");
  const query = guardianQuery.dashboard();
  const guardian = useResource<GuardianDashboard>(query.load, {
    cacheKey: query.key,
    topics: query.topics,
  });

  const dashboard = guardian.data;
  const permissions = permissionsOf(dashboard);
  const granted = sharedSections(dashboard);
  const keys = Object.keys(GUARDIAN_PERMISSION_LABELS) as (keyof typeof permissions)[];

  const header = <AdminSearchBar actions={<NotificationBell />} onQueryChange={setSearch} placeholder="Search" query={search} title="More" />;

  if (guardian.loading) {
    return (
      <Screen header={header} insideTabs>
        <View className="items-center gap-3 pt-2">
          <Skeleton height={96} radius={48} width={96} />
          <Skeleton height={18} width="46%" />
        </View>
        <View className="pt-6">
          <SkeletonRows rows={8} />
        </View>
      </Screen>
    );
  }

  return (
    <Screen
      header={header}
      insideTabs
      onRefresh={guardian.refresh}
      refreshing={guardian.refreshing}
      scroll
    >
      <MenuSearch query={search}>
        <MenuProfile
          avatar={
            <PersonAvatar
              image={account?.image}
              name={dashboard?.guardian.name ?? account?.name}
              size="xl"
            />
          }
          lines={[
            [dashboard?.guardian.relation, dashboard?.guardian.phone ?? account?.email]
              .filter(Boolean)
              .join(" · "),
            dashboard?.hostel ? `Guardian at ${dashboard.hostel.name}` : null,
          ]}
          title={dashboard?.guardian.name ?? account?.name ?? "Your account"}
        />

        <MenuGroups>
          <MenuGroup
            title={`What you can see · ${granted.length} of ${keys.length} shared by ${
              dashboard?.resident.fullName ?? "your ward"
            }`}
          >
            {keys.map((key) => (
              <ListRow
                key={key}
                right={
                  <Badge
                    label={permissions[key] ? "Shared" : "Private"}
                    tone={permissions[key] ? "success" : "neutral"}
                  />
                }
                title={GUARDIAN_PERMISSION_LABELS[key]}
              />
            ))}
            <Text className="pb-2" variant="caption">
              Only the resident can change these, from their own portal. The hostel cannot grant
              them on your behalf.
            </Text>
          </MenuGroup>

          {/* Guardian access is time-boxed by the hostel; the expiry silently ends this account. */}
          {dashboard?.access ? (
            <MenuGroup title="Your access">
              <View className="gap-2 py-2">
                <FactRow label="Expires" value={dates.date(dashboard.access.expiresAt)} />
              </View>
            </MenuGroup>
          ) : null}

          <MenuGroup>
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
