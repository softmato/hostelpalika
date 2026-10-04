import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useRef, useState } from "react";
import {
  Linking,
  Pressable,
  ScrollView,
  Share,
  useWindowDimensions,
  View,
} from "react-native";

import { facilityIcon } from "@/components/hostel-card";
import { HostelMap } from "@/components/hostel-map";
import { AppBar } from "@/components/ui/app-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, SectionHeader } from "@/components/ui/card";
import { Sheet } from "@/components/ui/sheet";
import { FactRow } from "@/components/ui/layout";
import { RowDivider } from "@/components/ui/list-row";
import { Screen } from "@/components/ui/screen";
import { Skeleton, SkeletonCard } from "@/components/ui/skeleton";
import { StackedThumb } from "@/components/ui/stacked-thumb";
import { ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useResource } from "@/hooks/use-resource";
import { API_BASE_URL } from "@/lib/api";
import { type BookingAvailability, getBookingAvailability } from "@/lib/booking-api";
import { bookState } from "@/lib/booking-button";
import { formatMoney } from "@/lib/format";
import { hostelCoordinates } from "@/lib/geo";
import {
  dayLabel,
  foodFacts,
  leadDay,
  routineDays,
  todayName,
  type RoutineDay,
} from "@/lib/hostel-food";
import { groupNearbyPlaces } from "@/lib/hostel-nearby";
import { buildHostelShare, hostelPublicUrl } from "@/lib/hostel-share";
import {
  campusDistanceLabel,
  formatDistance,
  locationLabel,
  priceRange,
  ratingDisplay,
} from "@/lib/hostel-display";
import { openAssetViewer } from "@/lib/asset-viewer";
import { absoluteMediaUrl } from "@/lib/media";
import {
  getPublicHostel,
  HOSTEL_TYPE_LABELS,
  type PublicHostelDetail,
} from "@/lib/public-api";

/**
 * One hostel's public profile (docs/mockups/mobile/README.md §4).
 *
 * ## Sections appear only when the hostel filled them in
 *
 * A published hostel can have no rules, no nearby places, no room
 * configurations and no food routine. The mockup draws all of them, so
 * rendering the frame unconditionally gives every sparse listing a column of
 * empty headings — which reads as the *app* being broken rather than the
 * listing being thin. Each block below is gated on having something to say.
 *
 * The exception is price and location, which are always shown: a listing
 * without them is not worth opening, and saying "—" is information.
 */
export default function HostelDetailScreen() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const { colors } = useAppTheme();

  const hostel = useResource<PublicHostelDetail>(
    useCallback(() => getPublicHostel(slug), [slug]),
    { cacheKey: `public-hostel:${slug}` },
  );
  // Every room's Book state in one call. A failed check draws no button; the checkout asks again.
  const availability = useResource<BookingAvailability>(
    useCallback(() => getBookingAvailability(slug), [slug]),
    { cacheKey: `booking-availability:${slug}` },
  );

  const data = hostel.data;

  /**
   * Hand the hostel to whatever the phone can share with.
   *
   * Every failure here is a dismissal. `Share.share` rejects when the user
   * swipes the sheet away on iOS, and reporting "could not share" for a decision
   * someone just made is the app arguing with them — same reasoning as the
   * community card's share.
   */
  const share = useCallback(async () => {
    if (!data) {
      return;
    }

    try {
      await Share.share({
        message: buildHostelShare({
          name: data.name,
          place: locationLabel(data.location),
          price: priceRange(data.pricing),
          url: hostelPublicUrl(API_BASE_URL, data.slug),
        }),
        title: data.name,
      });
    } catch {
      // Dismissing the sheet is not an error worth reporting.
    }
  }, [data]);

  /*
   * `centerTitle`, because the bar now has something on both sides of it and a
   * left-aligned name between a back arrow and a share button reads as neither
   * one thing nor the other. The action is only rendered once there is a hostel
   * to share — a share button over a loading spinner would post a blank message
   * naming nothing.
   */
  const header = (
    <AppBar
      actions={data ? <ShareButton onPress={() => void share()} /> : undefined}
      centerTitle
      showBack
      title={data?.name ?? "Hostel"}
    />
  );

  if (hostel.loading) {
    return (
      <Screen header={header} padded={false} scroll>
        <HostelDetailSkeleton />
      </Screen>
    );
  }

  if (hostel.error || !data) {
    return (
      <Screen header={header}>
        <ErrorState
          message={hostel.error ?? "This hostel could not be loaded."}
          onRetry={hostel.reload}
        />
      </Screen>
    );
  }

  const rating = ratingDisplay(data.ratingSummary);
  const campus = campusDistanceLabel(data.nearbyPlaces);
  const phone = data.contact.phone?.trim();

  return (
    <Screen
      footer={
        <View className="flex-row gap-3">
          {/* Only when there is a number. A dead "Call" button is worse than no
              call button — it fails after the tap, not before. */}
          {phone ? (
            <Button
              className="flex-1"
              label="Call hostel"
              onPress={() => void Linking.openURL(`tel:${phone}`)}
              variant="outline"
            />
          ) : null}
          <Button
            className="flex-1"
            label="Send inquiry"
            onPress={() => router.push(`/hostel/${slug}/inquiry`)}
          />
        </View>
      }
      header={header}
      onRefresh={hostel.refresh}
      padded={false}
      refreshing={hostel.refreshing}
      scroll
    >
      <Gallery hostel={data} />

      <View className="gap-6 px-5 pt-4">
        <View className="gap-4">
          <View className="gap-1.5">
            <View className="flex-row items-start gap-3">
              <Text className="flex-1" variant="title">
                {data.name}
              </Text>
              {rating.kind === "rated" ? (
                <View className="flex-row items-center gap-1 pt-1">
                  <Ionicons color={colors.warning} name="star" size={15} />
                  <Text className="font-semibold">{rating.value}</Text>
                  <Text variant="caption">{`(${rating.count})`}</Text>
                </View>
              ) : (
                <Badge label="New" />
              )}
            </View>

            <View className="flex-row items-center gap-1.5">
              <Ionicons
                color={colors.mutedForeground}
                name="location-outline"
                size={14}
              />
              <Text className="flex-1" variant="caption">
                {[data.location.address, locationLabel(data.location)]
                  .filter(Boolean)
                  .join(", ")}
              </Text>
            </View>

            {data.otherBranches?.length ? <Badge label={`${data.otherBranches.length} other ${data.otherBranches.length === 1 ? "branch" : "branches"}`} /> : null}

            {campus ? (
              <View className="flex-row items-center gap-1.5">
                <Ionicons
                  color={colors.mutedForeground}
                  name="school-outline"
                  size={14}
                />
                <Text variant="caption">{campus}</Text>
              </View>
            ) : null}
          </View>

          <KeyFacts hostel={data} />
        </View>

        {/*
          Chips, not the mockup's icon tiles with a sub-label under each. The
          sub-labels there — "High Speed" under Wi-Fi, "24/7 Security" under
          CCTV — are drawn from nothing: `facilities` is a `string[]`, and the
          only honest caption would be blank. A grid of tiles with empty second
          lines reads as data that failed to load.
        */}
        {data.facilities.length > 0 ? (
          <View>
            <SectionHeader title="Facilities" />
            <View className="flex-row flex-wrap gap-2">
              {data.facilities.map((facility) => (
                <View
                  className="flex-row items-center gap-1.5 rounded-xl border border-border px-3 py-2"
                  key={facility}
                >
                  <Ionicons
                    color={colors.primary}
                    name={facilityIcon(facility)}
                    size={15}
                  />
                  <Text variant="caption">{facility}</Text>
                </View>
              ))}
            </View>
          </View>
        ) : null}

        <RoomTypes availability={availability.data ?? null} hostel={data} />

        <FoodBlock hostel={data} />

        {data.description ? (
          <View>
            <SectionHeader title="About" />
            <Card>
              <Text variant="muted">{data.description}</Text>
            </Card>
          </View>
        ) : null}

        {data.rules.length > 0 ? (
          <View>
            <SectionHeader title="House rules" />
            <Card>
              {data.rules.map((rule, index) => (
                <View key={rule}>
                  {index > 0 ? <RowDivider /> : null}
                  <View className="flex-row items-start gap-2 py-2.5">
                    <Ionicons
                      color={colors.mutedForeground}
                      name="ellipse"
                      size={6}
                      style={{ marginTop: 7 }}
                    />
                    <Text className="flex-1" variant="muted">
                      {rule}
                    </Text>
                  </View>
                </View>
              ))}
            </Card>
          </View>
        ) : null}

        {data.otherBranches?.length ? (
          <View className="gap-3">
            <SectionHeader title="Other branches" subtitle="More locations from the same hostel owner" />
            {data.otherBranches.map((branch) => (
              <Pressable key={branch.id} accessibilityRole="link" accessibilityLabel={`View ${branch.name}`} onPress={() => router.push({ pathname: "/hostel/[slug]", params: { slug: branch.slug } })} className="flex-row items-center gap-3 rounded-2xl border border-border bg-card p-3 active:bg-muted">
                {branch.photoUrl ? <Image source={{ uri: branch.photoUrl.startsWith("/") ? `${API_BASE_URL}${branch.photoUrl}` : branch.photoUrl }} style={{ width: 72, height: 72, borderRadius: 12 }} contentFit="cover" accessibilityLabel={branch.name} /> : <View className="h-[72px] w-[72px] items-center justify-center rounded-xl bg-muted"><Ionicons name="business-outline" size={26} color={colors.mutedForeground} /></View>}
                <View className="flex-1 gap-1">
                  <Text variant="label">{branch.name}</Text>
                  <Text variant="caption">{[branch.area, branch.city].filter(Boolean).join(", ")}</Text>
                  <Text className="font-semibold text-primary" variant="caption">View branch</Text>
                </View>
                <Ionicons name="chevron-forward" size={18} color={colors.mutedForeground} />
              </Pressable>
            ))}
          </View>
        ) : null}

        <LocationBlock hostel={data} />

        <HostelFacts hostel={data} />
      </View>
    </Screen>
  );
}

/** Horizontal gallery with a counter — the server already sorts exterior-first. */
function Gallery({ hostel }: { hostel: PublicHostelDetail }) {
  const { colors } = useAppTheme();
  /*
   * The page width, which is the whole point.
   *
   * These images were a hardcoded `width: 400` inside a `pagingEnabled`
   * ScrollView — and paging snaps to the **viewport**, not to the child. So on
   * a 393dp phone every swipe left a 7dp sliver of the next photo, drifting
   * further out of alignment with each page; on a 430dp phone it stopped 30dp
   * short. It only looked right on a device exactly 400dp wide, and nobody has
   * one. Reading the real width also follows a rotation for free.
   */
  const { width } = useWindowDimensions();
  const scrollRef = useRef<ScrollView>(null);
  const [index, setIndex] = useState(0);
  /*
   * Resolved against the API origin before anything is drawn: the stored URLs
   * are relative, and a phone has no page origin to resolve them against (see
   * lib/media.ts). Filtering on the resolved value also drops a photo row whose
   * URL is blank, which the gallery would otherwise render as a grey panel the
   * user can swipe to.
   */
  const photos = hostel.photos
    .map((photo) => ({
      ...photo,
      uri: absoluteMediaUrl(photo.url, API_BASE_URL),
    }))
    .filter(
      (photo): photo is typeof photo & { uri: string } => photo.uri !== null,
    );

  if (photos.length === 0) {
    return (
      <View
        className="items-center justify-center"
        style={{ backgroundColor: colors.muted, height: 240 }}
      >
        <Ionicons
          color={colors.mutedForeground}
          name="image-outline"
          size={32}
        />
        <Text variant="caption">No photos yet</Text>
      </View>
    );
  }

  return (
    <View>
      <View>
        <ScrollView
          horizontal
          onMomentumScrollEnd={(event) => {
            const page = event.nativeEvent.layoutMeasurement.width;

            setIndex(
              page > 0
                ? Math.round(event.nativeEvent.contentOffset.x / page)
                : 0,
            );
          }}
          pagingEnabled
          ref={scrollRef}
          showsHorizontalScrollIndicator={false}
        >
          {photos.map((photo, photoIndex) => (
            <Pressable
              accessibilityLabel={photo.alt || hostel.name}
              accessibilityRole="imagebutton"
              key={photo.uri}
              /*
               * The carousel is 240dp of a building. Opening it full-screen is
               * the difference between "there is a photo" and being able to see
               * the room — and it is the first thing anyone tries on a gallery.
               */
              onPress={() =>
                openAssetViewer(
                  photos.map((item) => ({
                    caption: item.alt || undefined,
                    title: hostel.name,
                    url: item.uri,
                  })),
                  photoIndex,
                )
              }
            >
              <Image
                contentFit="cover"
                source={{ uri: photo.uri }}
                style={{ backgroundColor: colors.muted, height: 240, width }}
                transition={150}
              />
            </Pressable>
          ))}
        </ScrollView>

        {hostel.verificationStatus === "VERIFIED" ? (
          <View className="absolute left-5 top-3 flex-row items-center gap-1 rounded-full bg-card/95 px-2.5 py-1">
            <Ionicons
              color={colors.success}
              name="shield-checkmark"
              size={12}
            />
            <Text className="text-xs font-semibold">Verified hostel</Text>
          </View>
        ) : null}

        {photos.length > 1 ? (
          <View className="absolute bottom-3 right-5 rounded-full bg-black/60 px-2.5 py-1">
            <Text className="text-xs font-semibold text-white">
              {`${index + 1}/${photos.length}`}
            </Text>
          </View>
        ) : null}
      </View>

      {photos.length > 1 ? (
        <Thumbnails
          active={index}
          onSelect={(next) => {
            // Drives the carousel rather than opening the viewer: the strip is
            // navigation within the hero, and a tap that jumped straight to
            // full-screen would leave no way to browse in place.
            setIndex(next);
            scrollRef.current?.scrollTo({ animated: true, x: next * width });
          }}
          photos={photos}
        />
      ) : null}
    </View>
  );
}

/**
 * The mockup's thumbnail strip, under the hero.
 *
 * Twelve photos behind a swipe is twelve swipes to find the bathroom. The strip
 * is how someone gets to the one they want, and it doubles as the honest count
 * of what the hostel has actually uploaded — a hostel with three photos looks
 * like a hostel with three photos.
 *
 * Only drawn past two, because a strip under a single photo is a control with
 * nowhere to go.
 */
function Thumbnails({
  active,
  onSelect,
  photos,
}: {
  active: number;
  onSelect: (index: number) => void;
  photos: { alt?: string; uri: string }[];
}) {
  const { colors } = useAppTheme();

  return (
    <ScrollView
      className="mt-2"
      contentContainerClassName="gap-2 px-5"
      horizontal
      showsHorizontalScrollIndicator={false}
    >
      {photos.map((photo, photoIndex) => (
        <Pressable
          accessibilityLabel={`Photo ${photoIndex + 1}`}
          accessibilityRole="imagebutton"
          accessibilityState={{ selected: photoIndex === active }}
          key={photo.uri}
          onPress={() => onSelect(photoIndex)}
        >
          <Image
            contentFit="cover"
            source={{ uri: photo.uri }}
            style={{
              backgroundColor: colors.muted,
              borderColor:
                photoIndex === active ? colors.primary : "transparent",
              borderRadius: 10,
              borderWidth: 2,
              height: 52,
              width: 68,
            }}
          />
        </Pressable>
      ))}
    </ScrollView>
  );
}

/**
 * The money and the type as one ruled strip — no boxes.
 *
 * Two columns: rent with admission under it (both are what it costs), and the
 * hostel type beside them. Only the fees the platform stores — `pricing` has no
 * security deposit, so there is no deposit line to invent.
 */
function KeyFacts({ hostel }: { hostel: PublicHostelDetail }) {
  const admission = hostel.pricing.admissionFee;

  return (
    <View className="flex-row border-y border-border py-3.5">
      {/* Inline flex/padding: the arbitrary `flex-[n]` class did not apply and
          the columns sized to their text and ran into each other. */}
      <View style={{ flexBasis: 0, flexGrow: 1.6, gap: 12, minWidth: 0, paddingRight: 16 }}>
        <Fact accent label="Monthly rent" value={priceRange(hostel.pricing)} />
        {admission ? <Fact label="Admission fee" value={formatMoney(admission)} /> : null}
      </View>

      <View
        className="border-l border-border"
        style={{ flexBasis: 0, flexGrow: 1, minWidth: 0, paddingLeft: 16 }}
      >
        <Fact label="Type" value={HOSTEL_TYPE_LABELS[hostel.hostelType]} />
      </View>
    </View>
  );
}

function Fact({
  accent = false,
  label,
  value,
}: {
  accent?: boolean;
  label: string;
  value: string;
}) {
  return (
    <View className="gap-1">
      <Text variant="caption">{label}</Text>
      <Text
        className={`font-semibold ${accent ? "text-primary" : "text-foreground"}`}
        numberOfLines={2}
      >
        {value}
      </Text>
    </View>
  );
}

/** The detail screen's shape while it loads: gallery, title, facts, a card. */
function HostelDetailSkeleton() {
  return (
    <View>
      <Skeleton height={240} radius={0} />
      <View className="gap-6 px-5 pt-4">
        <View className="gap-4">
          <View className="gap-2">
            <Skeleton height={22} width="65%" />
            <Skeleton height={12} width="85%" />
          </View>
          <View className="flex-row border-y border-border py-3.5">
            <View style={{ flexBasis: 0, flexGrow: 1.6, gap: 12, paddingRight: 16 }}>
              {[0, 1].map((row) => (
                <View className="gap-1.5" key={row}>
                  <Skeleton height={10} width="40%" />
                  <Skeleton height={14} width="75%" />
                </View>
              ))}
            </View>
            <View
              className="gap-1.5 border-l border-border"
              style={{ flexBasis: 0, flexGrow: 1, paddingLeft: 16 }}
            >
              <Skeleton height={10} width="40%" />
              <Skeleton height={14} width="70%" />
            </View>
          </View>
        </View>
        <View className="flex-row flex-wrap gap-2">
          {[72, 96, 64, 88, 80].map((width, index) => (
            <Skeleton height={34} key={index} radius={12} width={width} />
          ))}
        </View>
        <SkeletonCard rows={3} />
      </View>
    </View>
  );
}

/**
 * What each kind of room costs and how many beds are left in it.
 *
 * Every hostel submits this at registration — rent, beds per room, how many
 * rooms of that kind, vacancy, whether meals are in the price — and until now
 * none of it reached a phone. The rent at the top of the screen is a range
 * across all of them, which answers "can I afford this hostel" and not "what am
 * I actually being offered".
 *
 * A card per room type rather than the website's four-across grid: a phone has
 * one column, and a room type with its facts stacked under it is the shape that
 * survives the narrowest screen we support.
 */
/** A room card's Book button, or the word that stands in for it. */
function RoomBook({
  availability,
  roomType,
  slug,
}: {
  availability: BookingAvailability | null;
  roomType: string;
  slug: string;
}) {
  const state = bookState(availability, roomType);

  if (state.kind === "hidden") {
    return null;
  }

  if (state.kind !== "book") {
    return (
      <View className="mt-3 flex-row">
        <Badge label={state.kind === "full" ? "Full" : "Not taking bookings"} tone="neutral" />
      </View>
    );
  }

  return (
    <Button
      className="mt-3"
      label={state.fee ? `Book · ${formatMoney(state.fee)} fee` : "Book"}
      onPress={() => router.push({ params: { room: roomType, slug }, pathname: "/book/[slug]" })}
    />
  );
}

function RoomTypes({
  availability,
  hostel,
}: {
  availability: BookingAvailability | null;
  hostel: PublicHostelDetail;
}) {
  if (hostel.roomConfigurations.length === 0) {
    return null;
  }

  return (
    <View>
      <SectionHeader
        subtitle={
          hostel.pricing.admissionFee
            ? `Admission fee ${formatMoney(hostel.pricing.admissionFee)}, once`
            : undefined
        }
        title="Rooms & pricing"
      />
      <View className="gap-3">
        {hostel.roomConfigurations.map((room) => {
          /*
           * A room shows its own shots only. Falling back to the hostel's
           * exterior would put the same building photo on every room type and
           * quietly claim it is a picture of that room.
           */
          const photos = hostel.photos
            .filter(
              (photo) => photo.kind === "ROOM" && photo.roomType === room.roomType,
            )
            .map((photo) => absoluteMediaUrl(photo.url, API_BASE_URL))
            .filter((url): url is string => Boolean(url));

          const facts = [
            room.monthlyRent > 0
              ? { label: "Monthly rent", value: formatMoney(room.monthlyRent) }
              : null,
            room.bedsPerRoom
              ? { label: "Beds per room", value: String(room.bedsPerRoom) }
              : null,
            room.rooms
              ? { label: "Rooms of this type", value: String(room.rooms) }
              : null,
            { label: "Vacant beds", value: String(room.vacantBeds) },
            room.mealInclusion ? { label: "Meals", value: room.mealInclusion } : null,
          ].filter((fact): fact is { label: string; value: string } => fact !== null);

          return (
            <Card key={room.roomType}>
              <View className="flex-row items-center gap-3">
                {photos[0] ? (
                  <Pressable
                    accessibilityLabel={`${room.roomType} photos`}
                    accessibilityRole="imagebutton"
                    onPress={() =>
                      openAssetViewer(
                        photos.map((url) => ({ title: room.roomType, url })),
                        0,
                      )
                    }
                  >
                    <StackedThumb photos={photos} />
                  </Pressable>
                ) : null}
                <Text className="flex-1 text-base font-semibold text-foreground">
                  {room.roomType}
                </Text>
              </View>
              <View className="mt-1">
                {facts.map((fact, index) => (
                  <View key={fact.label}>
                    {index > 0 ? <RowDivider /> : null}
                    <FactRow label={fact.label} value={fact.value} />
                  </View>
                ))}
              </View>
              <RoomBook availability={availability} roomType={room.roomType} slug={hostel.slug} />
            </Card>
          );
        })}
      </View>
    </View>
  );
}

/**
 * The kitchen's week.
 *
 * The website prints all seven days as a table. A phone cannot, and seven
 * stacked day cards would be twenty-eight rows in the middle of a listing
 * somebody is skimming — so the screen shows **today**, which is the day a
 * visitor can verify by turning up, and the rest of the week opens in a sheet.
 * That is this app's own vocabulary for overflow, and it keeps the listing
 * readable without hiding anything.
 */
function FoodBlock({ hostel }: { hostel: PublicHostelDetail }) {
  const [weekOpen, setWeekOpen] = useState(false);

  const facts = foodFacts(hostel.food);
  const days = routineDays(hostel.foodRoutine);

  if (facts.length === 0 && days.length === 0) {
    return null;
  }

  const today = todayName();
  const shown = leadDay(days, today);
  const monthEnd = hostel.foodRoutine.monthEndSpecial;

  return (
    <View>
      <SectionHeader title="Food" />
      {facts.length > 0 ? (
        <View className="mb-3 flex-row flex-wrap gap-2">
          {facts.map((fact) => (
            <Badge key={fact} label={fact} tone="neutral" />
          ))}
        </View>
      ) : null}

      {shown ? (
        <>
          <DayMeals day={shown} today={today} />
          {days.length > 1 ? (
            <Button
              className="mt-3"
              label="The whole week"
              onPress={() => setWeekOpen(true)}
              variant="outline"
            />
          ) : null}
        </>
      ) : null}

      {monthEnd ? (
        <View className="mt-3">
          <Text className="mb-1.5" variant="label">
            Last day of every month
          </Text>
          <Card>
            <Text className="font-semibold text-foreground">
              {monthEnd.items.join(", ")}
            </Text>
            {monthEnd.note ? <Text variant="caption">{monthEnd.note}</Text> : null}
          </Card>
        </View>
      ) : null}

      <Sheet onClose={() => setWeekOpen(false)} open={weekOpen} tall title="The week">
        <View className="gap-4 pb-2">
          {days.map((row) => (
            <DayMeals day={row} key={row.day} today={today} />
          ))}
        </View>
      </Sheet>
    </View>
  );
}

/** One day's meals, with the day heading outside the card as lists do here. */
function DayMeals({ day, today }: { day: RoutineDay; today: string }) {
  return (
    <View>
      <Text className="mb-1.5" variant="label">
        {day.day === today ? `Today · ${dayLabel(day.day)}` : dayLabel(day.day)}
      </Text>
      <Card>
        {day.meals.map((meal, index) => (
          <View key={meal.type}>
            {index > 0 ? <RowDivider /> : null}
            <FactRow
              label={meal.timing ? `${meal.label} · ${meal.timing}` : meal.label}
              value={meal.items.join(", ")}
            />
          </View>
        ))}
      </Card>
    </View>
  );
}

function HostelFacts({ hostel }: { hostel: PublicHostelDetail }) {
  const { capacitySummary } = hostel;
  const facts = [
    { label: "Hostel type", value: HOSTEL_TYPE_LABELS[hostel.hostelType] },
    capacitySummary.totalRooms
      ? { label: "Total rooms", value: String(capacitySummary.totalRooms) }
      : null,
    capacitySummary.totalBeds
      ? { label: "Total beds", value: String(capacitySummary.totalBeds) }
      : null,
    capacitySummary.vacantBeds === undefined
      ? null
      : { label: "Vacant beds", value: String(capacitySummary.vacantBeds) },
  ].filter((fact): fact is { label: string; value: string } => fact !== null);

  return (
    <View>
      <SectionHeader title="Hostel information" />
      <Card>
        {facts.map((fact, index) => (
          <View key={fact.label}>
            {index > 0 ? <RowDivider /> : null}
            <FactRow label={fact.label} value={fact.value} />
          </View>
        ))}
      </Card>
    </View>
  );
}

/**
 * Location — the map, a way to walk there, and what is around it.
 *
 * ## The web's Location panel, in one column
 *
 * On the website this is a two-column section: the map on the left, the nearby
 * places grouped down the right. A phone has one column, so the map comes first
 * and the groups follow it — which is also the order the information is wanted
 * in, because the map answers "where" and the list answers "how far from what".
 *
 * ## What replaced the flat list of eight
 *
 * This screen used to end in eight nearest places, mixed together, sorted by
 * distance. That reads as trivia: a pharmacy at 200 m and a park at 210 m sit
 * next to each other and neither tells you whether there is a campus nearby —
 * which for most of the people reading this page is the only question. Grouping
 * by category (the website's own order and labels, ported in
 * `lib/hostel-nearby.ts`) makes the answer a heading rather than something to
 * be found by scanning.
 *
 * ## The map is drawn only when the hostel has been placed on one
 *
 * `coordinates` is null until the hostel admin saves an address the geocoder can
 * resolve. An empty map is a grey rectangle that looks like a failed image, so
 * the address stands alone instead — and says why, in the website's own words.
 */
function LocationBlock({ hostel }: { hostel: PublicHostelDetail }) {
  const { colors } = useAppTheme();

  const point = hostelCoordinates(hostel);
  const groups = groupNearbyPlaces(hostel.nearbyPlaces);
  const address = [hostel.location.address, locationLabel(hostel.location)]
    .filter(Boolean)
    .join(", ");

  return (
    <View>
      <SectionHeader subtitle={address} title="Location" />

      <View className="gap-3">
        {point ? (
          <>
            {/*
              `preview`, because this screen scrolls.

              A pannable Leaflet map inside a vertical `ScrollView` puts two pan
              gestures on the same pixels — the rule `HostelMap` states in its own
              header, and the reason browse switches `<Screen scroll>` off for its
              map view. A fixed height does not avoid it; it makes it worse, since
              someone scrolling past a 220dp map drags the map instead of the
              page. So this one is a picture, and the tap goes to a screen that
              owns its gestures.

              `onSelect` is deliberately absent too: there is one pin and it is
              this hostel, so a "View hostel" link would navigate to the screen it
              was tapped on.
            */}
            <HostelMap
              height={220}
              hostels={[hostel]}
              me={null}
              nearby={hostel.nearbyPlaces}
              onPress={() => router.push(`/directions/${hostel.slug}`)}
              preview
            />

            {/*
              Directions is the action a map creates the appetite for, and the
              screen for it already exists (`/directions/[slug]`, task §7.4). Not
              a handoff to Google Maps: that screen draws the same OSM tiles with
              live turn-by-turn, and it works for someone with no maps app set up.
            */}
            <Button
              label="Get directions"
              onPress={() => router.push(`/directions/${hostel.slug}`)}
              variant="outline"
            />
          </>
        ) : (
          <Card className="items-center gap-2 py-6">
            <Ionicons color={colors.primary} name="map-outline" size={28} />
            <Text className="text-center" variant="label">
              {address || "Address not published"}
            </Text>
            <Text className="text-center" variant="caption">
              The exact location appears once the hostel saves an address.
            </Text>
          </Card>
        )}

        {groups.length > 0 ? (
          <Card className="gap-4">
            <Text variant="label">What&apos;s nearby</Text>

            {groups.map((group) => (
              <View className="gap-1.5" key={group.type}>
                <View className="flex-row items-center gap-2">
                  <Ionicons
                    color={colors.primary}
                    name={group.icon as keyof typeof Ionicons.glyphMap}
                    size={15}
                  />
                  <Text className="flex-1" variant="label">
                    {group.label}
                  </Text>
                  <Text variant="caption">{String(group.places.length)}</Text>
                </View>

                {/* Three per group, like the web. A hostel in Kathmandu can have
                    a dozen restaurants inside 500 m and listing all of them buries
                    the campus two groups down. */}
                {group.places.slice(0, 3).map((place) => (
                  <View
                    className="flex-row items-baseline gap-2 pl-6"
                    key={`${place.name}-${place.distance}`}
                  >
                    <Text className="flex-1" numberOfLines={1} variant="muted">
                      {place.name}
                    </Text>
                    <Text variant="caption">{formatDistance(place.distance)}</Text>
                  </View>
                ))}
              </View>
            ))}
          </Card>
        ) : null}
      </View>
    </View>
  );
}

/** The bar's right-hand slot. One control, which is what `centerTitle` allows. */
function ShareButton({ onPress }: { onPress: () => void }) {
  const { colors } = useAppTheme();

  return (
    <Pressable
      accessibilityLabel="Share this hostel"
      accessibilityRole="button"
      hitSlop={12}
      onPress={onPress}
    >
      <Ionicons color={colors.foreground} name="share-social-outline" size={22} />
    </Pressable>
  );
}
