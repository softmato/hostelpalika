"use client";

import { Camera, Send, Sparkles, Star, Upload } from "@/components/icons";
import { memo, useCallback, useMemo, useState, type FormEvent } from "react";

import { EmptyState, Input, Select, TextArea } from "@/app/_components/shared-ui";
import { FileUploaderView, useUploader } from "@/components/uploads";
import {
  EmptyInline,
  PortalPageHeader,
  RoleButton,
} from "@/app/_components/portal-dashboard-ui";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { browserApi } from "@/lib/browser-api";
import { dayMonthYear } from "@/lib/format-month";
import { useInvalidateResources, usePortalResource } from "@/lib/portal-query";
import { residentEndpoints } from "@/lib/resident-endpoints";
import { cn } from "@/lib/utils";
import { CardSkeletons, MealTile, SectionTitle, titleCase } from "./daily-portal-ui";
import {
  type FoodMenu,
  type FoodPhoto,
  type FoodRoutine,
  Message,
  field,
  optionalField,
} from "./resident-shared";

const MEAL_ORDER = ["BREAKFAST", "LUNCH", "SNACKS", "DINNER"];

const DAY_ORDER: FoodMenu["dayOfWeek"][] = [
  "SUNDAY",
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
];

export const ResidentFoodPageContent = memo(function ResidentFoodPageContent() {
  const [actionMessage, setActionMessage] = useState("");
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [photoOpen, setPhotoOpen] = useState(false);
  const today = DAY_ORDER[new Date().getDay()];
  const [day, setDay] = useState(today);
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
  const dayMenus = useMemo(() => sortedMenus.filter((menu) => menu.dayOfWeek === day), [day, sortedMenus]);

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
      setFeedbackOpen(false);
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
        setPhotoOpen(false);
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
        actions={
          <>
            <Button className="h-9 gap-2 rounded-xl" onClick={() => setPhotoOpen(true)} type="button" variant="outline">
              <Camera className="size-4" />
              Share photo
            </Button>
            <RoleButton className="h-9 px-4" onClick={() => setFeedbackOpen(true)} tone="team">
              <Star className="size-4" />
              Rate a meal
            </RoleButton>
          </>
        }
        description="The week's menu and photos from the kitchen."
        title="Food Menu"
      />
      <Message value={message} />

      <section className="space-y-3">
        {/* The routine repeats weekly, so it reads by day: one day's meals at a time. */}
        <div className="flex gap-1.5 overflow-x-auto pb-1">
          {DAY_ORDER.map((dayName) => {
            const on = dayName === day;

            return (
              <button
                aria-pressed={on}
                className={cn(
                  "shrink-0 rounded-full border px-3.5 py-1.5 text-[12.5px] font-semibold transition active:scale-95",
                  on
                    ? "border-transparent bg-foreground text-background"
                    : "border-border text-muted-foreground hover:text-foreground",
                )}
                key={dayName}
                onClick={() => setDay(dayName)}
                type="button"
              >
                {titleCase(dayName).slice(0, 3)}
                {dayName === today ? <span className="ml-1 text-[10px] opacity-70">today</span> : null}
              </button>
            );
          })}
        </div>
        {state === "loading" ? <CardSkeletons count={4} /> : null}
        {state === "error" ? <EmptyState label="Food could not be loaded." /> : null}
        {state === "ready" && sortedMenus.length === 0 ? (
          <EmptyInline label="No menu has been posted yet." />
        ) : null}
        {state === "ready" && sortedMenus.length > 0 && dayMenus.length === 0 ? (
          <EmptyInline label={`Nothing set for ${titleCase(day)}.`} />
        ) : null}
        {dayMenus.length > 0 ? (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {dayMenus.map((menu) => (
              <MealTile
                items={menu.items}
                key={`${menu.dayOfWeek}:${menu.mealType}`}
                mealType={menu.mealType}
                note={menu.note}
                timing={menu.timing}
              />
            ))}
          </div>
        ) : null}
        {routine?.monthEndSpecial && routine.monthEndSpecial.items.length > 0 ? (
          <div className="flex items-center gap-3 rounded-2xl border border-border/70 bg-card p-4">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-role-team-soft text-role-team">
              <Sparkles className="size-5" />
            </span>
            <div className="min-w-0">
              <p className="font-heading text-[15px] font-semibold text-foreground">Month-end special</p>
              <p className="truncate text-[13.5px] text-muted-foreground">
                {routine.monthEndSpecial.items.join(", ")}
              </p>
            </div>
          </div>
        ) : null}
      </section>

      <section className="space-y-3">
        <SectionTitle>Photos</SectionTitle>
        {photos.length === 0 ? (
          <EmptyInline label="No food photos shared yet." />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
            {photos.map((photo) => (
              <div
                className="overflow-hidden rounded-2xl border border-border/70 bg-card transition duration-200 hover:-translate-y-0.5 hover:shadow-md"
                key={photo.id}
              >
                {photo.photoAssetId ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    alt={photo.caption ?? `${photo.mealType} photo`}
                    className="aspect-[4/3] w-full object-cover"
                    onError={(event) => {
                      (event.currentTarget as HTMLImageElement).style.display = "none";
                    }}
                    src={`/api/v1/files/${photo.photoAssetId}/url?variant=THUMBNAIL`}
                  />
                ) : null}
                <div className="p-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-[13px] font-semibold text-foreground">{titleCase(photo.mealType)}</p>
                    <span className="text-[11.5px] text-muted-foreground">{dayMonthYear(photo.date)}</span>
                  </div>
                  {photo.caption ? (
                    <p className="mt-0.5 line-clamp-2 text-[12.5px] text-muted-foreground">{photo.caption}</p>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <Dialog onOpenChange={setFeedbackOpen} open={feedbackOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Rate a meal</DialogTitle>
            <DialogDescription>The kitchen sees every rating.</DialogDescription>
          </DialogHeader>
          <form className="grid gap-3" onSubmit={handleFeedback}>
            <div className="grid grid-cols-2 gap-3">
              <Input label="Date" name="date" required type="date" />
              <Select label="Meal" name="mealType" required>
                {MEAL_ORDER.map((meal) => (
                  <option key={meal} value={meal}>
                    {titleCase(meal)}
                  </option>
                ))}
              </Select>
            </div>
            <Select label="Rating" name="rating" required>
              {[5, 4, 3, 2, 1].map((value) => (
                <option key={value} value={value}>
                  {"★".repeat(value)} ({value})
                </option>
              ))}
            </Select>
            <TextArea label="Comment" name="comment" />
            <label className="flex items-center gap-2 text-[13px] font-medium text-foreground">
              <input className="accent-brand-teal" name="isAnonymous" type="checkbox" />
              Send without my name
            </label>
            <DialogFooter>
              <RoleButton className="h-10 px-5" tone="team" type="submit">
                <Send className="size-4" />
                Send rating
              </RoleButton>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog onOpenChange={setPhotoOpen} open={photoOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Share a photo</DialogTitle>
            <DialogDescription>Your plate, for everyone at the hostel.</DialogDescription>
          </DialogHeader>
          <form className="grid gap-3" onSubmit={handlePhoto}>
            <FileUploaderView label="Upload meal photo" tone="resident" uploader={photoUpload} />
            <input name="photoAssetId" type="hidden" value={photoAssetId} />
            <div className="grid grid-cols-2 gap-3">
              <Input label="Date" name="date" required type="date" />
              <Select label="Meal" name="mealType" required>
                {MEAL_ORDER.map((meal) => (
                  <option key={meal} value={meal}>
                    {titleCase(meal)}
                  </option>
                ))}
              </Select>
            </div>
            <Input label="Caption" name="caption" />
            <DialogFooter>
              <RoleButton
                className="h-10 px-5"
                disabled={photoUpload.isUploading || !photoAssetId}
                tone="team"
                type="submit"
              >
                <Upload className="size-4" />
                Share photo
              </RoleButton>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
});
