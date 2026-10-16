"use client";

import { MapPin, Sparkles } from "@/components/icons";
import Link from "next/link";

import { mapPublicHostelToSummary } from "@/app/_components/public-hostel-data";
import { formatMoney, SectionCard } from "@/app/_components/shared";
import { TalkToExpertButton } from "@/components/talk-to-expert";
import type { MyExpertConsultationRequest } from "@/hooks/use-expert-consultation";
import { parseBudgetRange, type HostelMatch } from "@/lib/hostel-recommendation";

/**
 * The compare page's "platform suggestion" strip.
 *
 * `myRequest` and `matches` are computed once in `PublicComparePage` (not
 * re-fetched here) because the comparison grid up top needs the same match
 * list to badge a hostel the visitor already added — this component only
 * renders the ones they *haven't* picked yet, so nothing is shown twice.
 */
export function HostelSuggestions({
  compareIds,
  isLoading,
  matches,
  myRequest,
  onAddToCompare,
  onSubmitted,
}: {
  compareIds: string[];
  isLoading: boolean;
  matches: HostelMatch[];
  myRequest: MyExpertConsultationRequest | null | undefined;
  onAddToCompare: (hostelId: string) => void;
  onSubmitted: () => void;
}) {
  if (isLoading) {
    return <div className="mb-4 h-10 animate-pulse rounded-lg border border-border bg-muted" />;
  }

  if (!myRequest) {
    return (
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-muted/30 px-4 py-2.5">
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Sparkles className="size-3.5 shrink-0 text-brand-teal" />
          Tell us your budget & college for hostels matched to you.
        </p>
        <TalkToExpertButton onSubmitted={onSubmitted} />
      </div>
    );
  }

  // Already-added hostels are tagged on the comparison grid above instead of
  // getting a second card here.
  const remaining = matches.filter(({ hostel }) => !compareIds.includes(hostel.id));

  if (remaining.length === 0) {
    return null;
  }

  const hasSignal = Boolean(
    parseBudgetRange(myRequest.budgetRange) || myRequest.preferredCollege,
  );

  return (
    <SectionCard
      action={<TalkToExpertButton onSubmitted={onSubmitted} />}
      className="mb-6"
      description={
        hasSignal
          ? "Matched to the budget and college you told our expert about."
          : "Popular verified hostels — add a budget and college next time for a tighter match."
      }
      title="You might also like these hostels"
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {remaining.map(({ distanceKm, hostel, withinBudget }) => {
          const summary = mapPublicHostelToSummary(hostel);

          return (
            <div
              className="overflow-hidden rounded-lg border border-border bg-surface"
              key={hostel.id}
            >
              <Link className="block" href={`/hostels/${hostel.slug}`}>
                <div
                  className="h-28 bg-cover bg-center"
                  style={{ backgroundImage: `url("${summary.image}")` }}
                />
              </Link>
              <div className="space-y-2 p-3">
                <Link
                  className="block truncate text-sm font-bold text-foreground hover:text-brand-teal"
                  href={`/hostels/${hostel.slug}`}
                  title={hostel.name}
                >
                  {hostel.name}
                </Link>
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="rounded-full bg-brand-teal-soft/60 px-2 py-0.5 text-[10px] font-bold text-brand-teal">
                    {formatMoney(summary.price)}/mo
                  </span>
                  {withinBudget ? (
                    <span className="rounded-full bg-success/10 px-2 py-0.5 text-[10px] font-bold text-success">
                      Within budget
                    </span>
                  ) : null}
                  {distanceKm != null ? (
                    <span className="inline-flex items-center gap-0.5 rounded-full bg-muted px-2 py-0.5 text-[10px] font-bold text-muted-foreground">
                      <MapPin className="size-2.5" />
                      {distanceKm < 1 ? "< 1 km away" : `${distanceKm.toFixed(1)} km away`}
                    </span>
                  ) : null}
                </div>
                <button
                  className="w-full rounded-md bg-brand-teal py-1.5 text-xs font-bold text-white transition hover:brightness-105"
                  onClick={() => onAddToCompare(hostel.id)}
                  type="button"
                >
                  Add to compare
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </SectionCard>
  );
}
