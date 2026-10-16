import { View } from "react-native";

import { Card, SectionHeader } from "@/components/ui/card";
import { Glyph } from "@/components/ui/glyph";
import { ListRow, RowDivider } from "@/components/ui/list-row";
import { useAppDispatch, useAppSelector } from "@/hooks/redux";
import { useAppTheme } from "@/hooks/use-app-theme";
import { calendarExample, CALENDAR_LABELS } from "@/lib/calendar";
import {
  type CalendarPreference,
  setCalendarPreference,
} from "@/store/slices/uiSlice";

/**
 * The calendar picker — Bikram Sambat or Gregorian, for every date in the app.
 *
 * ## Why it is a component and not a block on one screen
 *
 * It used to live inside `app/manage/settings.tsx` alone, because the calendar
 * was framed as the hostel's bookkeeping choice and the owner was the only
 * person with a reason to change it. Since the preference now decides what a
 * *resident* reads on their Payments screen, and a cook on their menu, it has to
 * be reachable by all of them — so it renders in the shared `app/settings.tsx`
 * too, off the same slice, and flipping it in either place moves both.
 *
 * Duplicating the markup instead would be two pickers that drift: one of them
 * eventually grows a third option, or stops showing the worked example, and
 * which one you get depends on which door you came in.
 *
 * ## The options, and the example under each
 *
 * BS leads because it is the default. The list must not reorder itself around
 * the current choice — the row under the thumb changing meaning between visits
 * is how a settings screen gets you to pick the wrong thing.
 *
 * Only the naming half is a constant. The example beside it is *today* written
 * in that calendar, built at render by `calendarExample`, because a frozen
 * `18 Aug 2026` under "English date" is a wrong date on every other day of the
 * year — and a wrong date is the one thing a calendar picker cannot show, since
 * the reader is standing there deciding which calendar to trust.
 *
 * Radio rows rather than a `<Segmented>`: two options that each need a worked
 * example under them do not fit inside a segment, and the example is the point.
 * Same shape as the theme picker it sits beside, deliberately.
 */
const CALENDAR_OPTIONS = [
  {
    label: CALENDAR_LABELS.BS,
    system: "Bikram Sambat",
    value: "BS",
  },
  {
    label: CALENDAR_LABELS.AD,
    system: "Gregorian",
    value: "AD",
  },
] as const satisfies readonly {
  label: string;
  system: string;
  value: CalendarPreference;
}[];

export function CalendarPreferenceCard() {
  const dispatch = useAppDispatch();
  const calendar = useAppSelector((state) => state.ui.calendarPreference);
  const { colors } = useAppTheme();

  return (
    <View>
      <SectionHeader subtitle="Stored on this phone only" title="Dates" />
      <Card>
        {CALENDAR_OPTIONS.map((option, index) => {
          const active = option.value === calendar;

          return (
            <View key={option.value}>
              {index > 0 ? <RowDivider /> : null}
              <ListRow
                onPress={() => dispatch(setCalendarPreference(option.value))}
                right={
                  <Glyph
                    color={active ? colors.primary : colors.border}
                    name={active ? "radio-button-on" : "radio-button-off"} variant={active ? "solid" : "line"}
                    size={20}
                  />
                }
                subtitle={`${option.system} — ${calendarExample(option.value)}`}
                title={option.label}
              />
            </View>
          );
        })}
      </Card>
    </View>
  );
}
