"use client";

import { Star } from "@/components/icons";
import { memo, useCallback, useState, type FormEvent } from "react";

import { BusyForm, SubmitButton } from "@/app/_components/busy-form";
import { browserApi } from "@/lib/browser-api";
import { field, Message, optionalNumber, PageHeader } from "./daily-operations-shared";
import { Input, Panel, TextArea } from "@/app/_components/shared-ui";

export const ResidentReviewsPageContent = memo(function ResidentReviewsPageContent() {
  const [message, setMessage] = useState("");

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
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not submit review.");
    }
  }, []);

  return (
    <div className="mx-auto max-w-[760px] space-y-6">
      <PageHeader description="Verified hostel review." icon={Star} title="Reviews" />
      <Message value={message} />
      <Panel>
        <BusyForm className="grid gap-3" onSubmit={submit}>
          <Input
            label="Overall rating"
            max="5"
            min="1"
            name="overallRating"
            required
            type="number"
          />
          <p className="text-sm text-muted-foreground">
            The rest are optional — score 1 to 5 only what you want to.
          </p>
          <Input label="Food" max="5" min="1" name="foodRating" type="number" />
          <Input
            label="Cleanliness"
            max="5"
            min="1"
            name="cleanlinessRating"
            type="number"
          />
          <Input label="Security" max="5" min="1" name="safetyRating" type="number" />
          <Input label="Room" max="5" min="1" name="roomRating" type="number" />
          <Input label="Location" max="5" min="1" name="locationRating" type="number" />
          <Input
            label="Management"
            max="5"
            min="1"
            name="managementRating"
            type="number"
          />
          <TextArea label="Comment" name="comment" />
          <SubmitButton className="h-11 rounded-md bg-role-resident text-sm font-semibold text-white">
            Submit Review
          </SubmitButton>
        </BusyForm>
      </Panel>
    </div>
  );
});
