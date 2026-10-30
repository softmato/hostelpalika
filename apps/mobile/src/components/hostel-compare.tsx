import { Image } from "expo-image";
import { router, useLocalSearchParams } from "expo-router";
import { useCallback } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { AppBar } from "@/components/ui/app-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Glyph } from "@/components/ui/glyph";
import { Screen } from "@/components/ui/screen";
import { SkeletonText, SkeletonTiles } from "@/components/ui/skeleton";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useResource } from "@/hooks/use-resource";
import { API_BASE_URL } from "@/lib/api";
import { cardPhotoUrl, coverPhoto, priceRange, ratingDisplay } from "@/lib/hostel-display";
import { absoluteMediaUrl } from "@/lib/media";
import {
  COMPARE_MIN,
  type ComparedHostel,
  HOSTEL_TYPE_LABELS,
} from "@/lib/public-api";
import { publicQuery } from "@/lib/public-queries";

/**
 * Two or three hostels, side by side (docs/mockups/mobile/README.md §3).
 *
 * Rendered by the root `/compare` screen — pushed over whichever group you were
 * in — and by the `(browse)` Compare tab, which is the same screen sitting
 * empty until a comparison has been picked.
 *
 * ## One scroll, shared by every row
 *
 * The mockup lays this out as a table. On a phone that means labels stacked
 * above their values and the hostel columns scrolling sideways — otherwise the
 * reader loses which row they are on halfway across, which is the one thing a
 * comparison must not do.
 *
 * This file used to give **each of eleven rows its own `ScrollView`** while the
 * header claimed the opposite. Two 172dp columns already overflow a phone, so
 * that showed up at the minimum comparison size: scroll the rent row and the
 * names above it stayed put, leaving one hostel's rent beside another's rating.
 * A comparison that can be read out of alignment is worse than no comparison.
 *
 * So there is now exactly one horizontal `ScrollView`, wrapping the header
 * cells, every field row and the inquiry buttons together. The labels sit above
 * their own row inside it and travel with it — a pinned label column would need
 * a synchronised second scroller, and the labels are short enough that stacking
 * them costs less than that machinery would.
 *
 * ## Only the fields the server actually compares
 *
 * `comparePublicHostels` returns a `comparison` block per hostel — rent,
 * location, room types, vacancy, facilities, food score, rating, verification.
 * That is the comparison; anything else on the screen would be a field one
 * hostel filled in and another did not, which reads as a difference between
 * hostels rather than a difference in how much admin they did.
 */

const COLUMN_WIDTH = 172;

export type HostelCompareProps = {
  /** Where the empty state's "Browse hostels" button goes. */
  browseHref: string;
  insideTabs?: boolean;
  showBack?: boolean;
};

export function HostelCompare({
  browseHref,
  insideTabs = false,
  showBack = false,
}: HostelCompareProps) {
  const { ids } = useLocalSearchParams<{ ids?: string }>();
  const selected = (ids ?? "").split(",").map((id) => id.trim()).filter(Boolean);

  const query = publicQuery.compare(selected);
  const compared = useResource<ComparedHostel[]>(
    useCallback(
      () => (selected.length >= COMPARE_MIN ? query.load() : Promise.resolve([])),
      // eslint-disable-next-line react-hooks/exhaustive-deps -- the array identity changes every render; the joined string is the real key
      [ids, query],
    ),
    // Unkeyed below the minimum: the empty array is a placeholder for "pick one
    // more", not an answer about these hostels.
    {
      cacheKey: selected.length >= COMPARE_MIN ? query.key : undefined,
      topics: query.topics,
    },
  );

  const header = <AppBar showBack={showBack} title="Compare hostels" />;

  if (selected.length < COMPARE_MIN) {
    return (
      <Screen header={header} insideTabs={insideTabs}>
        <EmptyState icon="git-compare"
          action={
            <Button
              label="Browse hostels"
              // `navigate`, not `replace`: inside the tab group replacing the
              // Compare tab with the Search tab would leave the bar pointing at
              // a route that is no longer mounted.
              onPress={() => router.navigate(browseHref)}
              variant="outline"
            />
          }
          description={`Pick at least ${COMPARE_MIN} hostels from the browse list — tap the compare icon on each card.`}
          title="Nothing to compare yet"
        />
      </Screen>
    );
  }

  if (compared.loading) {
    return (
      <Screen header={header} insideTabs={insideTabs}>
        <View className="gap-4 pt-1">
          <SkeletonTiles columns={2} height={120} />
          <SkeletonText lines={6} />
        </View>
      </Screen>
    );
  }

  if (compared.error || !compared.data) {
    return (
      <Screen header={header} insideTabs={insideTabs}>
        <ErrorState
          message={compared.error ?? "That comparison could not be loaded."}
          onRetry={compared.reload}
        />
      </Screen>
    );
  }

  const hostels = compared.data;

  return (
    <Screen
      header={header}
      insideTabs={insideTabs}
      onRefresh={compared.refresh}
      padded={false}
      refreshing={compared.refreshing}
      scroll
    >
      <View className="gap-4">
        <Text className="px-5" variant="muted">
          Side by side, from what each hostel has published.
        </Text>

        {/*
          The one scroller. Everything that has to line up column-for-column
          lives inside it, so there is a single scroll position by construction
          rather than by keeping several in step.
        */}
        <ScrollView
          contentContainerClassName="px-5"
          horizontal
          showsHorizontalScrollIndicator={false}
        >
          <View>
            <View className="flex-row gap-3">
              {hostels.map((hostel) => (
                <HeadCell hostel={hostel} key={hostel.id} />
              ))}
            </View>

            <View className="gap-0 pt-4">
          <Row hostels={hostels} label="Monthly rent" value={(h) => priceRange(h.pricing)} />
          <Row hostels={hostels} label="Location" value={(h) => h.comparison.locationText || "—"} />
          <Row
            hostels={hostels}
            label="Room types"
            value={(h) => h.comparison.roomTypes.join(", ") || "—"}
          />
          <Row
            hostels={hostels}
            label="Vacant beds"
            // 0 is the answer that decides whether to bother visiting.
            value={(h) => String(h.comparison.vacancy)}
          />
          <Row
            hostels={hostels}
            label="Type"
            value={(h) => HOSTEL_TYPE_LABELS[h.hostelType]}
          />
          <Row
            hostels={hostels}
            label="Food"
            value={(h) =>
              [
                h.food.mealsPerDay ? `${h.food.mealsPerDay}/day` : null,
                h.food.hasVeg ? "Veg" : null,
                h.food.hasNonVeg ? "Non-veg" : null,
              ]
                .filter(Boolean)
                .join(" · ") || "—"
            }
          />
          <Row
            hostels={hostels}
            label="Facilities"
            value={(h) => h.comparison.facilities.join(", ") || "—"}
          />
          <Row
            hostels={hostels}
            label="Rating"
            value={(h) => {
              const rating = ratingDisplay(h.ratingSummary);

              return rating.kind === "new"
                ? "New"
                : `${rating.value} (${rating.count})`;
            }}
          />
          <Row
            hostels={hostels}
            label="Verified"
            value={(h) => (h.verificationStatus === "VERIFIED" ? "Yes" : "Not yet")}
          />
            </View>

            <View className="flex-row gap-3 pb-2 pt-4">
              {hostels.map((hostel) => (
                <View key={hostel.id} style={{ width: COLUMN_WIDTH }}>
                  <Button
                    label="Send inquiry"
                    onPress={() => router.push(`/hostel/${hostel.slug}/inquiry`)}
                    size="sm"
                  />
                </View>
              ))}
            </View>
          </View>
        </ScrollView>

        <Text className="px-5 pb-2" variant="caption">
          Information is published by each hostel and updated regularly.
        </Text>
      </View>
    </Screen>
  );
}

function HeadCell({ hostel }: { hostel: ComparedHostel }) {
  const { colors } = useAppTheme();
  const cover = coverPhoto(hostel.photos);
  // Stored relative; a phone has no origin to resolve against. See lib/media.ts.
  const coverUri = absoluteMediaUrl(cardPhotoUrl(cover), API_BASE_URL);
  const rating = ratingDisplay(hostel.ratingSummary);

  return (
    <Pressable
      accessibilityRole="button"
      className="overflow-hidden rounded-2xl border border-border bg-card active:opacity-80"
      onPress={() => router.push(`/hostel/${hostel.slug}`)}
      style={{ width: COLUMN_WIDTH }}
    >
      {coverUri ? (
        <Image
          cachePolicy="memory-disk"
          contentFit="cover"
          source={{ uri: coverUri }}
          style={{ backgroundColor: colors.muted, height: 96 }}
        />
      ) : (
        <View
          className="items-center justify-center"
          style={{ backgroundColor: colors.muted, height: 96 }}
        >
          <Glyph color={colors.mutedForeground} name="image" size={22} />
        </View>
      )}

      <View className="gap-1 p-2.5">
        <Text numberOfLines={2} variant="label">
          {hostel.name}
        </Text>
        {rating.kind === "rated" ? (
          <View className="flex-row items-center gap-1">
            <Glyph color={colors.warning} name="star" size={11} />
            <Text variant="caption">{`${rating.value} (${rating.count})`}</Text>
          </View>
        ) : (
          <Badge label="New" />
        )}
      </View>
    </Pressable>
  );
}

/**
 * One comparison row: a label, then the values, one per hostel column.
 *
 * No `ScrollView` of its own — it sits inside the single one above, which is
 * what keeps every row's columns under the same header. The label spans the full
 * width above its values rather than being pinned left, so it scrolls out of
 * view with them; the alternative is a second, synchronised scroller for the
 * label column, which is a lot of machinery for six short words.
 */
function Row({
  hostels,
  label,
  value,
}: {
  hostels: ComparedHostel[];
  label: string;
  value: (hostel: ComparedHostel) => string;
}) {
  return (
    <View className="border-b border-border py-3">
      <Text className="mb-1.5" variant="caption">
        {label}
      </Text>
      <View className="flex-row gap-3">
        {hostels.map((hostel) => (
          <View key={hostel.id} style={{ width: COLUMN_WIDTH }}>
            <Text variant="label">{value(hostel)}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}
