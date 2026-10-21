import { useMemo, useState } from "react";
import { View } from "react-native";

import { FoodRoutineWeek, MonthEndSpecial } from "@/components/food-routine";
import { NotificationBell } from "@/components/notification-bell";
import { AppBar } from "@/components/ui/app-bar";
import { Card, SectionHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ListRow, RowDivider } from "@/components/ui/list-row";
import { Screen } from "@/components/ui/screen";
import { Skeleton, SkeletonCard, SkeletonRows } from "@/components/ui/skeleton";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useResource } from "@/hooks/use-resource";
import { searchCookResidents } from "@/lib/cook";
import type { CookResident, CookToday } from "@/lib/cook-api";
import { cookQuery } from "@/lib/cook-queries";
import { humanizeEnum } from "@/lib/format";

/**
 * The week's routine, and who is eating it. Read-only, both of them.
 *
 * ## Two things on one tab, on purpose
 *
 * They are the kitchen's two reference reads — what to cook, and how many
 * plates — and a cook checks them together at the start of a shift. Splitting
 * them would cost a tab from a five-tab bar whose other slots (announce, photo,
 * community) are things done rather than looked up.
 *
 * ## The week is `<FoodRoutineWeek>` now, not a third copy of it
 *
 * This screen used to build its own day strip — a horizontal `ScrollView` of
 * hand-rolled filled pills — and then map `MEAL_TYPES` into `<MealRow>`s
 * underneath it. Which is precisely what `components/food-routine.tsx` already
 * does, off the same `FoodRoutine` payload, for the resident's Food tab and for
 * `(admin)/today.tsx`. Three renderings of one menu is how "the app said
 * chicken" starts, and the kitchen's copy was the one most likely to diverge
 * because it was the one nobody was looking at while editing the others.
 *
 * The shared component also brings two things this screen did not have: today
 * is marked on the strip even when another day is selected, so a cook who has
 * browsed to Friday can find their way back, and each meal gets the icon square
 * the rest of the app uses.
 *
 * **No `mealFooter`.** That slot is where the resident's rating form goes; the
 * kitchen has nothing to put in it, which is the whole reason the component
 * takes a slot rather than owning the control.
 *
 * ## Nothing here is editable, and that is the product
 *
 * `PUT /hostel-admin/food/routine` is behind `manageFood`, a hostel-staff
 * capability a COOK does not hold — and rightly: the menu is what the hostel
 * has promised its residents, and the kitchen changing it silently is how a
 * hostel ends up serving something other than what it advertised. The routine
 * arrives on `GET /cook/today` alongside today's meals, so the week costs no
 * request of its own.
 *
 * ## The roster is two fields, and now searchable
 *
 * Name and room type. No phone, no email, nothing contactable — the cook login
 * is shared kitchen-wide and effectively static, so this is the list most
 * exposed by a leaked password, and it is deliberately worth no more than a
 * noticeboard.
 *
 * The field appears **only once the list is long enough to need it**, which is
 * the rule `(admin)/money.tsx` states for its own search: a hostel with eight
 * residents can see all eight, and a search box over eight rows is a control
 * that exists to be ignored. `searchCookResidents` matches the room type as it
 * is *written on screen*, so `double sharing` finds `DOUBLE_SHARING`.
 *
 * ## Two reads, two resources
 *
 * The week and the roster fail independently, and a kitchen whose roster errors
 * should still be able to read the menu. They were one combined `loadMenu`
 * before, which meant either failure blanked both.
 */

/** Below this the list is short enough to read whole. See the note above. */
const SEARCH_FROM = 12;

export default function CookMenuScreen() {
  // The same key the Today tab reads — `GET /cook/today` carries the whole
  // week. See `lib/cook-queries.ts` for what sharing it fixed.
  const weekQuery = cookQuery.today();
  const week = useResource<CookToday>(weekQuery.load, {
    cacheKey: weekQuery.key,
    topics: weekQuery.topics,
  });

  const rosterQuery = cookQuery.residents();
  const roster = useResource<CookResident[]>(rosterQuery.load, {
    cacheKey: rosterQuery.key,
    topics: rosterQuery.topics,
  });

  const [search, setSearch] = useState("");

  const residents = useMemo(() => roster.data ?? [], [roster.data]);
  const shown = useMemo(
    () => searchCookResidents(residents, search),
    [residents, search],
  );

  const header = <AppBar actions={<NotificationBell />} large title="Menu" />;

  if (week.loading) {
    return (
      <Screen header={header} insideTabs>
        {/* The day strip, the day's meals, then the roster. */}
        <View className="gap-4">
          <View className="flex-row gap-2">
            {Array.from({ length: 7 }, (_, index) => (
              <Skeleton height={52} key={index} radius={14} width={42} />
            ))}
          </View>

          <SkeletonCard rows={2} />
          <SkeletonCard rows={2} />
          <SkeletonRows rows={4} />
        </View>
      </Screen>
    );
  }

  if (week.error || !week.data) {
    return (
      <Screen header={header} insideTabs>
        <ErrorState
          message={week.error ?? "The weekly menu could not be loaded."}
          onRetry={week.reload}
        />
      </Screen>
    );
  }

  const { routine } = week.data;

  return (
    <Screen
      header={header}
      insideTabs
      onRefresh={() => {
        week.refresh();
        roster.refresh();
      }}
      refreshing={week.refreshing || roster.refreshing}
      scroll
    >
      <View className="gap-6 pt-1">
        <View className="gap-3">
          <SectionHeader
            subtitle={
              routine.updatedAt
                ? "Set by the hostel office"
                : "The hostel has not published a routine yet"
            }
            title="This week"
          />

          <FoodRoutineWeek meals={routine.meals} timings={routine.timings} />

          <MonthEndSpecial special={routine.monthEndSpecial} />
        </View>

        <View>
          <SectionHeader
            subtitle="Active residents. Names and rooms only."
            title={`Who's eating · ${residents.length}`}
          />

          <View className="gap-3">
            {residents.length >= SEARCH_FROM ? (
              <Input
                autoCapitalize="none"
                onChangeText={setSearch}
                placeholder="Find a name or a room type"
                value={search}
              />
            ) : null}

            {/*
              The roster's own failure, reported here rather than taking the
              whole screen. The menu above it is the thing a cook came for, and
              a roster that 500s must not cost them the week.
            */}
            {roster.error ? (
              <Card>
                <ErrorState message={roster.error} onRetry={roster.reload} />
              </Card>
            ) : roster.loading ? (
              <SkeletonRows rows={5} />
            ) : residents.length === 0 ? (
              <Card>
                <EmptyState icon="people"
                  description="Nobody is registered as an active resident right now."
                  title="No residents"
                />
              </Card>
            ) : shown.length === 0 ? (
              <Card>
                <Text variant="muted">
                  {`Nobody matches "${search.trim()}".`}
                </Text>
              </Card>
            ) : (
              <Card padding="px-4 py-1">
                {shown.map((resident, index) => (
                  <View key={resident.id}>
                    {index > 0 ? <RowDivider /> : null}
                    <ListRow
                      title={resident.fullName}
                      value={humanizeEnum(resident.roomType)}
                    />
                  </View>
                ))}
              </Card>
            )}
          </View>
        </View>
      </View>
    </Screen>
  );
}
