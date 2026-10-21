import { router } from "expo-router";
import { useCallback, useState } from "react";
import { View } from "react-native";

import { AppBar } from "@/components/ui/app-bar";
import { Button } from "@/components/ui/button";
import { Card, SectionHeader } from "@/components/ui/card";
import { Glyph } from "@/components/ui/glyph";
import { Input } from "@/components/ui/input";
import { Screen } from "@/components/ui/screen";
import { SkeletonCard } from "@/components/ui/skeleton";
import { StarRating } from "@/components/ui/star-rating";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useResource } from "@/hooks/use-resource";
import { readApiError, readApiErrorCode } from "@/lib/api-contract";
import type { ResidentProfile } from "@/lib/resident-api";
import { residentQuery } from "@/lib/resident-queries";
import { submitResidentReview } from "@/lib/review-api";
import {
  canReview,
  emptyReviewDraft,
  hasReviewErrors,
  MAX_COMMENT,
  REVIEW_CATEGORIES,
  REVIEW_MERGE_NOTICE,
  type ReviewDraft,
  type ReviewErrors,
  reviewGateReason,
  scoredCategoryCount,
  toReviewInput,
  validateReview,
} from "@/lib/reviews";
import { toastError, toastSuccess } from "@/lib/toast";

/**
 * Reviewing your hostel.
 *
 * Field set, order and labels come from
 * `apps/web/src/app/_components/resident-reviews-page.tsx` — overall first, then
 * its line "The rest are optional — score 1 to 5 only what you want to.", then
 * Food · Cleanliness · **Security** · Room · Location · Management, then the
 * comment. Only the control changed: the web's `<input type="number" min max>`
 * becomes a star row, for the reasons in `components/ui/star-rating.tsx`.
 *
 * ## The profile is loaded first, on purpose
 *
 * `createResidentReview` 403s with `REVIEW_NOT_ALLOWED` unless the resident is
 * `ACTIVE` or `MOVED_OUT`. Reading `resident.status` up front costs one request and
 * saves a `PENDING` resident from filling in seven ratings and a comment before
 * being refused. It also lets the screen name their hostel, which the review is
 * about.
 *
 * ## What cannot be shown
 *
 * There is no `GET /resident/reviews`, and the public list strips `residentId`, so
 * the app cannot show a resident what they scored last time. The POST is also a
 * partial `$set` upsert, so a category left blank keeps its earlier score rather
 * than clearing. Both are stated in one sentence (`REVIEW_MERGE_NOTICE`) instead of
 * being discovered — and both are §1 rows in `docs/MOBILE_APP_PHASES.md`.
 */

export default function ReviewScreen() {
  const query = residentQuery.profile();
  const profile = useResource<ResidentProfile>(query.load, {
    cacheKey: query.key,
    topics: query.topics,
  });

  const header = <AppBar showBack title="Review your hostel" />;

  if (profile.loading) {
    return (
      <Screen header={header}>
        <View className="gap-4 pt-1">
          <SkeletonCard rows={3} />
          <SkeletonCard rows={2} />
        </View>
      </Screen>
    );
  }

  if (profile.error || !profile.data) {
    return (
      <Screen header={header}>
        <ErrorState
          message={profile.error ?? "That could not be loaded."}
          onRetry={profile.reload}
        />
      </Screen>
    );
  }

  const { hostel, resident } = profile.data;

  if (!canReview(resident.status)) {
    return (
      <Screen header={header}>
        <EmptyState icon="star"
          description={reviewGateReason(resident.status)}
          title="Reviews aren't open for you yet"
        />
      </Screen>
    );
  }

  return <ReviewForm header={header} hostelName={hostel?.name ?? null} />;
}

function ReviewForm({
  header,
  hostelName,
}: {
  header: React.ReactNode;
  hostelName: string | null;
}) {
  const { colors } = useAppTheme();
  const [draft, setDraft] = useState<ReviewDraft>(emptyReviewDraft);
  const [errors, setErrors] = useState<ReviewErrors>({});
  const [saving, setSaving] = useState(false);

  const set = useCallback(
    <K extends keyof ReviewDraft>(field: K, value: ReviewDraft[K]) => {
      setDraft((current) => ({ ...current, [field]: value }));
    },
    [],
  );

  const submit = useCallback(async () => {
    const found = validateReview(draft);

    setErrors(found);

    if (hasReviewErrors(found)) {
      return;
    }

    setSaving(true);

    try {
      await submitResidentReview(toReviewInput(draft));

      toastSuccess(
        "Review submitted",
        "Thanks — it shows on your hostel's public page.",
      );
      router.back();
    } catch (caught) {
      /*
       * Unreachable from this screen, since the gate above checks the same
       * statuses — unless the hostel changed the resident's status between the
       * profile load and the tap, which is exactly when a generic error would be
       * least useful.
       */
      if (readApiErrorCode(caught) === "REVIEW_NOT_ALLOWED") {
        toastError(
          "Reviews are closed for your account",
          "Your stay's status changed. Your hostel's office can explain.",
        );
      } else {
        toastError("Could not submit that review", readApiError(caught));
      }
    } finally {
      setSaving(false);
    }
  }, [draft]);

  const scored = scoredCategoryCount(draft);

  return (
    <Screen
      footer={
        <Button
          label="Submit review"
          loading={saving}
          onPress={() => void submit()}
        />
      }
      header={header}
      scroll
    >
      <View className="gap-5 pt-1">
        <Card className="gap-2">
          <View className="flex-row items-center gap-2">
            <Glyph color={colors.primary} name="star" size={18} />
            <Text className="flex-1" variant="label">
              {hostelName ? `How was ${hostelName}?` : "How was your hostel?"}
            </Text>
          </View>
          {/*
            Both server behaviours in one sentence: the review cannot be read back,
            and a resubmission merges rather than replaces. A resident rescoring one
            category otherwise has no way to know the rest kept last month's numbers.
          */}
          <Text variant="muted">{REVIEW_MERGE_NOTICE}</Text>
        </Card>

        <Card>
          <StarRating
            label="Overall rating"
            onChange={(value) => set("overallRating", value)}
            size={34}
            sublabel="Required"
            value={draft.overallRating}
          />
          {errors.overallRating ? (
            <Text className="mt-2 text-destructive" variant="caption">
              {errors.overallRating}
            </Text>
          ) : null}
        </Card>

        <View>
          <SectionHeader
            subtitle={
              scored === 0
                ? "Score 1 to 5 only what you want to"
                : `${scored} of ${REVIEW_CATEGORIES.length} scored`
            }
            title="The rest are optional"
          />

          <Card className="gap-4">
            {REVIEW_CATEGORIES.map(({ key, label }) => (
              <StarRating
                key={key}
                label={label}
                onChange={(value) => set(key, value)}
                size={24}
                value={draft[key]}
              />
            ))}
          </Card>
        </View>

        <Input
          error={errors.comment}
          hint="Shown publicly next to your first name and an initial."
          label="Anything to add?"
          maxLength={MAX_COMMENT}
          multiline
          onChangeText={(value) => set("comment", value)}
          placeholder="What you would tell a friend who was thinking of moving in."
          style={{ height: 112, paddingTop: 12, textAlignVertical: "top" }}
          value={draft.comment}
        />
      </View>
    </Screen>
  );
}
