import { router } from "expo-router";
import { useEffect, useState } from "react";
import { View } from "react-native";

import { AppRows, MenuGroup, MenuGroups, MenuProfile, MenuRow, MenuSearch, SignOutRow } from "@/components/more-menu";
import { AdminSearchBar } from "@/components/admin-search-bar";
import { NotificationBell } from "@/components/notification-bell";
import { SupportContact } from "@/components/support-contact";
import { PersonAvatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { FactRow } from "@/components/ui/layout";
import { ListRow, RowDivider } from "@/components/ui/list-row";
import { Screen } from "@/components/ui/screen";
import { SkeletonRows } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useAppSelector } from "@/hooks/redux";
import { useDates } from "@/hooks/use-dates";
import { useResource } from "@/hooks/use-resource";
import type { CookToday, FoodReadyAnnouncement } from "@/lib/cook-api";
import { cookQuery } from "@/lib/cook-queries";
import { collectDeviceInfo } from "@/lib/device-info";
import { humanizeEnum } from "@/lib/format";

/**
 * The kitchen's account, the handset it is signed in on, and what it has called.
 *
 * ## This device, named
 *
 * `provisionCookAccount` creates **one account per hostel** — kitchen staff
 * share a phone and a password, and per-announcement attribution comes from
 * `FoodReadyLog.deviceInfo` rather than separate logins (PHASES.md §3.1). So
 * "signed in as" is not a person, and showing an account name here would imply
 * an accountability the system does not have. What is true, and useful, is
 * which handset this is: it is the value stamped on every announcement sent
 * from here.
 *
 * There is no cook-side device registration endpoint to call — the fingerprint
 * is written by the first announcement — so this reads the same
 * `collectDeviceInfo()` the announce call sends rather than fetching anything.
 *
 * ## The announcement history came here from the Photos tab
 *
 * It is the list that grows, and it is the same subject as the device block
 * above it: which handset is stamped on an announcement, then which
 * announcements were stamped. "Did I already announce lunch?" is answered on
 * Today, on the meal's own card.
 *
 * ## No privacy or account-deletion row, deliberately
 *
 * A cook login belongs to **the hostel**, and the person holding the phone at
 * 6am is not the person entitled to close it. The office removes a cook from
 * `manage/cook`, which is where that decision has an owner.
 */
export default function CookMoreScreen() {
  const dates = useDates();
  const account = useAppSelector((state) => state.auth.account);
  const [search, setSearch] = useState("");
  const [device, setDevice] = useState<Record<string, unknown> | null>(null);

  // Cached by Today; read here only for whether the owner turned expenses on.
  const kitchenQuery = cookQuery.today();
  const kitchen = useResource<CookToday>(kitchenQuery.load, {
    cacheKey: kitchenQuery.key,
    topics: kitchenQuery.topics,
  });
  // Allowed to fail on its own: the device details and sign-out must still work.
  const query = cookQuery.announcements();
  const logs = useResource<FoodReadyAnnouncement[]>(query.load, {
    cacheKey: query.key,
    topics: query.topics,
  });

  useEffect(() => {
    let cancelled = false;

    void collectDeviceInfo().then((info) => {
      if (!cancelled) {
        setDevice(info);
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  const deviceName = [device?.brand, device?.model].filter(Boolean).join(" ");
  const fingerprint = typeof device?.fingerprint === "string" ? device.fingerprint : "";
  const announcements = logs.data ?? [];

  return (
    <Screen
      header={<AdminSearchBar actions={<NotificationBell />} onQueryChange={setSearch} placeholder="Search" query={search} title="More" />}
      insideTabs
      onRefresh={logs.refresh}
      refreshing={logs.refreshing}
      scroll
    >
      <MenuSearch query={search}>
        {/* The one avatar in the product that is deliberately not a person. */}
        <MenuProfile
          avatar={<PersonAvatar image={account?.image} name={account?.name ?? "Kitchen"} size="xl" />}
          lines={["Shared by the whole kitchen. Announcements are traced to the device that sent them."]}
          title={account?.name ?? "Kitchen"}
        />

        <MenuGroups>
          {kitchen.data?.expensesEnabled ? (
            <MenuGroup>
              <MenuRow icon="add-circle-outline" onPress={() => router.push("/expenses/new")} title="Add expense" />
              <MenuRow icon="wallet-outline" onPress={() => router.push("/expenses")} title="My expenses" tone="warning" />
            </MenuGroup>
          ) : null}

          {/* `<FactRow>`: read-only facts that may wrap, not rows you can press. */}
          <MenuGroup title="This device · stamped on every announcement">
            <View className="gap-2 py-2">
              <FactRow label="Handset" value={deviceName || "Unknown"} />
              <FactRow
                label="Fingerprint"
                value={fingerprint ? `${fingerprint.slice(0, 8)}…` : "Not available"}
              />
              <FactRow label="App version" value={String(device?.appVersion ?? "—")} />
            </View>
          </MenuGroup>

          <MenuGroup title="Announcement history">
            {logs.error ? (
              <ErrorState message={logs.error} onRetry={logs.reload} />
            ) : logs.loading ? (
              <SkeletonRows rows={5} />
            ) : announcements.length === 0 ? (
              <Text className="py-2" variant="muted">
                Announce a meal from the Today tab and it appears here.
              </Text>
            ) : (
              announcements.map((log, index) => (
                <View key={log.id}>
                  {index > 0 ? <RowDivider /> : null}
                  <ListRow
                    right={
                      // Amber on zero: a 201 is returned whether or not anybody was told.
                      <Badge
                        label={`${log.notifiedCount} notified`}
                        tone={log.notifiedCount > 0 ? "success" : "warning"}
                      />
                    }
                    // A removed cook shows up here as "Previous <hostel> cook".
                    subtitle={[log.announcedBy, log.message].filter(Boolean).join(" · ") || undefined}
                    title={`${humanizeEnum(log.mealType)} · ${dates.dateTime(log.announcedAt)}`}
                  />
                </View>
              ))
            )}
          </MenuGroup>

          <AppRows privacy={false} />
          <SupportContact />
          <SignOutRow message="You'll need your cook sign-in to get back in — the hostel office can issue a new password if it has been lost." />
        </MenuGroups>
      </MenuSearch>
    </Screen>
  );
}
