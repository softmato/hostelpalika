import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useCallback, useState } from "react";
import { View } from "react-native";

import { SupportContact } from "@/components/support-contact";
import { AppBar } from "@/components/ui/app-bar";
import { Card, SectionHeader } from "@/components/ui/card";
import { ListRow, RowDivider } from "@/components/ui/list-row";
import { Screen } from "@/components/ui/screen";
import { Text } from "@/components/ui/text";
import { useAppDispatch, useAppSelector } from "@/hooks/redux";
import { useAppTheme } from "@/hooks/use-app-theme";
import { endSession } from "@/lib/auth-session";
import { prefetchCommunity } from "@/lib/community-queries";
import { openConfirm } from "@/lib/confirm";
import { setThemePreference } from "@/store/slices/uiSlice";

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
  const preference = useAppSelector((state) => state.ui.themePreference);
  const dispatch = useAppDispatch();
  const { colors } = useAppTheme();
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

  return (
    <Screen header={<AppBar title="More" />} insideTabs scroll>
      <View className="gap-5 pt-1">
        <Card className="gap-1">
          <Text variant="subtitle">{account?.name ?? "Your account"}</Text>
          <Text variant="caption">{account?.email ?? account?.phone ?? ""}</Text>
        </Card>

        <View>
          <SectionHeader title="Discover" />
          <Card>
            <ListRow
              icon="search-outline"
              onPress={() => router.push("/hostels")}
              subtitle="Browse and compare hostels across Nepal"
              title="Explore hostels"
            />
            <RowDivider inset />
            <ListRow
              icon="people-outline"
              onPress={() => router.push("/community")}
              // Touch-down warms the feed and the spaces rail — see
              // `prefetchCommunity`.
              onPressIn={prefetchCommunity}
              subtitle="Ask, answer and see what residents are saying"
              title="Community"
            />
          </Card>
        </View>

        <View>
          <SectionHeader title="App" />
          <Card>
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
              subtitle="Everything the platform has sent you"
              title="Notifications"
            />
            <RowDivider inset />
            <ListRow
              icon="shield-checkmark-outline"
              onPress={() => router.push("/settings")}
              subtitle="Privacy policy and account deletion"
              title="Privacy & account"
            />
          </Card>
        </View>

        <SupportContact />

        <Card>
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
