import { Ionicons } from "@expo/vector-icons";
import { Pressable, View } from "react-native";

import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";

/**
 * A circled icon action, with an optional count over its corner.
 *
 * Lived inside `discovery-header.tsx` until the admin group needed the same
 * bell in its own app bars. Nothing about it was ever specific to the public
 * home — it is the header-action shape the whole app uses.
 *
 * Capped at `9+`: the badge is 18px across, and a three-digit count either
 * overflows the circle or shrinks the digits past reading size. Nobody acts on
 * the difference between 47 and 112 unread.
 *
 * ## `tone="onAccent"`
 *
 * The default draws a `border-border` ring around a `foreground` glyph, which is
 * correct on the page background and invisible on a painted one — the admin
 * Home hero is a saturated gradient, and the bell sitting on it disappeared into
 * it. On that tone the glyph is white, the ring is a white wash, and the badge
 * inverts: a `bg-primary` pill on a brand-coloured card is the one combination
 * where the count cannot be read at all.
 *
 * Those are colour literals rather than palette values on purpose. A painted
 * surface does not re-theme, but `colors.foreground` does — it is near-black in
 * light mode and near-white in dark — so a themed glyph would disappear into
 * the gradient on exactly one of the two schemes.
 */
export function IconButton({
  badge = 0,
  label,
  name,
  onPress,
  size = "md",
  tone = "default",
}: {
  badge?: number;
  label: string;
  name: keyof typeof Ionicons.glyphMap;
  onPress: () => void;
  /** `sm` for a secondary action beside a primary one in the bar. */
  size?: "md" | "sm";
  /** `onAccent` for a painted surface — see the note above. */
  tone?: "default" | "onAccent";
}) {
  const { colors } = useAppTheme();
  const onAccent = tone === "onAccent";

  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      className={`${size === "sm" ? "h-8 w-8" : "h-10 w-10"} items-center justify-center rounded-full border active:opacity-70 ${
        onAccent ? "border-white/25 bg-white/15" : "border-border"
      }`}
      hitSlop={6}
      onPress={onPress}
    >
      <Ionicons color={onAccent ? "#ffffff" : colors.foreground} name={name} size={size === "sm" ? 15 : 19} />

      {badge > 0 ? (
        <View
          className={`absolute -right-0.5 -top-0.5 h-[18px] min-w-[18px] items-center justify-center rounded-full px-1 ${
            onAccent ? "bg-white" : "bg-primary"
          }`}
        >
          <Text
            className={`text-[10px] font-bold ${
              onAccent ? "text-[#0e7490]" : "text-primary-foreground"
            }`}
          >
            {badge > 9 ? "9+" : badge}
          </Text>
        </View>
      ) : null}
    </Pressable>
  );
}
