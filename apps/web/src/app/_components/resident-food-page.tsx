"use client";

import { Coffee, Cookie, Moon, Send, Soup, Upload, Utensils } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { memo, useCallback, useMemo, useState, type FormEvent } from "react";

import { EmptyState, Input, Select, TextArea } from "@/app/_components/shared-ui";
import { FileUploaderView, useUploader } from "@/components/uploads";
import {
  EmptyInline,
  PortalPageHeader,
  RoleButton,
  SectionCard,
  SoftBadge,
} from "@/app/_components/portal-dashboard-ui";
import { browserApi } from "@/lib/browser-api";
import { useInvalidateResources, usePortalResource } from "@/lib/portal-query";
import { residentEndpoints } from "@/lib/resident-endpoints";
import {
  type FoodPhoto,
  type FoodRoutine,
  Message,
  field,
  optionalField,
} from "./resident-shared";

const MEAL_META: Record<
  string,
  { icon: LucideIcon; tone: "amber" | "green" | "purple" | "cyan" }
> = {
  BREAKFAST: { icon: Coffee, tone: "amber" },
  LUNCH: { icon: Soup, tone: "green" },
  SNACKS: { icon: Cookie, tone: "purple" },
  DINNER: { icon: Moon, tone: "cyan" },
};

const MEAL_ORDER = ["BREAKFAST", "LUNCH", "SNACKS", "DINNER"];

const DAY_ORDER = [
  "SUNDAY",
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
];

function titleCase(value: string) {
  return value.charAt(0) + value.slice(1).toLowerCase();
}

function MealSkeleton() {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {Array.from({ length: 4 }).map((_, index) => (
        <div
          className="h-24 animate-pulse rounded-xl border border-border/60 bg-muted/30"
          key={index}
        />
      ))}
    </div>
  );
}

export const ResidentFoodPageContent = memo(function ResidentFoodPageContent() {
  const [actionMessage, setActionMessage] = useState("");
  const invalidate = useInvalidateResources();
  // Progress and upload errors surface in the global toaster; this only holds
  // the resulting asset id for the form submit.
  const photoUpload = useUploader({
    accessLevel: "PRIVATE",
    kind: "image",
    label: "Food photo",
    optimizeImage: true,
  });
  const photoAssetId = photoUpload.files[0]?.assetId ?? "";
  const { clear: clearPhoto } = photoUpload;

  const foodResource = usePortalResource<{ photos: FoodPhoto[]; routine: FoodRoutine }>(
    residentEndpoints.food,
    { errorMessage: "Could not load food." },
  );

  const routine = foodResource.data?.routine;
  const menus = useMemo(() => routine?.meals ?? [], [routine]);
  const photos = useMemo(() => foodResource.data?.photos ?? [], [foodResource.data]);
  const state = foodResource.state;
  const message = actionMessage || foodResource.message;

  // The routine repeats, so it reads day by day rather than by date.
  const sortedMenus = useMemo(
    () =>
      [...menus].sort(
        (a, b) =>
          DAY_ORDER.indexOf(a.dayOfWeek) - DAY_ORDER.indexOf(b.dayOfWeek) ||
          MEAL_ORDER.indexOf(a.mealType) - MEAL_ORDER.indexOf(b.mealType),
      ),
    [menus],
  );

  const handleFeedback = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);

    try {
      await browserApi(`${residentEndpoints.food}/feedback`, {
        body: JSON.stringify({
          comment: optionalField(form, "comment"),
          date: field(form, "date"),
          isAnonymous: form.get("isAnonymous") === "on",
          mealType: field(form, "mealType"),
          rating: Number(field(form, "rating")),
        }),
        method: "POST",
      });
      formElement.reset();
      setActionMessage("Feedback submitted. Thank you!");
    } catch (error) {
      setActionMessage(
        error instanceof Error ? error.message : "Could not submit feedback.",
      );
    }
  }, []);

  const handlePhoto = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const formElement = event.currentTarget;
      const form = new FormData(formElement);

      if (!photoAssetId) {
        setActionMessage("Please upload a photo first.");
        return;
      }

      try {
        await browserApi(residentEndpoints.foodPhotos, {
          body: JSON.stringify({
            caption: optionalField(form, "caption"),
            date: field(form, "date"),
            mealType: field(form, "mealType"),
            photoAssetId,
          }),
          method: "POST",
        });
        formElement.reset();
        clearPhoto();
        setActionMessage("Food photo uploaded.");
        invalidate(residentEndpoints.food);
      } catch (error) {
        setActionMessage(
          error instanceof Error ? error.message : "Could not upload photo.",
        );
      }
    },
    [clearPhoto, invalidate, photoAssetId],
  );

  return (
    <div className="mx-auto max-w-[1448px] space-y-5">
      <PortalPageHeader
        breadcrumb={[{ href: "/resident/dashboard", label: "Home" }, "Food Menu"]}
        description="Browse the current menu, view food photos, and share your feedback."
        title="Food Menu"
      />
      <Message value={message} />

      <div className="grid gap-5 xl:grid-cols-[1fr_360px]">
        <div className="space-y-5">
          <SectionCard title="Weekly Menu">
            {state === "loading" ? <MealSkeleton /> : null}
            {state === "error" ? <EmptyState label="Food could not be loaded." /> : null}
            {state === "ready" && sortedMenus.length === 0 ? (
              <EmptyInline label="No menu has been posted yet." />
            ) : null}
            {sortedMenus.length > 0 ? (
              <div className="grid gap-3 md:grid-cols-2">
                {sortedMenus.map((menu) => {
                  const meta = MEAL_META[menu.mealType] ?? {
                    icon: Utensils,
                    tone: "green",
                  };
                  const Icon = meta.icon;
                  return (
                    <div
                      className="flex items-start gap-3 rounded-xl border border-border/70 bg-muted/15 p-3 transition hover:border-role-resident/40"
                      key={`${menu.dayOfWeek}:${menu.mealType}`}
                    >
                      <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-role-resident-soft text-role-resident">
                        <Icon className="size-5" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-[13px] font-bold text-foreground">
                            {menu.mealType}
                          </p>
                          <SoftBadge tone={meta.tone}>{menu.timing}</SoftBadge>
                        </div>
                        <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">
                          {menu.items.join(", ")}
                        </p>
                        <p className="mt-1.5 text-[10.5px] text-muted-foreground/70">
                          Every {titleCase(menu.dayOfWeek)}
                          {menu.note ? ` · ${menu.note}` : ""}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : null}
          </SectionCard>

          <SectionCard title="Food Photos">
            {photos.length === 0 ? (
              <EmptyInline label="No food photos shared yet." />
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3">
                {photos.map((photo) => (
                  <div
                    className="overflow-hidden rounded-xl border border-border/70 bg-card"
                    key={photo.id}
                  >
                    {photo.photoAssetId ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        alt={photo.caption ?? `${photo.mealType} photo`}
                        className="h-32 w-full object-cover"
                        onError={(event) => {
                          (event.currentTarget as HTMLImageElement).style.display =
                            "none";
                        }}
                        src={`/api/v1/files/${photo.photoAssetId}/url?variant=THUMBNAIL`}
                      />
                    ) : null}
                    <div className="p-2.5">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-[12px] font-bold text-foreground">
                          {photo.mealType}
                        </p>
                        <span className="text-[10px] text-muted-foreground">
                          {new Date(photo.date).toLocaleDateString()}
                        </span>
                      </div>
                      {photo.caption ? (
                        <p className="mt-1 line-clamp-2 text-[11.5px] text-muted-foreground">
                          {photo.caption}
                        </p>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </SectionCard>
        </div>

        <div className="space-y-5">
          <SectionCard title="Rate a Meal">
            <form className="grid gap-3" onSubmit={handleFeedback}>
              <Input label="Date" name="date" required type="date" />
              <Select label="Meal" name="mealType" required>
                {MEAL_ORDER.map((meal) => (
                  <option key={meal} value={meal}>
                    {meal}
                  </option>
                ))}
              </Select>
              <Select label="Rating" name="rating" required>
                {[5, 4, 3, 2, 1].map((value) => (
                  <option key={value} value={value}>
                    {"★".repeat(value)} ({value})
                  </option>
                ))}
              </Select>
              <TextArea label="Comment" name="comment" />
              <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">
                <input
                  className="accent-role-resident"
                  name="isAnonymous"
                  type="checkbox"
                />
                Submit anonymously
              </label>
              <RoleButton className="w-full" tone="resident" type="submit">
                <Send className="size-3.5" />
                Submit Feedback
              </RoleButton>
            </form>
          </SectionCard>

          <SectionCard title="Share a Photo">
            <form className="grid gap-3" onSubmit={handlePhoto}>
              <div className="grid gap-1.5">
                <span className="text-[12.5px] font-semibold text-foreground">Photo</span>
                <FileUploaderView
                  label="Upload meal photo"
                  tone="resident"
                  uploader={photoUpload}
                />
              </div>
              <input name="photoAssetId" type="hidden" value={photoAssetId} />
              <Input label="Date" name="date" required type="date" />
              <Select label="Meal" name="mealType" required>
                {MEAL_ORDER.map((meal) => (
                  <option key={meal} value={meal}>
                    {meal}
                  </option>
                ))}
              </Select>
              <Input label="Caption" name="caption" />
              <RoleButton
                className="w-full"
                disabled={photoUpload.isUploading || !photoAssetId}
                tone="resident"
                type="submit"
                variant="outline"
              >
                <Upload className="size-3.5" />
                Upload Photo
              </RoleButton>
            </form>
          </SectionCard>
        </div>
      </div>
    </div>
  );
});
