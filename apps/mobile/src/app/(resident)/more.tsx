import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useState } from "react";
import { Linking } from "react-native";

import { AppRows, MenuGroup, MenuGroups, MenuProfile, MenuRow, MenuSearch, type MenuTone, SignOutRow } from "@/components/more-menu";
import { AdminSearchBar } from "@/components/admin-search-bar";
import { NotificationBell } from "@/components/notification-bell";
import { SupportContact } from "@/components/support-contact";
import { PersonAvatar } from "@/components/ui/avatar";
import { StatusPill } from "@/components/ui/badge";
import { Chip } from "@/components/ui/layout";
import { Screen } from "@/components/ui/screen";
import { useAppSelector } from "@/hooks/redux";
import { useDates } from "@/hooks/use-dates";
import { useResource } from "@/hooks/use-resource";
import {
  prefetchResidentRoute,
  type ResidentMore,
  residentQuery,
} from "@/lib/resident-queries";
import { prefetchCommunity } from "@/lib/community-queries";
import { humanizeEnum } from "@/lib/format";
import { stayPill } from "@/lib/resident-home";

/**
 * Everything that is not a tab, in the shared `components/more-menu.tsx` shape.
 *
 * Every row opens a real screen. If a later milestone wants a row listed before
 * its screen exists, bring back a `soon()` toast rather than pointing the row at
 * nothing. **Explore** is the discovery entry (agreed 2026-08-16): residents keep
 * their own five tabs, and hostel browsing lives here.
 */
type Row = { href: string; icon: keyof typeof Ionicons.glyphMap; title: string; tone?: MenuTone };

/** The doors, in the order Home's `<ResidentServiceGrid>` draws them. */
const STAY_ROWS: Row[] = [
  { href: "/profile", icon: "person-outline", title: "Profile" },
  { href: "/night-status", icon: "moon-outline", title: "Night status", tone: "warning" },
  // Directly under Night status: what the resident says, then what the phone reported.
  { href: "/attendance", icon: "location-outline", title: "Location & attendance" },
  { href: "/night-status-history", icon: "time-outline", title: "Night history", tone: "neutral" },
  // Its own row: sharing with a parent is a decision people revisit.
  { href: "/guardians", icon: "shield-outline", title: "Guardians" },
  { href: "/complaints", icon: "chatbox-ellipses-outline", title: "Complaints", tone: "danger" },
  { href: "/id-card", icon: "card-outline", title: "Digital ID", tone: "warning" },
  { href: "/offer-program/mine", icon: "ribbon-outline", title: "Offer Program" },
];

const DISCOVER_ROWS: Row[] = [
  { href: "/hostels", icon: "search-outline", title: "Explore hostels" },
  { href: "/community", icon: "people-outline", title: "Community", tone: "warning" },
  { href: "/referrals", icon: "gift-outline", title: "Refer a friend", tone: "danger" },
  { href: "/review", icon: "star-outline", title: "Review your hostel", tone: "warning" },
];

export default function ResidentMoreScreen() {
  const dates = useDates();
  const account = useAppSelector((state) => state.auth.account);
  // Same request and key as the warm-up — see `lib/resident-queries.ts`.
  const [search, setSearch] = useState("");
  const query = residentQuery.more();
  const more = useResource<ResidentMore>(query.load, {
    cacheKey: query.key,
    topics: query.topics,
  });

  const profile = more.data?.profile;
  const resident = profile?.resident;

  // `stayPill`, not `humanizeEnum(status.status)` — it reads the row *and* the alert.
  const tonight = more.data?.nightStatus
    ? stayPill(more.data.nightStatus.status, more.data.nightStatus.sos).label
    : undefined;

  const rows = (list: Row[]) =>
    list.map((row) => (
      <MenuRow
        icon={row.icon}
        key={row.href}
        onPress={() => router.push(row.href)}
        // Community warms its own platform-wide query, not the resident registry.
        onPressIn={
          row.href === "/community" ? prefetchCommunity : () => prefetchResidentRoute(row.href)
        }
        title={row.title}
        tone={row.tone}
        value={row.href === "/night-status" ? tonight : undefined}
      />
    ));

  return (
    <Screen
      header={<AdminSearchBar actions={<NotificationBell />} onQueryChange={setSearch} placeholder="Search" query={search} title="More" />}
      insideTabs
      onRefresh={more.refresh}
      refreshing={more.refreshing}
      scroll
    >
      <MenuSearch query={search}>
        <MenuProfile
          avatar={
            <PersonAvatar
              image={account?.image}
              name={resident?.fullName ?? account?.name}
              size="xl"
            />
          }
          lines={[resident?.email || account?.email || resident?.phone, profile?.hostel?.name]}
          title={resident?.fullName ?? account?.name ?? "Your account"}
        >
          {resident ? <StatusPill status={resident.status} /> : null}
          {profile?.hostel ? (
            <>
              <Chip icon="bed-outline" label={humanizeEnum(profile.accommodation.roomType)} />
              {resident ? (
                <Chip icon="calendar-outline" label={`Since ${dates.date(resident.moveInDate)}`} />
              ) : null}
              {profile.hostel.contact.phone ? (
                <Chip
                  icon="call-outline"
                  label={profile.hostel.contact.phone}
                  onPress={() => void Linking.openURL(`tel:${profile.hostel?.contact.phone}`)}
                  tone="brand"
                />
              ) : null}
            </>
          ) : null}
        </MenuProfile>

        <MenuGroups>
          <MenuGroup>{rows(STAY_ROWS)}</MenuGroup>
          <MenuGroup>{rows(DISCOVER_ROWS)}</MenuGroup>
          <AppRows notificationSettings />
          <SupportContact />
          <SignOutRow />
        </MenuGroups>
      </MenuSearch>
    </Screen>
  );
}
