"use client";

import {
  BadgeCheck,
  CheckCircle2,
  Image as ImageIcon,
  MapPin,
  PhoneCall,
  Plus,
  Send,
  Star,
  Users,
  Utensils,
  X,
} from "@/components/icons";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { HostelSuggestions } from "@/components/hostel-suggestions";
import { HostelMap } from "@/components/maps/hostel-map";
import { MediaLightbox, type LightboxItem } from "@/components/media-lightbox";
import { useCompareHostels, useHostels, useHostelsReviews } from "@/hooks/use-hostels";
import { useMyExpertConsultationRequest } from "@/hooks/use-expert-consultation";
import { topHostelMatches } from "@/lib/hostel-recommendation";
import { useComparisonStore } from "@/stores/comparison-store";
import { cn } from "@/lib/utils";
import { PublicShell, SectionCard, StatusPill, formatMoney } from "./shared";
import { mapPublicHostelToSummary, roomTypeLabel, type PublicHostel } from "./public-hostel-data";

/** Every photo the hostel has uploaded, in upload order — the lightbox's set. */
function galleryItemsFor(hostel: PublicHostel): LightboxItem[] {
  return (hostel.photos ?? [])
    .filter((photo) => Boolean(photo.url))
    .map((photo) => ({
      caption: photo.alt || undefined,
      kind: "image" as const,
      src: photo.url ?? "",
      title: hostel.name,
    }));
}

/**
 * N-column grid shared by every rich comparison section below the quick
 * table. Bordered and divided like the quick table's own columns, so each
 * hostel's data reads as one clearly bounded column instead of running
 * together — each child is expected to bring its own `p-4`.
 */
function CompareGrid({ children, count }: { children: ReactNode; count: number }) {
  return (
    <div className="overflow-x-auto">
      <div
        className="grid divide-x divide-border overflow-hidden rounded-lg border border-border"
        style={{
          gridTemplateColumns: `repeat(${count}, minmax(220px, 1fr))`,
          minWidth: `${count * 220}px`,
        }}
      >
        {children}
      </div>
    </div>
  );
}

/** Sunday-first, matching how the hostel admin configures the routine. */
const ROUTINE_DAYS = [
  "SUNDAY",
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
] as const;

const ROUTINE_MEALS = [
  { label: "Breakfast", type: "BREAKFAST" },
  { label: "Lunch", type: "LUNCH" },
  { label: "Snacks", type: "SNACKS" },
  { label: "Dinner", type: "DINNER" },
] as const;

function titleCaseDay(day: string) {
  return day.charAt(0) + day.slice(1).toLowerCase();
}

/** Only the days with something published — a half-filled routine still reads cleanly. */
function foodRoutineRowsFor(hostel: PublicHostel) {
  const meals = hostel.foodRoutine?.meals ?? [];

  return ROUTINE_DAYS.map((day) => ({
    day,
    meals: ROUTINE_MEALS.map((meal) => ({
      ...meal,
      menu: meals.find((entry) => entry.dayOfWeek === day && entry.mealType === meal.type),
    })).filter((meal) => Boolean(meal.menu)),
  })).filter((row) => row.meals.length > 0);
}

function ColumnLabel({ name }: { name: string }) {
  return (
    <p className="mb-2 truncate text-xs font-bold text-foreground" title={name}>
      {name}
    </p>
  );
}

export function PublicComparePage() {
  const compareIds = useComparisonStore((state) => state.ids);
  const toggleCompare = useComparisonStore((state) => state.toggle);
  const removeCompare = useComparisonStore((state) => state.remove);

  const [lightbox, setLightbox] = useState<{ index: number; items: LightboxItem[] } | null>(
    null,
  );

  const availableQuery = useHostels();
  const available = useMemo(
    () => availableQuery.data?.hostels ?? [],
    [availableQuery.data],
  );

  // Seed a default selection (first up to 3) so a direct visit to /compare is
  // not empty. Zustand action in an effect — not React setState.
  // Guard against stale persisted ids (e.g. a hostel later unpublished).
  const validIds = useMemo(
    () => compareIds.filter((id) => available.some((hostel) => hostel.id === id)),
    [compareIds, available],
  );

  // Nothing valid selected → drop stale ids and seed 3 random hostels.
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || validIds.length > 0 || available.length < 2) {
      return;
    }
    seeded.current = true;
    compareIds.forEach((id) => removeCompare(id));
    [...available]
      .sort(() => Math.random() - 0.5)
      .slice(0, 3)
      .forEach((hostel) => toggleCompare(hostel.id));
  }, [validIds.length, compareIds, available, toggleCompare, removeCompare]);

  const comparisonQuery = useCompareHostels(validIds);

  // The raw record, not the flattened card summary — the compare page needs
  // photos, room configurations, food routine and rules the summary drops.
  const comparedHostels = useMemo(
    () => comparisonQuery.data?.hostels ?? [],
    [comparisonQuery.data],
  );

  const reviewQueries = useHostelsReviews(comparedHostels.map((hostel) => hostel.slug));

  const availableHostels = useMemo(
    () => available.map(mapPublicHostelToSummary),
    [available],
  );

  // Computed here, not inside `HostelSuggestions`, because the comparison
  // grid below needs the same match list to badge a hostel the visitor
  // already added instead of that component rendering it a second time.
  const {
    data: myMatchRequest,
    isLoading: isLoadingMatches,
    refetch: refetchMatchRequest,
  } = useMyExpertConsultationRequest();
  const matches = useMemo(
    () => topHostelMatches(available, myMatchRequest ?? null, 3),
    [available, myMatchRequest],
  );
  const matchedIds = useMemo(
    () => new Set(matches.map(({ hostel }) => hostel.id)),
    [matches],
  );

  const isLoading = availableQuery.isPending || comparisonQuery.isFetching;

  const message = availableQuery.isError
    ? "Could not load hostel comparison data."
    : available.length < 2
      ? "Publish at least two verified hostels to compare them."
      : "";

  const criteriaRows = [
    "Hostel",
    "Monthly Rent",
    "Location",
    "Room Types",
    "Vacant Beds",
    "Facilities",
    "Food",
    "Verification",
    "Rating & Reviews",
  ];

  const addHostel = () => {
    const next = availableHostels.find((hostel) => !compareIds.includes(hostel.id));
    if (!next) {
      return;
    }
    const added = toggleCompare(next.id);
    if (!added) {
      window.alert("You can compare up to 3 hostels side-by-side.");
    }
  };

  const addSpecificHostel = (hostelId: string) => {
    if (compareIds.includes(hostelId)) {
      return;
    }
    const added = toggleCompare(hostelId);
    if (!added) {
      window.alert("You can compare up to 3 hostels side-by-side.");
    }
  };

  const openGallery = (hostel: PublicHostel, index = 0) => {
    const items = galleryItemsFor(hostel);
    if (items.length === 0) {
      return;
    }
    setLightbox({ index, items });
  };

  return (
    <PublicShell active="compare">
      <section className="mx-auto max-w-[1360px] px-4 pt-8 pb-16 sm:px-6">
        <div className="mb-6 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-foreground sm:text-3xl">Compare Hostels</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Compare verified hostels side by side and choose the best place that fits
              your needs.
            </p>
          </div>
          {comparedHostels.length < 3 && (
            <button
              onClick={addHostel}
              className="rounded-lg bg-brand-teal px-5 py-2.5 text-sm font-semibold text-white shadow hover:brightness-105 transition flex items-center gap-1.5"
            >
              <Plus className="size-4" /> Add Another Hostel
            </button>
          )}
        </div>

        <div className="flex gap-4 mb-4">
          <Link
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-muted-foreground hover:text-foreground transition"
            href="/hostels"
          >
            &larr; Back to Hostels
          </Link>
        </div>

        <HostelSuggestions
          compareIds={compareIds}
          isLoading={isLoadingMatches}
          matches={matches}
          myRequest={myMatchRequest}
          onAddToCompare={addSpecificHostel}
          onSubmitted={() => void refetchMatchRequest()}
        />

        {message ? (
          <div className="mb-4 rounded-lg border border-border bg-muted/40 p-3 text-sm text-foreground">
            {message}
          </div>
        ) : null}

        {isLoading ? (
          <div className="h-96 animate-pulse rounded-xl border border-border bg-muted" />
        ) : comparedHostels.length === 0 ? (
          <SectionCard>
            <div className="p-10 text-center text-sm text-muted-foreground">
              No hostels selected. Pick hostels from the{" "}
              <Link
                className="font-semibold text-brand-teal hover:underline"
                href="/hostels"
              >
                listing page
              </Link>{" "}
              to compare them here.
            </div>
          </SectionCard>
        ) : (
          <div className="space-y-6">
            <SectionCard className="overflow-x-auto">
              <div
                className="grid"
                style={{
                  // The criteria column pins to the left edge so a phone scrolling
                  // sideways through hostels never loses which row it is reading.
                  gridTemplateColumns: `minmax(128px, 220px) repeat(${comparedHostels.length}, minmax(220px, 1fr))`,
                  minWidth: 128 + comparedHostels.length * 220,
                }}
              >
                {/* Left Criteria column */}
                <div className="sticky left-0 z-30 border-r border-border bg-muted">
                  <div className="h-44 flex items-center px-3 sm:px-5 border-b border-border bg-muted">
                    <span className="font-bold text-sm text-foreground uppercase tracking-wider">
                      Comparison Criteria
                    </span>
                  </div>
                  <div className="divide-y divide-border/60 text-xs font-semibold text-muted-foreground">
                    {criteriaRows.map((label) => (
                      <div key={label} className="h-14 flex items-center px-3 sm:px-5">
                        {label}
                      </div>
                    ))}
                    <div className="h-20 flex items-center px-3 sm:px-5">Actions</div>
                  </div>
                </div>

                {/* Hostel columns */}
                {comparedHostels.map((hostel) => {
                  const summary = mapPublicHostelToSummary(hostel);
                  const photoCount = (hostel.photos ?? []).filter((p) => p.url).length;
                  const fee = hostel.comparison?.monthlyFee;
                  const rent =
                    fee && fee.max && fee.min && fee.max !== fee.min
                      ? `${formatMoney(fee.min)} - ${formatMoney(fee.max)}`
                      : formatMoney(summary.price);
                  const foodFacts = [
                    hostel.food?.mealsPerDay ? `${hostel.food.mealsPerDay}x/day` : null,
                    hostel.food?.hasVeg ? "Veg" : null,
                    hostel.food?.hasNonVeg ? "Non-veg" : null,
                  ].filter((fact): fact is string => Boolean(fact));

                  return (
                    <div
                      className="border-r border-border last:border-r-0 relative"
                      key={hostel.id}
                    >
                      {/* Delete header button */}
                      <button
                        onClick={() => removeCompare(hostel.id)}
                        className="absolute right-3 top-3 z-20 size-7 bg-surface/90 hover:bg-red-50 hover:text-danger rounded-full border border-border flex items-center justify-center text-muted-foreground transition shadow-sm"
                        title="Remove from comparison"
                      >
                        <X className="size-3.5" />
                      </button>

                      {/* Card header — click the photo to open the full gallery */}
                      <div className="h-44 border-b border-border bg-surface p-4 flex flex-col justify-end">
                        <button
                          aria-label={`View ${summary.name} photos`}
                          className="absolute inset-0 h-32 cursor-zoom-in"
                          onClick={() => openGallery(hostel)}
                          type="button"
                        >
                          <span
                            className="absolute inset-0 bg-cover bg-center opacity-90"
                            style={{ backgroundImage: `url("${summary.image}")` }}
                          />
                          <span className="absolute inset-0 h-32 bg-gradient-to-t from-surface via-surface/50 to-transparent" />
                        </button>
                        {photoCount > 0 ? (
                          <span className="pointer-events-none absolute left-3 top-3 z-10 inline-flex items-center gap-1 rounded-full bg-slate-950/60 px-2 py-0.5 text-[10px] font-bold text-white">
                            <ImageIcon className="size-3" /> {photoCount}
                          </span>
                        ) : null}
                        <div className="relative z-10 pt-24 pointer-events-none">
                          <div className="mb-1 flex flex-wrap items-center gap-1">
                            <StatusPill
                              tone="success"
                              className="text-[9px] py-0 px-1 rounded-sm w-fit"
                            >
                              Verified
                            </StatusPill>
                            {matchedIds.has(hostel.id) ? (
                              <span className="inline-flex items-center gap-0.5 rounded-sm bg-warning px-1 py-0 text-[9px] font-bold text-white">
                                <Star className="size-2.5 fill-white" />
                                Suggested match
                              </span>
                            ) : null}
                          </div>
                          <h2
                            className="font-bold text-sm text-foreground truncate"
                            title={summary.name}
                          >
                            {summary.name}
                          </h2>
                        </div>
                      </div>

                      {/* Criteria Values rows */}
                      <div className="divide-y divide-border/60 text-xs text-foreground">
                        {/* Name */}
                        <div className="h-14 flex items-center px-5 font-semibold truncate bg-surface">
                          {summary.name}
                        </div>
                        {/* Rent */}
                        <div className="h-14 flex items-center px-5 font-extrabold text-brand-teal bg-surface">
                          {rent}{" "}
                          <span className="text-[10px] font-normal text-muted-foreground ml-1">
                            / month
                          </span>
                        </div>
                        {/* Location */}
                        <div className="h-14 flex items-center px-5 bg-surface truncate">
                          {summary.address}
                        </div>
                        {/* Room Types */}
                        <div className="h-14 flex items-center px-5 bg-surface truncate">
                          {summary.roomTypes.map(roomTypeLabel).join(", ") || "—"}
                        </div>
                        {/* Vacancy */}
                        <div className="h-14 flex items-center px-5 font-bold text-success bg-surface">
                          {summary.vacancy} Beds Vacant
                        </div>
                        {/* Facilities */}
                        <div className="h-14 flex items-center gap-1 px-5 bg-surface overflow-hidden">
                          {summary.facilities.slice(0, 3).map((f) => (
                            <span
                              key={f}
                              className="rounded bg-muted px-1.5 py-0.5 text-[9px] text-muted-foreground"
                              title={f}
                            >
                              {f}
                            </span>
                          ))}
                          {summary.facilities.length > 3 ? (
                            <span className="text-[9px] font-semibold text-muted-foreground">
                              +{summary.facilities.length - 3}
                            </span>
                          ) : null}
                        </div>
                        {/* Food */}
                        <div className="h-14 flex items-center gap-1 px-5 bg-surface overflow-hidden">
                          {foodFacts.length > 0 ? (
                            foodFacts.map((fact) => (
                              <span
                                key={fact}
                                className="rounded bg-brand-teal-soft/40 px-1.5 py-0.5 text-[9px] font-bold text-brand-teal"
                              >
                                {fact}
                              </span>
                            ))
                          ) : (
                            <span className="text-muted-foreground">Not specified</span>
                          )}
                        </div>
                        {/* Verification */}
                        <div className="h-14 flex items-center px-5 bg-surface">
                          <StatusPill tone="success" className="text-[10px]">
                            Verified Profile
                          </StatusPill>
                        </div>
                        {/* Rating */}
                        <div className="h-14 flex items-center gap-1 px-5 bg-surface font-semibold">
                          <Star className="size-3.5 fill-warning text-warning" />
                          <span>{summary.rating ? summary.rating.toFixed(1) : "New"}</span>
                          <span className="text-[10px] text-muted-foreground font-normal">
                            ({summary.reviews} reviews)
                          </span>
                        </div>
                      </div>

                      {/* Action buttons */}
                      <div className="h-20 flex flex-col justify-center px-4 bg-muted gap-1.5 border-t border-border">
                        <Link
                          className="w-full text-center py-2 rounded-md bg-brand-teal text-white text-[11px] font-bold shadow hover:brightness-105 transition flex items-center justify-center gap-1"
                          href={`/inquiry?hostel=${hostel.slug}`}
                        >
                          <Send className="size-3" /> Send Inquiry
                        </Link>
                        <Link
                          className="w-full text-center text-[10px] font-semibold text-brand-teal hover:underline"
                          href={`/hostels/${hostel.slug}`}
                        >
                          View Details &rarr;
                        </Link>
                      </div>
                    </div>
                  );
                })}
              </div>
            </SectionCard>

            {/* Photos — every uploaded photo, clickable into the same viewer
                the hostel admin portal uses. */}
            <SectionCard
              description="Every photo the hostel has uploaded. Click any photo to open the full viewer."
              title="Photos"
            >
              <CompareGrid count={comparedHostels.length}>
                {comparedHostels.map((hostel) => {
                  const items = galleryItemsFor(hostel);
                  const visible = items.slice(0, 5);
                  const remaining = items.length - visible.length;

                  return (
                    <div className="p-4" key={hostel.id}>
                      <ColumnLabel name={hostel.name} />
                      {items.length === 0 ? (
                        <p className="text-xs text-muted-foreground">
                          No photos uploaded yet.
                        </p>
                      ) : (
                        <div className="grid grid-cols-3 gap-1.5">
                          {visible.map((item, index) => (
                            <button
                              className="group relative aspect-square overflow-hidden rounded-md border border-border bg-muted"
                              key={`${item.src}-${index}`}
                              onClick={() => setLightbox({ index, items })}
                              type="button"
                            >
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img
                                alt={item.caption ?? hostel.name}
                                className="size-full object-cover transition group-hover:scale-105"
                                decoding="async"
                                loading="lazy"
                                src={item.src}
                              />
                            </button>
                          ))}
                          {remaining > 0 ? (
                            <button
                              className="relative aspect-square overflow-hidden rounded-md border border-border bg-slate-950/75 text-[11px] font-bold text-white transition hover:bg-slate-950/60"
                              onClick={() => setLightbox({ index: visible.length, items })}
                              type="button"
                            >
                              <span className="absolute inset-0 flex items-center justify-center">
                                +{remaining} more
                              </span>
                            </button>
                          ) : null}
                        </div>
                      )}
                    </div>
                  );
                })}
              </CompareGrid>
            </SectionCard>

            {/* Rooms & Pricing */}
            <SectionCard title="Rooms & Pricing">
              <CompareGrid count={comparedHostels.length}>
                {comparedHostels.map((hostel) => {
                  const configs = hostel.roomConfigurations ?? [];

                  return (
                    <div className="space-y-2 p-4" key={hostel.id}>
                      <ColumnLabel name={hostel.name} />
                      {configs.length === 0 ? (
                        <p className="text-xs text-muted-foreground">
                          {hostel.roomTypes.length > 0
                            ? hostel.roomTypes.map(roomTypeLabel).join(", ")
                            : "Not specified yet."}
                        </p>
                      ) : (
                        configs.map((config) => (
                          <div
                            className="rounded-lg border border-border bg-muted/30 p-3"
                            key={config.id ?? config.roomType}
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-xs font-bold text-foreground">
                                {roomTypeLabel(config.roomType)}
                              </span>
                              <span className="text-xs font-extrabold text-brand-teal">
                                {formatMoney(config.monthlyRent)}
                              </span>
                            </div>
                            <p className="mt-1.5 flex items-center gap-3 text-[11px] text-muted-foreground">
                              <span className="inline-flex items-center gap-1">
                                <Users className="size-3" /> {config.vacantBeds} vacant
                              </span>
                              {config.mealInclusion ? <span>{config.mealInclusion}</span> : null}
                            </p>
                          </div>
                        ))
                      )}
                    </div>
                  );
                })}
              </CompareGrid>
            </SectionCard>

            {/* Facilities — the full list; the quick table above only teases it. */}
            <SectionCard title="Facilities">
              <CompareGrid count={comparedHostels.length}>
                {comparedHostels.map((hostel) => (
                  <div className="p-4" key={hostel.id}>
                    <ColumnLabel name={hostel.name} />
                    {hostel.facilities.length === 0 ? (
                      <p className="text-xs text-muted-foreground">Not listed yet.</p>
                    ) : (
                      <div className="flex flex-wrap gap-1.5">
                        {hostel.facilities.map((facility) => (
                          <span
                            className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/40 px-2.5 py-1 text-[11px] font-semibold text-foreground"
                            key={facility}
                          >
                            <CheckCircle2 className="size-3 text-brand-teal" />
                            {facility}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </CompareGrid>
            </SectionCard>

            {/* Food — facts plus the actual weekly routine, not just a claim
                that food is served. */}
            <SectionCard title="Food">
              <CompareGrid count={comparedHostels.length}>
                {comparedHostels.map((hostel) => {
                  const facts = [
                    hostel.food?.mealsPerDay ? `${hostel.food.mealsPerDay} meals a day` : null,
                    hostel.food?.hasVeg ? "Veg" : null,
                    hostel.food?.hasNonVeg ? "Non-veg" : null,
                  ].filter((fact): fact is string => Boolean(fact));
                  const routineRows = foodRoutineRowsFor(hostel);

                  return (
                    <div className="p-4" key={hostel.id}>
                      <ColumnLabel name={hostel.name} />
                      {facts.length === 0 ? (
                        <p className="text-xs text-muted-foreground">Not specified yet.</p>
                      ) : (
                        <div className="flex flex-wrap gap-1.5">
                          {facts.map((fact) => (
                            <span
                              className="inline-flex items-center gap-1 rounded-full bg-brand-teal-soft/40 px-2.5 py-1 text-[11px] font-bold text-brand-teal"
                              key={fact}
                            >
                              <Utensils className="size-3" />
                              {fact}
                            </span>
                          ))}
                        </div>
                      )}
                      {hostel.food?.notes ? (
                        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                          {hostel.food.notes}
                        </p>
                      ) : null}

                      <div className="mt-3 border-t border-border pt-3">
                        <p className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
                          Weekly routine
                        </p>
                        {routineRows.length === 0 ? (
                          <p className="mt-1.5 text-[11px] text-muted-foreground">
                            No routine published yet.
                          </p>
                        ) : (
                          <div className="mt-1.5 space-y-1.5">
                            {routineRows.map((row) => (
                              <p className="text-[11px] leading-relaxed" key={row.day}>
                                <span className="font-bold text-foreground">
                                  {titleCaseDay(row.day)}:{" "}
                                </span>
                                <span className="text-muted-foreground">
                                  {row.meals
                                    .map((meal) => `${meal.label} — ${meal.menu?.items.join(", ")}`)
                                    .join(" · ")}
                                </span>
                              </p>
                            ))}
                          </div>
                        )}
                        {hostel.foodRoutine?.monthEndSpecial ? (
                          <p className="mt-2 text-[11px] font-semibold text-brand-teal">
                            Month-end special:{" "}
                            {hostel.foodRoutine.monthEndSpecial.items.join(", ")}
                          </p>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </CompareGrid>
            </SectionCard>

            {/* About & Rules */}
            <SectionCard title="About & Rules">
              <CompareGrid count={comparedHostels.length}>
                {comparedHostels.map((hostel) => (
                  <div className="space-y-3 p-4" key={hostel.id}>
                    <ColumnLabel name={hostel.name} />
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      {hostel.description || "This hostel has not added a description yet."}
                    </p>
                    {hostel.rules.length > 0 ? (
                      <ul className="space-y-1.5 border-t border-border pt-3">
                        {hostel.rules.map((rule) => (
                          <li
                            className="flex items-start gap-1.5 text-[11px] font-medium text-muted-foreground"
                            key={rule}
                          >
                            <CheckCircle2 className="mt-0.5 size-3 shrink-0 text-brand-teal" />
                            {rule}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                ))}
              </CompareGrid>
            </SectionCard>

            {/* Ratings & Reviews — category breakdown plus real review snippets,
                fetched from the same endpoint the hostel detail page uses. */}
            <SectionCard title="Ratings & Reviews">
              <CompareGrid count={comparedHostels.length}>
                {comparedHostels.map((hostel, index) => {
                  const summary = mapPublicHostelToSummary(hostel);
                  const reviewQuery = reviewQueries[index];
                  const data = reviewQuery?.data;
                  const categories = data
                    ? Object.entries(data.summary.categories).filter(
                        (entry): entry is [string, number] =>
                          entry[0] !== "overall" && entry[1] !== null,
                      )
                    : [];

                  return (
                    <div className="space-y-3 p-4" key={hostel.id}>
                      <ColumnLabel name={hostel.name} />
                      <div className="flex items-center gap-2">
                        <span className="text-2xl font-extrabold text-foreground">
                          {summary.rating ? summary.rating.toFixed(1) : "New"}
                        </span>
                        <div className="flex gap-0.5">
                          {[1, 2, 3, 4, 5].map((star) => (
                            <Star
                              className={cn(
                                "size-3",
                                star <= Math.round(summary.rating)
                                  ? "fill-warning text-warning"
                                  : "text-muted-foreground/40",
                              )}
                              key={star}
                            />
                          ))}
                        </div>
                        <span className="text-[11px] text-muted-foreground">
                          ({summary.reviews})
                        </span>
                      </div>

                      {reviewQuery?.isLoading ? (
                        <p className="text-[11px] text-muted-foreground">Loading reviews…</p>
                      ) : data && data.summary.total > 0 ? (
                        <>
                          {categories.length > 0 ? (
                            <dl className="grid grid-cols-2 gap-x-3 gap-y-1 border-t border-border pt-2 text-[11px]">
                              {categories.map(([key, value]) => (
                                <div className="flex justify-between gap-2" key={key}>
                                  <dt className="capitalize text-muted-foreground">{key}</dt>
                                  <dd className="font-bold text-foreground">
                                    {value.toFixed(1)}
                                  </dd>
                                </div>
                              ))}
                            </dl>
                          ) : null}

                          <ul className="space-y-2.5 border-t border-border pt-3">
                            {data.reviews.slice(0, 2).map((review) => (
                              <li key={review.id}>
                                <div className="flex items-center gap-1.5 text-[11px] font-bold text-foreground">
                                  {review.reviewerName}
                                  {review.isVerifiedResident ? (
                                    <BadgeCheck className="size-3 text-brand-teal" />
                                  ) : null}
                                </div>
                                {review.comment ? (
                                  <p className="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">
                                    {review.comment}
                                  </p>
                                ) : null}
                              </li>
                            ))}
                          </ul>

                          <Link
                            className="inline-block text-[11px] font-bold text-brand-teal hover:underline"
                            href={`/hostels/${hostel.slug}#hostel-reviews`}
                          >
                            Read all {data.summary.total}{" "}
                            {data.summary.total === 1 ? "review" : "reviews"} &rarr;
                          </Link>
                        </>
                      ) : (
                        <p className="text-[11px] text-muted-foreground">
                          No reviews yet — residents can leave the first one.
                        </p>
                      )}
                    </div>
                  );
                })}
              </CompareGrid>
            </SectionCard>

            {/* Location & Contact */}
            <SectionCard title="Location & Contact">
              <CompareGrid count={comparedHostels.length}>
                {comparedHostels.map((hostel) => {
                  const summary = mapPublicHostelToSummary(hostel);
                  const nearbyCount = hostel.nearbyPlaces?.length ?? 0;

                  return (
                    <div className="space-y-2 p-4" key={hostel.id}>
                      <ColumnLabel name={hostel.name} />
                      <div className="h-36 overflow-hidden rounded-lg border border-border">
                        {hostel.coordinates ? (
                          <HostelMap
                            center={hostel.coordinates}
                            name={hostel.name}
                            nearby={hostel.nearbyPlaces}
                          />
                        ) : (
                          <div className="flex h-full items-center justify-center border border-dashed border-brand-teal/40 bg-brand-teal-soft/20 text-center">
                            <p className="px-3 text-[10px] font-semibold text-muted-foreground">
                              Exact location not pinned yet
                            </p>
                          </div>
                        )}
                      </div>
                      <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                        <MapPin className="mt-0.5 size-3.5 shrink-0 text-brand-teal" />
                        {summary.address}
                      </p>
                      {nearbyCount > 0 ? (
                        <p className="text-[11px] text-muted-foreground">
                          {nearbyCount} nearby places mapped
                        </p>
                      ) : null}
                      {hostel.contact?.phone ? (
                        <a
                          className="inline-flex items-center gap-1.5 text-xs font-bold text-brand-teal hover:underline"
                          href={`tel:${hostel.contact.phone}`}
                        >
                          <PhoneCall className="size-3.5" />
                          {hostel.contact.phone}
                        </a>
                      ) : (
                        <p className="text-[11px] text-muted-foreground">
                          No phone published yet.
                        </p>
                      )}
                    </div>
                  );
                })}
              </CompareGrid>
            </SectionCard>
          </div>
        )}

      </section>

      {lightbox ? (
        <MediaLightbox
          index={lightbox.index}
          items={lightbox.items}
          onClose={() => setLightbox(null)}
          onIndexChange={(next) =>
            setLightbox((current) => (current ? { ...current, index: next } : current))
          }
        />
      ) : null}
    </PublicShell>
  );
}
