import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import { useCallback, useMemo, useState } from "react";
import { Pressable, View } from "react-native";

import { NotificationBell } from "@/components/notification-bell";
import { AppBar } from "@/components/ui/app-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, SectionHeader } from "@/components/ui/card";
import { Grid } from "@/components/ui/layout";
import { Screen } from "@/components/ui/screen";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useAppSelector } from "@/hooks/redux";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useDates } from "@/hooks/use-dates";
import { useResource } from "@/hooks/use-resource";
import { readApiError } from "@/lib/api-contract";
import { openAssetViewer } from "@/lib/asset-viewer";
import {
  type CookPhotoDay,
  type CookPhotoFeed,
  listCookFoodPhotos,
  uploadCookFoodPhoto,
} from "@/lib/cook-api";
import { mergePhotoDays } from "@/lib/cook";
import { cookQuery } from "@/lib/cook-queries";
import { formatTime, humanizeEnum } from "@/lib/format";
import { mealTypeNow } from "@/lib/food-week";
import { toastError, toastSuccess } from "@/lib/toast";
import { privateAssetSource, uploadAsset } from "@/lib/uploads";

/**
 * A photo of the meal, taken with the camera in the kitchen.
 *
 * ## Camera first, library second
 *
 * Food transparency is the point of the feed: a picture of *this* meal, taken
 * now. Opening the library first invites a stock photo or last week's curry, so
 * the primary action launches the camera and the library is the secondary
 * button — the same order the web's uploader offers, inverted for a device that
 * has a camera in hand.
 *
 * ## The meal type is guessed, not asked
 *
 * `mealTypeNow()` reads the Kathmandu clock. A picker between "I want to share
 * this" and the photo being shared is where people give up, and a wrong bucket
 * costs the hostel nothing — nobody audits which meal a curry photo landed in.
 *
 * ## One feed, now readable from both ends
 *
 * `POST /cook/food-photos` writes the same `FoodPhoto` collection the resident
 * and admin routes write to, and publishes on the FOOD topic, so a photo appears
 * on residents' food screens as it is posted. Until 2026-08-18 that route was
 * **POST-only** — the kitchen could post a photo of dinner and had no way to see
 * it, or to see whether anyone had posted at all today, while every resident in
 * the hostel could. `GET /cook/food-photos` closes that, and this screen now
 * shows the same rows the residents see rather than a local approximation of
 * them.
 *
 * ## Grouped by day, by the server
 *
 * Nepal is +05:45, so a breakfast photographed at 05:30 local is `23:45Z` the
 * *previous* day. Grouping on the phone would hand that decision to the
 * handset's timezone, and a cook whose phone is set to anything else would see
 * this morning's breakfast filed under yesterday. `food-photo-days.ts` does it
 * in `Asia/Kathmandu` and sends the day key down.
 *
 * The **meals covered** count per day is the number the kitchen is actually
 * judged on: four photos of dinner is not the same as one of each meal, and a
 * photo count cannot tell those apart.
 *
 * ## The announcement history left this tab
 *
 * It used to sit under the photo feed: every meal this kitchen has ever called,
 * on a tab named "Photos". Two subjects on one screen, and the wrong one was
 * growing — a hostel serving four meals a day fills that list with a hundred and
 * twenty rows a month, under the control a cook opens this tab to press.
 *
 * "Did I already announce lunch?" is answered on **Today**, on the meal's own
 * card, which carries `Sent 12:04`. "What has this kitchen called, and from
 * which handset?" is a record, asked rarely, and it is now on **More**, beside
 * the device fingerprint that is stamped on every one of those rows. Two
 * questions, two homes, and this tab is one subject again.
 */
export default function CookPhotosScreen() {
  /*
   * One read now, under the portal's own key — the announcement log that used to
   * be fetched alongside it moved to More with the section that drew it. See
   * `lib/cook-queries.ts`.
   */
  const query = cookQuery.photos();
  const feed = useResource<CookPhotoFeed>(query.load, {
    cacheKey: query.key,
    topics: query.topics,
  });

  /*
   * Which source is uploading, not merely that one is: the two buttons sit on
   * top of each other and a shared boolean drew the spinner on "Take a photo"
   * while the picture from the gallery was the one going up.
   */
  const [busy, setBusy] = useState<"camera" | "library" | null>(null);

  const share = useCallback(
    async (source: "camera" | "library") => {
      const permission =
        source === "camera"
          ? await ImagePicker.requestCameraPermissionsAsync()
          : await ImagePicker.requestMediaLibraryPermissionsAsync();

      if (!permission.granted) {
        toastError(
          "Permission needed",
          source === "camera"
            ? "Allow camera access to photograph the meal."
            : "Allow photo access to pick a meal photo.",
        );
        return;
      }

      const result =
        source === "camera"
          ? await ImagePicker.launchCameraAsync({ quality: 0.8 })
          : await ImagePicker.launchImageLibraryAsync({
              mediaTypes: ["images"],
              quality: 0.8,
            });
      const asset = result.canceled ? null : result.assets[0];

      if (!asset) {
        return;
      }

      setBusy(source);

      try {
        // Progress is reported by `<UploadToaster />` at the app root — call
        // sites never build their own.
        const photoAssetId = await uploadAsset(asset, {
          kind: "GENERIC",
          label: "Meal photo",
        });

        await uploadCookFoodPhoto({
          date: new Date().toISOString(),
          mealType: mealTypeNow(),
          photoAssetId,
        });

        toastSuccess("Photo shared", "Residents can see it on their food screen.");
        // The photo the cook just took should appear in the grid below without
        // them having to pull to refresh to believe it worked. A refetch rather
        // than a cache write, unlike the announce button: the POST returns an
        // id, not the serialized feed row, so there is nothing here to fold in
        // that would not have to be invented.
        feed.refresh();
      } catch (caught) {
        toastError("Could not share that photo", readApiError(caught));
      } finally {
        setBusy(null);
      }
    },
    [feed],
  );

  const header = <AppBar actions={<NotificationBell />} large title="Photos" />;

  return (
    <Screen
      header={header}
      insideTabs
      onRefresh={feed.refresh}
      refreshing={feed.refreshing}
      scroll
    >
      <View className="gap-5 pt-1">
        <Card className="gap-3">
          <Text variant="subtitle">Show them what&apos;s cooking</Text>
          <Text variant="muted">
            {`A photo of today's ${humanizeEnum(
              mealTypeNow(),
            ).toLowerCase()} appears on every resident's food screen straight away.`}
          </Text>
          <Button
            disabled={busy === "library"}
            label="Take a photo"
            loading={busy === "camera"}
            onPress={() => void share("camera")}
            size="lg"
          />
          <Button
            disabled={busy === "camera"}
            label="Choose from gallery"
            loading={busy === "library"}
            onPress={() => void share("library")}
            variant="outline"
          />
        </Card>

        <PhotoFeedSection feed={feed} />
      </View>
    </Screen>
  );
}

/**
 * What the kitchen has posted, newest day first.
 *
 * Each day is a header — the date, the meals it covered, how many photos — and a
 * grid beneath it. Tapping opens the global asset viewer on **that day's**
 * photos, not the whole feed: the day is the unit a cook thinks in, and paging
 * from Tuesday's dinner into last week is not what the tap meant.
 */
function PhotoFeedSection({
  feed,
}: {
  feed: ReturnType<typeof useResource<CookPhotoFeed>>;
}) {
  /*
   * Pages beyond the first, held here rather than in the cache.
   *
   * `cook:photos` is the *first* page and stays that: it is what the portal
   * warms on entry and what a FOOD event invalidates, and writing an
   * accumulated four-page list back under that key would mean a refresh either
   * throwing the paging away silently or re-fetching four pages to redraw one
   * screen. So the cache keeps the answer to "what has this kitchen posted
   * lately" and the extra pages live for as long as the tab does — which is the
   * lifetime a scroll position has anyway.
   */
  const [older, setOlder] = useState<CookPhotoDay[]>([]);
  const [cursor, setCursor] = useState<string | null>(feed.data?.cursor ?? null);
  const [paging, setPaging] = useState(false);

  /*
   * A new first page resets the paging, adjusted during render rather than in
   * an effect — the same idiom `useResource` documents for a changed key. An
   * effect would commit one frame of last-load's older pages sitting under a
   * freshly refreshed first page, which is the flicker, and worse here because
   * the two halves would briefly be from different reads.
   */
  const [pagedFrom, setPagedFrom] = useState(feed.data);

  if (feed.data !== pagedFrom) {
    setPagedFrom(feed.data);
    setOlder([]);
    setCursor(feed.data?.cursor ?? null);
  }

  const days = useMemo(
    () => mergePhotoDays(feed.data?.days ?? [], older),
    [feed.data, older],
  );

  const loadOlder = useCallback(async () => {
    if (!cursor) {
      return;
    }

    setPaging(true);

    try {
      const page = await listCookFoodPhotos(cursor);

      setOlder((current) => mergePhotoDays(current, page.days));
      // The server's own answer, not a guess: `null` here is the end of the
      // feed and is what takes the button off the screen.
      setCursor(page.cursor);
    } catch (caught) {
      toastError("Could not load older photos", readApiError(caught));
    } finally {
      setPaging(false);
    }
  }, [cursor]);

  const total = (feed.data?.total ?? 0) + older.reduce((sum, day) => sum + day.photos.length, 0);

  return (
    <View>
      <SectionHeader
        subtitle={
          total > 0
            ? `${total} photo${total === 1 ? "" : "s"}${
                cursor ? " · most recent first" : ""
              }`
            : "Everything this kitchen has shared"
        }
        title="Your photos"
      />

      {feed.loading ? (
        /* Two day cards, each a heading over a row of four tiles — the shape
           this section lands in. `CLAUDE.md` and `NOTES.md` §9: loading is
           skeletons. */
        <View className="gap-4">
          {Array.from({ length: 2 }, (_, index) => (
            <View className="gap-2 rounded-2xl border border-border bg-card p-4" key={index}>
              <Skeleton height={16} width="52%" />
              <View className="flex-row gap-2 pt-1">
                {Array.from({ length: 4 }, (_, tile) => (
                  <Skeleton height={84} key={tile} radius={10} width="23%" />
                ))}
              </View>
            </View>
          ))}
        </View>
      ) : feed.error ? (
        <ErrorState message={feed.error} onRetry={feed.reload} />
      ) : days.length === 0 ? (
        <Card>
          <EmptyState icon="images"
            description="Take a photo above and it appears here, and on every resident's food screen."
            title="No photos yet"
          />
        </Card>
      ) : (
        <View className="gap-4">
          {days.map((day) => (
            <PhotoDayCard day={day} key={day.day} />
          ))}

          {/*
            The feed reaches back a page at a time, and the button is the only
            thing that says so. `hasMore` was already on the payload and nothing
            read it, so a kitchen posting daily lost last month off the bottom
            with no indication there was a bottom — the same fault the resident
            notices screen had.

            A button rather than infinite scroll on purpose: this is a record
            somebody consults, not a feed they browse, and an accidental thumb
            drag should not pull a fortnight of images over hostel wifi.
          */}
          {cursor ? (
            <Button
              label={paging ? "Loading…" : "Load older photos"}
              loading={paging}
              onPress={() => void loadOlder()}
              variant="outline"
            />
          ) : null}
        </View>
      )}
    </View>
  );
}

function PhotoDayCard({ day }: { day: CookPhotoDay }) {
  const dates = useDates();
  const token = useAppSelector((state) => state.auth.accessToken);
  const { colors } = useAppTheme();

  const items = day.photos.map((photo) => ({
    assetId: photo.photoAssetId,
    caption: [
      humanizeEnum(photo.mealType),
      `Posted ${formatTime(photo.uploadedAt)}`,
      photo.source === "RESIDENT" ? "By a resident" : null,
      photo.caption || null,
    ]
      .filter(Boolean)
      .join(" · "),
    title: dates.date(day.day),
  }));

  return (
    <Card className="gap-3">
      <View className="flex-row items-center justify-between gap-2">
        <View className="flex-1">
          <Text variant="label">{dates.dateLong(day.day)}</Text>
          <Text variant="caption">
            {`${day.photos.length} photo${day.photos.length === 1 ? "" : "s"}`}
          </Text>
        </View>

        {/*
          Out of four, because four is the routine. "2 of 4 meals" is a nudge
          with a number behind it; a bare "2" is not.
        */}
        <Badge
          label={`${day.mealsCovered} of 4 meals`}
          tone={day.mealsCovered >= 4 ? "success" : "neutral"}
        />
      </View>

      <Grid gap={8} maxColumns={4} minCellWidth={84}>
        {day.photos.map((photo, index) => (
          <Pressable
            accessibilityLabel={`${humanizeEnum(photo.mealType)}, posted ${formatTime(
              photo.uploadedAt,
            )}`}
            accessibilityRole="imagebutton"
            className="gap-1 active:opacity-80"
            key={photo.id}
            onPress={() => openAssetViewer(items, index)}
          >
            <Image
              cachePolicy="memory-disk"
              contentFit="cover"
              source={privateAssetSource(photo.photoAssetId, token, "THUMBNAIL")}
              style={{
                aspectRatio: 1,
                backgroundColor: colors.muted,
                borderRadius: 10,
                width: "100%",
              }}
            />
            <Text numberOfLines={1} variant="caption">
              {humanizeEnum(photo.mealType)}
            </Text>
            {/* The "when" the cook asked for: the clock time it went up. */}
            <Text className="text-[10px] text-muted-foreground" numberOfLines={1}>
              {photo.source === "RESIDENT"
                ? `Resident · ${formatTime(photo.uploadedAt)}`
                : formatTime(photo.uploadedAt)}
            </Text>
          </Pressable>
        ))}
      </Grid>
    </Card>
  );
}
