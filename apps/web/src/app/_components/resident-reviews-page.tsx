"use client";

import { Star } from "@/components/icons";
import { memo, useCallback, useState, type FormEvent } from "react";

import { BusyForm, SubmitButton } from "@/app/_components/busy-form";
import { Glyph, type GlyphName } from "@/components/glyph";
import { browserApi } from "@/lib/browser-api";
import { cn } from "@/lib/utils";
import { field, Message, optionalNumber, PageHeader } from "./daily-operations-shared";
import { SectionCard } from "./portal-dashboard-ui";
import { TextArea } from "@/app/_components/shared-ui";

/* Overall first and required; the rest are optional and post as 0 when unset,
   as the number boxes they replace did. */
const RATINGS: { glyph: GlyphName; label: string; name: string }[] = [
  { glyph: "star", label: "Overall", name: "overallRating" },
  { glyph: "restaurant", label: "Food", name: "foodRating" },
  { glyph: "sparkles", label: "Cleanliness", name: "cleanlinessRating" },
  { glyph: "shield", label: "Security", name: "safetyRating" },
  { glyph: "bed", label: "Room", name: "roomRating" },
  { glyph: "location", label: "Location", name: "locationRating" },
  { glyph: "people", label: "Management", name: "managementRating" },
];

/** Five stars that post their number through a hidden field. */
function StarRow({
  glyph,
  label,
  name,
  onChange,
  value,
}: {
  glyph: GlyphName;
  label: string;
  name: string;
  onChange: (value: number) => void;
  value: number;
}) {
  return (
    <div className="flex items-center gap-3 py-2.5">
      <Glyph className="size-4 shrink-0 text-muted-foreground" name={glyph} />
      <span className="flex-1 text-[13.5px] font-medium text-foreground">{label}</span>
      <input name={name} type="hidden" value={value || ""} />
      <div className="flex gap-0.5">
        {[1, 2, 3, 4, 5].map((score) => (
          <button
            aria-label={`${label}: ${score} of 5`}
            aria-pressed={value === score}
            className={cn(
              "rounded-md p-1 transition active:scale-90",
              score <= value ? "text-foreground" : "text-muted-foreground/40 hover:text-muted-foreground",
            )}
            key={score}
            onClick={() => onChange(value === score ? 0 : score)}
            type="button"
          >
            <Glyph className="size-6" name="star" variant={score <= value ? "solid" : "line"} />
          </button>
        ))}
      </div>
    </div>
  );
}

export const ResidentReviewsPageContent = memo(function ResidentReviewsPageContent() {
  const [message, setMessage] = useState("");
  const [scores, setScores] = useState<Record<string, number>>({});

  const submit = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);

    try {
      await browserApi("/api/v1/resident/reviews", {
        body: JSON.stringify({
          cleanlinessRating: optionalNumber(form, "cleanlinessRating"),
          comment: field(form, "comment"),
          foodRating: optionalNumber(form, "foodRating"),
          locationRating: optionalNumber(form, "locationRating"),
          managementRating: optionalNumber(form, "managementRating"),
          overallRating: optionalNumber(form, "overallRating"),
          roomRating: optionalNumber(form, "roomRating"),
          safetyRating: optionalNumber(form, "safetyRating"),
        }),
        method: "POST",
      });
      setMessage("Review submitted.");
      formElement.reset();
      setScores({});
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not submit review.");
    }
  }, []);

  return (
    <div className="mx-auto max-w-[680px] space-y-5">
      <PageHeader description="Rate your hostel. Only residents can." icon={Star} title="Reviews" />
      <Message value={message} />
      {/* The form is the page: there is nothing else here for a header button
          to open it over. */}
      <SectionCard>
        <BusyForm className="grid gap-4" onSubmit={submit}>
          <div className="divide-y divide-border/60">
            {RATINGS.map((rating) => (
              <StarRow
                glyph={rating.glyph}
                key={rating.name}
                label={rating.name === "overallRating" ? rating.label : `${rating.label} · optional`}
                name={rating.name}
                onChange={(value) => setScores((current) => ({ ...current, [rating.name]: value }))}
                value={scores[rating.name] ?? 0}
              />
            ))}
          </div>
          <TextArea label="Comment" name="comment" />
          <SubmitButton
            className="h-11 bg-brand-teal text-white hover:bg-brand-teal/90 disabled:opacity-50"
            disabled={!scores.overallRating}
          >
            Submit review
          </SubmitButton>
        </BusyForm>
      </SectionCard>
    </div>
  );
});
