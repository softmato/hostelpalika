import { router } from "expo-router";
import { Pressable, View } from "react-native";

import { Card } from "@/components/ui/card";
import { Glyph, type GlyphName } from "@/components/ui/glyph";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useSiteConfig } from "@/hooks/use-site-config";
import { hostelLeavePromise } from "@hostel/constants/hostel-leave";

/**
 * "Your data stays yours" — leave any time, take everything, change your mind
 * within the hold (docs/HOSTEL_LEAVE_PLATFORM.md). The web's `LeavePromise`,
 * on Pricing, plan Billing and KYC. `leaveLink` adds the door to the leave
 * screen, for an owner already inside the portal.
 */
export function LeavePromiseCard({ leaveLink = false }: { leaveLink?: boolean }) {
  const { colors } = useAppTheme();
  const promise = hostelLeavePromise(useSiteConfig().config.leaveHold);

  return (
    <Card className="gap-3">
      <View className="flex-row items-center gap-2.5">
        <View className="h-9 w-9 items-center justify-center rounded-xl bg-brand-soft">
          <Glyph color={colors.primary} name="shield-checkmark" size={18} />
        </View>
        <Text className="flex-1" variant="label">
          {promise.title}
        </Text>
        {leaveLink ? (
          <Pressable accessibilityRole="link" className="active:opacity-70" onPress={() => router.push("/manage/leave")}>
            <Text style={{ color: colors.primary, fontWeight: "600" }} variant="caption">
              How to leave
            </Text>
          </Pressable>
        ) : null}
      </View>
      {promise.points.map((point) => (
        <View className="flex-row items-start gap-3" key={point.title}>
          <Glyph color={colors.primary} name={point.icon as GlyphName} size={18} />
          <View className="flex-1 gap-0.5">
            <Text variant="label">{point.title}</Text>
            <Text variant="caption">{point.body}</Text>
          </View>
        </View>
      ))}
    </Card>
  );
}
