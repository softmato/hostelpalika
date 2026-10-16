import { BlurView } from "expo-blur";
import { router } from "expo-router";
import type { ReactNode } from "react";
import { Pressable, View } from "react-native";

import { AppBar } from "@/components/ui/app-bar";
import { Button } from "@/components/ui/button";
import { Glyph } from "@/components/ui/glyph";
import { Screen } from "@/components/ui/screen";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { promptKyc } from "@/lib/kyc-lock";

/**
 * A frozen feature: the thing itself, iced over, with a lock — tap it and you
 * are asked to complete KYC (docs/QUICK_SIGNUP_KYC_TRIAL.md).
 *
 * The frost is the `GlassPanel` recipe (its doc explains why Android gets a
 * wash rather than a live blur): a light blur with the theme's own background
 * over it, so it reads as ice in both themes without a colour of its own.
 * What is underneath is never pressable — the lock is the only answer.
 */
export function KycFrost({
  center = false,
  children,
  className = "",
  frozen = true,
  label,
  radius = 16,
}: {
  /** The lock in the middle — a grid tile — rather than at the row's end. */
  center?: boolean;
  children: ReactNode;
  /** The outer box: `flex-1` for a cell in a row. */
  className?: string;
  frozen?: boolean;
  /** What is frozen, for screen readers. */
  label: string;
  radius?: number;
}) {
  const { colors, isDark } = useAppTheme();

  if (!frozen) {
    return <>{children}</>;
  }

  return (
    <View className={className} style={{ borderRadius: radius, overflow: "hidden" }}>
      <View
        accessibilityElementsHidden
        className={className ? "flex-1" : undefined}
        importantForAccessibility="no-hide-descendants"
        pointerEvents="none"
      >
        {children}
      </View>
      <Pressable
        accessibilityHint="Complete your hostel KYC to open it"
        accessibilityLabel={`${label}, locked`}
        accessibilityRole="button"
        className="absolute inset-0 active:opacity-80"
        onPress={promptKyc}
      >
        {/* `style`, not `className`: BlurView has no cssInterop, so `flex-1` was
            dropped, the frost collapsed to 0 height and the lock sat half off the top. */}
        <BlurView intensity={14} style={{ flex: 1 }} tint={isDark ? "dark" : "light"}>
          <View className={`flex-1 justify-center bg-background/60 ${center ? "items-center" : "items-end px-4"}`}>
            <View className="h-8 w-8 items-center justify-center rounded-full border border-border bg-card">
              <Glyph color={colors.foreground} name="lock-closed" size={15} />
            </View>
          </View>
        </BlurView>
      </Pressable>
    </View>
  );
}

/**
 * A whole tab frozen — Payments, for one. Still shapes of cards under the ice
 * rather than skeletons: nothing is loading, it is locked.
 */
export function KycLockedScreen({ title }: { title: string }) {
  return (
    <Screen header={<AppBar title={title} />} insideTabs scroll>
      <View className="gap-5 pb-6">
        <KycFrost center label={title}>
          <View className="gap-3">
            {[0, 1, 2].map((row) => (
              <View className="gap-3 rounded-2xl border border-border bg-card p-4" key={row}>
                <View className="h-4 w-2/5 rounded-full bg-muted" />
                <View className="h-3 w-4/5 rounded-full bg-muted" />
                <View className="h-3 w-3/5 rounded-full bg-muted" />
              </View>
            ))}
          </View>
        </KycFrost>
        <View className="items-center gap-2">
          <Text className="text-center" variant="subtitle">
            {title} opens after KYC
          </Text>
          <Text className="text-center" variant="muted">
            Complete your hostel KYC. Our team checks it within 24 hours.
          </Text>
        </View>
        <Button label="Open KYC" onPress={() => router.push("/manage/kyc")} />
      </View>
    </Screen>
  );
}
