import { router } from "expo-router";
import { useState } from "react";
import { View } from "react-native";

import { FoodWeekDays, MealSheet, splitItems, useFoodWeek } from "@/components/manage/food-week";
import { AppBar } from "@/components/ui/app-bar";
import { Button } from "@/components/ui/button";
import { Card, SectionHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ListRow, RowDivider } from "@/components/ui/list-row";
import { Meter } from "@/components/ui/meter";
import { Screen } from "@/components/ui/screen";
import { Sheet } from "@/components/ui/sheet";
import { SkeletonCard } from "@/components/ui/skeleton";
import { ErrorState, PermissionCard } from "@/components/ui/states";
import { prefetchAdminRoute } from "@/lib/admin-queries";
import { humanizeEnum } from "@/lib/format";
import { MEAL_TYPES, type MealType } from "@/lib/food-week";

/**
 * Food — editing the week, which is the half the app did not have.
 *
 * `(admin)/today.tsx` renders `FoodRoutineWeek` read-only and says so: "editing
 * the week's menu (a grid)" was on its list of things that wanted a desk. The
 * grid was the web's *layout*, not the feature. On a phone the same data is a
 * day at a time — seven days × four meals is 28 cells nobody can fill in one
 * sitting anyway, and the person editing it is usually fixing one of them.
 *
 * ## One document, one save
 *
 * `PUT /hostel-admin/food/routine` replaces the whole routine. There is no
 * per-cell write, so this screen holds a **draft** and only touches the network
 * when Save is pressed — which also means an accidental tap on the wrong day
 * costs nothing. The footer appears only when the draft differs from what was
 * loaded, so the screen is not permanently wearing a Save button.
 *
 * ## "Special foods" is not a thing to store
 *
 * The portal has a Special Foods tab; it lists the meals that carry a note.
 * That is a *view*, not data — the note lives on the meal — and on a phone the
 * note is already on the meal card you are looking at. So there is no third tab
 * here, and nothing is missing.
 *
 * ## The kitchen is one row, not a section
 *
 * Deciding what is served and deciding who may say it is ready are the same
 * person's decisions, so a door to the cooks belongs here. It used to be the
 * whole control panel — a switch, a name field, a login, a password status —
 * and that stopped fitting when a hostel could have several cooks, invited as
 * well as issued, each removable. `manage/cook.tsx` owns that now; this screen
 * points at it.
 */

const MEAL_HINTS: Record<MealType, string> = {
  BREAKFAST: "6:00 AM - 7:00 AM",
  DINNER: "7:00 PM - 8:45 PM",
  LUNCH: "8:45 AM - 12:00 PM",
  SNACKS: "3:00 PM - 5:00 PM",
};

export default function ManageFoodScreen() {
  const week = useFoodWeek();
  const { cells, current, dirty, filled, food, loaded, save, saving, setDraft } = week;

  const [monthEndOpen, setMonthEndOpen] = useState(false);
  const [timesOpen, setTimesOpen] = useState(false);

  const cook = food.data?.cook ?? null;

  if (food.loading) {
    return (
      <Screen header={<AppBar accent centerTitle showBack title="Food" />}>
        <View className="gap-4 pt-1">
          <SkeletonCard rows={3} />
          <SkeletonCard rows={3} />
        </View>
      </Screen>
    );
  }

  if (food.error) {
    return (
      <Screen header={<AppBar accent centerTitle showBack title="Food" />}>
        <ErrorState message={food.error} onRetry={food.reload} />
      </Screen>
    );
  }

  const monthEnd = splitItems(current.monthEndItems);

  return (
    <Screen
      footer={
        dirty ? (
          <View className="flex-row gap-2">
            <Button
              className="flex-1"
              label="Discard"
              onPress={() => setDraft(null)}
              variant="outline"
            />
            <Button
              className="flex-[2]"
              label="Save the week"
              loading={saving}
              onPress={() => void save()}
            />
          </View>
        ) : null
      }
      header={<AppBar accent centerTitle showBack title="Food" />}
      onRefresh={food.refresh}
      refreshing={food.refreshing}
      scroll
    >
      <View className="gap-5 pt-1">
        {food.data?.routine === null ? (
          <PermissionCard capability="food" feature="The weekly menu" />
        ) : (
          <>
            <Card>
              <Meter label={`${filled} of ${cells} meals set this week`} percent={Math.round((filled / cells) * 100)} />
            </Card>

            <View>
              <SectionHeader title="The week" />
              <FoodWeekDays week={week} />
            </View>
          </>
        )}

        <Card padding="px-4 py-1">
          {food.data?.routine === null ? null : (
            <>
              <ListRow
                icon="time-outline"
                iconBgColor="#007AFF"
                onPress={() => setTimesOpen(true)}
                subtitle={
                  MEAL_TYPES.filter((mealType) => current.timings[mealType]?.trim()).length ===
                  MEAL_TYPES.length
                    ? "All four set"
                    : `${MEAL_TYPES.filter((mealType) => current.timings[mealType]?.trim()).length} of 4 set`
                }
                title="Meal times"
              />
              <RowDivider inset />
              <ListRow
                icon="star-outline"
                iconBgColor="#FF9500"
                onPress={() => setMonthEndOpen(true)}
                subtitle={monthEnd.length > 0 ? monthEnd.join(", ") : "Not set"}
                title="Month-end special"
              />
              <RowDivider inset />
            </>
          )}
          {cook === null ? (
            <ListRow icon="flame-outline" subtitle="No access" title="Cooks" />
          ) : (
            <ListRow
              icon="flame-outline"
              iconBgColor="#FF3B30"
              onPress={() => router.push("/manage/cook")}
              onPressIn={() => prefetchAdminRoute("/manage/cook")}
              subtitle={
                cook.cookPortalEnabled
                  ? (cook.cookName ?? "Kitchen is open")
                  : "Nobody has the kitchen yet"
              }
              title="Cooks"
            />
          )}
        </Card>
      </View>

      <Sheet
        footer={<Button label="Done" onPress={() => setTimesOpen(false)} />}
        onClose={() => setTimesOpen(false)}
        open={timesOpen}
        title="Meal times"
      >
        <View className="gap-3 pb-2">
          {MEAL_TYPES.map((mealType) => (
            <Input
              key={mealType}
              label={humanizeEnum(mealType)}
              onChangeText={(value) =>
                setDraft((prev) => {
                  const base = prev ?? loaded;

                  return { ...base, timings: { ...base.timings, [mealType]: value } };
                })
              }
              placeholder={MEAL_HINTS[mealType]}
              value={current.timings[mealType] ?? ""}
            />
          ))}
        </View>
      </Sheet>

      <MealSheet week={week} />

      <Sheet
        footer={<Button label="Done" onPress={() => setMonthEndOpen(false)} />}
        onClose={() => setMonthEndOpen(false)}
        open={monthEndOpen}
        title="Month-end special"
      >
        <View className="gap-3 pb-2">
          <Input
            hint="Separate them with commas."
            label="What is served"
            multiline
            onChangeText={(monthEndItems) =>
              setDraft((prev) => ({ ...(prev ?? loaded), monthEndItems }))
            }
            placeholder="Chicken curry, sel roti, kheer"
            style={{ height: 96 }}
            value={current.monthEndItems}
          />

          <Input
            label="Note"
            multiline
            onChangeText={(monthEndNote) =>
              setDraft((prev) => ({ ...(prev ?? loaded), monthEndNote }))
            }
            style={{ height: 80 }}
            value={current.monthEndNote}
          />
        </View>
      </Sheet>
    </Screen>
  );
}
