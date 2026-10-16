import { type ReactNode, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Glyph, type GlyphName } from "@/components/ui/glyph";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import {
  MEAL_TYPES,
  type MealType,
  ROUTINE_DAYS,
  type RoutineDay,
  todayInNepal,
} from "@/lib/food-week";
import { humanizeEnum } from "@/lib/format";

/**
 * The weekly food routine, drawn the way a phone can read it.
 *
 * ## Why this is a component and not two screens' worth of markup
 *
 * The resident Food tab has shown the routine as a day strip over four meal
 * cards since it was built. The public hostel page needs the same routine, from
 * the same `foodRoutine` payload, for someone deciding whether to move in — and
 * the website shows it there as a **7×4 table**, which is the right shape for
 * a 1200dp column and the wrong one for a 360dp screen. Rebuilding the resident
 * layout beside it would have been two renderers for one dataset, drifting apart
 * the way `apps/web`'s five prose pages did (see `components/info-page.tsx`).
 *
 * So the resident screen's day strip and meal card moved here, unchanged, and
 * the public page renders them with nothing in the footer slot.
 *
 * ## What the table becomes
 *
 * Every cell, in the same order, one day at a time. Nothing is dropped: the
 * website's table and this show the same 28 cells from the same array — the
 * difference is that a table asks the reader to scroll sideways through a week
 * to find tonight, and this opens on tonight.
 *
 * Day is resolved in **Nepal time**. `getDay()` on a phone left on another
 * timezone selects the wrong column for the last 5h45m of every day, which is
 * exactly the evening window when people check dinner.
 */

const DAY_LABELS: Record<RoutineDay, string> = {
  FRIDAY: "Fri",
  MONDAY: "Mon",
  SATURDAY: "Sat",
  SUNDAY: "Sun",
  THURSDAY: "Thu",
  TUESDAY: "Tue",
  WEDNESDAY: "Wed",
};

const MEAL_ICONS: Record<MealType, GlyphName> = {
  BREAKFAST: "sunny",
  DINNER: "moon",
  LUNCH: "restaurant",
  SNACKS: "cafe",
};

/** One entry of `foodRoutine.meals`, which both APIs return in this shape. */
export type RoutineMeal = {
  dayOfWeek: string;
  items: string[];
  mealType: string;
  note: string;
  timing: string;
};

export function DayStrip({
  active,
  onChange,
  today,
}: {
  active: RoutineDay;
  onChange: (day: RoutineDay) => void;
  today: RoutineDay;
}) {
  return (
    <ScrollView
      contentContainerClassName="gap-2"
      horizontal
      showsHorizontalScrollIndicator={false}
    >
      {ROUTINE_DAYS.map((day) => {
        const selected = day === active;

        return (
          <Pressable
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            className={`min-w-14 items-center rounded-xl border px-3 py-2 active:opacity-70 ${
              selected ? "border-primary bg-primary" : "border-border"
            }`}
            key={day}
            onPress={() => onChange(day)}
          >
            <Text
              className={`text-sm font-medium ${
                selected ? "text-primary-foreground" : "text-foreground"
              }`}
            >
              {DAY_LABELS[day]}
            </Text>
            {/* Marked even when it is not the selected day, so a reader who has
                browsed to Friday can find their way back. */}
            {day === today ? (
              <Text
                className={`text-[10px] ${
                  selected ? "text-primary-foreground/80" : "text-muted-foreground"
                }`}
              >
                Today
              </Text>
            ) : null}
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

/**
 * One meal of one day.
 *
 * `footer` is the whole reason this is shared rather than copied: the resident
 * screen puts a rating form there, and the public page puts nothing. Rating is
 * per meal per day because that is what the server aggregates — feedback with no
 * meal attached cannot tell an owner that Tuesday dinner is the problem, which
 * is the only thing the feedback is for — so the slot has to be *inside* the
 * card, not a sibling of it.
 */
export function MealCard({
  footer,
  items,
  mealType,
  note,
  timing,
}: {
  /** Rendered under the meal. Given the item list, so a caller can hide itself
   *  on a day the hostel published nothing for. */
  footer?: (context: { hasItems: boolean }) => ReactNode;
  items: string[];
  mealType: MealType;
  note: string;
  timing: string;
}) {
  const { colors } = useAppTheme();

  return (
    <Card className="gap-2">
      <View className="flex-row items-start gap-3">
        <View className="h-11 w-11 items-center justify-center rounded-xl bg-brand-soft">
          <Glyph color={colors.primary} name={MEAL_ICONS[mealType]} size={19} />
        </View>

        <View className="flex-1 gap-1">
          <View className="flex-row items-center justify-between gap-2">
            <Text className="flex-1" variant="label">
              {humanizeEnum(mealType)}
            </Text>
            {timing ? <Badge label={timing} tone="success" /> : null}
          </View>

          <Text variant={items.length ? "body" : "muted"}>
            {items.length ? items.join(", ") : "Not published for this day."}
          </Text>

          {note ? <Text variant="caption">{note}</Text> : null}
        </View>
      </View>

      {footer?.({ hasItems: items.length > 0 })}
    </Card>
  );
}

/**
 * The day strip plus that day's four meals — the routine, whole.
 *
 * Owns the selected day itself. Both callers want it initialised to today and
 * neither has any other use for the value, so lifting it out would be two
 * screens holding a `useState` to pass straight back down.
 */
export function FoodRoutineWeek({
  meals,
  mealFooter,
  timings,
}: {
  /** `foodRoutine.meals`. */
  meals: readonly RoutineMeal[];
  mealFooter?: (context: {
    day: RoutineDay;
    hasItems: boolean;
    mealType: MealType;
  }) => ReactNode;
  /** `foodRoutine.timings` — the hostel's default clock per meal type. */
  timings?: Record<string, string | undefined>;
}) {
  const [day, setDay] = useState<RoutineDay>(() => todayInNepal());
  const today = todayInNepal();

  return (
    <View className="gap-4">
      <DayStrip active={day} onChange={setDay} today={today} />

      <View className="gap-3">
        {MEAL_TYPES.map((mealType) => {
          const meal = meals.find(
            (entry) => entry.dayOfWeek === day && entry.mealType === mealType,
          );

          return (
            <MealCard
              footer={
                mealFooter
                  ? ({ hasItems }) => mealFooter({ day, hasItems, mealType })
                  : undefined
              }
              items={meal?.items ?? []}
              key={mealType}
              mealType={mealType}
              note={meal?.note ?? ""}
              /* The meal's own timing wins; the routine's per-type default is
                 the fallback. A hostel that serves dinner an hour later on
                 Saturdays sets it on the meal, not on the routine. */
              timing={meal?.timing || timings?.[mealType] || ""}
            />
          );
        })}
      </View>
    </View>
  );
}

/**
 * The month-end treat, as its own card.
 *
 * Deliberately not folded into the specials strip the website builds. On the web
 * a noted meal and the month-end treat "read the same way to a visitor, so they
 * share one strip"; here they do not, because the day strip already puts every
 * noted meal on the day it happens — a second copy of Tuesday's note under the
 * heading "Special meals" is the same sentence twice. The month-end special is
 * the one entry that belongs to no day, which is exactly why it needs a card.
 */
export function MonthEndSpecial({
  special,
}: {
  special: { items: string[]; note: string } | null;
}) {
  const { colors } = useAppTheme();

  if (!special) {
    return null;
  }

  return (
    <Card className="gap-2 bg-brand-soft">
      <View className="flex-row items-center gap-2">
        <Glyph color={colors.primary} name="sparkles" size={16} />
        <Text variant="label">Month-end special</Text>
      </View>
      <Text variant="muted">
        {special.items.join(", ") || "Announced closer to the day."}
      </Text>
      {special.note ? <Text variant="caption">{special.note}</Text> : null}
    </Card>
  );
}
