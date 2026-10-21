import { router } from "expo-router";
import { View } from "react-native";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Glyph } from "@/components/ui/glyph";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useDates } from "@/hooks/use-dates";
import { readApiError } from "@/lib/api-contract";
import { adoptRoleChange } from "@/lib/auth-session";
import { openConfirm } from "@/lib/confirm";
import { type HeldHostel, reclaimHostel } from "@/lib/registration-api";
import { toastError, toastSuccess } from "@/lib/toast";
import { PLATFORM_NAME } from "@hostel/brand/brand";

/**
 * A hostel the owner took off the platform, still claimable while its data is
 * held (docs/HOSTEL_LEAVE_PLATFORM.md). Shown on Profile, which is where a
 * former owner lands: leaving made them a public account again.
 */
export function HeldHostelCard({ hostel }: { hostel: HeldHostel }) {
  const { colors } = useAppTheme();
  const dates = useDates();

  const claim = () =>
    openConfirm({
      confirmLabel: "Claim it back",
      message: `${hostel.hostelName} comes back on ${PLATFORM_NAME} exactly as you left it — portal, residents and data.`,
      onConfirm: async () => {
        try {
          await reclaimHostel(hostel.requestId);
          toastSuccess("Your hostel is back", hostel.hostelName);

          if (!(await adoptRoleChange())) {
            router.replace("/(admin)");
          }
        } catch (error) {
          toastError("Could not claim it back", readApiError(error));
        }
      },
      title: `Claim ${hostel.hostelName} back?`,
    });

  return (
    <Card className="gap-3">
      <View className="flex-row items-center gap-3">
        <View className="h-11 w-11 items-center justify-center rounded-xl bg-brand-soft">
          <Glyph color={colors.primary} name="business" size={22} />
        </View>
        <View className="flex-1">
          <Text numberOfLines={1} variant="label">
            {hostel.hostelName}
          </Text>
          <Text variant="caption">{`Held until ${dates.date(hostel.holdUntil)}`}</Text>
        </View>
      </View>
      <Button icon="refresh" label="Claim hostel back" onPress={claim} />
    </Card>
  );
}
