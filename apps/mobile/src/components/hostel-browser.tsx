import { Ionicons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Modal, Pressable, ScrollView, TextInput, View } from "react-native";

import { HostelCard } from "@/components/hostel-card";
import { HostelMap } from "@/components/hostel-map";
import { AppBar } from "@/components/ui/app-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Screen } from "@/components/ui/screen";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useCommuteTimes } from "@/hooks/use-commute";
import { useNearby } from "@/hooks/use-nearby";
import { useResource } from "@/hooks/use-resource";
import { useSavedHostels } from "@/hooks/use-saved";
import { useSystemInsets } from "@/hooks/use-system-insets";
import { sortByDistance } from "@/lib/geo";
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
 * **`Sort: nearest` is the one exception, and it is honest** — it re-orders the
 * rows the server already returned, on the client, with the coordinates already
 * in the payload (`lib/geo.ts`). It changes what the user sees, so it is a
 * control that does something; it does not pretend to have narrowed the query.
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

/** Everything a link into this screen is allowed to ask for. */
type BrowseParams = {
  city?: string;
  facility?: string;
  meals?: string;
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
   * therefore narrows the rows already returned — the same trade `Sort: nearest`
   * makes, and honest for the same reason: it changes what is on screen and does
   * not claim to have narrowed the query. Held separately so it cannot be sent.
   */
  const [city, setCity] = useState(params.city ?? "");
  /*
   * "Serves food", from the home screen's Food tile. Client-side and held apart
   * from `filters` for the same reason as `city`: the server's `food` filter
   * chooses between veg and non-veg rather than answering whether meals are
   * provided at all, so this narrows the returned rows on `mealsPerDay`.
   */
  const [meals, setMeals] = useState(params.meals === "1");
  const [search, setSearch] = useState(params.q ?? "");
  const [sheetOpen, setSheetOpen] = useState(false);
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
   * had already been initialised, and was dropped on the floor: the field
   * showed whatever was last typed *here*, and the list showed the results for
   * that. From the home screen that looks like the field clearing itself on
   * submit, which is the bug this fixes.
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
  const nearby = useNearby();
  const saved = useSavedHostels();

  const query = publicQuery.hostels(filters);
  const hostels = useResource<PublicHostel[]>(query.load, {
    cacheKey: query.key,
    topics: query.topics,
  });

  const activeCount = useMemo(
    () =>
      Object.entries(filters).filter(
        ([key, value]) => key !== "q" && value !== undefined && value !== "",
      ).length,
    [filters],
  );

  // Memoised only so the sort below is not redone on every keystroke in the
  // search field: `?? []` is a fresh array each render.
  //
  // `returned` is what the server sent; `rows` is what is on screen after the
  // city narrowing. The two are separate because the "first 60" footer has to
  // describe the *request* — narrowing 60 rows down to 9 does not mean the
  // catalogue held 9.
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
      header={
        <AppBar showBack={showBack} subtitle="Verified hostels in Nepal" title="Browse" />
      }
      insideTabs={insideTabs}
      onRefresh={view === "list" ? hostels.refresh : undefined}
      padded={false}
      refreshing={hostels.refreshing}
      /*
       * The map takes over the scroll gesture, so the page must not also own
       * one — see `fill` in `components/hostel-map.tsx`. Pull-to-refresh goes
       * with it; the filters above still refetch, which is the case that
       * matters.
       */
      scroll={view === "list"}
    >
      <View className={`gap-4 px-5 ${view === "map" ? "flex-1" : ""}`}>
        <View className="flex-row items-center gap-2">
          <View className="h-12 flex-1 flex-row items-center gap-2 rounded-xl border border-border bg-card px-3">
            <Ionicons color={colors.mutedForeground} name="search" size={17} />
            <TextInput
              className="h-full flex-1 text-base text-foreground"
              onChangeText={setSearch}
              onSubmitEditing={() =>
                setFilters((current) => ({ ...current, q: search.trim() || undefined }))
              }
              placeholder="Hostel name or area"
              placeholderTextColor={colors.mutedForeground}
              returnKeyType="search"
              value={search}
            />
            {search ? (
              <Pressable
                accessibilityLabel="Clear search"
                accessibilityRole="button"
                hitSlop={8}
                onPress={() => {
                  setSearch("");
                  setFilters((current) => ({ ...current, q: undefined }));
                }}
              >
                <Ionicons color={colors.mutedForeground} name="close-circle" size={17} />
              </Pressable>
            ) : null}
          </View>

          <Pressable
            accessibilityLabel="Filters"
            accessibilityRole="button"
            className="h-12 flex-row items-center gap-1.5 rounded-xl border border-border px-3 active:opacity-70"
            onPress={() => setSheetOpen(true)}
          >
            <Ionicons color={colors.foreground} name="options-outline" size={18} />
            {activeCount > 0 ? (
              <View className="h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1">
                <Text className="text-[11px] font-bold text-primary-foreground">
                  {activeCount}
                </Text>
              </View>
            ) : null}
          </Pressable>
        </View>

        <View className="flex-row items-center gap-2">
          <View className="flex-1">
            <NearestToggle nearby={nearby} />
          </View>
          <ViewSwitch onChange={setView} value={view} />
        </View>

        {activeCount > 0 || city || meals ? (
          <ActiveFilterChips
            city={city}
            filters={filters}
            meals={meals}
            onChange={setFilters}
            onClearCity={() => setCity("")}
            onClearMeals={() => setMeals(false)}
          />
        ) : null}

        {hostels.loading ? (
          <View className="gap-3">
            <Skeleton height={250} radius={16} />
            <Skeleton height={250} radius={16} />
          </View>
        ) : hostels.error ? (
          <ErrorState message={hostels.error} onRetry={hostels.reload} />
        ) : view === "map" ? (
          /*
             The same `ordered` rows the list would draw. A hostel with no
             coordinates has no pin and the map says so — it is still in the
             list, and dropping it from both would be the dishonest version.
          */
          <HostelMap
            fill
            hostels={ordered.map((row) => row.hostel)}
            me={nearby.coordinates}
            onSelect={(slug) => router.push(`/hostel/${slug}`)}
          />
        ) : rows.length === 0 ? (
          <EmptyState
            action={
              activeCount > 0 || city || meals ? (
                <Button
                  label="Clear filters"
                  onPress={() => {
                    setFilters({ q: filters.q });
                    setCity("");
                    setMeals(false);
                    setSheetOpen(false);
                  }}
                  variant="outline"
                />
              ) : undefined
            }
            description={
              city && returned.length > 0
                ? `None of these listings are in ${city}. Clear the city to see the rest.`
                : meals && returned.length > 0
                  ? "None of these listings have said they provide meals. Clear that to see the rest."
                  : activeCount > 0
                  ? "Nothing matches all of those filters. Try widening one."
                  : "No hostels are published yet."
            }
            title="No results"
          />
        ) : (
          <View className="gap-3">
            <Text variant="caption">
              {`${rows.length} verified ${rows.length === 1 ? "hostel" : "hostels"}`}
              {city ? ` in ${city}` : ""}
              {nearby.isActive ? " · nearest first" : ""}
            </Text>

            {ordered.map((row) => (
              <HostelCard
                commute={
                  commute && minutesTo(row.hostel.id)
                    ? `${minutesTo(row.hostel.id)} min walk to ${commute.name}`
                    : null
                }
                distanceMeters={row.distanceMeters}
                hostel={row.hostel}
                key={row.hostel.id}
                onToggleCompare={toggleCompare}
                onToggleSave={saved.toggle}
                saved={saved.ids.has(row.hostel.id)}
                selectedForCompare={compare.includes(row.hostel.id)}
                showCampusDistance
              />
            ))}

            <Text className="py-4 text-center" variant="caption">
              {/* Reads `returned`, not `rows`: the cap is a property of the
                  request, and the city narrowing happens after it. */}
              {returned.length >= 60
                ? "Showing the first 60 — narrow your filters to see more."
                : "You've reached the end"}
            </Text>
          </View>
        )}
      </View>

      <FilterSheet
        filters={filters}
        onApply={(next) => {
          setFilters(next);
          setSheetOpen(false);
        }}
        onClose={() => setSheetOpen(false)}
        open={sheetOpen}
      />
    </Screen>
  );
}

/**
 * The `Sort: nearest` control — a toggle chip, not a dropdown.
 *
 * There is exactly one alternative to the server's cheapest-first order, so a
 * dropdown would be a menu of two. It sits above the results rather than inside
 * the filter sheet because it needs a permission dialogue: burying a prompt
 * behind Apply means the dialogue arrives after the sheet has closed, attached
 * to nothing the user can see they asked for.
 *
 * `blocked` keeps the chip visible and turns it into the settings link. Hiding
 * it would leave a user who once tapped "Don't allow" with no way back and no
 * explanation of where the option went.
 */
/**
 * List or map, as one two-segment control.
 *
 * A segmented control rather than a single "Map" button because the state is
 * exclusive and persistent — the user is *in* one of two views, and a lone
 * toggle button leaves them guessing which. Both segments stay visible and the
 * selected one is filled, so the current view and the way out of it are the
 * same control.
 *
 * Sized against the 44dp touch target rather than the label: this sits beside a
 * filter chip that people reach for with a thumb halfway down the screen.
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
    { icon: "list-outline", label: "List", value: "list" },
    { icon: "map-outline", label: "Map", value: "map" },
  ] as const;

  return (
    <View className="flex-row overflow-hidden rounded-full border border-border">
      {options.map((option) => {
        const selected = option.value === value;

        return (
          <Pressable
            accessibilityLabel={`${option.label} view`}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            className={`flex-row items-center gap-1.5 px-3 py-1.5 active:opacity-70 ${
              selected ? "bg-primary" : ""
            }`}
            key={option.value}
            onPress={() => onChange(option.value)}
          >
            <Ionicons
              color={selected ? colors.primaryForeground : colors.mutedForeground}
              name={option.icon}
              size={14}
            />
            <Text
              className={`text-xs font-medium ${
                selected ? "text-primary-foreground" : "text-muted-foreground"
              }`}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function NearestToggle({ nearby }: { nearby: ReturnType<typeof useNearby> }) {
  const { colors } = useAppTheme();

  const label = nearby.isBusy
    ? "Finding you…"
    : nearby.isActive
      ? "Nearest first"
      : nearby.status === "blocked"
        ? "Location is blocked — open settings"
        : nearby.status === "unavailable"
          ? "Couldn't find you — try again"
          : "Sort: nearest";

  return (
    <View className="flex-row">
      <Pressable
        accessibilityLabel={label}
        accessibilityRole="button"
        accessibilityState={{ selected: nearby.isActive }}
        className={`flex-row items-center gap-1.5 rounded-full border px-3 py-1.5 active:opacity-70 ${
          nearby.isActive ? "border-primary bg-primary/10" : "border-border"
        }`}
        disabled={nearby.isBusy}
        onPress={() => {
          if (nearby.status === "blocked") {
            nearby.openSettings();
            return;
          }

          if (nearby.isActive) {
            nearby.disable();
            return;
          }

          void nearby.enable();
        }}
      >
        <Ionicons
          color={nearby.isActive ? colors.primary : colors.mutedForeground}
          name={nearby.isActive ? "navigate" : "navigate-outline"}
          size={14}
        />
        <Text
          className={`text-xs font-medium ${nearby.isActive ? "text-primary" : ""}`}
        >
          {label}
        </Text>
      </Pressable>
    </View>
  );
}

function ActiveFilterChips({
  city,
  filters,
  meals,
  onChange,
  onClearCity,
  onClearMeals,
}: {
  /** Narrows on the client, so it is not a `HostelFilters` key — see above. */
  city: string;
  filters: HostelFilters;
  /** Also client-side, and also not a `HostelFilters` key — see above. */
  meals: boolean;
  onChange: (next: HostelFilters) => void;
  onClearCity: () => void;
  onClearMeals: () => void;
}) {
  const chips: { clear: () => void; key: string; label: string }[] = [];

  /** Removes one server-side filter, and its partner where it has one. */
  function drop(key: keyof HostelFilters) {
    const next = { ...filters };

    delete next[key];
    // Budget is one chip over two fields, so clearing it clears both.
    if (key === "minPrice") delete next.maxPrice;

    onChange(next);
  }

  if (city) {
    // First, because it is the one the user most likely arrived with — the home
    // screen's "Browse by city" row deep-links straight into this list.
    chips.push({ clear: onClearCity, key: "city", label: city });
  }

  if (meals) {
    chips.push({ clear: onClearMeals, key: "meals", label: "Serves food" });
  }

  if (filters.type) {
    chips.push({
      clear: () => drop("type"),
      key: "type",
      label: HOSTEL_TYPE_LABELS[filters.type],
    });
  }

  if (filters.stay) {
    chips.push({ clear: () => drop("stay"), key: "stay", label: "Short stays" });
  }

  if (filters.roomType) {
    chips.push({ clear: () => drop("roomType"), key: "roomType", label: filters.roomType });
  }

  if (filters.facility) {
    chips.push({ clear: () => drop("facility"), key: "facility", label: filters.facility });
  }

  if (filters.food) {
    chips.push({
      clear: () => drop("food"),
      key: "food",
      label: filters.food === "veg" ? "Veg" : "Non-veg",
    });
  }

  if (filters.area) {
    chips.push({ clear: () => drop("area"), key: "area", label: filters.area });
  }

  if (filters.minPrice || filters.maxPrice) {
    const band = BUDGET_BANDS.find(
      (option) =>
        option.minPrice === filters.minPrice && option.maxPrice === filters.maxPrice,
    );

    chips.push({ clear: () => drop("minPrice"), key: "budget", label: band?.label ?? "Budget" });
  }

  return (
    <ScrollView contentContainerClassName="gap-2" horizontal showsHorizontalScrollIndicator={false}>
      {chips.map((chip) => (
        <Pressable
          accessibilityLabel={`Remove ${chip.label} filter`}
          accessibilityRole="button"
          className="flex-row items-center gap-1.5 rounded-full bg-primary px-3 py-1.5 active:opacity-70"
          key={chip.key}
          onPress={chip.clear}
        >
          <Text className="text-xs font-semibold text-primary-foreground">
            {chip.label}
          </Text>
          <Ionicons color="#ffffff" name="close" size={12} />
        </Pressable>
      ))}
    </ScrollView>
  );
}

/**
 * The filter sheet.
 *
 * Edits a **draft** and only lifts it on Apply. Filtering live on every tap
 * would refetch four times while somebody sets four filters, and the list
 * behind the sheet would shuffle under a control they are still using.
 */
function FilterSheet({
  filters,
  onApply,
  onClose,
  open,
}: {
  filters: HostelFilters;
  onApply: (next: HostelFilters) => void;
  onClose: () => void;
  open: boolean;
}) {
  const insets = useSystemInsets();
  const [draft, setDraft] = useState(filters);

  const patch = useCallback((next: Partial<HostelFilters>) => {
    setDraft((current) => ({ ...current, ...next }));
  }, []);

  return (
    <Modal
      animationType="slide"
      onRequestClose={onClose}
      onShow={() => setDraft(filters)}
      presentationStyle="pageSheet"
      visible={open}
    >
      <View className="flex-1 bg-background" style={{ paddingTop: insets.top }}>
        <View className="flex-row items-center gap-3 border-b border-border px-5 pb-3 pt-2">
          <Pressable accessibilityLabel="Close" accessibilityRole="button" hitSlop={10} onPress={onClose}>
            <Ionicons name="close" size={24} />
          </Pressable>
          <Text className="flex-1" variant="subtitle">
            Filters
          </Text>
          <Pressable
            accessibilityRole="button"
            hitSlop={8}
            onPress={() => setDraft({ q: draft.q })}
          >
            <Text className="text-primary" variant="label">
              Clear all
            </Text>
          </Pressable>
        </View>

        <ScrollView contentContainerClassName="gap-6 px-5 py-5" contentContainerStyle={{ paddingBottom: 32 }}>
          <FilterGroup title="Hostel type">
            <Choice
              label="Any"
              onPress={() => patch({ type: undefined })}
              selected={!draft.type}
            />
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
                selected={
                  draft.minPrice === band.minPrice && draft.maxPrice === band.maxPrice
                }
              />
            ))}
          </FilterGroup>

          <FilterGroup title="Room type">
            <Choice
              label="Any"
              onPress={() => patch({ roomType: undefined })}
              selected={!draft.roomType}
            />
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
            <Choice
              label="Veg"
              onPress={() => patch({ food: "veg" })}
              selected={draft.food === "veg"}
            />
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
            <Choice
              label="Any"
              onPress={() => patch({ facility: undefined })}
              selected={!draft.facility}
            />
            {FACILITIES.map((facility) => (
              <Choice
                key={facility}
                label={facility}
                onPress={() => patch({ facility })}
                selected={draft.facility === facility}
              />
            ))}
          </FilterGroup>
        </ScrollView>

        <View
          className="border-t border-border px-5 pt-3"
          style={{ paddingBottom: Math.max(insets.bottom, 16) }}
        >
          <Button label="Show hostels" onPress={() => onApply(draft)} />
        </View>
      </View>
    </Modal>
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
