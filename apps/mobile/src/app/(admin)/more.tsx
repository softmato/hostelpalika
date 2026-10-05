import { OverallTabScreen } from "@/components/overall-views";
import { useIsOverall } from "@/components/hostel-switcher";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useCallback, useState } from "react";
import { View } from "react-native";

import { NotificationBell } from "@/components/notification-bell";
import { SupportContact } from "@/components/support-contact";
import { AppBar } from "@/components/ui/app-bar";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Card, SectionHeader } from "@/components/ui/card";
import { CardRow, ListRow, RowDivider } from "@/components/ui/list-row";
import { Screen } from "@/components/ui/screen";
import { Text } from "@/components/ui/text";
import { useAppDispatch, useAppSelector } from "@/hooks/redux";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useResource } from "@/hooks/use-resource";
import type { AdminHostel } from "@/lib/admin-api";
import { adminQuery, prefetchAdminRoute } from "@/lib/admin-queries";
import { endSession } from "@/lib/auth-session";
import { prefetchCommunity } from "@/lib/community-queries";
import { readableRole, ROLE } from "@/constants/roles";
import { openConfirm } from "@/lib/confirm";
import { setThemePreference } from "@/store/slices/uiSlice";

/**
 * More — the doors that are not tabs.
 *
 * ## It used to be a browser
 *
 * This section was called *Manage on the web*: eight rows, each one
 * `WebBrowser.openBrowserAsync` into `/{slug}/admin/...`, and a paragraph here
 * arguing that a phone could not do "nine columns". The owner overruled it on
 * 2026-08-21 and was right — nine columns is a desktop *layout*, not a feature
 * list, and a row that leaves the app is not an app screen. Every one of them is
 * now native, under `app/manage/` (tasks.md §12).
 *
 * `lib/web-portal.ts` survives for nothing on this screen. Before adding a link
 * back to it, note that the argument it encodes has already been tried once.
 *
 * ## The rows overlap the tabs on purpose
 *
 * Money, Residents and Today cover the part of Finance, Residents and Operations
 * a phone does *while walking* — verifying a claim, calling somebody who has not
 * paid, marking a roll call, publishing a notice. These rows are the *rest* of
 * those sections: the rates the invoices are computed from, the room inventory,
 * the reports. The subtitles say which half you are getting.
 */
const MANAGE_ROWS: {
  href: string;
  icon: keyof typeof Ionicons.glyphMap;
  /** Routes are `requireHostelAdminPrincipal` — hidden from wardens. */
  ownerOnly?: boolean;
  subtitle: string;
  title: string;
  tone?: "brand" | "danger" | "neutral" | "success" | "warning";
}[] = [
  {
    href: "/manage/finance",
    icon: "cash-outline",
    subtitle: "Rate cards, the billing run, payment setup and reconciliation",
    title: "Finance",
    tone: "success",
  },
  {
    href: "/manage/finance/statement",
    icon: "receipt-outline",
    subtitle: "Every payment received, day by day, searchable and exportable",
    title: "Statement",
    tone: "success",
  },
  {
    href: "/expenses",
    icon: "wallet-outline",
    subtitle: "Money spent for the hostel: add it, see where it went",
    title: "Expenses",
    tone: "success",
  },
  {
    href: "/stock",
    icon: "cube-outline",
    subtitle: "Rice, daal, vegetables: bought, sent to each branch, what is left",
    title: "Stock",
    tone: "success",
  },
  {
    href: "/manage/bookings",
    icon: "calendar-outline",
    subtitle: "Confirm or decline booked beds, and your share",
    title: "Bookings",
    tone: "brand",
  },
  {
    href: "/(admin)/residents",
    icon: "people-outline",
    subtitle: "Register, move in and out, activation codes, guardians",
    title: "Residents",
    tone: "brand",
  },
  {
    href: "/manage/roll-call",
    icon: "moon-outline",
    subtitle: "Who is in tonight, who is out, and who has not been verified",
    title: "Night status",
    tone: "brand",
  },
  {
    href: "/manage/attendance",
    icon: "location-outline",
    subtitle: "Where residents are today by zone, and absence alerts",
    title: "Attendance",
    tone: "brand",
  },
  {
    href: "/manage/move-history",
    icon: "swap-horizontal-outline",
    subtitle: "Every move-in and move-out, by year",
    title: "Move in / out",
    tone: "neutral",
  },
  {
    href: "/manage/complaints",
    icon: "chatbox-ellipses-outline",
    subtitle: "What residents have raised, and what is still unanswered",
    title: "Complaints",
    tone: "warning",
  },
  {
    href: "/manage/rooms",
    icon: "bed-outline",
    subtitle: "Room types, beds, vacancies and their photos",
    title: "Rooms",
    tone: "brand",
  },
  {
    href: "/manage/notices",
    icon: "megaphone-outline",
    subtitle: "Schedule, target and expire a notice",
    title: "Notices",
    tone: "warning",
  },
  {
    href: "/manage/push-notices",
    icon: "notifications-outline",
    subtitle: "Now, later, daily or on chosen days",
    title: "Push notices",
    tone: "brand",
  },
  {
    href: "/manage/food",
    icon: "restaurant-outline",
    subtitle: "The weekly menu, meal times and the cook's login",
    title: "Food",
    tone: "danger",
  },
  {
    href: "/manage/kyc",
    icon: "ribbon-outline",
    ownerOnly: true,
    subtitle: "Photos, documents, payouts and food, step by step",
    title: "Hostel KYC",
    tone: "brand",
  },
  {
    href: "/manage/wardens",
    icon: "shield-checkmark-outline",
    ownerOnly: true,
    subtitle: "Invite staff, suspend them and set what each one may do",
    title: "Wardens",
    tone: "brand",
  },
  {
    href: "/manage/maintenance",
    icon: "construct-outline",
    subtitle: "The repair queue, its notes, and the approved providers",
    title: "Maintenance",
    tone: "neutral",
  },
  {
    href: "/manage/reports",
    icon: "bar-chart-outline",
    subtitle: "Rent, residents, listing reach, and the month as a PDF",
    title: "Reports",
    tone: "brand",
  },
  {
    href: "/manage/billing",
    icon: "card-outline",
    subtitle: "Days left on your plan, and every invoice and receipt from us",
    title: "Billing",
    tone: "danger",
  },
  {
    href: "/manage/branches",
    icon: "business-outline",
    subtitle: "Other buildings you run on this plan — add one, switch from Home",
    title: "Branches",
    tone: "brand",
  },
  {
    href: "/manage/announcements",
    icon: "notifications-outline",
    subtitle: "A one-off message to residents or guardians, with read counts",
    title: "Send a notification",
    tone: "warning",
  },
  {
    href: "/manage/invite-hostels",
    icon: "megaphone-outline",
    subtitle: "Share your hostel's code — both hostels get extra plan time",
    title: "Invite hostels",
    tone: "success",
  },
  {
    href: "/manage/settings",
    icon: "settings-outline",
    subtitle: "Hostel profile, wardens and the hostel-wide switches",
    title: "Settings",
    tone: "neutral",
  },
];

function BranchAdminMoreScreen() {
  const account = useAppSelector((state) => state.auth.account);
  const preference = useAppSelector((state) => state.ui.themePreference);
  const dispatch = useAppDispatch();
  const { colors } = useAppTheme();

  const query = adminQuery.hostel();
  const hostel = useResource<AdminHostel | null>(query.load, {
    cacheKey: query.key,
    topics: query.topics,
  });
  const [signingOut, setSigningOut] = useState(false);

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

  const area = [hostel.data?.location.area, hostel.data?.location.city]
    .filter(Boolean)
    .join(", ");

  return (
    <Screen
      header={<AppBar actions={<NotificationBell />} title="More" />}
      insideTabs
      onRefresh={hostel.refresh}
      refreshing={hostel.refreshing}
      scroll
    >
      <View className="gap-5 pt-1">
        <Card className="flex-row items-center gap-3">
          <Avatar name={hostel.data?.name ?? account?.name} size="lg" />

          <View className="flex-1 gap-1">
            <Text numberOfLines={1} variant="subtitle">
              {hostel.data?.name ?? account?.name ?? "Your hostel"}
            </Text>

            <Text numberOfLines={1} variant="caption">
              {[account ? readableRole(account.role) : null, account?.email]
                .filter(Boolean)
                .join(" · ")}
            </Text>

            {area ? (
              <View className="flex-row items-center gap-1">
                <Ionicons color={colors.mutedForeground} name="location-outline" size={11} />
                <Text className="flex-1" numberOfLines={1} variant="caption">
                  {area}
                </Text>
              </View>
            ) : null}

            {hostel.data ? (
              <View className="flex-row flex-wrap gap-1.5 pt-0.5">
                <Badge
                  label={hostel.data.status === "PUBLISHED" ? "Published" : "Draft"}
                  tone={hostel.data.status === "PUBLISHED" ? "success" : "warning"}
                />
                <Badge
                  label={
                    hostel.data.verificationStatus === "VERIFIED"
                      ? "Verified"
                      : "Awaiting verification"
                  }
                  tone={hostel.data.verificationStatus === "VERIFIED" ? "success" : "warning"}
                />
              </View>
            ) : null}
          </View>
        </Card>

        <View>
          <SectionHeader
            subtitle="Everything the portal does, without leaving the app"
            title="Manage"
          />
          <View className="gap-3">
            {MANAGE_ROWS.filter(
              (row) => !row.ownerOnly || account?.role === ROLE.HOSTEL_ADMIN,
            ).map((row) => (
              <CardRow
                icon={row.icon}
                key={row.href}
                onPress={() => router.push(row.href)}
                onPressIn={() => prefetchAdminRoute(row.href)}
                subtitle={row.subtitle}
                title={row.title}
                tone={row.tone}
              />
            ))}
          </View>
        </View>

        <View>
          <SectionHeader title="Discover" />
          <Card padding="px-4 py-1">
            <ListRow
              icon="search-outline"
              iconBgColor="#007AFF"
              onPress={() => router.push("/hostels")}
              subtitle="See your listing the way a student does"
              title="Browse hostels"
            />
            <RowDivider inset />
            <ListRow
              icon="people-outline"
              iconBgColor="#FF2D55"
              onPress={() => router.push("/community")}
              onPressIn={prefetchCommunity}
              subtitle="What residents are saying, platform-wide"
              title="Community"
            />
          </Card>
        </View>

        <View>
          <SectionHeader title="App" />
          <Card padding="px-4 py-1">
            <ListRow
              icon={preference === "dark" ? "moon-outline" : "sunny-outline"}
              iconBgColor={preference === "dark" ? "#5E5CE6" : "#FF9500"}
              onPress={() => dispatch(setThemePreference(nextTheme))}
              subtitle={`Currently ${preference}`}
              title="Theme"
              value={`Switch to ${nextTheme}`}
            />
            <RowDivider inset />
            <ListRow
              icon="notifications-outline"
              iconBgColor="#FF3B30"
              onPress={() => router.push("/notifications")}
              subtitle="Everything the platform has sent you"
              title="Notifications"
            />
            <RowDivider inset />
            <ListRow
              icon="shield-checkmark-outline"
              iconBgColor="#AF52DE"
              onPress={() => router.push("/settings")}
              subtitle="Privacy policy and account deletion"
              title="Privacy & account"
            />
          </Card>
        </View>

        <SupportContact />

        <Card padding="px-4 py-1">
          <ListRow
            icon="log-out-outline"
            iconBgColor="#FF3B30"
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

/**
 * With Overall picked in the switcher this tab answers for every branch at
 * once (`components/overall-views.tsx`); otherwise it is the one branch's screen.
 */
export default function AdminMoreScreen() {
  return useIsOverall() ? <OverallTabScreen tab="more" /> : <BranchAdminMoreScreen />;
}
