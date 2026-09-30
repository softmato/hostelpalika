import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { Pressable, View } from "react-native";
import Svg, { Circle } from "react-native-svg";

import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useResource } from "@/hooks/use-resource";
import { getHostelKyc } from "@/lib/admin-api";

export const KYC_CACHE_KEY = "admin:kyc";

/** Progress as a ring — read before it is counted. */
export function KycRing({ percent, size = 96 }: { percent: number; size?: number }) {
  const { colors } = useAppTheme();
  const stroke = size / 10;
  const radius = (size - stroke) / 2;
  const length = 2 * Math.PI * radius;

  return (
    <View style={{ height: size, width: size }}>
      <Svg height={size} style={{ transform: [{ rotate: "-90deg" }] }} width={size}>
        <Circle cx={size / 2} cy={size / 2} fill="none" r={radius} stroke={colors.muted} strokeWidth={stroke} />
        <Circle
          cx={size / 2}
          cy={size / 2}
          fill="none"
          r={radius}
          stroke={colors.primary}
          strokeDasharray={length}
          strokeDashoffset={length * (1 - percent / 100)}
          strokeLinecap="round"
          strokeWidth={stroke}
        />
      </Svg>
      <View className="absolute inset-0 items-center justify-center">
        <Text className="font-bold text-foreground" style={{ fontSize: size / 4.5 }}>
          {percent}%
        </Text>
      </View>
    </View>
  );
}

/** Home nudge. Renders nothing once KYC is complete, or for a warden (403). */
export function KycCard() {
  const { colors } = useAppTheme();
  const kyc = useResource(getHostelKyc, { cacheKey: KYC_CACHE_KEY });

  if (!kyc.data || kyc.data.percent >= 100) {
    return null;
  }

  return (
    <Pressable
      accessibilityLabel={`Complete hostel KYC, ${kyc.data.percent}% done`}
      accessibilityRole="button"
      className="flex-row items-center gap-4 rounded-3xl border border-primary/30 bg-brand-soft p-4 active:opacity-70"
      onPress={() => router.push("/manage/kyc")}
    >
      <KycRing percent={kyc.data.percent} size={52} />
      <View className="flex-1">
        <Text className="font-bold text-foreground">Complete hostel KYC</Text>
        <Text className="text-muted-foreground" variant="caption">
          Unlock every feature
        </Text>
      </View>
      <Ionicons color={colors.primary} name="chevron-forward" size={20} />
    </Pressable>
  );
}
