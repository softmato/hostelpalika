"use client";

import {
  AlertCircle as AlertIcon,
  ChevronRight,
  Filter,
  GitCompare,
  Grid2X2,
  List,
  Search,
  X,
} from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";

import { useHostels } from "@/hooks/use-hostels";
import { haversineMeters } from "@/lib/maps/nearby";
import { NEPAL_COLLEGES } from "@/lib/maps/nepal-colleges";
import { useComparisonStore } from "@/stores/comparison-store";
import {
  useHostelFiltersStore,
  type HostelFiltersState,
} from "@/stores/hostel-filters-store";
import { useUiStore } from "@/stores/ui-store";
import { cn } from "@/lib/utils";
import { HostelCard, HostelListCard, NepalBannerGraphic, PublicShell } from "./shared";
import { hasFood, mapPublicHostelToSummary } from "./public-hostel-data";
import { facilityOptions } from "./registration-fields";

function hostelTypeQuery(value: string) {
  if (value === "Boys") return "BOYS";
  if (value === "Girls") return "GIRLS";
  if (value === "Co-living") return "CO_LIVING";

  return "";
}

function budgetQuery(value: string): { maxPrice?: string; minPrice?: string } {
  if (value === "Under NPR 8,000") return { maxPrice: "7999" };
  if (value === "NPR 8,000 - 10,000") {
    return { maxPrice: "10000", minPrice: "8000" };
  }
  if (value === "Above NPR 10,000") return { minPrice: "10001" };

  return {};
}

/** Reverse of budgetQuery: turn a parsed price range back into a filter label. */
function budgetLabel(minPrice?: string, maxPrice?: string): string | undefined {
  const min = minPrice ? Number(minPrice) : undefined;
  const max = maxPrice ? Number(maxPrice) : undefined;

  if (max != null && max <= 8000 && min == null) return "Under NPR 8,000";
  if (min != null && min >= 10000 && max == null) return "Above NPR 10,000";
  if (min != null && max != null) {
    if (max <= 8000) return "Under NPR 8,000";
    if (min >= 10000) return "Above NPR 10,000";
    return "NPR 8,000 - 10,000";
  }

  return undefined;
}

function typeLabel(value: string | null): string | undefined {
  if (value === "BOYS") return "Boys";
  if (value === "GIRLS") return "Girls";
  if (value === "CO_LIVING") return "Co-living";

  return undefined;
}

/** Dietary filter label → the `food` value the public hostels API expects. */
function dietQuery(value: string): "veg" | "non-veg" | undefined {
  if (value === "Veg") return "veg";
  if (value === "Non-veg") return "non-veg";

  return undefined;
}

/** Reverse of dietQuery, for seeding the filter from a hero-search deep link. */
function dietLabel(value: string | null): string | undefined {
  if (value === "veg") return "Veg";
  if (value === "non-veg") return "Non-veg";

  return undefined;
}

function PublicHostelListingPageContent() {
  const searchParams = useSearchParams();

  const {
    area: selectedArea,
    budget: selectedBudget,
    college: selectedCollege,
    diet: selectedDiet,
    facilities: selectedFacilities,
    food: selectedFood,
    query,
    reset,
    room: selectedRoom,
    sortBy,
    stay: selectedStay,
    type: selectedType,
    update,
    viewMode,
  } = useHostelFiltersStore();

  const compareIds = useComparisonStore((state) => state.ids);
  const toggleCompare = useComparisonStore((state) => state.toggle);
  const clearCompare = useComparisonStore((state) => state.clear);

  const mobileFiltersOpen = useUiStore((state) => state.mobileFiltersOpen);
  const setMobileFiltersOpen = useUiStore((state) => state.setMobileFiltersOpen);

  const [facilitySearch, setFacilitySearch] = useState("");

  // Seed the filters from the deep link (zustand action, not React setState —
  // safe inside an effect). The hero search resolves a sentence into these
  // params before navigating here, so arriving pre-filtered is the normal path.
  const deepLink = searchParams?.toString() ?? "";
  useEffect(() => {
    const params = new URLSearchParams(deepLink);
    const patch: Partial<HostelFiltersState> = {};

    const search = params.get("search");
    if (search) patch.query = search;

    const area = params.get("area");
    if (area) patch.area = area;

    const facility = params.get("facility");
    if (facility) {
      patch.facilities = facility
        .split(",")
        .map((f) => f.trim())
        .filter(Boolean);
    }

    const room = params.get("roomType");
    if (room) patch.room = room;

    const type = typeLabel(params.get("type"));
    if (type) patch.type = type;

    const budget = budgetLabel(
      params.get("minPrice") ?? undefined,
      params.get("maxPrice") ?? undefined,
    );
    if (budget) patch.budget = budget;

    const diet = dietLabel(params.get("food"));
    if (diet) patch.diet = diet;

    if (params.get("stay") === "short") patch.stay = "Short stays";

    if (Object.keys(patch).length > 0) {
      update(patch);
    }
  }, [deepLink, update]);

  // Debounce the search term that actually drives the query, so typing does not
  // fire a request per keystroke.
  const [debouncedQuery, setDebouncedQuery] = useState(query);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query), 180);
    return () => window.clearTimeout(timer);
  }, [query]);

  const apiParams = useMemo(() => {
    const budget = budgetQuery(selectedBudget);
    const type = hostelTypeQuery(selectedType);

    return {
      area: selectedArea !== "All Areas" ? selectedArea : undefined,
      facility: selectedFacilities.length > 0 ? selectedFacilities.join(",") : undefined,
      food: dietQuery(selectedDiet),
      maxPrice: budget.maxPrice,
      minPrice: budget.minPrice,
      q: debouncedQuery.trim() || undefined,
      roomType: selectedRoom !== "All Room Types" ? selectedRoom : undefined,
      stay: selectedStay === "Short stays" ? ("short" as const) : undefined,
      type: type || undefined,
    };
  }, [
    debouncedQuery,
    selectedArea,
    selectedBudget,
    selectedDiet,
    selectedFacilities,
    selectedRoom,
    selectedStay,
    selectedType,
  ]);

  const { data, error, isError, isPending } = useHostels(apiParams);
  const hostels = useMemo(() => data?.hostels ?? [], [data]);
  const message = isError
    ? error instanceof Error
      ? error.message
      : "Could not load published hostels."
    : "";

  const hostelRows = useMemo(
    () =>
      hostels.map((hostel) => ({
        raw: hostel,
        summary: mapPublicHostelToSummary(hostel),
      })),
    [hostels],
  );

  const filtered = useMemo(() => {
    let rows = hostelRows.filter(({ raw }) => {
      if (selectedFood !== "Any") {
        const hostelHasFood = hasFood(raw);
        if (selectedFood === "With Food" && !hostelHasFood) return false;
        if (selectedFood === "Without Food" && hostelHasFood) return false;
      }

      return true;
    });

    const college =
      selectedCollege !== "All Colleges"
        ? NEPAL_COLLEGES.find((item) => item.name === selectedCollege)
        : undefined;

    if (college) {
      // "Near my college": rank by straight-line distance; hostels without
      // pinned coordinates fall to the end.
      const distanceOf = ({ raw }: (typeof rows)[number]) =>
        raw.coordinates
          ? haversineMeters(raw.coordinates, college.coordinates)
          : Number.POSITIVE_INFINITY;
      rows = [...rows].sort((a, b) => distanceOf(a) - distanceOf(b));
    } else if (sortBy === "Price: Low to High") {
      rows = [...rows].sort((a, b) => a.summary.price - b.summary.price);
    } else if (sortBy === "Price: High to Low") {
      rows = [...rows].sort((a, b) => b.summary.price - a.summary.price);
    } else if (sortBy === "Rating") {
      rows = [...rows].sort((a, b) => b.summary.rating - a.summary.rating);
    }

    return rows.map(({ summary }) => summary);
  }, [selectedFood, hostelRows, sortBy, selectedCollege]);

  const areaOptions = useMemo(() => {
    const areas = new Set<string>(["All Areas"]);

    hostels.forEach((hostel) => {
      if (hostel.location.city) areas.add(hostel.location.city);
      if (hostel.location.area) areas.add(hostel.location.area);
    });

    return [...areas];
  }, [hostels]);

  const handleClearAll = () => {
    reset();
    setDebouncedQuery("");
  };

  return (
    <PublicShell active="browse">
      {/* Hero Banner Section with Nepal Silhouette Graphic */}
      <section className="relative overflow-hidden border-b border-border bg-brand-teal-soft/20 min-h-[160px] flex items-center">
        <div className="mx-auto w-full max-w-[1448px] px-4 py-8 relative z-10 sm:px-6">
          <span className="text-xs font-bold text-brand-teal uppercase tracking-wider">
            Discover Places
          </span>
          <h1 className="text-2xl sm:text-3xl md:text-4xl font-extrabold text-foreground mt-1">
            Browse Hostels in Nepal
          </h1>
          <p className="mt-2 text-xs md:text-sm text-muted-foreground max-w-xl leading-relaxed">
            Explore verified hostels across top cities. Compare facilities, prices, and
            availability to find the perfect place for your stay.
          </p>
        </div>
        <NepalBannerGraphic />
      </section>

      <div className="mx-auto max-w-[1448px] px-4 py-6 sm:px-6">
        {/* Breadcrumbs */}
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-6">
          <Link href="/" className="hover:text-foreground transition font-medium">
            Home
          </Link>
          <ChevronRight className="size-3 text-muted-foreground/60" />
          <span className="text-foreground font-semibold">Hostels</span>
        </div>

        {/* Mobile filters toggle */}
        <button
          className="lg:hidden mb-4 flex w-full items-center justify-center gap-2 rounded-lg border border-border bg-surface px-4 py-2.5 text-sm font-bold text-foreground shadow-sm"
          onClick={() => setMobileFiltersOpen(!mobileFiltersOpen)}
          type="button"
        >
          <Filter className="size-4 text-brand-teal" />
          {mobileFiltersOpen ? "Hide Filters" : "Show Filters"}
        </button>

        {/* Main Two-Column Layout */}
        <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-8 items-start">
          {/* Left Sidebar Filter Column */}
          <aside
            className={cn(
              "space-y-6 lg:sticky lg:top-24",
              !mobileFiltersOpen && "hidden lg:block",
            )}
          >
            <div className="bg-surface rounded-xl border border-border/80 p-5 shadow-sm space-y-6">
              {/* Header */}
              <div className="flex items-center justify-between border-b border-border/60 pb-3">
                <h3 className="font-bold text-sm text-foreground flex items-center gap-1.5">
                  <Filter className="size-4 text-brand-teal" /> Filters
                </h3>
                <button
                  onClick={handleClearAll}
                  className="text-xs font-bold text-brand-teal hover:underline"
                >
                  Clear All
                </button>
              </div>

              {/* Search input in sidebar */}
              <div className="space-y-2">
                <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">
                  Search
                </p>
                <div className="relative flex items-center rounded-lg border border-border bg-muted px-3 py-2 focus-within:border-brand-teal focus-within:ring-2 focus-within:ring-brand-teal/15 transition">
                  <Search className="size-4 text-muted-foreground shrink-0" />
                  <input
                    aria-label="Search by hostel name or area"
                    className="ml-2 w-full bg-transparent text-xs outline-none placeholder:text-muted-foreground"
                    onChange={(event) => update({ query: event.target.value })}
                    placeholder="Hostel name or area..."
                    value={query}
                  />
                </div>
              </div>

              {/* Area select list */}
              <div className="space-y-2 pt-2 border-t border-border/60">
                <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">
                  Area
                </p>
                <div className="space-y-1 max-h-40 overflow-y-auto scrollbar-thin pr-1">
                  {areaOptions.map((areaName) => {
                    const active = selectedArea === areaName;
                    return (
                      <button
                        key={areaName}
                        onClick={() => update({ area: areaName })}
                        className={cn(
                          "flex items-center justify-between w-full text-left px-2 py-1.5 rounded-md text-xs font-semibold transition",
                          active
                            ? "bg-brand-teal-soft/30 text-brand-teal"
                            : "text-foreground hover:bg-muted",
                        )}
                      >
                        <span>{areaName}</span>
                        {areaName !== "All Areas" && (
                          <span className="text-[10px] font-normal text-muted-foreground">
                            (
                            {
                              hostelRows.filter(
                                ({ summary }) =>
                                  summary.area === areaName || summary.city === areaName,
                              ).length
                            }
                            )
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Budget radio buttons */}
              <div className="space-y-2 pt-2 border-t border-border/60">
                <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">
                  Budget (Monthly)
                </p>
                <div className="space-y-2">
                  {[
                    "Any Budget",
                    "Under NPR 8,000",
                    "NPR 8,000 - 10,000",
                    "Above NPR 10,000",
                  ].map((budgetRange) => {
                    const active = selectedBudget === budgetRange;
                    return (
                      <label
                        key={budgetRange}
                        className="flex items-center gap-2.5 cursor-pointer text-xs font-semibold text-foreground"
                      >
                        <input
                          type="radio"
                          name="budget"
                          checked={active}
                          onChange={() => update({ budget: budgetRange })}
                          className="size-3.5 text-brand-teal border-border focus:ring-brand-teal"
                        />
                        <span>{budgetRange}</span>
                      </label>
                    );
                  })}
                </div>
              </div>

              {/* Stay length — filtered server-side on the hostel's short-stay switch. */}
              <div className="space-y-2 pt-2 border-t border-border/60">
                <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">
                  Stay Length
                </p>
                <div className="space-y-2">
                  {["Any", "Short stays"].map((stayVal) => (
                    <label
                      key={stayVal}
                      className="flex items-center gap-2.5 cursor-pointer text-xs font-semibold text-foreground"
                    >
                      <input
                        type="radio"
                        name="stay"
                        checked={selectedStay === stayVal}
                        onChange={() => update({ stay: stayVal })}
                        className="size-3.5 text-brand-teal border-border focus:ring-brand-teal"
                      />
                      <span>{stayVal === "Any" ? "Any length" : "Short stays (nightly)"}</span>
                    </label>
                  ))}
                </div>
              </div>

              {/* Hostel Type */}
              <div className="space-y-2 pt-2 border-t border-border/60">
                <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">
                  Hostel Type
                </p>
                <div className="space-y-2">
                  {["All Types", "Boys", "Girls", "Co-living"].map((typeVal) => {
                    const active = selectedType === typeVal;
                    return (
                      <label
                        key={typeVal}
                        className="flex items-center gap-2.5 cursor-pointer text-xs font-semibold text-foreground"
                      >
                        <input
                          type="radio"
                          name="type"
                          checked={active}
                          onChange={() => update({ type: typeVal })}
                          className="size-3.5 text-brand-teal border-border focus:ring-brand-teal"
                        />
                        <span>{typeVal}</span>
                      </label>
                    );
                  })}
                </div>
              </div>

              {/* Room Type */}
              <div className="space-y-2 pt-2 border-t border-border/60">
                <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">
                  Room Type
                </p>
                <div className="space-y-2">
                  {["All Room Types", "Single", "Double", "Triple", "Dormitory"].map(
                    (roomVal) => {
                      const active = selectedRoom === roomVal;
                      return (
                        <label
                          key={roomVal}
                          className="flex items-center gap-2.5 cursor-pointer text-xs font-semibold text-foreground"
                        >
                          <input
                            type="radio"
                            name="room"
                            checked={active}
                            onChange={() => update({ room: roomVal })}
                            className="size-3.5 text-brand-teal border-border focus:ring-brand-teal"
                          />
                          <span>{roomVal}</span>
                        </label>
                      );
                    },
                  )}
                </div>
              </div>

              {/* Food Option */}
              <div className="space-y-2 pt-2 border-t border-border/60">
                <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">
                  Food Option
                </p>
                <div className="space-y-2">
                  {["Any", "With Food", "Without Food"].map((foodVal) => {
                    const active = selectedFood === foodVal;
                    return (
                      <label
                        key={foodVal}
                        className="flex items-center gap-2.5 cursor-pointer text-xs font-semibold text-foreground"
                      >
                        <input
                          type="radio"
                          name="food"
                          checked={active}
                          onChange={() => update({ food: foodVal })}
                          className="size-3.5 text-brand-teal border-border focus:ring-brand-teal"
                        />
                        <span>{foodVal}</span>
                      </label>
                    );
                  })}
                </div>
              </div>

              {/* Dietary — asks what is served, unlike Food Option above which
                  asks whether meals are provided at all. Filtered server-side. */}
              <div className="space-y-2 pt-2 border-t border-border/60">
                <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">
                  Dietary
                </p>
                <div className="space-y-2">
                  {["Any", "Veg", "Non-veg"].map((dietVal) => {
                    const active = selectedDiet === dietVal;
                    return (
                      <label
                        key={dietVal}
                        className="flex items-center gap-2.5 cursor-pointer text-xs font-semibold text-foreground"
                      >
                        <input
                          type="radio"
                          name="diet"
                          checked={active}
                          onChange={() => update({ diet: dietVal })}
                          className="size-3.5 text-brand-teal border-border focus:ring-brand-teal"
                        />
                        <span>{dietVal}</span>
                      </label>
                    );
                  })}
                </div>
              </div>

              {/* Facilities */}
              <div className="space-y-2 pt-2 border-t border-border/60">
                <div className="flex items-center justify-between">
                  <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">
                    Facilities {selectedFacilities.length > 0 ? `(${selectedFacilities.length})` : ""}
                  </p>
                  {selectedFacilities.length > 0 ? (
                    <button
                      className="text-[10px] font-bold text-brand-teal hover:underline"
                      onClick={() => update({ facilities: [] })}
                      type="button"
                    >
                      Clear
                    </button>
                  ) : null}
                </div>

                <div className="relative flex items-center rounded-lg border border-border bg-muted px-2.5 py-1.5 focus-within:border-brand-teal focus-within:ring-2 focus-within:ring-brand-teal/15 transition mb-2">
                  <Search className="size-3 text-muted-foreground shrink-0" />
                  <input
                    aria-label="Filter facilities"
                    className="ml-1.5 w-full bg-transparent text-[11px] outline-none placeholder:text-muted-foreground"
                    onChange={(e) => setFacilitySearch(e.target.value)}
                    placeholder="Filter amenities..."
                    value={facilitySearch}
                  />
                </div>

                <div className="space-y-1.5 max-h-48 overflow-y-auto scrollbar-thin pr-1">
                  {facilityOptions
                    .filter((facVal) =>
                      facVal.toLowerCase().includes(facilitySearch.trim().toLowerCase()),
                    )
                    .map((facVal) => {
                      const active = selectedFacilities.includes(facVal);
                      return (
                        <label
                          key={facVal}
                          className="flex items-center gap-2.5 cursor-pointer text-xs font-semibold text-foreground py-0.5"
                        >
                          <input
                            type="checkbox"
                            checked={active}
                            onChange={() => {
                              const next = active
                                ? selectedFacilities.filter((f) => f !== facVal)
                                : [...selectedFacilities, facVal];
                              update({ facilities: next });
                            }}
                            className="size-3.5 rounded border-border text-brand-teal focus:ring-brand-teal"
                          />
                          <span>{facVal}</span>
                        </label>
                      );
                    })}
                </div>
              </div>

              {/* Near my college */}
              <div className="space-y-2 pt-2 border-t border-border/60">
                <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">
                  Near My College
                </p>
                <select
                  className="w-full rounded-lg border border-border bg-muted px-3 py-2 text-xs font-semibold text-foreground outline-none focus:border-brand-teal focus:ring-2 focus:ring-brand-teal/15"
                  onChange={(event) => update({ college: event.target.value })}
                  value={selectedCollege}
                >
                  <option value="All Colleges">All Colleges</option>
                  {NEPAL_COLLEGES.map((college) => (
                    <option key={college.name} value={college.name}>
                      {college.name}
                    </option>
                  ))}
                </select>
                {selectedCollege !== "All Colleges" ? (
                  <p className="text-[10px] font-medium text-muted-foreground">
                    Sorted by distance to {selectedCollege}.
                  </p>
                ) : null}
              </div>
            </div>
          </aside>

          {/* Right Listings Column */}
          <main className="space-y-5">
            {/* Top Toolbar */}
            <div className="flex flex-wrap items-center justify-between gap-4 bg-surface rounded-xl border border-border/80 p-4 shadow-sm">
              <div className="space-y-0.5">
                <h3 className="font-bold text-sm text-foreground">Showing Hostels</h3>
                <p className="text-[11px] text-muted-foreground font-semibold">
                  {isPending
                    ? "Loading published hostels..."
                    : `${filtered.length} verified ${
                        filtered.length === 1 ? "result" : "results"
                      } found in Nepal`}
                </p>
              </div>

              <div className="flex items-center gap-4">
                {/* Sort Option */}
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold text-muted-foreground shrink-0">
                    Sort by:
                  </span>
                  <select
                    value={sortBy}
                    onChange={(e) => update({ sortBy: e.target.value })}
                    className="bg-muted border border-border rounded-lg text-xs font-bold text-foreground py-1.5 px-3 outline-none focus:border-brand-teal focus:ring-2 focus:ring-brand-teal/15 transition cursor-pointer"
                  >
                    {[
                      "Recommended",
                      "Price: Low to High",
                      "Price: High to Low",
                      "Rating",
                    ].map((opt) => (
                      <option key={opt} value={opt}>
                        {opt}
                      </option>
                    ))}
                  </select>
                </div>

                {/* View Toggles */}
                <div className="flex items-center gap-1.5 border-l border-border/60 pl-4">
                  <button
                    onClick={() => update({ viewMode: "grid" })}
                    className={cn(
                      "size-8 rounded-lg flex items-center justify-center border transition",
                      viewMode === "grid"
                        ? "border-brand-teal bg-brand-teal-soft/10 text-brand-teal"
                        : "border-border text-muted-foreground hover:bg-muted",
                    )}
                  >
                    <Grid2X2 className="size-4" />
                  </button>
                  <button
                    onClick={() => update({ viewMode: "list" })}
                    className={cn(
                      "size-8 rounded-lg flex items-center justify-center border transition",
                      viewMode === "list"
                        ? "border-brand-teal bg-brand-teal-soft/10 text-brand-teal"
                        : "border-border text-muted-foreground hover:bg-muted",
                    )}
                  >
                    <List className="size-4" />
                  </button>
                </div>
              </div>
            </div>

            {/* Results Grid / List */}
            {message ? (
              <div className="rounded-xl border border-danger/20 bg-danger/5 p-4 text-sm font-semibold text-danger">
                {message}
              </div>
            ) : null}

            {isPending ? (
              <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
                {Array.from({ length: 6 }).map((_, index) => (
                  <div
                    className="h-72 animate-pulse rounded-xl border border-border bg-muted"
                    key={index}
                  />
                ))}
              </div>
            ) : filtered.length === 0 ? (
              <div className="text-center py-20 rounded-xl border border-dashed border-border bg-muted/50">
                <AlertIcon className="mx-auto size-10 text-muted-foreground" />
                <p className="mt-4 font-bold text-foreground">
                  No results match your filters
                </p>
                <p className="text-xs text-muted-foreground mt-1 max-w-sm mx-auto leading-relaxed">
                  Try widening your search criteria, clearing search keywords, or
                  selecting different filter parameters.
                </p>
                <button
                  className="mt-5 rounded-lg bg-brand-teal px-5 py-2.5 text-xs font-bold text-white hover:brightness-105 transition"
                  onClick={handleClearAll}
                >
                  Reset All Filters
                </button>
              </div>
            ) : (
              <div
                className={cn(
                  viewMode === "grid"
                    ? "grid gap-5 sm:grid-cols-2 lg:grid-cols-3"
                    : "flex flex-col gap-4",
                )}
              >
                {filtered.map((hostel) => {
                  const inCompare = compareIds.includes(hostel.id);
                  return (
                    <div className="relative" key={hostel.id}>
                      <button
                        aria-pressed={inCompare}
                        className={cn(
                          "absolute left-3 top-3 z-20 flex items-center gap-1 rounded-full border px-2.5 py-1 text-[10px] font-bold shadow-sm transition",
                          inCompare
                            ? "border-brand-teal bg-brand-teal text-white"
                            : "border-border bg-surface/90 text-foreground hover:bg-muted",
                        )}
                        onClick={() => {
                          const ok = toggleCompare(hostel.id);
                          if (!ok) {
                            window.alert("You can compare up to 3 hostels side-by-side.");
                          }
                        }}
                        type="button"
                      >
                        <GitCompare className="size-3" />
                        {inCompare ? "Added" : "Compare"}
                      </button>
                      {viewMode === "grid" ? (
                        <HostelCard hostel={hostel} />
                      ) : (
                        <HostelListCard hostel={hostel} />
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </main>
        </div>
      </div>

      {/* Floating comparison tray */}
      {compareIds.length > 0 ? (
        <div className="fixed bottom-6 left-1/2 z-40 flex max-w-[calc(100%-2rem)] -translate-x-1/2 items-center gap-3 whitespace-nowrap rounded-full border border-border bg-surface px-5 py-3 shadow-xl">
          <GitCompare className="size-4 text-brand-teal" />
          <span className="text-sm font-bold text-foreground">
            {compareIds.length} selected
          </span>
          <Link
            className="rounded-full bg-brand-teal px-4 py-1.5 text-xs font-bold text-white transition hover:brightness-105"
            href="/compare"
          >
            Compare
          </Link>
          <button
            aria-label="Clear comparison"
            className="text-muted-foreground transition hover:text-foreground"
            onClick={clearCompare}
            type="button"
          >
            <X className="size-4" />
          </button>
        </div>
      ) : null}
    </PublicShell>
  );
}

export function PublicHostelListingPage() {
  return (
    <Suspense fallback={null}>
      <PublicHostelListingPageContent />
    </Suspense>
  );
}
