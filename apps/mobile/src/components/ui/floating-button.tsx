import { BlurView } from "expo-blur";
import { ActivityIndicator, Pressable, View } from "react-native";

import { Glyph, type GlyphName } from "@/components/ui/glyph";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";

/**
 * A translucent pill that floats over the content.
 *
 * Used where an action has to stay reachable while the page scrolls under it —
 * the signed-out Log in call to action, and later the resident SOS button.
 *
 * Frosted rather than solid: at 82% the brand green still reads as a button and
 * as unmistakably green, while the content sliding beneath stays legible enough
 * that the page does not feel truncated. The `BlurView` behind it is what keeps
 * that readable — over plain translucency, text under the pill shows through as
 * unreadable smears rather than a soft wash.
 *
 * Positioning belongs to the caller (`<Screen floating={...}>`), which knows
 * where the system inset and the tab bar are.
 */
export function FloatingButton({
  compact = false,
  icon,
  label,
  loading = false,
  onPress,
  tone = "brand",
}: {
  /** Shrink to fit the label — for a secondary action sharing the row. */
  compact?: boolean;
  icon?: GlyphName;
  label: string;
  loading?: boolean;
  onPress: () => void;
  tone?: "brand" | "danger";
}) {
  const { colors, isDark } = useAppTheme();

  const tint = tone === "danger" ? colors.destructive : colors.primary;

  return (
    <View
      // Spans the screen's content width by default. A primary action is easier
      // to hit and reads as the way forward when it is the full width of the
      // page, rather than a small pill floating in the middle of it.
      className={`overflow-hidden rounded-full ${compact ? "" : "w-full"}`}
      style={{
        // A soft lift so the pill separates from whatever scrolls behind it;
        // without it a translucent button on a busy list looks like part of the
        // list rather than something on top of it.
        elevation: 8,
        shadowColor: "#000",
        shadowOffset: { height: 6, width: 0 },
        shadowOpacity: isDark ? 0.45 : 0.18,
        shadowRadius: 14,
      }}
    >
      <BlurView intensity={28} tint={isDark ? "dark" : "light"}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ busy: loading, disabled: loading }}
          className="h-14 flex-row items-center justify-center gap-2 px-6 active:opacity-85"
          disabled={loading}
          onPress={() => {
            onPress();
          }}
          style={{ backgroundColor: `${tint}D1` }}
        >
          {loading ? (
            <ActivityIndicator color="#ffffff" size="small" />
          ) : icon ? (
            <Glyph color="#ffffff" name={icon} size={19} />
          ) : null}

          <Text className="text-base font-semibold text-white">{label}</Text>
        </Pressable>
      </BlurView>
    </View>
  );
}
