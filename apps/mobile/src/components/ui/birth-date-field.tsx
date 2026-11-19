import { bsMonthName } from "@hostel/calendar/bs";
import { useState } from "react";
import { Pressable, ScrollView, View, type ViewStyle } from "react-native";

import { Button } from "@/components/ui/button";
import { Glyph } from "@/components/ui/glyph";
import { FieldLabel } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { Sheet } from "@/components/ui/sheet";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { adToBs, type BirthCalendar, bsToAd, daysIn, isoOf, partsOf } from "@/lib/birth-date";

const AD_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const YEARS_BACK = 77;
const CALENDARS = [
  { label: "BS (Nepali)", value: "BS" },
  { label: "AD (English)", value: "AD" },
] as const;

export type BirthDate = {
  /** Always AD, `YYYY-MM-DD`: what age, the ID card and scans read. */
  ad: string;
  calendar: BirthCalendar;
  /** The date exactly as picked, in `calendar`. */
  asEntered: string;
};

const monthName = (calendar: BirthCalendar, month: number) =>
  calendar === "AD" ? AD_MONTHS[month - 1]! : bsMonthName(month);

/** `27 July 2001` or `12 Shrawan 2058 BS`. */
export function formatBirthDate(calendar: BirthCalendar, iso: string) {
  const parts = partsOf(iso);

  return parts ? `${parts.day} ${monthName(calendar, parts.month)} ${parts.year}${calendar === "BS" ? " BS" : ""}` : null;
}

/**
 * Date of birth as a calendar field (owner, 2026-11-16): tapping opens a sheet
 * where the person picks BS or AD, then year, month and day. Whatever they pick
 * in, `onChange` hands back the AD date plus the original. Replaces the typed
 * `YYYY-MM-DD` box on the admission form and the AD-only picker on the ID card.
 */
export function BirthDateField({
  error,
  label = "Date of birth",
  onChange,
  value,
}: {
  error?: string | null;
  label?: string;
  onChange: (value: BirthDate) => void;
  /** Blank `ad` = nothing picked yet. `calendar`/`asEntered` may be blank for an AD-only record. */
  value: { ad: string; asEntered?: string; calendar?: string };
}) {
  const { colors } = useAppTheme();
  const shownCalendar: BirthCalendar = value.calendar === "BS" ? "BS" : "AD";
  const shownIso = value.calendar === "BS" && value.asEntered ? value.asEntered : value.ad;
  const shown = value.ad ? formatBirthDate(shownCalendar, shownIso) : null;

  const [open, setOpen] = useState(false);
  const [calendar, setCalendar] = useState<BirthCalendar>("BS");
  const [year, setYear] = useState(0);
  const [month, setMonth] = useState(1);
  const [day, setDay] = useState(1);

  const thisYear = Number((calendar === "BS" ? adToBs(new Date().toISOString().slice(0, 10)) : null)?.slice(0, 4) ?? new Date().getFullYear());
  const years = Array.from({ length: YEARS_BACK }, (_, i) => thisYear - i);
  const days = daysIn(calendar, year, month);

  /** Starts on what is saved, in the calendar it was saved in; else BS, twenty years back. */
  const openSheet = () => {
    const start = partsOf(shownIso);
    const startCalendar: BirthCalendar = start ? shownCalendar : "BS";
    const nowBs = Number(adToBs(new Date().toISOString().slice(0, 10))?.slice(0, 4) ?? 2083);

    setCalendar(startCalendar);
    setYear(start?.year ?? (startCalendar === "BS" ? nowBs : new Date().getFullYear()) - 20);
    setMonth(start?.month ?? 1);
    setDay(start?.day ?? 1);
    setOpen(true);
  };

  /** Switching calendar converts the picked day rather than resetting it. */
  const switchCalendar = (next: BirthCalendar) => {
    if (next === calendar) return;
    const iso = isoOf(year, month, Math.min(day, days));
    const converted = partsOf((next === "BS" ? adToBs(iso) : bsToAd(iso)) ?? "");

    setCalendar(next);
    if (converted) {
      setYear(converted.year);
      setMonth(converted.month);
      setDay(converted.day);
    }
  };

  const pickedIso = isoOf(year, month, Math.min(day, days));
  const pickedAd = calendar === "AD" ? pickedIso : bsToAd(pickedIso);
  const future = pickedAd !== null && pickedAd > new Date().toISOString().slice(0, 10);

  return (
    <View className="gap-1.5">
      <FieldLabel>{label}</FieldLabel>
      <Pressable
        accessibilityLabel={`${label}: ${shown ?? "not set"}. Change`}
        accessibilityRole="button"
        className={`flex-row items-center gap-2 active:opacity-70 ${
          "h-11 rounded-lg border bg-card px-3"
        } ${error ? "border-destructive" : ""}`}
        style={error ? undefined : { borderColor: colors.input }}
        onPress={openSheet}
      >
        <Text className={`flex-1 text-base ${shown ? "text-foreground" : "text-muted-foreground"}`} variant={null}>
          {shown ?? "Pick the date"}
        </Text>
        <Glyph color={colors.primary} name="calendar" size={20} />
      </Pressable>
      {error ? (
        <Text className="text-destructive" variant="caption">
          {error}
        </Text>
      ) : null}

      <Sheet
        footer={
          <Button
            disabled={!pickedAd || future}
            label={future ? "That day has not come yet" : `Set ${formatBirthDate(calendar, pickedIso)}`}
            onPress={() => {
              if (!pickedAd || future) return;
              onChange({ ad: pickedAd, asEntered: pickedIso, calendar });
              setOpen(false);
            }}
          />
        }
        onClose={() => setOpen(false)}
        open={open}
        tall
        title={label}
      >
        <View className="gap-6 pb-2">
          <Segmented onChange={switchCalendar} options={CALENDARS} value={calendar} />

          <View className="gap-2">
            <FieldLabel>Year</FieldLabel>
            <ScrollView
              contentContainerStyle={{ gap: 8 }}
              horizontal
              showsHorizontalScrollIndicator={false}
              style={{ flexGrow: 0, height: 40 }}
            >
              {years.map((value) => (
                <Cell key={value} label={String(value)} on={value === year} onPress={() => setYear(value)} style={{ height: 40, paddingHorizontal: 14 }} />
              ))}
            </ScrollView>
          </View>

          <View className="gap-2">
            <FieldLabel>Month</FieldLabel>
            <View className="flex-row flex-wrap" style={{ marginHorizontal: -4 }}>
              {Array.from({ length: 12 }, (_, i) => i + 1).map((value) => (
                <View key={value} style={{ padding: 4, width: "25%" }}>
                  <Cell label={calendar === "AD" ? monthName(calendar, value).slice(0, 3) : monthName(calendar, value)} on={value === month} onPress={() => setMonth(value)} style={{ height: 40 }} />
                </View>
              ))}
            </View>
          </View>

          <View className="gap-2">
            <FieldLabel>Day</FieldLabel>
            <View className="flex-row flex-wrap" style={{ marginHorizontal: -3 }}>
              {Array.from({ length: days }, (_, i) => i + 1).map((value) => (
                <View key={value} style={{ padding: 3, width: `${100 / 7}%` }}>
                  <Cell label={String(value)} on={value === Math.min(day, days)} onPress={() => setDay(value)} style={{ aspectRatio: 1 }} />
                </View>
              ))}
            </View>
          </View>
        </View>
      </Sheet>
    </View>
  );
}

/** One tappable year, month or day. Sized by explicit styles so nothing wraps into its neighbour. */
function Cell({ label, on, onPress, style }: { label: string; on: boolean; onPress: () => void; style: ViewStyle }) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: on }}
      className={`items-center justify-center rounded-full active:opacity-70 ${on ? "bg-primary" : "bg-muted"}`}
      onPress={onPress}
      style={style}
    >
      <Text className={`text-sm ${on ? "font-semibold text-primary-foreground" : "text-foreground"}`} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}
