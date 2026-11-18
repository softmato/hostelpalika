import { useMemo, useState } from "react";
import { View } from "react-native";

import { Quiet, Rows, TintRow } from "@/components/platform-ui";
import { AppBar } from "@/components/ui/app-bar";
import { Screen } from "@/components/ui/screen";
import { Segmented } from "@/components/ui/segmented";
import { SkeletonRows } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useDates } from "@/hooks/use-dates";
import { useResource } from "@/hooks/use-resource";
import { readApiError } from "@/lib/api-contract";
import { openConfirm } from "@/lib/confirm";
import { listPlatformHostels, listPlatformReviews, type PlatformReview, setReviewHidden } from "@/lib/platform-admin-api";
import { toastError, toastSuccess } from "@/lib/toast";

/**
 * Reviews — every resident review on the platform (web `platform-reviews-page`).
 * Low ratings first under "Low"; a press hides an abusive one from the public
 * listing, or shows a hidden one again. Nothing is deleted.
 */

const loadHostels = () => listPlatformHostels(false);

export default function ReviewsScreen() {
  const dates = useDates();
  const reviews = useResource(listPlatformReviews, { cacheKey: "platform:reviews" });
  const hostels = useResource(loadHostels, { cacheKey: "platform:hostels" });
  const [filter, setFilter] = useState<"low" | "hidden" | "all">("low");

  const names = useMemo(() => new Map((hostels.data ?? []).map((hostel) => [hostel.id, hostel.name])), [hostels.data]);
  const rows = useMemo(() => {
    const all = reviews.data ?? [];
    if (filter === "hidden") return all.filter((review) => review.status === "HIDDEN");
    if (filter === "low") return all.filter((review) => review.status === "VISIBLE" && review.overallRating <= 2);
    return all;
  }, [filter, reviews.data]);

  function toggle(review: PlatformReview) {
    const hide = review.status === "VISIBLE";
    openConfirm({
      confirmLabel: hide ? "Hide" : "Show again",
      destructive: hide,
      message: hide ? "It leaves the public listing. The resident and hostel still see it." : "It shows on the public listing again.",
      onConfirm: async () => {
        try {
          await setReviewHidden(review.id, hide);
          toastSuccess(hide ? "Review hidden" : "Review visible");
          reviews.refresh();
        } catch (error) {
          toastError("Not saved", readApiError(error));
        }
      },
      title: hide ? "Hide this review?" : "Show this review?",
    });
  }

  return (
    <Screen header={<AppBar showBack title="Reviews" />} onRefresh={reviews.refresh} refreshing={reviews.refreshing} scroll>
      <View className="gap-4">
        <Segmented
          onChange={setFilter}
          options={[
            { label: "Low (1–2★)", value: "low" },
            { label: "Hidden", value: "hidden" },
            { label: "All", value: "all" },
          ]}
          value={filter}
        />
        {reviews.loading ? (
          <SkeletonRows rows={5} />
        ) : reviews.error ? (
          <ErrorState message={reviews.error} onRetry={reviews.reload} />
        ) : rows.length === 0 ? (
          <Quiet>{filter === "low" ? "No low rating to look at." : "Nothing here."}</Quiet>
        ) : (
          <Rows>
            {rows.map((review) => (
              <TintRow
                icon={review.status === "HIDDEN" ? "eye-off" : "star"}
                key={review.id}
                onPress={() => toggle(review)}
                right={<Text className="font-amount text-base font-bold tabular-nums">{`${review.overallRating}★`}</Text>}
                subtitle={[names.get(review.hostelId) ?? "Hostel", review.createdAt ? dates.ago(review.createdAt) : null, review.status === "HIDDEN" ? "hidden" : null].filter(Boolean).join(" · ")}
                title={review.comment.trim() || "No comment"}
                tone={review.status === "HIDDEN" ? "neutral" : review.overallRating <= 2 ? "danger" : "success"}
              />
            ))}
          </Rows>
        )}
      </View>
    </Screen>
  );
}
