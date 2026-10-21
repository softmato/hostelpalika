import { router, useLocalSearchParams } from "expo-router";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, RefreshControl, ScrollView, TextInput, View } from "react-native";
import Animated from "react-native-reanimated";

import { HostelCard } from "@/components/hostel-card";
import { HostelMap } from "@/components/hostel-map";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Glyph, type GlyphName } from "@/components/ui/glyph";
import { Screen, useOwnScroll } from "@/components/ui/screen";
import { Sheet } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useCommuteTimes } from "@/hooks/use-commute";
import { useNearby } from "@/hooks/use-nearby";
import { useResource } from "@/hooks/use-resource";
import { useSavedHostels } from "@/hooks/use-saved";
import { useSystemInsets } from "@/hooks/use-system-insets";
import { type HostelWithDistance, sortByDistance } from "@/lib/geo";
import { inCity, servingMeals } from "@/lib/home-sections";
import {
  FACILITIES,
  HOSTEL_TYPE_LABELS,
  HOSTEL_TYPES,
  type HostelFilters,
  type HostelType,
  type PublicHostel,
  ROOM_TYPES,
} from "@/lib/public-api";
import { COMPARE_MAX, COMPARE_MIN } from "@/lib/public-api";
import { publicQuery } from "@/lib/public-queries";
import { toastInfo } from "@/lib/toast";

/**
 * Browse and filter (docs/mockups/mobile/README.md §5).
 *
 * Rendered by the `(browse)` Search tab, and — with a back button — by the
 * root-level `/hostels` screen that a resident, admin or provider reaches from
 * their More tab.
 *
 * ## The header is the search
 *
 * The tab is called Search, so the first thing on it is the field — the same
 * pill as Home's, with the filter button inside it — and under it one row of
 * one-tap filters (Nearest, the three hostel types, short stays, a budget, food).
 * Those are the filters people actually reach for; the sheet keeps the long tail.
 * Both stay pinned while the list scrolls under them, so narrowing a result never
 * means scrolling back up. A "Browse" title above them said nothing the tab bar
 * does not.
 *
 * ## The list is virtualized
 *
 * Up to sixty cards, each a photo and a dozen icons. Drawn with `.map()` in a
 * ScrollView they were all built on mount, all re-attached on every visit to the
 * tab and all reconciled on every keystroke — which is what made the tab slow to
 * open. A `FlatList` builds the few on screen and recycles the rest.
 *
 * ## The filter sheet only offers what the server accepts
 *
 * `publicHostelListQuerySchema` takes **one** `facility` and **one**
 * `roomType`, has no `sort` and no pagination, and returns the first 60 sorted
 * cheapest-first. The mockup draws facilities as a checkbox group and a Sort
 * dropdown — both would be controls that silently do nothing, which is worse
 * than not offering them, because the user believes the result set is filtered.
 * So facilities are single-select here and Sort is absent until the server
 * grows one.
 *
 * **`Nearest` is the one exception, and it is honest** — it re-orders the rows
 * the server already returned, on the client, with the coordinates already in
 * the payload (`lib/geo.ts`). It changes what the user sees, so it is a control
 * that does something; it does not pretend to have narrowed the query.
 *
 * Budget is sent as `minPrice`/`maxPrice`, which the server compares against
 * the hostel's *range* (`monthlyRentMax >= minPrice`, `monthlyRentMin <=
 * maxPrice`) — so a hostel whose range overlaps the band matches, rather than
 * only one priced entirely inside it.
 */

const BUDGET_BANDS = [
  { label: "Any budget", maxPrice: undefined, minPrice: undefined },
  { label: "Under NPR 8,000", maxPrice: 8000, minPrice: undefined },
  { label: "NPR 8,000 – 10,000", maxPrice: 10000, minPrice: 8000 },
  { label: "Above NPR 10,000", maxPrice: undefined, minPrice: 10000 },
] as const;

/** The band the quick row offers. The sheet has the rest. */
const QUICK_BUDGET = BUDGET_BANDS[1];

/** Typing pauses this long before the list follows the field. */
const SEARCH_PAUSE_MS = 450;

/** Same height as Home's field, so the two searches read as one control. */
const SEARCH_HEIGHT = 46;
const FILTER_BUTTON = 32;

const NO_ROWS: HostelWithDistance[] = [];

/** Everything a link into this screen is allowed to ask for. */
type BrowseParams = {
  city?: string;
  facility?: string;
  meals?: string;
  /** `1` — open with "Nearest" on (Home's Near me door). */
  near?: string;
  q?: string;
  type?: string;
};

/**
 * The server-side filters a link into this screen asks for.
 *
 * Written once and called twice — to seed the state on mount, and to reseed it
 * when a later navigation arrives with different params. Two copies of "which
 * of these params is a filter, and which of them the server will even accept"
 * is exactly the pair that drifts the first time one more filter is added.
 *
 * `city` and `meals` are deliberately not here: neither is a field the server
 * filters on, so both are held as their own state and narrow the returned rows
 * on the client — see where they are declared for why.
 */
function filtersFromParams(params: BrowseParams): HostelFilters {
  return {
    facility: params.facility,
    q: params.q,
    type: HOSTEL_TYPES.includes(params.type as HostelType)
      ? (params.type as HostelType)
      : undefined,
  };
}

export type HostelBrowserProps = {
  /** Where the compare bar goes, with `?ids=` appended. */
  compareHref: string;
  insideTabs?: boolean;
  /** Off inside a tab: a tab is a destination, not something you came from. */
  showBack?: boolean;
};

export function HostelBrowser({
  compareHref,
  insideTabs = false,
  showBack = false,
}: HostelBrowserProps) {
  const params = useLocalSearchParams<BrowseParams>();
  const { colors } = useAppTheme();
  const insets = useSystemInsets();

  // Seeded from the deep link that pushed this screen — the home screen's
  // search field, or one of its city cards — so it opens on a list that is
  // already filtered rather than on the whole catalogue.
  const [filters, setFilters] = useState<HostelFilters>(() =>
    filtersFromParams(params),
  );
  /*
   * City is **not** a `HostelFilters` field, because the server has no city
   * filter: `publicHostelListQuerySchema`'s `area` matches `location.area` only,
   * so a hostel in "Ghattekulo, Kathmandu" does not match `?area=Kathmandu`. It
   * therefore narrows the rows already returned — the same trade `Nearest`
   * makes, and honest for the same reason: it changes what is on screen and does
   * not claim to have narrowed the query. Held separately so it cannot be sent.
   */
  const [city, setCity] = useState(params.city ?? "");
  /*
   * "Serves food". Client-side and held apart from `filters` for the same
   * reason as `city`: the server's `food` filter chooses between veg and non-veg
   * rather than answering whether meals are provided at all, so this narrows the
   * returned rows on `mealsPerDay`.
   */
  const [meals, setMeals] = useState(params.meals === "1");
  const [search, setSearch] = useState(params.q ?? "");
  const [sheetOpen, setSheetOpen] = useState(false);
  const [draft, setDraft] = useState<HostelFilters>(filters);
  /*
   * List or map. Not a filter — both views show the same `ordered` rows, so
   * switching never changes the result set, only how it is drawn. The map is
   * deliberately not the default: it is blank without a network, it cannot show
   * a hostel that has never been geocoded, and price and vacancy — the two
   * things people actually compare — do not fit on a pin.
   */
  const [view, setView] = useState<"list" | "map">("list");
  const [compare, setCompare] = useState<string[]>([]);

  /*
   * Adopt a search that arrives *after* this screen is already mounted.
   *
   * Seeding the state above is the whole story for the pushed copy in the
   * signed-out stack: that screen is mounted by the push that carries the
   * params and torn down when you go back. Inside the tabs this screen **is** a
   * tab — mounted the first time it is focused and never unmounted again — so
   * every later `?q=…` from the home screen's field landed on a search box that
   * had already been initialised, and was dropped on the floor.
   *
   * Keyed on the params rather than on focus, and that distinction is the
   * point: tapping Search in the tab bar re-focuses this screen without
   * changing them, and has to leave whatever is on screen exactly as it is.
   * Only a navigation carrying *different* params reseeds — including a bare
   * one with none at all, which is "View all" and does mean the whole
   * catalogue.
   */
  const { city: cityParam, facility, meals: mealsParam, q, type } = params;
  const incoming = JSON.stringify([cityParam, facility, mealsParam, q, type]);
  const applied = useRef(incoming);

  useEffect(() => {
    if (applied.current === incoming) {
      return;
    }

    applied.current = incoming;
    setCity(cityParam ?? "");
    setFilters(filtersFromParams({ facility, q, type }));
    setMeals(mealsParam === "1");
    setSearch(q ?? "");
  }, [cityParam, facility, incoming, mealsParam, q, type]);

  /*
   * The list follows the field after a pause. Enter used to be the only way to
   * search, and a field that does nothing until a key half the readers never
   * press reads as broken. One request per pause rather than per letter, and a
   * lone letter waits for a second — it matches nearly everything.
   */
  useEffect(() => {
    const typed = search.trim();

    if (typed.length === 1) {
      return;
    }

    const timer = setTimeout(() => {
      setFilters((current) =>
        (current.q ?? "") === typed ? current : { ...current, q: typed || undefined },
      );
    }, SEARCH_PAUSE_MS);

    return () => clearTimeout(timer);
  }, [search]);

  const nearby = useNearby();
  const saved = useSavedHostels();
  const own = useOwnScroll(insideTabs);

  // Keyed on the param alone: `enable` asks for location, once per arrival.
  useEffect(() => {
    if (params.near === "1") void nearby.enable();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.near]);

  const query = publicQuery.hostels(filters);
  const hostels = useResource<PublicHostel[]>(query.load, {
    cacheKey: query.key,
    topics: query.topics,
  });

  /** On the filter button: how many server-side filters are on, the query aside. */
  const activeCount = useMemo(
    () =>
      Object.entries(filters).filter(
        ([key, value]) => key !== "q" && value !== undefined && value !== "",
      ).length,
    [filters],
  );

  // `returned` is what the server sent; `rows` is what is on screen after the
  // city and meals narrowing. The two are separate because the "first 60"
  // footer has to describe the *request* — narrowing 60 rows down to 9 does not
  // mean the catalogue held 9.
  const returned = useMemo(() => hostels.data ?? [], [hostels.data]);
  const rows = useMemo(() => {
    const narrowed = city ? inCity(returned, city) : returned;

    return meals ? servingMeals(narrowed) : narrowed;
  }, [city, meals, returned]);

  /*
   * With no position this is the server's order with every distance null, so
   * the list renders through one path whether or not "nearest" is on — a second
   * branch for the unsorted case is how the two drift apart.
   */
  const ordered = useMemo(
    () => sortByDistance(rows, nearby.coordinates),
    [nearby.coordinates, rows],
  );

  // Walking minutes to the reader's own college or office, when they set one on the map.
  const { minutesTo, place: commute } = useCommuteTimes(rows, "foot");

  const toggleCompare = useCallback(
    (hostel: PublicHostel) => {
      setCompare((current) => {
        if (current.includes(hostel.id)) {
          return current.filter((id) => id !== hostel.id);
        }

        if (current.length >= COMPARE_MAX) {
          // The server rejects a fourth id outright, so this is a real limit
          // rather than a UI preference.
          toastInfo(
            `Compare up to ${COMPARE_MAX}`,
            "Remove one before adding another.",
          );
          return current;
        }

        return [...current, hostel.id];
      });
    },
    [],
  );

  const clearAll = useCallback(() => {
    setFilters((current) => ({ q: current.q }));
    setCity("");
    setMeals(false);
  }, []);

  const renderRow = useCallback(
    ({ item }: { item: HostelWithDistance }) => {
      const minutes = commute ? minutesTo(item.hostel.id) : null;

      return (
        <HostelCard
          commute={commute && minutes ? `${minutes} min walk to ${commute.name}` : null}
          distanceMeters={item.distanceMeters}
          hostel={item.hostel}
          onToggleCompare={toggleCompare}
          onToggleSave={saved.toggle}
          saved={saved.ids.has(item.hostel.id)}
          selectedForCompare={compare.includes(item.hostel.id)}
          showCampusDistance
        />
      );
    },
    [commute, compare, minutesTo, saved.ids, saved.toggle, toggleCompare],
  );

  const narrowed = activeCount > 0 || Boolean(city) || meals;

  const summary = hostels.loading
    ? "Finding hostels…"
    : `${rows.length} ${rows.length === 1 ? "hostel" : "hostels"}${city ? ` in ${city}` : ""}${
        nearby.isActive ? " · nearest first" : ""
      }`;

  const resultsLine = (
    <View className="flex-row items-center gap-3 pb-3">
      <Text className="flex-1" numberOfLines={1} variant="caption">
        {summary}
      </Text>
      <ViewSwitch onChange={setView} value={view} />
    </View>
  );

  const header = (
    <View
      className="gap-3 border-b border-border bg-background pb-3"
      style={{ paddingTop: insets.top + 10 }}
    >
      <View className="flex-row items-center gap-2 px-5">
        {showBack ? (
          <Pressable
            accessibilityLabel="Back"
            accessibilityRole="button"
            className="active:opacity-60"
            hitSlop={12}
            onPress={() => router.back()}
          >
            <Glyph color={colors.foreground} name="chevron-back" size={24} />
          </Pressable>
        ) : null}

        <View
          className="flex-1 flex-row items-center gap-2 rounded-2xl border border-border bg-card"
          style={{ height: SEARCH_HEIGHT, paddingLeft: 12, paddingRight: 6 }}
        >
          <Glyph color={colors.mutedForeground} name="search" size={16} />
          <TextInput
            className="h-full flex-1 text-base text-foreground"
            onChangeText={setSearch}
            onSubmitEditing={() =>
              setFilters((current) => ({ ...current, q: search.trim() || undefined }))
            }
            placeholder="Hostel, area or city"
            placeholderTextColor={colors.mutedForeground}
            returnKeyType="search"
            value={search}
          />
          {search ? (
            <Pressable
              accessibilityLabel="Clear search"
              accessibilityRole="button"
              hitSlop={8}
              onPress={() => setSearch("")}
            >
              <Glyph color={colors.mutedForeground} name="close-circle" size={16} />
            </Pressable>
          ) : null}
          <Pressable
            accessibilityLabel={activeCount > 0 ? `Filters, ${activeCount} on` : "Filters"}
            accessibilityRole="button"
            className="items-center justify-center rounded-xl bg-primary active:opacity-80"
            onPress={() => {
              setDraft(filters);
              setSheetOpen(true);
            }}
            style={{ height: FILTER_BUTTON, width: FILTER_BUTTON }}
          >
            <Glyph color={colors.primaryForeground} name="options" size={16} />
            {activeCount > 0 ? (
              <View
                className="absolute items-center justify-center rounded-full border-2 border-card bg-foreground"
                style={{ height: 17, minWidth: 17, paddingHorizontal: 3, right: -6, top: -6 }}
              >
                <Text className="text-background" style={{ fontSize: 9, fontWeight: "700" }}>
                  {activeCount}
                </Text>
              </View>
            ) : null}
          </Pressable>
        </View>
      </View>

      <QuickFilters
        city={city}
        filters={filters}
        meals={meals}
        nearby={nearby}
        onChange={setFilters}
        onClearCity={() => setCity("")}
        onToggleMeals={() => setMeals((current) => !current)}
      />
    </View>
  );

  const bottomPad = compare.length > 0 ? 12 : own.scrollPaddingBottom;

  return (
    <Screen
      footer={
        compare.length > 0 ? (
          <View className="flex-row items-center gap-3">
            <Text className="flex-1" variant="muted">
              {`${compare.length} selected`}
            </Text>
            <Button
              label="Clear"
              onPress={() => setCompare([])}
              size="sm"
              variant="ghost"
            />
            <Button
              disabled={compare.length < COMPARE_MIN}
              label={
                compare.length < COMPARE_MIN
                  ? `Pick ${COMPARE_MIN - compare.length} more`
                  : "Compare"
              }
              onPress={() => router.push(`${compareHref}?ids=${compare.join(",")}`)}
              size="sm"
            />
          </View>
        ) : undefined
      }
      header={header}
      insideTabs={insideTabs}
      ownScroll
      padded={false}
    >
      {view === "map" ? (
        /*
          The same rows the list would draw. A hostel with no coordinates has no
          pin and the map says so — it is still in the list, and dropping it
          from both would be the dishonest version.
        */
        <View className="flex-1 px-5 pt-3" style={{ paddingBottom: bottomPad }}>
          {resultsLine}
          {hostels.loading ? (
            <View className="flex-1">
              <Skeleton height="100%" radius={16} />
            </View>
          ) : hostels.error ? (
            <ErrorState message={hostels.error} onRetry={hostels.reload} />
          ) : (
            <HostelMap
              fill
              hostels={rows}
              me={nearby.coordinates}
              onSelect={(slug) => router.push(`/hostel/${slug}`)}
            />
          )}
        </View>
      ) : (
        <Animated.FlatList<HostelWithDistance>
          ItemSeparatorComponent={RowGap}
          ListEmptyComponent={
            hostels.loading ? (
              <View className="gap-3">
                <Skeleton height={300} radius={16} />
                <Skeleton height={300} radius={16} />
              </View>
            ) : hostels.error ? (
              <ErrorState message={hostels.error} onRetry={hostels.reload} />
            ) : (
              <EmptyState
                action={
                  narrowed ? (
                    <Button label="Clear filters" onPress={clearAll} variant="outline" />
                  ) : undefined
                }
                description={
                  city && returned.length > 0
                    ? `None of these listings are in ${city}. Clear the city to see the rest.`
                    : meals && returned.length > 0
                      ? "None of these listings have said they provide meals. Clear that to see the rest."
                      : activeCount > 0
                        ? "Nothing matches all of those filters. Try widening one."
                        : filters.q
                          ? `Nothing matches “${filters.q}”. Try a city or an area instead.`
                          : "No hostels are published yet."
                }
                icon="search"
                title="No hostels found"
              />
            )
          }
          ListFooterComponent={
            ordered.length > 0 ? (
              <Text className="py-5 text-center" variant="caption">
                {/* Reads `returned`, not `rows`: the cap is a property of the
                    request, and the city narrowing happens after it. */}
                {returned.length >= 60
                  ? "Showing the first 60 — narrow your filters to see more."
                  : "You've reached the end"}
              </Text>
            ) : null
          }
          ListHeaderComponent={resultsLine}
          contentContainerStyle={{ paddingBottom: bottomPad, paddingHorizontal: 20, paddingTop: 12 }}
          data={hostels.loading || hostels.error ? NO_ROWS : ordered}
          initialNumToRender={3}
          keyExtractor={(row) => row.hostel.id}
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          maxToRenderPerBatch={4}
          onScroll={own.onScroll}
          refreshControl={
            <RefreshControl
              colors={[colors.primary]}
              onRefresh={hostels.refresh}
              refreshing={hostels.refreshing}
              tintColor={colors.primary}
            />
          }
          renderItem={renderRow}
          scrollEventThrottle={own.scrollEventThrottle}
          showsVerticalScrollIndicator={false}
          windowSize={7}
        />
      )}

      <FilterSheet
        draft={draft}
        onApply={() => {
          // The field keeps its own query: it is visible above the sheet, and a
          // draft taken before the last keystroke would rewrite it.
          setFilters((current) => ({ ...draft, q: current.q }));
          setSheetOpen(false);
        }}
        onClose={() => setSheetOpen(false)}
        onDraft={setDraft}
        open={sheetOpen}
      />
    </Screen>
  );
}

function RowGap() {
  return <View className="h-3" />;
}

/**
 * List or map, as one two-segment control on the results line.
 *
 * A segmented control rather than a single "Map" button because the state is
 * exclusive and persistent — the user is *in* one of two views, and a lone
 * toggle button leaves them guessing which. Both segments stay visible and the
 * selected one is lifted, so the current view and the way out of it are the
 * same control.
 */
function ViewSwitch({
  onChange,
  value,
}: {
  onChange: (next: "list" | "map") => void;
  value: "list" | "map";
}) {
  const { colors } = useAppTheme();

  const options = [
    { icon: "list", label: "List", value: "list" },
    { icon: "map", label: "Map", value: "map" },
  ] as const;

  return (
    <View className="flex-row rounded-full bg-muted p-0.5">
      {options.map((option) => {
        const selected = option.value === value;

        return (
          <Pressable
            accessibilityLabel={`${option.label} view`}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            className={`flex-row items-center gap-1 rounded-full px-3 py-1.5 active:opacity-70 ${
              selected ? "bg-card" : ""
            }`}
            hitSlop={4}
            key={option.value}
            onPress={() => onChange(option.value)}
          >
            <Glyph
              color={selected ? colors.primary : colors.mutedForeground}
              name={option.icon}
              size={14}
            />
            <Text
              className={`text-xs ${selected ? "font-semibold text-foreground" : "font-medium text-muted-foreground"}`}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * The one-tap filters, pinned under the field.
 *
 * Each is a toggle that writes the same `HostelFilters` the sheet writes, so the
 * two can never disagree — a type picked here is ticked in the sheet, and one
 * picked in the sheet lights its chip here. Filters with no chip of their own
 * (a city from Home, a room type, a facility) ride at the front as removable
 * chips, which is where somebody who arrived with one looks for the way out.
 *
 * `flexGrow: 0` is not decoration: a horizontal ScrollView grows by default, and
 * in the map view's column it grew to half the screen and stretched its chips
 * into a giant green pill.
 */
function QuickFilters({
  city,
  filters,
  meals,
  nearby,
  onChange,
  onClearCity,
  onToggleMeals,
}: {
  city: string;
  filters: HostelFilters;
  meals: boolean;
  nearby: ReturnType<typeof useNearby>;
  onChange: (next: (current: HostelFilters) => HostelFilters) => void;
  onClearCity: () => void;
  onToggleMeals: () => void;
}) {
  /** Removes one server-side filter, and its partner where it has one. */
  const drop = (key: keyof HostelFilters) =>
    onChange((current) => {
      const next = { ...current };

      delete next[key];
      // Budget is one chip over two fields, so clearing it clears both.
      if (key === "minPrice") delete next.maxPrice;

      return next;
    });

  const quickBudget =
    filters.minPrice === QUICK_BUDGET.minPrice && filters.maxPrice === QUICK_BUDGET.maxPrice;
  const otherBudget = Boolean(filters.minPrice || filters.maxPrice) && !quickBudget;
  const band = BUDGET_BANDS.find(
    (option) => option.minPrice === filters.minPrice && option.maxPrice === filters.maxPrice,
  );

  const nearestLabel = nearby.isBusy
    ? "Finding you…"
    : nearby.status === "blocked"
      ? "Location blocked"
      : "Nearest";

  return (
    <ScrollView
      contentContainerClassName="gap-2 px-5"
      horizontal
      keyboardShouldPersistTaps="handled"
      showsHorizontalScrollIndicator={false}
      style={{ flexGrow: 0 }}
    >
      {city ? <FilterChip label={city} onPress={onClearCity} removable selected /> : null}
      {filters.roomType ? (
        <FilterChip label={filters.roomType} onPress={() => drop("roomType")} removable selected />
      ) : null}
      {filters.facility ? (
        <FilterChip label={filters.facility} onPress={() => drop("facility")} removable selected />
      ) : null}
      {filters.food ? (
        <FilterChip
          label={filters.food === "veg" ? "Veg" : "Non-veg"}
          onPress={() => drop("food")}
          removable
          selected
        />
      ) : null}
      {filters.area ? (
        <FilterChip label={filters.area} onPress={() => drop("area")} removable selected />
      ) : null}
      {otherBudget ? (
        <FilterChip label={band?.label ?? "Budget"} onPress={() => drop("minPrice")} removable selected />
      ) : null}

      <FilterChip
        disabled={nearby.isBusy}
        icon="navigate"
        label={nearestLabel}
        onPress={() => {
          if (nearby.status === "blocked") {
            nearby.openSettings();
          } else if (nearby.isActive) {
            nearby.disable();
          } else {
            void nearby.enable();
          }
        }}
        selected={nearby.isActive}
      />

      {HOSTEL_TYPES.map((type) => (
        <FilterChip
          key={type}
          label={HOSTEL_TYPE_LABELS[type]}
          onPress={() =>
            onChange((current) => ({ ...current, type: current.type === type ? undefined : type }))
          }
          selected={filters.type === type}
        />
      ))}

      <FilterChip
        label="Short stays"
        onPress={() =>
          onChange((current) => ({ ...current, stay: current.stay ? undefined : "short" }))
        }
        selected={filters.stay === "short"}
      />

      <FilterChip
        label="Under 8,000"
        onPress={() =>
          onChange((current) =>
            quickBudget
              ? { ...current, maxPrice: undefined, minPrice: undefined }
              : { ...current, maxPrice: QUICK_BUDGET.maxPrice, minPrice: QUICK_BUDGET.minPrice },
          )
        }
        selected={quickBudget}
      />

      <FilterChip label="Serves food" onPress={onToggleMeals} selected={meals} />
    </ScrollView>
  );
}

const FilterChip = memo(function FilterChip({
  disabled = false,
  icon,
  label,
  onPress,
  removable = false,
  selected,
}: {
  disabled?: boolean;
  icon?: GlyphName;
  label: string;
  onPress: () => void;
  /** Already applied, and a tap takes it off — so it draws the ×. */
  removable?: boolean;
  selected: boolean;
}) {
  const { colors } = useAppTheme();
  const ink = selected ? colors.primaryForeground : colors.foreground;

  return (
    <Pressable
      accessibilityLabel={removable ? `Remove ${label} filter` : label}
      accessibilityRole="button"
      accessibilityState={{ disabled, selected }}
      className={`h-9 flex-row items-center gap-1.5 rounded-full border px-3.5 active:opacity-70 ${
        selected ? "border-primary bg-primary" : "border-border bg-card"
      }`}
      disabled={disabled}
      onPress={onPress}
    >
      {icon ? (
        <Glyph color={ink} name={icon} size={14} variant={selected ? "solid" : "line"} />
      ) : null}
      <Text
        className={`text-sm ${selected ? "font-semibold text-primary-foreground" : "font-medium text-foreground"}`}
      >
        {label}
      </Text>
      {removable ? <Glyph color={ink} name="close" size={12} /> : null}
    </Pressable>
  );
});

/**
 * The filter sheet.
 *
 * A bottom sheet at 72% of the screen, not a full-screen page: the results stay
 * in view above it, it drags away like every other sheet in the app, and the
 * six groups scroll inside it. Reset and Show sit pinned at the bottom, where
 * the thumb already is.
 *
 * Edits a **draft** and only lifts it on Show. Filtering live on every tap
 * would refetch four times while somebody sets four filters, and the list
 * behind the sheet would shuffle under a control they are still using. The
 * opener seeds the draft from what is applied, so a sheet dragged away
 * half-edited opens next time on the truth, not on the abandoned edit.
 */
const FILTER_SHEET_HEIGHT = 0.72;

function FilterSheet({
  draft,
  onApply,
  onClose,
  onDraft,
  open,
}: {
  draft: HostelFilters;
  onApply: () => void;
  onClose: () => void;
  onDraft: (next: (current: HostelFilters) => HostelFilters) => void;
  open: boolean;
}) {
  const patch = (next: Partial<HostelFilters>) => onDraft((current) => ({ ...current, ...next }));

  return (
    <Sheet
      footer={
        <View className="flex-row items-center gap-3">
          <View className="flex-1">
            <Button
              label="Reset"
              onPress={() => onDraft((current) => ({ q: current.q }))}
              variant="ghost"
            />
          </View>
          <View className="flex-1">
            <Button label="Show hostels" onPress={onApply} />
          </View>
        </View>
      }
      height={FILTER_SHEET_HEIGHT}
      onClose={onClose}
      open={open}
      title="Filters"
    >
      <View className="gap-6 pb-2">
        <FilterGroup title="Hostel type">
          <Choice label="Any" onPress={() => patch({ type: undefined })} selected={!draft.type} />
          {HOSTEL_TYPES.map((type) => (
            <Choice
              key={type}
              label={HOSTEL_TYPE_LABELS[type]}
              onPress={() => patch({ type })}
              selected={draft.type === type}
            />
          ))}
        </FilterGroup>

        <FilterGroup title="Stay length">
          <Choice label="Any" onPress={() => patch({ stay: undefined })} selected={!draft.stay} />
          <Choice
            label="Short stays (nightly)"
            onPress={() => patch({ stay: "short" })}
            selected={draft.stay === "short"}
          />
        </FilterGroup>

        <FilterGroup title="Budget (monthly)">
          {BUDGET_BANDS.map((band) => (
            <Choice
              key={band.label}
              label={band.label}
              onPress={() => patch({ maxPrice: band.maxPrice, minPrice: band.minPrice })}
              selected={draft.minPrice === band.minPrice && draft.maxPrice === band.maxPrice}
            />
          ))}
        </FilterGroup>

        <FilterGroup title="Room type">
          <Choice label="Any" onPress={() => patch({ roomType: undefined })} selected={!draft.roomType} />
          {ROOM_TYPES.map((roomType) => (
            <Choice
              key={roomType}
              label={roomType}
              onPress={() => patch({ roomType })}
              selected={draft.roomType === roomType}
            />
          ))}
        </FilterGroup>

        <FilterGroup title="Food">
          <Choice label="Any" onPress={() => patch({ food: undefined })} selected={!draft.food} />
          <Choice label="Veg" onPress={() => patch({ food: "veg" })} selected={draft.food === "veg"} />
          <Choice
            label="Non-veg"
            onPress={() => patch({ food: "non-veg" })}
            selected={draft.food === "non-veg"}
          />
        </FilterGroup>

        {/*
          One at a time, not a checkbox group: the server takes a single
          `facility`. A multi-select here would quietly drop everything after
          the first and show a result set the user believes is narrower.
        */}
        <FilterGroup subtitle="One at a time" title="Facility">
          <Choice label="Any" onPress={() => patch({ facility: undefined })} selected={!draft.facility} />
          {FACILITIES.map((facility) => (
            <Choice
              key={facility}
              label={facility}
              onPress={() => patch({ facility })}
              selected={draft.facility === facility}
            />
          ))}
        </FilterGroup>
      </View>
    </Sheet>
  );
}

function FilterGroup({
  children,
  subtitle,
  title,
}: {
  children: React.ReactNode;
  subtitle?: string;
  title: string;
}) {
  return (
    <View className="gap-2">
      <View className="flex-row items-center gap-2">
        <Text variant="label">{title}</Text>
        {subtitle ? <Badge label={subtitle} /> : null}
      </View>
      <View className="flex-row flex-wrap gap-2">{children}</View>
    </View>
  );
}

function Choice({
  label,
  onPress,
  selected,
}: {
  label: string;
  onPress: () => void;
  selected: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      className={`rounded-full border px-3.5 py-2 active:opacity-70 ${
        selected ? "border-primary bg-primary" : "border-border"
      }`}
      onPress={onPress}
    >
      <Text
        className={`text-sm font-medium ${
          selected ? "text-primary-foreground" : "text-foreground"
        }`}
      >
        {label}
      </Text>
    </Pressable>
  );
}
