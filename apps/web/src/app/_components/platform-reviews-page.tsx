"use client";

import { Eye, EyeOff, Star, Stars } from "@/components/icons";
import { memo, useCallback, useMemo, useState } from "react";

import { browserApi } from "@/lib/browser-api";
import { platformEndpoints } from "@/lib/platform-endpoints";
import { useInvalidateResources, usePortalResource } from "@/lib/portal-query";
import { type Review, Message } from "./daily-operations-shared";
import { EmptyState, Panel } from "@/app/_components/shared-ui";
import {
  MetricCard,
  PortalPageHeader,
  RatingStars,
  SearchField,
  SoftBadge,
  statusToneFromLabel,
} from "@/app/_components/portal-dashboard-ui";
import { FilterButton, FilterChoice } from "@/components/filter-panel";
import { Button } from "@/components/ui/button";

export const PlatformReviewsPageContent = memo(function PlatformReviewsPageContent() {
  const [actionMessage, setActionMessage] = useState("");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"ALL" | Review["status"]>("ALL");
  const [starsFilter, setStarsFilter] = useState("ALL");
  const invalidate = useInvalidateResources();
  const reviewsResource = usePortalResource<{ reviews: Review[] }>(
    platformEndpoints.reviews,
    { errorMessage: "Could not load reviews." },
  );

  const reviews = useMemo(
    () => reviewsResource.data?.reviews ?? [],
    [reviewsResource.data],
  );
  const message = actionMessage || reviewsResource.message;

  const moderate = useCallback(
    async (reviewId: string, action: "hide" | "unhide") => {
      setActionMessage("");
      try {
        await browserApi(`${platformEndpoints.review(reviewId)}/${action}`, {
          body: JSON.stringify({}),
          method: "PATCH",
        });
        invalidate(platformEndpoints.reviews);
      } catch (error) {
        setActionMessage(
          error instanceof Error ? error.message : "Could not moderate review.",
        );
      }
    },
    [invalidate],
  );

  const stats = useMemo(() => {
    const hidden = reviews.filter((review) =>
      review.status.toUpperCase().includes("HIDDEN"),
    ).length;
    const avg =
      reviews.length > 0
        ? reviews.reduce((sum, review) => sum + (review.overallRating ?? 0), 0) /
          reviews.length
        : 0;
    return { avg, hidden, total: reviews.length, visible: reviews.length - hidden };
  }, [reviews]);

  // Stars 5 → 1, each with how many reviews gave it: the shape of the ratings.
  const spread = [5, 4, 3, 2, 1].map((stars) => ({
    count: reviews.filter((review) => Math.round(review.overallRating ?? 0) === stars).length,
    stars,
  }));
  const term = query.trim().toLowerCase();
  const shown = reviews.filter(
    (review) =>
      (statusFilter === "ALL" || review.status === statusFilter) &&
      (starsFilter === "ALL" || Math.round(review.overallRating ?? 0) === Number(starsFilter)) &&
      (!term || review.comment.toLowerCase().includes(term)),
  );

  return (
    <div className="mx-auto max-w-[1448px] space-y-5">
      <PortalPageHeader description="Resident reviews across the platform, and which are shown." title="Reviews" />
      <Message value={message} />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          active={statusFilter === "ALL"}
          icon={Stars}
          label="Reviews"
          onClick={() => setStatusFilter("ALL")}
          value={stats.total}
        />
        <MetricCard
          active={statusFilter === "VISIBLE"}
          icon={Eye}
          label="Shown"
          onClick={() => setStatusFilter("VISIBLE")}
          value={stats.visible}
        />
        <MetricCard
          active={statusFilter === "HIDDEN"}
          icon={EyeOff}
          label="Hidden"
          onClick={() => setStatusFilter("HIDDEN")}
          tone="slate"
          value={stats.hidden}
        />
        <MetricCard icon={Star} label="Average rating" value={stats.avg.toFixed(1)} />
      </div>

      <div className="grid gap-5 xl:grid-cols-[300px_minmax(0,1fr)]">
        <Panel title="Ratings">
          <div className="space-y-2.5">
            {spread.map((row) => (
              <button
                className="flex w-full items-center gap-2.5 text-left"
                key={row.stars}
                onClick={() => setStarsFilter(starsFilter === String(row.stars) ? "ALL" : String(row.stars))}
                type="button"
              >
                <span className="flex w-8 shrink-0 items-center gap-0.5 text-[12.5px] font-semibold text-foreground">
                  {row.stars}
                  <Star className="size-3 text-role-team" variant="solid" />
                </span>
                <span className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                  <span
                    className={
                      starsFilter === String(row.stars)
                        ? "block h-full rounded-full bg-foreground"
                        : "block h-full rounded-full bg-brand-teal"
                    }
                    style={{ width: `${stats.total > 0 ? Math.round((row.count / stats.total) * 100) : 0}%` }}
                  />
                </span>
                <span className="w-7 shrink-0 text-right text-[12px] font-semibold tabular-nums text-muted-foreground">
                  {row.count}
                </span>
              </button>
            ))}
          </div>
        </Panel>

        <Panel>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <SearchField onChange={setQuery} placeholder="Search reviews" value={query} />
            <FilterButton
              active={(statusFilter === "ALL" ? 0 : 1) + (starsFilter === "ALL" ? 0 : 1)}
              onClear={() => {
                setStatusFilter("ALL");
                setStarsFilter("ALL");
              }}
            >
              <FilterChoice
                label="Status"
                onChange={setStatusFilter}
                options={[
                  { label: "All", value: "ALL" },
                  { label: "Shown", value: "VISIBLE" },
                  { label: "Hidden", value: "HIDDEN" },
                ]}
                value={statusFilter}
              />
              <FilterChoice
                label="Stars"
                onChange={setStarsFilter}
                options={[
                  { label: "All", value: "ALL" },
                  ...[5, 4, 3, 2, 1].map((stars) => ({ label: `${stars} ★`, value: String(stars) })),
                ]}
                value={starsFilter}
              />
            </FilterButton>
          </div>

          {shown.length === 0 ? <EmptyState label="No reviews." /> : null}
          <div className="grid gap-3 md:grid-cols-2">
            {shown.map((review) => (
              <div className="space-y-3 rounded-2xl border border-border/70 bg-card p-4" key={review.id}>
                <div className="flex items-start justify-between gap-3">
                  <RatingStars rating={review.overallRating ?? 0} />
                  <SoftBadge tone={statusToneFromLabel(review.status)}>
                    {review.status === "HIDDEN" ? "Hidden" : "Shown"}
                  </SoftBadge>
                </div>
                <p className="text-[13.5px] text-foreground">{review.comment || "—"}</p>
                <div className="flex gap-2">
                  <Button onClick={() => void moderate(review.id, "hide")} size="sm" type="button" variant="outline">
                    <EyeOff className="size-3.5" /> Hide
                  </Button>
                  <Button onClick={() => void moderate(review.id, "unhide")} size="sm" type="button" variant="ghost">
                    <Eye className="size-3.5" /> Unhide
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </Panel>
      </div>
    </div>
  );
});
