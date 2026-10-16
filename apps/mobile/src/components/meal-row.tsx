import { View } from "react-native";

import { Badge } from "@/components/ui/badge";
import { Glyph, type GlyphName } from "@/components/ui/glyph";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { humanizeEnum } from "@/lib/format";

/**
 * One meal, drawn the same way on every screen that shows one.
 *
 * Four screens show a meal — the resident's home and food tabs, the guardian's
 * home, and the cook's weekly routine — and before this they showed it three
 * different ways: a `<ListRow>` with the items truncated to one line, a plain
 * icon beside a heading, and a row with the timing as trailing text. The same
 * dinner looked like a different thing depending on who was looking at it, and
 * a parent asking their child about it was reading a shorter version of the
 * answer.
 *
 * ## The items get two lines
 *
 * "Rice, dal, seasonal vegetable, chicken curry, pickle" is exactly the string a
 * one-line row cuts at the part somebody cares about. Two lines fits the
 * realistic worst case on a 320dp phone; past that it truncates, which by then
 * is a menu nobody reads to the end of anyway.
 *
 * ## The timing is a badge, not trailing text
 *
 * It is the second thing anyone looks for — "is dinner at 7 or 8" — and trailing
 * muted text at the end of a row is where it goes to be missed.
 */

export const MEAL_ICONS: Record<string, GlyphName> = {
  BREAKFAST: "sunny",
  DINNER: "moon",
  LUNCH: "restaurant",
  SNACKS: "cafe",
};

export function mealIcon(mealType: string): GlyphName {
  return MEAL_ICONS[mealType] ?? "restaurant";
}

export function MealRow({
  items,
  mealType,
  note,
  /** What to say when the kitchen has published nothing for this slot. */
  placeholder = "Not set",
  timing,
}: {
  items: string[];
  mealType: string;
  note?: string;
  placeholder?: string;
  timing?: string;
}) {
  const { colors } = useAppTheme();

  return (
    <View className="flex-row items-start gap-3 rounded-xl border border-border bg-muted/20 p-3">
      <View className="h-11 w-11 items-center justify-center rounded-xl bg-brand-soft">
        <Glyph color={colors.primary} name={mealIcon(mealType)} size={19} />
      </View>

      <View className="flex-1 gap-1">
        <View className="flex-row items-center justify-between gap-2">
          <Text className="flex-1" numberOfLines={1} variant="label">
            {humanizeEnum(mealType)}
          </Text>
          {timing ? <Badge label={timing} tone="success" /> : null}
        </View>

        <Text numberOfLines={2} variant={items.length > 0 ? "muted" : "caption"}>
          {items.length > 0 ? items.join(", ") : placeholder}
        </Text>

        {note ? (
          <Text numberOfLines={1} variant="caption">
            {note}
          </Text>
        ) : null}
      </View>
    </View>
  );
}
