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
  SoftBadge,
  statusToneFromLabel,
} from "@/app/_components/portal-dashboard-ui";

export const PlatformReviewsPageContent = memo(function PlatformReviewsPageContent() {
  const [actionMessage, setActionMessage] = useState("");
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

  return (
    <div className="mx-auto max-w-[1448px] space-y-5">
      <PortalPageHeader
        breadcrumb={["Home", "Reviews"]}
        description="Moderate resident reviews across the platform."
        title="Reviews"
      />
      <Message value={message} />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          icon={Stars}
          label="Total Reviews"
          note="All hostels"
          tone="blue"
          value={stats.total}
        />
        <MetricCard
          icon={Eye}
          label="Visible"
          note="Public on listings"
          noteTone="green"
          tone="green"
          value={stats.visible}
        />
        <MetricCard
          icon={EyeOff}
          label="Hidden"
          note="Moderated out"
          noteTone="rose"
          tone="rose"
          value={stats.hidden}
        />
        <MetricCard
          icon={Star}
          label="Avg Rating"
          note="Across reviews"
          tone="amber"
          value={stats.avg.toFixed(1)}
        />
      </div>

      <Panel title="Moderation Queue">
        {reviews.length === 0 ? <EmptyState label="No reviews." /> : null}
        <div className="grid gap-3 md:grid-cols-2">
          {reviews.map((review) => (
            <div className="rounded-xl border border-border p-4" key={review.id}>
              <div className="flex items-start justify-between gap-3">
                <RatingStars rating={review.overallRating ?? 0} />
                <SoftBadge tone={statusToneFromLabel(review.status)}>
                  {review.status}
                </SoftBadge>
              </div>
              <p className="mt-2 text-sm text-muted-foreground">
                {review.comment || "—"}
              </p>
              <div className="mt-3 flex gap-2">
                <button
                  className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-semibold text-foreground"
                  onClick={() => void moderate(review.id, "hide")}
                  type="button"
                >
                  <EyeOff className="size-3.5" /> Hide
                </button>
                <button
                  className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-semibold text-foreground"
                  onClick={() => void moderate(review.id, "unhide")}
                  type="button"
                >
                  <Eye className="size-3.5" /> Unhide
                </button>
              </div>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
});
