import type { ReactNode } from "react";
import { View } from "react-native";

import { Glyph } from "@/components/ui/glyph";
import { PressableScale } from "@/components/ui/pressable-scale";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";

export function Card({
  children,
  className = "",
  padding = "p-4",
}: {
  children: ReactNode;
  className?: string;
  /**
   * Replaces the default inset rather than adding to it.
   *
   * A card holding rows that carry their own `py-3` wants a *narrower* vertical
   * inset, not a wider one, and passing `py-1` through `className` does not do
   * that — both rules reach the compiled stylesheet and which of them wins is
   * decided by generation order, not by where it sat in the string. So the
   * padding is one slot with one value in it.
   */
  padding?: string;
}) {
  return (
    <View className={`rounded-2xl border border-border bg-card ${padding} ${className}`}>
      {children}
    </View>
  );
}

export function SectionHeader({
  action,
  subtitle,
  title,
}: {
  action?: ReactNode;
  subtitle?: string;
  title: string;
}) {
  return (
    <View className="mb-3 flex-row items-end justify-between">
      <View className="flex-1">
        <Text variant="subtitle">{title}</Text>
        {subtitle ? <Text variant="caption">{subtitle}</Text> : null}
      </View>
      {action}
    </View>
  );
}

/**
 * "See all" — a section header's escape hatch to the full list.
 *
 * The counterpart to showing only part of something. A section that displays the
 * four queues an owner deals with daily is more useful than one listing every
 * queue there is, but only if the rest is one tap away and visibly so; without
 * this, trimming a section is just hiding things.
 *
 * Text and a chevron rather than a button. It sits on the same line as a heading
 * and must not out-weigh it — a filled control up there reads as the section's
 * main action, which is the opposite of what this is.
 */
export function SectionLink({
  label = "See all",
  onPress,
  onPressIn,
}: {
  label?: string;
  onPress: () => void;
  /**
   * Touch-down. Starts the fetch the destination will make — see `<ListRow>`'s
   * note for why it must stay side-effect-free.
   */
  onPressIn?: () => void;
}) {
  const { colors } = useAppTheme();

  return (
    <PressableScale
      accessibilityRole="button"
      className="flex-row items-center gap-0.5"
      hitSlop={10}
      onPress={() => {        onPress();
      }}
      onPressIn={onPressIn}
    >
      <Text className="text-xs font-semibold text-primary">{label}</Text>
      <Glyph color={colors.primary} name="chevron-forward" size={13} />
    </PressableScale>
  );
}
