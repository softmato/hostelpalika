"use client";

import { Coffee, Cookie, Moon, Soup, Upload, Users, UtensilsCrossed } from "@/components/icons";
import type { IconComponent } from "@/components/icons";
import { useEffect, useState, type FormEvent } from "react";

import {
  MetricCard,
  PortalPageHeader,
  RoleButton,
  SectionCard,
} from "@/app/_components/portal-dashboard-ui";
import { EmptyState, Input, Select } from "@/app/_components/shared-ui";
import { FileUploaderView, useUploader } from "@/components/uploads";
import { browserApi } from "@/lib/browser-api";
import { useInvalidateResources, usePortalResource } from "@/lib/portal-query";
import { cn } from "@/lib/utils";
import {
  formatMinuteOfDay,
  mealAnnounceState,
  mealClosesAtMinute,
  mealOpensAtMinute,
  nepalDayKey,
  nepalMinuteOfDay,
  nepalWeekday,
  type MealAnnounceState,
} from "@hostel/shared/food/meal-window";

/**
 * The cook app's Today, Menu and Photos tabs, on the web. Same endpoints and
 * the same meal gate as `apps/mobile/src/lib/cook.ts` — read that file for why
 * a button is locked; this one only draws it.
 */

const MEAL_TYPES = ["BREAKFAST", "LUNCH", "SNACKS", "DINNER"] as const;
type MealType = (typeof MEAL_TYPES)[number];

const DAYS = [
  "SUNDAY",
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
] as const;

const MEAL_ICON: Record<MealType, IconComponent> = {
  BREAKFAST: Coffee,
  DINNER: Moon,
  LUNCH: Soup,
  SNACKS: Cookie,
};

const TODAY_URL = "/api/v1/cook/today";
const PHOTOS_URL = "/api/v1/cook/food-photos";

type Meal = {
  dayOfWeek: (typeof DAYS)[number];
  items: string[];
  mealType: MealType;
  note: string;
  timing: string;
};

type Announcement = {
  announcedAt: string;
  id: string;
  mealType: string;
  message: string;
  notifiedCount: number;
};

type CookToday = {
  announced: Announcement[];
  hostel: { id: string; name: string; slug: string };
  meals: Meal[];
  residentCount: number;
  routine: { meals: Meal[]; timings: Partial<Record<MealType, string>> };
};

type PhotoDay = {
  day: string;
  mealsCovered: number;
  photos: Array<{
    caption: string;
    id: string;
    mealType: MealType;
    photoAssetId: string;
    source: "KITCHEN" | "RESIDENT";
    uploadedAt: string;
  }>;
};

type PhotoFeed = { cursor: string | null; days: PhotoDay[]; hasMore: boolean };

function humanize(value: string) {
  return value.charAt(0) + value.slice(1).toLowerCase();
}

function clock(iso: string) {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

/** Re-renders every minute so a meal unlocks without a refresh. */
function useNow() {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  return now;
}

function mealNow(now: Date): MealType {
  const hour = Math.floor(nepalMinuteOfDay(now) / 60);
  return hour < 10 ? "BREAKFAST" : hour < 15 ? "LUNCH" : hour < 18 ? "SNACKS" : "DINNER";
}

type MealButton = {
  closesAt: string | null;
  items: string[];
  locked: boolean;
  mealType: MealType;
  opensAt: string | null;
  sent: Announcement | null;
  state: MealAnnounceState;
  timing: string;
};

function mealButtons(today: CookToday, now: Date): MealButton[] {
  const minute = nepalMinuteOfDay(now);

  return MEAL_TYPES.map((mealType) => {
    const planned = today.meals.find((meal) => meal.mealType === mealType);
    const timing = today.routine.timings[mealType]?.trim() || planned?.timing || "";
    // Announcements arrive newest first; the first per meal is the latest.
    const sent = today.announced.find((item) => item.mealType === mealType) ?? null;
    const opens = mealOpensAtMinute(timing);
    const closes = mealClosesAtMinute(timing);
    const state: MealAnnounceState = sent ? "ANY" : mealAnnounceState(timing, minute);

    return {
      closesAt: closes === null ? null : formatMinuteOfDay(closes),
      items: planned?.items ?? [],
      locked: state === "EARLY" || state === "MISSED",
      mealType,
      opensAt: opens === null ? null : formatMinuteOfDay(opens),
      sent,
      state,
      timing: planned?.timing || timing,
    };
  });
}

function buttonLabel(button: MealButton) {
  if (button.state === "EARLY") return button.opensAt ? `Opens ${button.opensAt}` : "Not yet";
  if (button.state === "MISSED") return "Not announced in time";
  return button.sent ? "Announce again" : "Food ready";
}

function lockNote(button: MealButton) {
  if (button.state === "EARLY") {
    return button.opensAt ? `You can call this meal from ${button.opensAt}.` : "Not due yet.";
  }
  if (button.state === "MISSED") {
    return button.closesAt
      ? `This meal could be called until ${button.closesAt}. Tell the office if the serving time has changed.`
      : "The time to call this meal has passed.";
  }
  return null;
}

function Skeletons({ count, height }: { count: number; height: string }) {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {Array.from({ length: count }, (_, index) => (
        <div className={cn("animate-pulse rounded-xl bg-muted/50", height)} key={index} />
      ))}
    </div>
  );
}

function MealIcon({ mealType }: { mealType: MealType }) {
  const Icon = MEAL_ICON[mealType];

  return (
    <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-role-admin-soft text-role-admin">
      <Icon className="size-[18px]" />
    </span>
  );
}

export function CookTodayPage() {
  const now = useNow();
  const invalidate = useInvalidateResources();
  const today = usePortalResource<{ today: CookToday }>(TODAY_URL, {
    errorMessage: "Today's menu could not be loaded.",
  });
  const [busy, setBusy] = useState<MealType | null>(null);
  const [notice, setNotice] = useState("");

  async function announce(mealType: MealType) {
    setBusy(mealType);
    setNotice("");

    try {
      const { announcement } = await browserApi<{
        announcement: Announcement & { staffNotifiedCount: number };
      }>("/api/v1/cook/food-ready", {
        body: JSON.stringify({
          deviceInfo: { platform: "web", userAgent: navigator.userAgent },
          mealType,
          useMenuDescription: true,
        }),
        method: "POST",
      });
      const staff = announcement.staffNotifiedCount > 0 ? " The office was notified as well." : "";
      setNotice(
        announcement.notifiedCount > 0
          ? `${humanize(mealType)} announced. ${announcement.notifiedCount} resident(s) notified.${staff}`
          : `${humanize(mealType)} recorded, but no resident here has an app account yet.${staff}`,
      );
      invalidate(TODAY_URL);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Not announced.");
    } finally {
      setBusy(null);
    }
  }

  const data = today.data?.today;
  const buttons = data ? mealButtons(data, now) : [];
  const next = buttons.find((button) => !button.sent) ?? null;

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <PortalPageHeader
        description="Tap when the food is out — residents get a notification, and so does the office."
        title={data?.hostel.name ?? "Today"}
      />

      {!data ? (
        today.state === "error" ? (
          <EmptyState label={today.message || "Today's menu could not be loaded."} />
        ) : (
          <Skeletons count={4} height="h-36" />
        )
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <MetricCard icon={Users} label="Residents" value={data.residentCount} />
            <MetricCard
              icon={UtensilsCrossed}
              label="Announced today"
              value={`${buttons.filter((button) => button.sent).length} of 4`}
            />
            <MetricCard
              icon={MEAL_ICON[next?.mealType ?? "DINNER"]}
              label="Next meal"
              note={next?.timing || undefined}
              value={next ? humanize(next.mealType) : "All done"}
            />
          </div>

          {notice ? (
            <p className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-[12.5px] text-foreground">
              {notice}
            </p>
          ) : null}

          <div className="grid gap-3 md:grid-cols-2">
            {buttons.map((button) => {
              const note = lockNote(button);

              return (
                <div
                  className={cn(
                    "space-y-3 rounded-xl border bg-card p-4 shadow-sm",
                    button.state === "MISSED"
                      ? "border-warning/40"
                      : next?.mealType === button.mealType && !button.locked
                        ? "border-role-admin/50"
                        : "border-border",
                  )}
                  key={button.mealType}
                >
                  <div className="flex items-start gap-3">
                    <MealIcon mealType={button.mealType} />
                    <div className="min-w-0 flex-1">
                      <p className="font-heading text-[14px] font-bold">{humanize(button.mealType)}</p>
                      <p className="text-[12px] text-muted-foreground">
                        {button.sent
                          ? button.sent.message
                          : button.items.join(", ") || "Nothing planned for today"}
                      </p>
                    </div>
                    <span
                      className={cn(
                        "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold",
                        button.sent
                          ? "bg-role-admin-soft text-role-admin"
                          : button.locked
                            ? "bg-warning/10 text-warning"
                            : "bg-muted text-muted-foreground",
                      )}
                    >
                      {button.sent
                        ? `Sent ${clock(button.sent.announcedAt)}`
                        : button.state === "MISSED"
                          ? "Missed"
                          : button.state === "EARLY" && button.opensAt
                            ? `From ${button.opensAt}`
                            : button.timing || "Any time"}
                    </span>
                  </div>

                  <RoleButton
                    className="h-10 w-full"
                    disabled={button.locked || busy !== null}
                    onClick={() => void announce(button.mealType)}
                    tone="admin"
                    variant={button.sent || button.state === "MISSED" ? "outline" : "solid"}
                  >
                    {busy === button.mealType ? "Announcing…" : buttonLabel(button)}
                  </RoleButton>

                  {button.sent ? (
                    <p className="text-[11.5px] text-muted-foreground">
                      {button.sent.notifiedCount} resident(s) notified.
                    </p>
                  ) : note ? (
                    <p className="text-[11.5px] text-muted-foreground">{note}</p>
                  ) : null}
                </div>
              );
            })}
          </div>

          <p className="text-[11.5px] text-muted-foreground">
            The message is built from today&apos;s menu. If you cooked something else,
            announce it and tell residents in person — the menu is the office&apos;s to change.
          </p>
        </>
      )}
    </div>
  );
}

export function CookMenuPage() {
  const now = useNow();
  const today = usePortalResource<{ today: CookToday }>(TODAY_URL, {
    errorMessage: "The menu could not be loaded.",
  });
  const meals = today.data?.today.routine.meals ?? [];
  const start = nepalWeekday(now);
  // Today first, then the rest of the week in order.
  const days = DAYS.map((_, index) => DAYS[(start + index) % 7]!);

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <PortalPageHeader
        description="The hostel's weekly routine. The office changes it; you cook from it."
        title="Menu"
      />

      {!today.data ? (
        today.state === "error" ? (
          <EmptyState label={today.message || "The menu could not be loaded."} />
        ) : (
          <Skeletons count={4} height="h-40" />
        )
      ) : meals.length === 0 ? (
        <EmptyState label="The office has not set a weekly menu yet." />
      ) : (
        <div className="space-y-5">
          {days.map((day, index) => {
            const dayMeals = MEAL_TYPES.map((mealType) =>
              meals.find((meal) => meal.dayOfWeek === day && meal.mealType === mealType),
            ).filter((meal): meal is Meal => Boolean(meal));

            if (dayMeals.length === 0) return null;

            return (
              <section className="space-y-2" key={day}>
                <h2 className="text-[11.5px] font-bold uppercase tracking-wide text-muted-foreground">
                  {index === 0 ? `Today · ${humanize(day)}` : humanize(day)}
                </h2>
                <SectionCard>
                  <ul className="divide-y divide-border/60">
                    {dayMeals.map((meal) => (
                      <li className="flex items-start gap-3 py-2.5" key={meal.mealType}>
                        <MealIcon mealType={meal.mealType} />
                        <div className="min-w-0 flex-1">
                          <p className="text-[13px] font-semibold">
                            {humanize(meal.mealType)}
                            {meal.timing ? (
                              <span className="ml-2 font-normal text-muted-foreground">
                                {meal.timing}
                              </span>
                            ) : null}
                          </p>
                          <p className="text-[12px] text-muted-foreground">
                            {meal.items.join(", ") || "—"}
                            {meal.note ? ` · ${meal.note}` : ""}
                          </p>
                        </div>
                      </li>
                    ))}
                  </ul>
                </SectionCard>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function CookPhotosPage() {
  const now = useNow();
  const invalidate = useInvalidateResources();
  const feed = usePortalResource<PhotoFeed>(PHOTOS_URL, {
    errorMessage: "Photos could not be loaded.",
  });
  const [older, setOlder] = useState<PhotoFeed | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [notice, setNotice] = useState("");
  const upload = useUploader({
    accessLevel: "PRIVATE",
    kind: "image",
    label: "Meal photo",
    optimizeImage: true,
  });
  const photoAssetId = upload.files[0]?.assetId ?? "";

  // Older pages are appended below the first; a refetch of the first resets them.
  const days = [...(feed.data?.days ?? []), ...(older?.days ?? [])];
  const cursor = older ? older.cursor : (feed.data?.cursor ?? null);
  const hasMore = older ? older.hasMore : Boolean(feed.data?.hasMore);

  async function share(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);

    try {
      await browserApi(PHOTOS_URL, {
        body: JSON.stringify({
          caption: String(form.get("caption") ?? "").trim() || undefined,
          date: nepalDayKey(),
          mealType: form.get("mealType"),
          photoAssetId,
        }),
        method: "POST",
      });
      upload.clear();
      setOlder(null);
      setNotice("Photo shared. Residents can see it on their food screen.");
      invalidate(PHOTOS_URL);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Photo not shared.");
    }
  }

  async function loadMore() {
    if (!cursor) return;
    setLoadingMore(true);

    try {
      const page = await browserApi<PhotoFeed>(`${PHOTOS_URL}?cursor=${encodeURIComponent(cursor)}`);
      setOlder((prev) => ({ ...page, days: [...(prev?.days ?? []), ...page.days] }));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not load older photos.");
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <PortalPageHeader
        description="Photograph the meal as it goes out. Residents see it on their food screen."
        title="Photos"
      />

      <SectionCard title="Share a photo">
        <form className="grid gap-3 md:grid-cols-[1fr_1fr_auto] md:items-end" onSubmit={share}>
          <div className="md:col-span-3">
            <FileUploaderView label="Upload meal photo" tone="admin" uploader={upload} />
          </div>
          <Select defaultValue={mealNow(now)} label="Meal" name="mealType" required>
            {MEAL_TYPES.map((meal) => (
              <option key={meal} value={meal}>
                {humanize(meal)}
              </option>
            ))}
          </Select>
          <Input label="Caption" name="caption" />
          <RoleButton
            className="h-9"
            disabled={upload.isUploading || !photoAssetId}
            tone="admin"
            type="submit"
          >
            <Upload className="size-3.5" />
            Share photo
          </RoleButton>
        </form>
        {notice ? <p className="mt-3 text-[12px] text-muted-foreground">{notice}</p> : null}
      </SectionCard>

      {!feed.data ? (
        feed.state === "error" ? (
          <EmptyState label={feed.message || "Photos could not be loaded."} />
        ) : (
          <Skeletons count={2} height="h-40" />
        )
      ) : days.length === 0 ? (
        <EmptyState label="No meal photos yet. The first one you share appears here." />
      ) : (
        <div className="space-y-5">
          {days.map((day) => (
            <section className="space-y-2" key={day.day}>
              <h2 className="flex items-baseline justify-between text-[11.5px] font-bold uppercase tracking-wide text-muted-foreground">
                {new Date(day.day).toLocaleDateString("en-GB", {
                  day: "numeric",
                  month: "long",
                  weekday: "long",
                })}
                <span className="font-medium normal-case tracking-normal">
                  {new Set(day.photos.map((photo) => photo.mealType)).size} of 4 meals
                </span>
              </h2>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                {day.photos.map((photo) => (
                  <figure className="overflow-hidden rounded-xl border border-border bg-card" key={photo.id}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      alt={`${humanize(photo.mealType)} photo`}
                      className="aspect-square w-full object-cover"
                      loading="lazy"
                      src={`/api/v1/files/${photo.photoAssetId}/url?variant=THUMBNAIL`}
                    />
                    <figcaption className="px-2.5 py-2 text-[11.5px] text-muted-foreground">
                      <span className="font-semibold text-foreground">{humanize(photo.mealType)}</span>
                      {` · ${clock(photo.uploadedAt)}`}
                      {photo.source === "RESIDENT" ? " · By a resident" : ""}
                      {photo.caption ? <span className="block truncate">{photo.caption}</span> : null}
                    </figcaption>
                  </figure>
                ))}
              </div>
            </section>
          ))}

          {hasMore ? (
            <RoleButton
              className="w-full"
              disabled={loadingMore}
              onClick={() => void loadMore()}
              tone="admin"
              variant="outline"
            >
              {loadingMore ? "Loading…" : "Show older photos"}
            </RoleButton>
          ) : null}
        </div>
      )}
    </div>
  );
}
