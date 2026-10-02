import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useCallback, useState } from "react";
import { View } from "react-native";

import { NotificationBell } from "@/components/notification-bell";
import { SupportContact } from "@/components/support-contact";
import { AppBar } from "@/components/ui/app-bar";
import { PersonAvatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Card, SectionHeader } from "@/components/ui/card";
import { FactRow } from "@/components/ui/layout";
import { CardRow, ListRow, RowDivider } from "@/components/ui/list-row";
import { Screen } from "@/components/ui/screen";
import { Skeleton, SkeletonCard } from "@/components/ui/skeleton";
import { Text } from "@/components/ui/text";
import { useAppDispatch, useAppSelector } from "@/hooks/redux";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useDates } from "@/hooks/use-dates";
import { useResource } from "@/hooks/use-resource";
import { endSession } from "@/lib/auth-session";
import { prefetchCommunity } from "@/lib/community-queries";
import { openConfirm } from "@/lib/confirm";
import {
  GUARDIAN_PERMISSION_LABELS,
  permissionsOf,
  sharedSections,
} from "@/lib/guardian";
import type { GuardianDashboard } from "@/lib/guardian-api";
import { guardianQuery } from "@/lib/guardian-queries";
import { setThemePreference } from "@/store/slices/uiSlice";

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
 * ## What changed in the tab-shape pass
 *
 * - **The bell.** No guardian screen opened `/notifications`, which is scoped to
 *   `principal.userId` with no role branch — so a guardian's feed existed and
 *   was reachable by a push banner and by nothing else. It is on every tab's bar
 *   now, and this screen has its own row into it.
 * - **A skeleton** instead of the spinner, and the portal's shared cache key, so
 *   arriving here from any other tab paints immediately.
 * - **`Discover` is a `<CardRow>` shelf**, matching the resident and admin More
 *   screens. Community is the one destination a guardian has beyond their ward's
 *   record, and it was not reachable from this portal at all — the board is
 *   platform-wide and a guardian is a signed-in user of it, which is why the tab
 *   bar has always had a Community slot this screen never acknowledged.
 * - **The `App` group keeps its hairlines**, and gets the `px-4 py-1` inset that
 *   admin's has. Those rows are settings, not doors; a card around them is a
 *   true claim rather than a false one.
 */
export default function GuardianMoreScreen() {
  const dates = useDates();
  const account = useAppSelector((state) => state.auth.account);
  const preference = useAppSelector((state) => state.ui.themePreference);
  const dispatch = useAppDispatch();
  const { colors } = useAppTheme();
  // The portal's one key — see `lib/guardian-queries.ts`.
  const query = guardianQuery.dashboard();
  const guardian = useResource<GuardianDashboard>(query.load, {
    cacheKey: query.key,
    topics: query.topics,
  });
  const [signingOut, setSigningOut] = useState(false);

  const dashboard = guardian.data;
  const permissions = permissionsOf(dashboard);
  const granted = sharedSections(dashboard);
  const keys = Object.keys(GUARDIAN_PERMISSION_LABELS) as (keyof typeof permissions)[];

  const signOut = useCallback(() => {
    openConfirm({
      confirmLabel: "Sign out",
      destructive: true,
      message: "You'll need your password to get back in.",
      onConfirm: () => {
        setSigningOut(true);
        void endSession().finally(() => router.replace("/(browse)"));
      },
      title: "Sign out?",
    });
  }, []);

  const nextTheme = preference === "dark" ? "light" : "dark";
  const header = <AppBar actions={<NotificationBell />} large title="More" />;

  if (guardian.loading) {
    return (
      <Screen header={header} insideTabs>
        {/* The identity card, the permission list, then the App group. */}
        <View className="gap-5">
          <Skeleton height={88} radius={16} />
          <View className="gap-3">
            <Skeleton height={18} width="46%" />
            <SkeletonCard rows={6} />
          </View>
          <SkeletonCard rows={3} />
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
      <View className="gap-5 pt-1">
        {/*
          The shared `<Avatar>`, which this card did not have — every other More
          screen in the app leads with a face, and the guardian's led with two
          lines of text. It colours the fallback initial from the name, the same
          way the same person is coloured in Community.
        */}
        <Card className="flex-row items-center gap-3">
          <PersonAvatar
            image={account?.image}
            name={dashboard?.guardian.name ?? account?.name}
            size="lg"
          />

          <View className="flex-1 gap-0.5">
            <Text numberOfLines={1} variant="subtitle">
              {dashboard?.guardian.name ?? account?.name ?? "Your account"}
            </Text>
            <Text numberOfLines={1} variant="caption">
              {[dashboard?.guardian.relation, dashboard?.guardian.phone ?? account?.email]
                .filter(Boolean)
                .join(" · ")}
            </Text>
            {dashboard?.hostel ? (
              <Text numberOfLines={1} variant="caption">
                {`Guardian at ${dashboard.hostel.name}`}
              </Text>
            ) : null}
          </View>
        </Card>

        <View>
          <SectionHeader
            subtitle={`${granted.length} of ${keys.length} shared by ${
              dashboard?.resident.fullName ?? "your ward"
            }`}
            title="What you can see"
          />
          <Card padding="px-4 py-1">
            {keys.map((key, index) => (
              <View key={key}>
                {index > 0 ? <RowDivider /> : null}
                <ListRow
                  right={
                    <Badge
                      label={permissions[key] ? "Shared" : "Private"}
                      tone={permissions[key] ? "success" : "neutral"}
                    />
                  }
                  title={GUARDIAN_PERMISSION_LABELS[key]}
                />
              </View>
            ))}
          </Card>
          <Text className="px-1 pt-2" variant="caption">
            Only the resident can change these, from their own portal. The hostel cannot
            grant them on your behalf.
          </Text>
        </View>

        {dashboard?.access ? (
          <View>
            <SectionHeader title="Your access" />
            <Card className="gap-2">
              <FactRow label="Access code" value={dashboard.access.accessCode} />
              {/*
                Guardian access is time-boxed by the hostel, and the expiry is
                the one thing that will silently end this account. Better read
                here than discovered at a locked screen.

                `<FactRow>`, so a long code or a two-calendar date wraps instead
                of being squeezed into the ~150dp a 320dp phone leaves for a
                right-hand column — see `NOTES.md` §8.
              */}
              <FactRow label="Expires" value={dates.date(dashboard.access.expiresAt)} />
            </Card>
          </View>
        ) : null}

        <View>
          <SectionHeader title="Discover" />
          {/*
            One door, on the shelf shape the other two portals use. The board is
            platform-wide — signed out, public account, resident, staff, guardian
            — which is why it is a root-stack screen rather than something inside
            a role's tabs, and why this portal's tab bar has always had a slot
            for it that this screen never mentioned.
          */}
          <CardRow
            icon="people-outline"
            onPress={() => router.push("/community")}
            // Touch-down warms the feed and the spaces rail. It is not in any
            // role's registry on purpose — see `lib/community-queries.ts`.
            onPressIn={prefetchCommunity}
            subtitle="Ask, answer and see what other households are saying"
            title="Community"
          />
        </View>

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
            {/*
              The feed's own row, and the reason the bell went onto every bar:
              this portal had no path to `/notifications` at all. Same fault, and
              the same fix, as the resident group's §2.1.
            */}
            <ListRow
              icon="notifications-outline"
              onPress={() => router.push("/notifications")}
              subtitle="Everything the hostel and the platform have sent you"
              title="Notifications"
            />
            <RowDivider inset />
            <ListRow
              icon="shield-checkmark-outline"
              onPress={() =>
                router.push({
                  params: { section: "privacy" },
                  pathname: "/settings",
                })
              }
              // Named `section`, as the resident and browse profiles do. A bare
              // `/settings` is two promises delivered by whichever half happens
              // to be scrolled to.
              subtitle="Your data, and closing your account"
              title="Privacy & your data"
            />
          </Card>
        </View>

        <SupportContact />

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
