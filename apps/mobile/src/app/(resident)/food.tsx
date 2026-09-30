import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import { useCallback, useState } from "react";
import { Pressable, View } from "react-native";

import {
  FoodRoutineWeek,
  MonthEndSpecial,
} from "@/components/food-routine";
import { NotificationBell } from "@/components/notification-bell";
import { AppBar } from "@/components/ui/app-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, SectionHeader, SectionLink } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Chip, Grid } from "@/components/ui/layout";
import { ListRow } from "@/components/ui/list-row";
import { Screen } from "@/components/ui/screen";
import { Sheet } from "@/components/ui/sheet";
import { Skeleton, SkeletonCard } from "@/components/ui/skeleton";
import { StarRating } from "@/components/ui/star-rating";
import { ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { Toggle } from "@/components/ui/toggle";
import { useAppSelector } from "@/hooks/redux";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useDates } from "@/hooks/use-dates";
import { useResource } from "@/hooks/use-resource";
import { residentQuery } from "@/lib/resident-queries";
import { readApiError } from "@/lib/api-contract";
import {
  dateForDay,
  type MealType,
  mealTypeNow,
  type RoutineDay,
} from "@/lib/food-week";
import { humanizeEnum } from "@/lib/format";
import {
  type ResidentFood,
  submitFoodFeedback,
  uploadFoodPhoto,
} from "@/lib/resident-api";
import { toastError, toastSuccess } from "@/lib/toast";
import { openAssetViewer } from "@/lib/asset-viewer";
import { privateAssetSource, uploadAsset } from "@/lib/uploads";

/**
 * The week's food, and the two things a resident can put back into it.
 *
 * ## Today leads, the week follows
 *
 * The routine is a 7×4 grid and a phone is one column wide, so it is shown a
 * day at a time with today selected. A resident checking the app at 6pm wants
 * tonight's dinner, not a table they have to scroll sideways through — and the
 * day strip makes "what is Friday" one tap rather than a different screen.
 *
 * Day is resolved in **Nepal time**. `getDay()` on a phone left on another
 * timezone selects the wrong column for the last 5h45m of every day, which is
 * exactly the evening window when people check dinner.
 *
 * ## Rating opens a sheet, and used to grow the card
 *
 * "Rate this meal" was a bare `text-primary` link at the foot of each meal card,
 * and tapping it swapped the link for the whole form **inside that card** — five
 * stars, a multiline comment box, a checkbox and two buttons. So rating
 * breakfast pushed lunch, snacks and dinner down the page by about 200 points
 * while the resident was typing, and dismissing it pulled them back up. A row's
 * secondary action opens a **bottom sheet** in this app (`NOTES.md` §6); a form
 * that reflows the list it was launched from is the case that rule exists for.
 *
 * The trigger is a `<Chip>` rather than a link, so it reads as a control at a
 * glance and matches the star chip on the meal it belongs to.
 *
 * ## The routine itself moved out
 *
 * The day strip, the meal cards and the month-end card live in
 * `components/food-routine.tsx`, because the public hostel page shows the same
 * routine from the same payload to someone deciding whether to move in — and
 * `(admin)/today.tsx` shows it read-only. This screen keeps the two things that
 * are a resident's alone — rating a meal, and posting a photo of it — and passes
 * the first in through `mealFooter`.
 */

export default function ResidentFoodScreen() {
  /*
   * The kitchen changes this screen, not the resident. `food.service.ts` and
   * `cook.service.ts` both publish, so a menu edited at 5pm reaches the phone
   * of somebody deciding whether to eat in.
   */
  const query = residentQuery.food();
  const food = useResource<ResidentFood>(query.load, {
    cacheKey: query.key,
    topics: query.topics,
  });

  /*
   * One sheet for four meal cards, keyed by which meal opened it.
   *
   * The state used to live *inside* each `MealCard`'s footer, one flag per card,
   * which is what made the form inline. Hoisting it here is what lets a single
   * `<Sheet>` serve all four — and the draft inside the sheet is keyed on this
   * value for the same reason `guardians/index.tsx` keys its permission draft on
   * the guardian: a reused surface with an unkeyed draft paints the previous
   * subject's answers onto the next one, so a resident who half-rated breakfast
   * would find those stars already lit under dinner.
   */
  const [rating, setRating] = useState<{ day: RoutineDay; mealType: MealType } | null>(
    null,
  );

  const header = (
    <AppBar
      actions={<NotificationBell />}
      /*
        `large`, as on the other resident tabs and every admin one. The subtitle
        went with it: "This week's routine" was chrome describing the band
        directly underneath it, and a tab whose name is a page heading does not
        also need a caption saying what the page is.
      */
      large
      title="Food"
    />
  );

  if (food.loading) {
    return (
      <Screen header={header} insideTabs>
        {/*
          The day strip, then the day's meals, then the photo wall — the three
          bands `FoodRoutineWeek` and `PhotoGallery` resolve into. See Home's
          note on why this is a skeleton and not a spinner.
        */}
        <View className="gap-4">
          <View className="flex-row gap-2">
            {Array.from({ length: 7 }, (_, index) => (
              <Skeleton height={52} key={index} radius={14} width={42} />
            ))}
          </View>

          <SkeletonCard rows={2} />
          <SkeletonCard rows={2} />

          <View className="flex-row gap-2">
            <Skeleton height={92} radius={14} width="32%" />
            <Skeleton height={92} radius={14} width="32%" />
            <Skeleton height={92} radius={14} width="32%" />
          </View>
        </View>
      </Screen>
    );
  }

  if (food.error || !food.data) {
    return (
      <Screen header={header} insideTabs>
        <ErrorState
          message={food.error ?? "The menu could not be loaded."}
          onRetry={food.reload}
        />
      </Screen>
    );
  }

  const { photos, routine } = food.data;

  return (
    <>
      <Screen
        header={header}
        insideTabs
        onRefresh={food.refresh}
        refreshing={food.refreshing}
        scroll
      >
        <View className="gap-5 pt-1">
          <FoodRoutineWeek
            mealFooter={({ day, hasItems, mealType }) =>
              hasItems ? (
                /*
                  Wrapped in a row so the chip hugs its label. `MealCard`'s
                  footer slot is a column, whose default `align-items: stretch`
                  would take a lone chip to the full width of the card — a
                  full-width green bar reading "Rate this meal", which looks like
                  the card's primary action rather than its aside.
                */
                <View className="flex-row">
                  <Chip
                    icon="star-outline"
                    label="Rate this meal"
                    onPress={() => setRating({ day, mealType })}
                    tone="brand"
                  />
                </View>
              ) : null
            }
            meals={routine.meals}
            timings={routine.timings}
          />

          <MonthEndSpecial special={routine.monthEndSpecial} />

          <PhotoGallery onUploaded={food.refresh} photos={photos} />
        </View>
      </Screen>

      {/*
        Outside `<Screen>`, so the sheet is not a child of the scroll view it
        covers. Rendered unconditionally with `open` driven by the state, which
        is the contract `<Sheet>` documents — mounting it on the boolean instead
        is what leaves gorhom's modal stuck in `DISMISSING` and draws nothing.
      */}
      <FeedbackSheet meal={rating} onClose={() => setRating(null)} />
    </>
  );
}

/**
 * The rating form, for whichever meal opened it.
 *
 * Rating is per meal *per day*, because that is what the server aggregates:
 * feedback with no meal attached cannot tell an owner that Tuesday dinner is the
 * problem, which is the only thing the feedback is for. So the sheet's title
 * names both, and closing it clears the draft rather than carrying yesterday's
 * three stars into tonight's dinner.
 */
function FeedbackSheet({
  meal,
  onClose,
}: {
  meal: { day: RoutineDay; mealType: MealType } | null;
  onClose: () => void;
}) {
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState("");
  const [anonymous, setAnonymous] = useState(false);
  const [busy, setBusy] = useState(false);

  const close = useCallback(() => {
    /*
      Cleared on the way out, not on the way in. `<Sheet>`'s `onClose` fires for
      the drag and the backdrop tap as well as for our own dismissal, so this is
      the one place that runs for every exit — and resetting on open instead
      would leave a half-typed comment sitting in state until the next open,
      where a slow render shows it for a frame under a different meal's title.
    */
    setRating(0);
    setComment("");
    setAnonymous(false);
    onClose();
  }, [onClose]);

  const send = useCallback(async () => {
    if (!meal) {
      return;
    }

    if (rating < 1) {
      toastError("Pick a rating first");
      return;
    }

    setBusy(true);

    try {
      await submitFoodFeedback({
        comment: comment.trim() || undefined,
        date: dateForDay(meal.day),
        isAnonymous: anonymous,
        mealType: meal.mealType,
        rating,
      });

      toastSuccess("Thanks — that's been sent to your hostel.");
      close();
    } catch (caught) {
      toastError("Could not send that", readApiError(caught));
    } finally {
      setBusy(false);
    }
  }, [anonymous, close, comment, meal, rating]);

  return (
    <Sheet
      footer={
        <View className="flex-row gap-3">
          <View className="flex-1">
            <Button label="Cancel" onPress={close} variant="outline" />
          </View>
          <View className="flex-1">
            <Button label="Send" loading={busy} onPress={() => void send()} />
          </View>
        </View>
      }
      onClose={close}
      open={meal !== null}
      title={
        meal
          ? `${humanizeEnum(meal.mealType)} · ${humanizeEnum(meal.day)}`
          : "Rate this meal"
      }
    >
      <View className="gap-4">
        {/*
          The kit's `<StarRating>`, not five hand-rolled `Pressable`s around an
          `Ionicons`. This screen had its own copy — the same 26-point amber
          stars, the same `star` / `star-outline` swap — while `review.tsx` used
          the component, so one resident rated their dinner and their hostel with
          two implementations of one control.
        */}
        <StarRating
          label="How was it?"
          onChange={setRating}
          sublabel="Your hostel sees the average per meal, per day."
          value={rating}
        />

        <Input
          label="Anything you'd like them to know?"
          multiline
          onChangeText={setComment}
          placeholder="Optional"
          value={comment}
        />

        {/*
          Worth offering: honest feedback about the cook is hard to give when you
          eat there every day and your name is on it.

          A `<ListRow>` carrying a `<Toggle>`, which is how every switch in the
          app is drawn — `settings.tsx` is a screen of them. This form had a
          hand-rolled checkbox instead: a `Pressable` around `checkbox` /
          `square-outline` glyphs, so one resident met two different controls for
          "turn this on" inside one app.
        */}
        <Card padding="px-4 py-1">
          <ListRow
            right={
              <Toggle
                accessibilityLabel="Send without my name"
                onChange={setAnonymous}
                value={anonymous}
              />
            }
            subtitle="Your hostel sees the rating and the comment, not who left them."
            title="Send without my name"
          />
        </Card>
      </View>
    </Sheet>
  );
}

function PhotoGallery({
  onUploaded,
  photos,
}: {
  onUploaded: () => void;
  photos: ResidentFood["photos"];
}) {
  const dates = useDates();
  const token = useAppSelector((state) => state.auth.accessToken);
  const { colors } = useAppTheme();
  const [busy, setBusy] = useState(false);

  const add = useCallback(async () => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();

    if (!permission.granted) {
      toastError("Permission needed", "Allow photo access to share a meal photo.");
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      quality: 0.8,
    });
    const asset = result.canceled ? null : result.assets[0];

    if (!asset) {
      return;
    }

    setBusy(true);

    try {
      const photoAssetId = await uploadAsset(asset, {
        kind: "GENERIC",
        // Every other call site names the task; this one did not, so the
        // toaster and the new shade notification both said "Uploading file".
        label: "Food photo",
      });

      await uploadFoodPhoto({
        date: new Date().toISOString(),
        mealType: mealTypeNow(),
        photoAssetId,
      });

      toastSuccess("Photo shared");
      onUploaded();
    } catch (caught) {
      toastError("Could not share that photo", readApiError(caught));
    } finally {
      setBusy(false);
    }
  }, [onUploaded]);

  /*
   * The grid and the viewer are built from the *same* slice, so the tapped tile
   * and the page it opens cannot drift apart — indexing a 12-tile grid into an
   * unsliced list is how a gallery opens on the wrong photo.
   */
  const shown = photos.slice(0, 12);
  const items = shown.map((photo) => ({
    assetId: photo.photoAssetId,
    caption: [photo.caption, dates.date(photo.date)].filter(Boolean).join(" · "),
    title: humanizeEnum(photo.mealType),
  }));

  return (
    <View>
      <SectionHeader
        action={
          /*
            `<SectionLink>`, which is the kit's own text-and-chevron for exactly
            this slot. This screen hand-rolled a `Pressable` around a
            `text-primary` `<Text>` — the same object without the chevron, the
            haptic or the hit slop, sitting beside a dozen headers that have all
            three.
          */
          <SectionLink
            label={busy ? "Uploading…" : "Add photo"}
            onPress={() => {
              if (busy) {
                return;
              }

              void add();
            }}
          />
        }
        title="Photos"
      />

      {photos.length === 0 ? (
        <Card>
          <Text variant="muted">No photos yet. Add the first.</Text>
        </Card>
      ) : (
        /*
         * `<Grid>` rather than a fixed 104dp tile: three of those plus their
         * gaps need 328dp, and a 320dp phone has about 280 after the screen's
         * own padding — so the third tile wrapped to its own line and left a
         * hole. The grid measures what it was given and fits what fits.
         */
        <Grid gap={8} maxColumns={3} minCellWidth={96}>
          {shown.map((photo, index) => (
            <Pressable
              accessibilityLabel={`${humanizeEnum(photo.mealType)} on ${dates.date(photo.date)}`}
              accessibilityRole="imagebutton"
              className="gap-1 active:opacity-80"
              key={photo.id}
              onPress={() => openAssetViewer(items, index)}
            >
              <Image
                contentFit="cover"
                source={privateAssetSource(photo.photoAssetId, token, "THUMBNAIL")}
                style={{
                  aspectRatio: 1,
                  backgroundColor: colors.muted,
                  borderRadius: 12,
                  width: "100%",
                }}
              />
              <Badge label={humanizeEnum(photo.mealType)} />
              {/*
                The caption is stored by the server and shown by the web, and
                was dropped here. Meal photos are captioned with the thing worth
                knowing — "this was Tuesday's dal" — so a grid without them is
                twelve squares of curry.
              */}
              {photo.caption ? (
                <Text numberOfLines={2} variant="caption">
                  {photo.caption}
                </Text>
              ) : (
                <Text variant="caption">{dates.date(photo.date)}</Text>
              )}
            </Pressable>
          ))}
        </Grid>
      )}
    </View>
  );
}
