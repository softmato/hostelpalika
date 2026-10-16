import { Pressable, View } from "react-native";

import { Glyph } from "@/components/ui/glyph";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { MAX_STARS } from "@/lib/reviews";

/**
 * A 1–5 star row.
 *
 * This is the one place the mobile review form deliberately departs from the web,
 * which uses `<input type="number" min="1" max="5">`. That is a reasonable desktop
 * control and a poor phone one: it opens a numeric keyboard for a value with five
 * possible answers, and on Android a number field accepts "0" and "12" happily and
 * only complains on submit. Five tap targets need no keyboard and cannot express an
 * invalid value.
 *
 * **`0` means unscored**, matching `ReviewDraft` — five hollow stars, no score
 * printed. Tapping the star that is already the score does *not* clear it: the
 * server has no way to un-rate a category (`$set` never clears an absent key), so a
 * gesture that appeared to clear one would silently do nothing. Only the label says
 * anything about that; the control simply does not offer it.
 */

const SCORE_WORDS = ["", "Terrible", "Poor", "Okay", "Good", "Excellent"] as const;

export function StarRating({
  label,
  onChange,
  size = 28,
  sublabel,
  value,
}: {
  label: string;
  onChange: (value: number) => void;
  size?: number;
  sublabel?: string;
  value: number;
}) {
  const { colors } = useAppTheme();

  return (
    <View className="gap-1.5">
      <View className="flex-row items-center gap-2">
        <View className="flex-1">
          <Text variant="label">{label}</Text>
          {sublabel ? <Text variant="caption">{sublabel}</Text> : null}
        </View>

        {/* The word, not the number: "Good" is what somebody means by four stars,
            and it also confirms the tap registered on the row they aimed at. */}
        {value >= 1 ? (
          <Text className="text-primary" variant="label">
            {SCORE_WORDS[value]}
          </Text>
        ) : null}
      </View>

      <View
        accessibilityLabel={label}
        accessibilityRole="adjustable"
        accessibilityValue={{
          max: MAX_STARS,
          min: 0,
          now: value,
          text: value >= 1 ? `${value} of ${MAX_STARS}, ${SCORE_WORDS[value]}` : "Not scored",
        }}
        className="flex-row gap-1.5"
      >
        {Array.from({ length: MAX_STARS }, (_, index) => index + 1).map((star) => {
          const filled = star <= value;

          return (
            <Pressable
              accessibilityLabel={`${star} star${star === 1 ? "" : "s"}`}
              accessibilityRole="button"
              hitSlop={6}
              key={star}
              onPress={() => {                onChange(star);
              }}
            >
              <Glyph
                color={filled ? colors.warning : colors.border}
                name="star"
                variant={filled ? "solid" : "line"}
                size={size}
              />
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
