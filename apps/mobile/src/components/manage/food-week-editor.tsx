import { Ionicons } from "@expo/vector-icons";
import { Copy } from "lucide-react-native";
import { useState } from "react";
import { Pressable, View } from "react-native";

import type { FoodWeek } from "@/components/manage/food-week";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { Sheet } from "@/components/ui/sheet";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { cellKey, copyMeals, splitItems } from "@/lib/food-draft";
import { MEAL_TYPES, ROUTINE_DAYS, type MealType, type RoutineDay } from "@/lib/food-week";
import { humanizeEnum } from "@/lib/format";

const ICONS: Record<MealType, keyof typeof Ionicons.glyphMap> = {
  BREAKFAST: "cafe-outline", LUNCH: "restaurant-outline", SNACKS: "fast-food-outline", DINNER: "moon-outline",
};
const DISHES = ["Dal", "Bhat", "Tarkari", "Achar", "Chiura", "Tea", "Paratha", "Roti", "Anda curry", "Chicken curry", "Momo", "Khir"];
/** One tap for the usual slots; anything else is typed. */
const TIME_PRESETS: Record<MealType, string[]> = {
  BREAKFAST: ["6:00 – 7:00 AM", "7:00 – 8:00 AM", "7:30 – 9:00 AM"],
  LUNCH: ["9:00 – 10:00 AM", "11:00 AM – 12:00 PM", "12:00 – 1:00 PM"],
  SNACKS: ["3:00 – 4:00 PM", "4:00 – 5:00 PM", "5:00 – 6:00 PM"],
  DINNER: ["7:00 – 8:00 PM", "8:00 – 9:00 PM", "8:30 – 9:30 PM"],
};
const short = (day: RoutineDay) => humanizeEnum(day).slice(0, 3);

/**
 * The week's menu, shared by Hostel KYC and Food.
 *
 * Meal times come first and are set once — they are the same every day, so the
 * day view does not repeat them on every meal. Then a day at a time: each meal
 * is one line of food, and tapping it opens the editor right there in the row
 * (never a sheet: filling four meals should not mean opening four sheets).
 */
export function FoodWeekEditor({ week }: { week: FoodWeek }) {
  const { saving } = week;
  const [view, setView] = useState<"day" | "week">("day");

  return (
    <View className="gap-4" pointerEvents={saving ? "none" : "auto"}>
      <MealTimes week={week} />
      <Segmented
        onChange={setView}
        options={[{ label: "Day", value: "day" }, { label: "Week", value: "week" }]}
        value={view}
      />
      {view === "week" ? <WeekGrid onOpen={() => setView("day")} week={week} /> : <DayMeals week={week} />}
      <MonthEnd week={week} />
    </View>
  );
}

function MealTimes({ week }: { week: FoodWeek }) {
  const { colors } = useAppTheme();
  const { current, setDraft } = week;
  const [open, setOpen] = useState<MealType | null>(null);
  const setTime = (meal: MealType, value: string) =>
    setDraft({ ...current, timings: { ...current.timings, [meal]: value } });

  return (
    <Card padding="p-0" className="overflow-hidden">
      <View className="flex-row items-center justify-between px-4 pb-1 pt-3">
        <Text variant="subtitle">Meal times</Text>
        <Text variant="caption">Same every day</Text>
      </View>
      {MEAL_TYPES.map((meal) => {
        const time = current.timings[meal]?.trim() ?? "";
        const expanded = open === meal;

        return (
          <View key={meal}>
            <Pressable
              accessibilityLabel={`${humanizeEnum(meal)} time, ${time || "not set"}`}
              accessibilityRole="button"
              accessibilityState={{ expanded }}
              className="min-h-12 flex-row items-center gap-3 px-4 active:opacity-70"
              onPress={() => setOpen(expanded ? null : meal)}
            >
              <Ionicons color={colors.foreground} name={ICONS[meal]} size={20} />
              <Text className="flex-1" variant="label">{humanizeEnum(meal)}</Text>
              <Text className={time ? "" : "text-primary"} variant={time ? "body" : "label"}>{time || "Set time"}</Text>
              <Ionicons color={colors.mutedForeground} name={expanded ? "chevron-up" : "chevron-down"} size={18} />
            </Pressable>
            {expanded ? (
              <View className="gap-3 px-4 pb-4">
                <View className="flex-row flex-wrap gap-2">
                  {TIME_PRESETS[meal].map((preset) => (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityState={{ selected: time === preset }}
                      className={`min-h-11 justify-center rounded-xl border px-3 ${time === preset ? "border-primary bg-brand-soft" : "border-border"}`}
                      key={preset}
                      onPress={() => { setTime(meal, preset); setOpen(null); }}
                    >
                      <Text className={time === preset ? "text-primary" : ""} variant="label">{preset}</Text>
                    </Pressable>
                  ))}
                </View>
                <Input
                  accessibilityLabel={`${humanizeEnum(meal)} time`}
                  onChangeText={(value) => setTime(meal, value)}
                  placeholder="Or type a time"
                  returnKeyType="done"
                  onSubmitEditing={() => setOpen(null)}
                  value={current.timings[meal] ?? ""}
                />
              </View>
            ) : null}
          </View>
        );
      })}
    </Card>
  );
}

function DayMeals({ week }: { week: FoodWeek }) {
  const { colors } = useAppTheme();
  const { current, day, setDay, editing, setEditing, setCell } = week;
  const [copy, setCopy] = useState<"day" | MealType | null>(null);

  return (
    <>
      <View className="flex-row gap-1">
        {ROUTINE_DAYS.map((item) => {
          const count = MEAL_TYPES.filter((meal) => splitItems(current.meals[cellKey(item, meal)]?.items ?? "").length).length;

          return (
            <Pressable
              accessibilityLabel={`${humanizeEnum(item)}, ${count} of 4 meals`}
              accessibilityRole="tab"
              accessibilityState={{ selected: day === item }}
              className={`min-h-12 flex-1 items-center justify-center gap-1 rounded-lg ${day === item ? "bg-primary" : "border border-border"}`}
              key={item}
              onPress={() => { setDay(item); setEditing(null); }}
            >
              <Text className={day === item ? "text-primary-foreground" : ""} variant="label">{short(item)}</Text>
              {/* A dot per day that still has an empty meal. */}
              <View className={`h-1 w-1 rounded-full ${count === 4 ? "bg-transparent" : day === item ? "bg-primary-foreground" : "bg-warning"}`} />
            </Pressable>
          );
        })}
      </View>

      <View className="flex-row items-center justify-between">
        <Text variant="subtitle">{humanizeEnum(day)}</Text>
        <Button icon={Copy} label="Copy day" onPress={() => setCopy("day")} size="sm" variant="ghost" />
      </View>

      <Card padding="p-0" className="overflow-hidden">
        {MEAL_TYPES.map((meal, at) => {
          const cell = current.meals[cellKey(day, meal)] ?? { items: "", note: "" };
          const items = splitItems(cell.items);
          const open = editing === meal;

          return (
            <View className={at ? "border-t border-border" : ""} key={meal}>
              <Pressable
                accessibilityLabel={`${humanizeEnum(meal)}: ${items.join(", ") || "no food yet"}`}
                accessibilityRole="button"
                accessibilityState={{ expanded: open }}
                className="min-h-16 flex-row items-center gap-3 px-4 py-3 active:opacity-70"
                onPress={() => setEditing(open ? null : meal)}
              >
                <View className="h-10 w-10 items-center justify-center rounded-xl bg-brand-soft">
                  <Ionicons color={colors.primary} name={ICONS[meal]} size={20} />
                </View>
                <View className="flex-1">
                  <Text variant="label">{humanizeEnum(meal)}</Text>
                  {open ? null : (
                    <Text className={items.length ? "" : "text-muted-foreground"} numberOfLines={2} variant="body">
                      {items.join(", ") || "Add food"}
                    </Text>
                  )}
                </View>
                <Ionicons color={items.length ? colors.mutedForeground : colors.primary} name={open ? "chevron-up" : items.length ? "pencil-outline" : "add"} size={20} />
              </Pressable>

              {open ? (
                <View className="gap-3 px-4 pb-4">
                  <Input
                    accessibilityLabel={`${humanizeEnum(meal)} food`}
                    autoFocus={!items.length}
                    multiline
                    onChangeText={(value) => setCell(meal, { ...cell, items: value })}
                    placeholder="Dal, bhat, tarkari"
                    style={{ minHeight: 64, textAlignVertical: "top" }}
                    value={cell.items}
                  />
                  <View className="flex-row flex-wrap gap-2">
                    {DISHES.filter((dish) => !items.some((item) => item.toLowerCase() === dish.toLowerCase())).map((dish) => (
                      <Pressable
                        accessibilityLabel={`Add ${dish}`}
                        accessibilityRole="button"
                        className="min-h-10 justify-center rounded-full border border-border px-3 active:opacity-70"
                        disabled={items.length >= 20}
                        key={dish}
                        onPress={() => setCell(meal, { ...cell, items: [...items, dish].join(", ") })}
                      >
                        <Text variant="label">+ {dish}</Text>
                      </Pressable>
                    ))}
                  </View>
                  <Input onChangeText={(note) => setCell(meal, { ...cell, note })} placeholder="Note (optional)" value={cell.note} />
                  <View className="flex-row gap-2">
                    <Button className="flex-1" label="Same every day" onPress={() => setCopy(meal)} size="sm" variant="outline" />
                    <Button className="flex-1" label="Done" onPress={() => setEditing(null)} size="sm" />
                  </View>
                </View>
              ) : null}
            </View>
          );
        })}
      </Card>

      <CopySheet onClose={() => setCopy(null)} target={copy} week={week} />
    </>
  );
}

/** The whole week at a glance; a cell opens that meal in the day view. */
function WeekGrid({ onOpen, week }: { onOpen: () => void; week: FoodWeek }) {
  const { colors } = useAppTheme();
  const { current, setDay, setEditing } = week;

  return (
    <Card padding="p-2" className="gap-1">
      <View className="flex-row items-end">
        <View className="w-11" />
        {MEAL_TYPES.map((meal) => (
          <View className="flex-1 items-center gap-0.5 py-2" key={meal}>
            <Ionicons accessibilityLabel={humanizeEnum(meal)} color={colors.foreground} name={ICONS[meal]} size={20} />
            <Text style={{ fontSize: 10 }} variant="caption">{humanizeEnum(meal)}</Text>
            <Text className="text-center" numberOfLines={2} style={{ fontSize: 9 }} variant="caption">
              {current.timings[meal]?.trim() || "—"}
            </Text>
          </View>
        ))}
      </View>
      {ROUTINE_DAYS.map((item) => (
        <View className="flex-row items-center gap-1" key={item}>
          <Text className="w-11" variant="label">{short(item)}</Text>
          {MEAL_TYPES.map((meal) => {
            const filled = splitItems(current.meals[cellKey(item, meal)]?.items ?? "").length > 0;

            return (
              <Pressable
                accessibilityLabel={`${humanizeEnum(item)} ${humanizeEnum(meal)}, ${filled ? "edit" : "add"}`}
                accessibilityRole="button"
                className={`min-h-11 flex-1 items-center justify-center rounded-lg ${filled ? "bg-brand-soft" : "border border-dashed border-border"}`}
                key={meal}
                onPress={() => { setDay(item); setEditing(meal); onOpen(); }}
              >
                <Ionicons color={filled ? colors.primary : colors.mutedForeground} name={filled ? "checkmark" : "add"} size={20} />
              </Pressable>
            );
          })}
        </View>
      ))}
    </Card>
  );
}

function MonthEnd({ week }: { week: FoodWeek }) {
  const { colors } = useAppTheme();
  const { current, setDraft } = week;
  const [open, setOpen] = useState(false);
  const items = splitItems(current.monthEndItems);

  return (
    <Card padding="p-0" className="overflow-hidden">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        className="min-h-14 flex-row items-center gap-3 px-4 active:opacity-70"
        onPress={() => setOpen(!open)}
      >
        <Ionicons color={colors.foreground} name="star-outline" size={20} />
        <View className="flex-1">
          <Text variant="label">Month-end meal</Text>
          {open ? null : <Text className={items.length ? "" : "text-muted-foreground"} numberOfLines={1}>{items.join(", ") || "Optional"}</Text>}
        </View>
        <Ionicons color={colors.mutedForeground} name={open ? "chevron-up" : items.length ? "pencil-outline" : "add"} size={20} />
      </Pressable>
      {open ? (
        <View className="gap-3 px-4 pb-4">
          <Input multiline onChangeText={(monthEndItems) => setDraft({ ...current, monthEndItems })} placeholder="Khir, puri" value={current.monthEndItems} />
          <Input onChangeText={(monthEndNote) => setDraft({ ...current, monthEndNote })} placeholder="Note (optional)" value={current.monthEndNote} />
        </View>
      ) : null}
    </Card>
  );
}

/** Copies the open day — or one meal of it — onto the picked days, in the draft only. */
function CopySheet({ onClose, target, week }: { onClose: () => void; target: "day" | MealType | null; week: FoodWeek }) {
  const { colors } = useAppTheme();
  const { current, day, saving, setDraft } = week;
  const others = ROUTINE_DAYS.filter((item) => item !== day);
  const [targets, setTargets] = useState<RoutineDay[]>(others);
  const [openFor, setOpenFor] = useState(target);

  // Every open starts with all the other days picked.
  if (target !== openFor) {
    setOpenFor(target);
    setTargets(others);
  }

  const all = targets.length === others.length;

  return (
    <Sheet
      footer={
        <Button
          disabled={!targets.length || saving}
          label={`Copy to ${targets.length} ${targets.length === 1 ? "day" : "days"}`}
          onPress={() => {
            setDraft(copyMeals(current, day, targets, target === "day" ? undefined : target ?? undefined));
            onClose();
          }}
        />
      }
      onClose={onClose}
      open={target !== null}
      title={target === "day" ? `Copy ${humanizeEnum(day)}` : `${humanizeEnum(target ?? "")} every day`}
    >
      <View className="gap-4">
        <View className="flex-row flex-wrap gap-2">
          {others.map((item) => {
            const picked = targets.includes(item);

            return (
              <Pressable
                accessibilityRole="checkbox"
                accessibilityState={{ checked: picked }}
                className={`min-h-14 w-[31%] flex-row items-center justify-center gap-2 rounded-xl border ${picked ? "border-primary/20 bg-brand-soft" : "border-border"}`}
                key={item}
                onPress={() => setTargets((previous) => (picked ? previous.filter((day) => day !== item) : [...previous, item]))}
              >
                <Ionicons color={picked ? colors.primary : colors.mutedForeground} name={picked ? "checkmark-circle" : "ellipse-outline"} size={20} />
                <Text variant="label">{short(item)}</Text>
              </Pressable>
            );
          })}
        </View>
        <Button label={all ? "Clear all" : "Pick all"} onPress={() => setTargets(all ? [] : others)} variant="outline" />
        <Text className="text-warning" variant="muted">Meals on these days will change.</Text>
      </View>
    </Sheet>
  );
}
