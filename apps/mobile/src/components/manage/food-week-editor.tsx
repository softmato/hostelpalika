import { Ionicons } from "@expo/vector-icons";
import { Clock, Copy, Plus } from "lucide-react-native";
import { useState } from "react";
import { Pressable, View } from "react-native";

import type { FoodWeek } from "@/components/manage/food-week";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
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
const TIMES = { BREAKFAST: "6:00 AM – 7:00 AM", LUNCH: "11:00 AM – 12:00 PM", SNACKS: "3:00 PM – 4:00 PM", DINNER: "7:00 PM – 8:00 PM" };

/** Shared native/PWA editor. A meal expands into inputs in its own row. */
export function FoodWeekEditor({ week }: { week: FoodWeek }) {
  const { colors } = useAppTheme();
  const { current, day, setDay, editing, setEditing, setCell, setDraft, saving } = week;
  const [view, setView] = useState<"day" | "week">("day");
  const [times, setTimes] = useState(false);
  const [special, setSpecial] = useState(false);
  const [copy, setCopy] = useState<"day" | MealType | null>(null);
  const [targets, setTargets] = useState<RoutineDay[]>([]);
  const changeDay = (next: RoutineDay) => { setDay(next); setEditing(null); };
  const openCopy = (meal: "day" | MealType) => {
    setTargets(ROUTINE_DAYS.filter(item => item !== day));
    setCopy(meal);
  };

  return <View className="gap-4" pointerEvents={saving ? "none" : "auto"}>
    <View className="flex-row rounded-xl border border-border p-1">
      {(["day", "week"] as const).map(item => <Pressable accessibilityRole="tab" accessibilityState={{ selected: view === item }} key={item} onPress={() => setView(item)} className={`min-h-11 flex-1 items-center justify-center rounded-lg ${view === item ? "bg-primary" : ""}`}><Text className={view === item ? "text-primary-foreground" : "text-foreground"} variant="label">{item === "day" ? "Day" : "Week"}</Text></Pressable>)}
    </View>
    {view === "week" ? <Card padding="p-2" className="gap-1">
      <View className="flex-row items-center"><View className="w-12" />{MEAL_TYPES.map(meal => <View key={meal} className="flex-1 items-center py-2"><Ionicons accessibilityLabel={humanizeEnum(meal)} name={ICONS[meal]} color={colors.foreground} size={20} /><Text style={{ fontSize: 10 }} variant="caption">{humanizeEnum(meal)}</Text></View>)}</View>
      {ROUTINE_DAYS.map(item => <View key={item} className="flex-row items-center gap-1"><Text className="w-11" variant="label">{humanizeEnum(item).slice(0, 3)}</Text>{MEAL_TYPES.map(meal => {
        const filled = splitItems(current.meals[cellKey(item, meal)]?.items ?? "").length > 0;
        return <Pressable key={meal} accessibilityRole="button" accessibilityLabel={`${humanizeEnum(item)} ${humanizeEnum(meal)}, ${filled ? "edit" : "add"}`} onPress={() => { changeDay(item); setEditing(meal); setView("day"); }} className={`min-h-11 flex-1 items-center justify-center rounded-lg ${filled ? "bg-brand-soft" : "border border-dashed border-border"}`}><Ionicons name={filled ? "checkmark" : "add"} color={filled ? colors.primary : colors.mutedForeground} size={20} /></Pressable>;
      })}</View>)}
    </Card> : <>
      <View className="flex-row gap-1">{ROUTINE_DAYS.map(item => <Pressable key={item} accessibilityRole="tab" accessibilityState={{ selected: day === item }} onPress={() => changeDay(item)} className={`min-h-11 flex-1 items-center justify-center rounded-lg ${day === item ? "bg-brand-soft" : "border border-border"}`}><Text variant="label" className={day === item ? "text-primary" : ""}>{humanizeEnum(item).slice(0, 3)}</Text></Pressable>)}</View>
      <View className="flex-row items-center justify-between"><Text variant="subtitle">{humanizeEnum(day)}</Text><Button icon={Copy} label="Copy day" variant="ghost" onPress={() => openCopy("day")} /></View>
      <Card padding="p-0" className="overflow-hidden">
        {MEAL_TYPES.map((meal, at) => {
          const cell = current.meals[cellKey(day, meal)] ?? { items: "", note: "" };
          const open = editing === meal;
          return <View key={meal} className={at ? "border-t border-border" : ""}>
            <Pressable accessibilityRole="button" accessibilityLabel={`Edit ${humanizeEnum(meal)}`} accessibilityState={{ expanded: open }} onPress={() => setEditing(open ? null : meal)} className="min-h-24 flex-row items-start gap-3 p-4">
              <Ionicons name={ICONS[meal]} color={colors.foreground} size={24} />
              <View className="flex-1 gap-1"><Text variant="subtitle">{humanizeEnum(meal)}</Text>{!open && <><Text variant="muted">{splitItems(cell.items).join(", ") || "Add food"}</Text>{cell.note ? <Text variant="muted">{cell.note}</Text> : null}</>}{current.timings[meal] ? <Text variant="caption">{current.timings[meal]}</Text> : null}</View>
              <Ionicons name={open ? "chevron-up" : "pencil-outline"} size={20} color={colors.foreground} />
            </Pressable>
            {open ? <View className="gap-3 px-4 pb-4">
              <Input accessibilityLabel={`${humanizeEnum(meal)} food`} label="Food" multiline value={cell.items} placeholder="Dal, bhat, tarkari" onChangeText={items => setCell(meal, { ...cell, items })} style={{ minHeight: 80, textAlignVertical: "top" }} />
              <View className="flex-row flex-wrap gap-2">{DISHES.map(dish => {
                const added = splitItems(cell.items).some(item => item.toLowerCase() === dish.toLowerCase());
                return <Pressable key={dish} accessibilityRole="button" accessibilityLabel={`Add ${dish}`} disabled={added || splitItems(cell.items).length >= 20} onPress={() => setCell(meal, { ...cell, items: [...splitItems(cell.items), dish].join(", ") })} className={`min-h-11 justify-center rounded-xl border px-3 ${added ? "border-primary/20 bg-brand-soft" : "border-border"}`}><Text variant="label" className={added ? "text-primary" : ""}>{added ? "✓" : "+"} {dish}</Text></Pressable>;
              })}</View>
              <Input label="Note (optional)" value={cell.note} onChangeText={note => setCell(meal, { ...cell, note })} placeholder="Add a note" multiline />
              <View className="flex-row gap-2"><Button className="flex-1" label="Same every day" variant="outline" onPress={() => openCopy(meal)} /><Button label="Done" variant="outline" onPress={() => setEditing(null)} /></View>
            </View> : null}
          </View>;
        })}
      </Card>
    </>}
    <View className="flex-row gap-2"><Button className="flex-1" icon={Clock} label="Meal times" variant="outline" onPress={() => setTimes(!times)} /><Button className="flex-1" icon={Plus} label="Month-end meal" variant="outline" onPress={() => setSpecial(!special)} /></View>
    {times ? <Card className="gap-3"><Text variant="subtitle">Meal times</Text><Text variant="muted">Same time each day</Text>{MEAL_TYPES.map(meal => <Input key={meal} label={humanizeEnum(meal)} value={current.timings[meal] ?? ""} placeholder={TIMES[meal]} onChangeText={value => setDraft({ ...current, timings: { ...current.timings, [meal]: value } })} />)}</Card> : null}
    {special ? <Card className="gap-3"><Text variant="subtitle">Month-end meal</Text><Input label="Food" multiline value={current.monthEndItems} placeholder="Khir, puri" onChangeText={monthEndItems => setDraft({ ...current, monthEndItems })} /><Input label="Note (optional)" value={current.monthEndNote} onChangeText={monthEndNote => setDraft({ ...current, monthEndNote })} /></Card> : current.monthEndItems ? <Text variant="muted">Month-end: {current.monthEndItems}</Text> : null}
    <Sheet open={copy !== null} onClose={() => setCopy(null)} title={copy === "day" ? `Copy ${humanizeEnum(day)}` : `${humanizeEnum(copy ?? "")} each day`} footer={<Button disabled={!targets.length || saving} label={`Copy to ${targets.length} ${targets.length === 1 ? "day" : "days"}`} onPress={() => { setDraft(copyMeals(current, day, targets, copy === "day" ? undefined : copy ?? undefined)); setCopy(null); }} />}>
      <View className="gap-4"><Text variant="subtitle">Pick days</Text><View className="flex-row flex-wrap gap-2">{ROUTINE_DAYS.filter(item => item !== day).map(item => <Pressable key={item} accessibilityRole="checkbox" accessibilityState={{ checked: targets.includes(item) }} onPress={() => setTargets(previous => previous.includes(item) ? previous.filter(target => target !== item) : [...previous, item])} className={`min-h-14 w-[30%] items-center justify-center rounded-xl border ${targets.includes(item) ? "border-primary/20 bg-brand-soft" : "border-border"}`}><Text variant="label">{targets.includes(item) ? "✓ " : ""}{humanizeEnum(item).slice(0, 3)}</Text></Pressable>)}</View><Button label={targets.length === ROUTINE_DAYS.length - 1 ? "Clear all" : "Pick all"} variant="outline" onPress={() => setTargets(targets.length === ROUTINE_DAYS.length - 1 ? [] : ROUTINE_DAYS.filter(item => item !== day))} /><Text className="text-warning" variant="muted">Meals on these days will change.</Text></View>
    </Sheet>
  </View>;
}
