import { router } from "expo-router";
import { View } from "react-native";

import { useFoodWeek } from "@/components/manage/food-week";
import { FoodWeekEditor } from "@/components/manage/food-week-editor";
import { AppBar } from "@/components/ui/app-bar";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ListRow } from "@/components/ui/list-row";
import { Meter } from "@/components/ui/meter";
import { Screen } from "@/components/ui/screen";
import { SkeletonCard } from "@/components/ui/skeleton";
import { ErrorState, PermissionCard } from "@/components/ui/states";
import { prefetchAdminRoute } from "@/lib/admin-queries";

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

export default function ManageFoodScreen() {
  const week = useFoodWeek();
  const { cells, dirty, filled, food, save, saving, setDraft } = week;
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

            <FoodWeekEditor week={week} />
          </>
        )}

        <Card padding="px-4 py-1">
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
    </Screen>
  );
}
