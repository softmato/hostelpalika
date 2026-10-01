import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { Alert, View } from "react-native";

import { NotificationBell } from "@/components/notification-bell";
import { AppBar } from "@/components/ui/app-bar";
import { PersonAvatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Card, SectionHeader } from "@/components/ui/card";
import { FactRow } from "@/components/ui/layout";
import { ListRow, RowDivider } from "@/components/ui/list-row";
import { Screen } from "@/components/ui/screen";
import { SkeletonRows } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useAppDispatch, useAppSelector } from "@/hooks/redux";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useDates } from "@/hooks/use-dates";
import { useResource } from "@/hooks/use-resource";
import { endSession } from "@/lib/auth-session";
import type { CookToday, FoodReadyAnnouncement } from "@/lib/cook-api";
import { cookQuery } from "@/lib/cook-queries";
import { collectDeviceInfo } from "@/lib/device-info";
import { humanizeEnum } from "@/lib/format";
import { setThemePreference } from "@/store/slices/uiSlice";

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
 * It sat under the photo feed, on a tab named "Photos", and it is the list that
 * grows: a hostel serving four meals a day adds a hundred and twenty rows a
 * month underneath the control a cook opens that tab to press.
 *
 * It belongs here because it is the **same subject as the block above it**. The
 * device section says which handset is stamped on an announcement; this says
 * which announcements were stamped. Together they are the whole of what a shared
 * kitchen login can be held to, which is the one thing this screen exists to be
 * honest about.
 *
 * "Did I already announce lunch?" is not this list's question — that is answered
 * on Today, on the meal's own card, which carries `Sent 12:04`.
 *
 * ## No privacy or account-deletion row, deliberately
 *
 * Every other portal's More has one into `settings?section=privacy`, whose
 * pathways include closing the account. A cook login belongs to **the hostel**
 * — a generated one outright, an invited one for as long as the hostel says so
 * — and the person holding the phone at 6am is not the person entitled to
 * close it. The office removes a cook from `manage/cook`, which is where that
 * decision has an owner.
 */
export default function CookMoreScreen() {
  const dates = useDates();
  const account = useAppSelector((state) => state.auth.account);
  const preference = useAppSelector((state) => state.ui.themePreference);
  const dispatch = useAppDispatch();
  const { colors } = useAppTheme();
  const [device, setDevice] = useState<Record<string, unknown> | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  /*
   * Under the portal's own key, warmed on entry — see `lib/cook-queries.ts`.
   * It is the one read on this screen and it is allowed to fail on its own: a
   * kitchen whose log errors must still be able to read its device details and
   * sign out.
   */
  // Cached by Today; read here only for whether the owner turned expenses on.
  const kitchenQuery = cookQuery.today();
  const kitchen = useResource<CookToday>(kitchenQuery.load, {
    cacheKey: kitchenQuery.key,
    topics: kitchenQuery.topics,
  });
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

  const signOut = useCallback(() => {
    Alert.alert(
      "Sign out?",
      "You'll need your cook sign-in to get back in — the hostel office can issue a new password if it has been lost.",
      [
        { style: "cancel", text: "Cancel" },
        {
          onPress: () => {
            setSigningOut(true);
            void endSession().finally(() => router.replace("/(browse)"));
          },
          style: "destructive",
          text: "Sign out",
        },
      ],
    );
  }, []);

  const nextTheme = preference === "dark" ? "light" : "dark";
  const deviceName = [device?.brand, device?.model].filter(Boolean).join(" ");
  const fingerprint = typeof device?.fingerprint === "string" ? device.fingerprint : "";
  const announcements = logs.data ?? [];

  return (
    <Screen
      header={<AppBar actions={<NotificationBell />} large title="More" />}
      insideTabs
      onRefresh={logs.refresh}
      refreshing={logs.refreshing}
      scroll
    >
      <View className="gap-5 pt-1">
        {/*
          An `<Avatar>`, as every other More screen in the app opens with — and
          this one is the only place in the product where the initial is
          deliberately *not* a person. It is the kitchen, and the caption under
          it says so in the same breath.
        */}
        <Card className="flex-row items-center gap-3">
          <PersonAvatar
            image={account?.image}
            name={account?.name ?? "Kitchen"}
            size="lg"
          />

          <View className="flex-1 gap-0.5">
            <Text numberOfLines={1} variant="subtitle">
              {account?.name ?? "Kitchen"}
            </Text>
            <Text variant="caption">
              Shared by the whole kitchen. Announcements are traced to the device that
              sent them, not to a person.
            </Text>
          </View>
        </Card>

        <View>
          <SectionHeader
            subtitle="Stamped on every announcement sent from here"
            title="This device"
          />
          {/*
            `<FactRow>` rather than three `<ListRow>`s with a `value`. These are
            read-only facts, not rows you can press — and a fingerprint is
            exactly the string `NOTES.md` §8's label/value pair exists to let
            wrap, instead of being squeezed into the ~150dp a 320dp phone leaves
            a right-hand column.
          */}
          <Card className="gap-2">
            <FactRow label="Handset" value={deviceName || "Unknown"} />
            <FactRow
              label="Fingerprint"
              value={fingerprint ? `${fingerprint.slice(0, 8)}…` : "Not available"}
            />
            <FactRow label="App version" value={String(device?.appVersion ?? "—")} />
          </Card>
        </View>

        <View>
          <SectionHeader
            subtitle="Everything this kitchen has called, newest first"
            title="Announcement history"
          />

          {logs.error ? (
            <Card>
              <ErrorState message={logs.error} onRetry={logs.reload} />
            </Card>
          ) : logs.loading ? (
            <SkeletonRows rows={5} />
          ) : announcements.length === 0 ? (
            <Card>
              <Text variant="muted">
                Announce a meal from the Today tab and it appears here.
              </Text>
            </Card>
          ) : (
            <Card padding="px-4 py-1">
              {announcements.map((log, index) => (
                <View key={log.id}>
                  {index > 0 ? <RowDivider /> : null}
                  <ListRow
                    right={
                      /*
                        `notifiedCount`, and amber when it is zero. The fan-out
                        returns 201 once the log row is written whether or not a
                        single resident had an account — so a green pill on a
                        zero would tell a kitchen the hostel had been called to
                        dinner when nobody was told.
                      */
                      <Badge
                        label={`${log.notifiedCount} notified`}
                        tone={log.notifiedCount > 0 ? "success" : "warning"}
                      />
                    }
                    /*
                      Who called it, under what was said. This is where a
                      removed cook shows up as "Previous Sunrise cook" — the
                      whole point of keeping their roster row after their
                      account is gone. Rows from before the roster carry no
                      name and simply show the message, which is what they
                      always showed.
                    */
                    subtitle={
                      [log.announcedBy, log.message].filter(Boolean).join(" · ") ||
                      undefined
                    }
                    title={`${humanizeEnum(log.mealType)} · ${dates.dateTime(
                      log.announcedAt,
                    )}`}
                  />
                </View>
              ))}
            </Card>
          )}
        </View>

        {kitchen.data?.expensesEnabled ? (
          <View>
            <SectionHeader title="Money" />
            <Card padding="px-4 py-1">
              <ListRow
                icon="add-circle-outline"
                onPress={() => router.push("/expenses/new")}
                subtitle="What the kitchen paid for"
                title="Add expense"
              />
              <RowDivider inset />
              <ListRow
                icon="wallet-outline"
                onPress={() => router.push("/expenses")}
                subtitle="Everything added from this phone"
                title="My expenses"
              />
            </Card>
          </View>
        ) : null}

        <View>
          <SectionHeader title="App" />
          <Card padding="px-4 py-1">
            <ListRow
              icon={preference === "dark" ? "moon-outline" : "sunny-outline"}
              onPress={() => dispatch(setThemePreference(nextTheme))}
              subtitle={`Currently ${preference}`}
              title="Theme"
              value={`Switch to ${nextTheme}`}
            />
            <RowDivider inset />
            <ListRow
              icon="notifications-outline"
              onPress={() => router.push("/notifications")}
              subtitle="Everything the platform has sent this account"
              title="Notifications"
            />
          </Card>
        </View>

        <Card padding="px-4 py-1">
          <ListRow
            icon="log-out-outline"
            onPress={signOut}
            right={
              <Ionicons
                color={colors.destructive}
                name={signingOut ? "hourglass-outline" : "chevron-forward"}
                size={18}
              />
            }
            title="Sign out"
          />
        </Card>
      </View>
    </Screen>
  );
}
