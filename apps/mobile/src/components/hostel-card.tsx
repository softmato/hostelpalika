import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import { router } from "expo-router";
import { Pressable, View } from "react-native";

import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { API_BASE_URL } from "@/lib/api";
import {
  campusDistanceLabel,
  coverPhoto,
  formatDistance,
  locationLabel,
  priceRange,
  ratingDisplay,
  vacancyLabel,
} from "@/lib/hostel-display";
import { absoluteMediaUrl } from "@/lib/media";
import { HOSTEL_TYPE_LABELS, type PublicHostel } from "@/lib/public-api";

/**
 * One hostel, as every discovery surface draws it.
 *
 * Three shapes, one component: `carousel` for a horizontally-scrolling row,
 * `list` for the full-width browse results, and `grid` for the two-column
 * "Nearby Hostels" block on the home screen. A second component per shape is how
 * they drift — the verified chip ends up in a different corner, and the price
 * loses its `/month` on one of them.
 *
 * ## What `grid` changes, and why
 *
 * It is half a screen wide, so roughly 150dp of text column. Two things do not
 * survive that width and are therefore drawn differently rather than squeezed:
 *
 * - **The badge is the hostel type, not "Verified".** At this size only one pill
 *   fits over the photo, and Boys/Girls is the thing being scanned for; the
 *   verified tick moves *inside* that pill, as it already does on the showcase.
 * - **Facilities lose their labels.** "Attached bathroom" beside three others is
 *   four wrapped lines here. They become a row of circled icons, which is the
 *   mockup's shape and is also the only one that fits four of them.
 *
 * Vacancy is dropped from this shape for the same reason — there is no line left
 * for it, and it is on the detail screen the card opens.
 *
 * ## Distance gets its own badge, and the badge is a button
 *
 * A `grid` card with a position reads `1.2 km away · Ghattekulo, Kathmandu` on
 * one `numberOfLines={1}` caption in a 174dp column — so the address was cut to
 * make room for the number, and the number itself sat in a line the eye reads as
 * "where this is", not "how far this is from you". The distance is now a pill on
 * the photograph and the caption is the address again. Both are legible, and the
 * one that changes when the reader walks down the street is the one that stands
 * out. It opens the map on that hostel with directions already running — the
 * number is the question, and the map is the answer to it.
 *
 * Nested inside the card's own `Pressable`, which is legal and does what it
 * looks like: the inner press wins, the outer one still covers everything else.
 * With `hitSlop` because the badge is small enough to read at a glance and too
 * small to aim at.
 *
 * ## The rating is the interesting part
 *
 * An unreviewed hostel shows **"New"**, not zero stars. Every average comes
 * back `0` for a hostel nobody has reviewed, so rendering the number would put
 * a one-star badge on every hostel that just joined — a visitor filters it out
 * and it never gets its first review. See `ratingDisplay`.
 */

/**
 * The Boys/Girls tag on the photo, in points.
 *
 * Exported because `HostelShowcase` draws the same pill, and the two sit one
 * above the other on the home screen — Top Picks over Nearby — where half a
 * point of difference between them reads as a mistake rather than a hierarchy.
 */
export const TYPE_TAG_SIZE = 7;

/**
 * Keyed by `facilityKey`, not by the label.
 *
 * `FACILITIES` in `lib/public-api.ts` is the list the filter sheet offers, but a
 * hostel's `facilities` array is **free text** — it is whatever the hostel admin
 * typed into the registration form. "Wi-Fi", "WIFI" and "Wifi" all arrive, and
 * an exact-match table gave every one of them the generic tick, so a card ended
 * up showing four identical circles instead of four different facilities.
 */
const FACILITY_ICONS: Record<string, keyof typeof Ionicons.glyphMap> = {
  ac: "snow-outline",
  airconditioning: "snow-outline",
  attachedbathroom: "water-outline",
  cctv: "videocam-outline",
  gym: "barbell-outline",
  hotwater: "thermometer-outline",
  kitchen: "restaurant-outline",
  laundry: "shirt-outline",
  meals: "restaurant-outline",
  parking: "car-outline",
  powerbackup: "flash-outline",
  security: "shield-checkmark-outline",
  studytable: "book-outline",
  water: "water-outline",
  wifi: "wifi-outline",
};

/** Case, spaces and punctuation all dropped: `Hot Water` and `hot-water` are one key. */
function facilityKey(facility: string): string {
  return facility.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function facilityIcon(facility: string): keyof typeof Ionicons.glyphMap {
  return FACILITY_ICONS[facilityKey(facility)] ?? "checkmark-circle-outline";
}

/**
 * The heart, shared by the cards and the home showcase so the two cannot end up
 * with different icons for the same state.
 *
 * Green when saved rather than red: the palette is white, black and one green
 * accent (docs/DESIGN.md), and a red heart is the only warm colour on the screen
 * — it reads as a warning next to a `destructive` token that means exactly that.
 *
 * No haptic here. `useSavedHostels().toggle` already fires one, and two on a
 * single tap is a stutter.
 */
export function SaveButton({
  hostel,
  onToggle,
  saved,
}: {
  hostel: PublicHostel;
  onToggle: (hostel: PublicHostel) => void;
  saved: boolean;
}) {
  const { colors } = useAppTheme();

  return (
    <Pressable
      accessibilityLabel={saved ? `Remove ${hostel.name} from saved` : `Save ${hostel.name}`}
      accessibilityRole="button"
      accessibilityState={{ selected: saved }}
      /*
        The disc is painted from `colors`, not `bg-card/95`. This heart sits on
        a photograph, so the disc is the only thing separating a grey outline
        from a grey roof — and an opacity modifier on a `var(--card)` colour is
        the one Tailwind form that can come out as no background at all, which
        is exactly how it rendered: a bare heart floating on the picture.
      */
      className="h-9 w-9 items-center justify-center rounded-full active:opacity-70"
      hitSlop={6}
      onPress={() => onToggle(hostel)}
      style={{ backgroundColor: colors.card }}
    >
      <Ionicons
        color={saved ? colors.primary : colors.mutedForeground}
        name={saved ? "heart" : "heart-outline"}
        size={18}
      />
    </Pressable>
  );
}

export function HostelCard({
  commute,
  distanceMeters,
  hostel,
  onToggleCompare,
  onToggleSave,
  saved = false,
  selectedForCompare = false,
  showCampusDistance = false,
  showVacancy = false,
  variant = "list",
}: {
  /** "12 min walk to IOE Pulchowk" — the reader's own place outranks a campus guess. */
  commute?: string | null;
  /**
   * Metres from the device, when the screen has a position and this hostel has
   * coordinates — see `lib/geo.ts`. `null`/absent means one of those is missing,
   * which is not the same as zero and must not render as "0 m away".
   */
  distanceMeters?: number | null;
  hostel: PublicHostel;
  /** Omitted on surfaces where comparing is not offered. */
  onToggleCompare?: (hostel: PublicHostel) => void;
  /** The heart. Omitted where saving makes no sense — inside Favourites itself. */
  onToggleSave?: (hostel: PublicHostel) => void;
  saved?: boolean;
  selectedForCompare?: boolean;
  /** Students search by campus, so the browse list leads with that distance. */
  showCampusDistance?: boolean;
  /**
   * Adds the free-bed count to a `grid` card.
   *
   * Off by default and on for exactly one row — the home screen's "Rooms
   * Available Now", where it is the claim the heading makes. Everywhere else the
   * line is dropped on purpose: it is the fastest-moving number on the card and
   * a stale "2 beds vacant" is worse than none.
   */
  showVacancy?: boolean;
  variant?: "carousel" | "grid" | "list";
}) {
  const { colors } = useAppTheme();

  const cover = coverPhoto(hostel.photos);
  /*
   * Photo URLs are stored relative (`/api/v1/files/…`) so one row works on
   * every web origin. A phone has no origin to resolve them against, so
   * without this the `<Image>` fails silently and every card is a grey box.
   * Branching on the *resolved* URL means an unresolvable photo falls through
   * to the placeholder below rather than rendering a broken image.
   */
  const coverUri = absoluteMediaUrl(cover?.url, API_BASE_URL);
  const rating = ratingDisplay(hostel.ratingSummary);
  const vacancy = vacancyLabel(hostel.capacitySummary);
  const campus = showCampusDistance ? campusDistanceLabel(hostel.nearbyPlaces) : null;
  const isCarousel = variant === "carousel";
  const isGrid = variant === "grid";
  const imageHeight = isGrid ? 118 : isCarousel ? 128 : 168;
  /*
   * Metres straight from `haversineMeters` — the device's own fix against this
   * hostel's coordinates, measured on the client because the server has no
   * geospatial query (see `lib/geo.ts`). `typeof`, not a truthiness check: a
   * hostel 30m up the road rounds to `0` at this precision, and `0 || …` would
   * hide the badge on the single nearest listing in the row.
   */
  const measured = typeof distanceMeters === "number";

  // Distance from *you* outranks distance from a campus: it is the thing the
  // user just asked for by tapping "Near me", and the campus line is a guess at
  // what they care about.
  const place = commute ?? campus ?? locationLabel(hostel.location);
  const subtitle =
    typeof distanceMeters === "number"
      ? `${formatDistance(distanceMeters)} away · ${place}`
      : place;

  return (
    <Pressable
      accessibilityRole="button"
      className={`overflow-hidden rounded-2xl border border-border bg-card active:opacity-80 ${
        isCarousel ? "w-64" : "w-full"
      }`}
      onPress={() => router.push(`/hostel/${hostel.slug}`)}
    >
      <View>
        {coverUri ? (
          <Image
            accessibilityLabel={cover?.alt || hostel.name}
            contentFit="cover"
            source={{ uri: coverUri }}
            style={{ backgroundColor: colors.muted, height: imageHeight }}
            transition={150}
          />
        ) : (
          <View
            className="items-center justify-center"
            style={{ backgroundColor: colors.muted, height: imageHeight }}
          >
            <Ionicons color={colors.mutedForeground} name="image-outline" size={28} />
          </View>
        )}

        {isGrid ? (
          /*
            Small, and quiet with it: this is a label on a photograph, not the
            headline of the card. At `px-2.5 py-1.5` and `text-[9px] semibold` it
            was a solid brand-coloured slab reading BOYS louder than the hostel's
            own name two lines below it — and it says the same word on most of
            the cards in the row, so it is the last thing on the picture that
            should be shouting.

            7px `font-medium` puts it under the 8px distance badge in the
            opposite corner, which is the right ranking: that badge is a number
            that differs per reader, this is a category that repeats.

            `uppercase` and `tracking-wide` are what make the size survivable,
            not decoration — capitals have no descenders to lose at 7px, and the
            letter-spacing is the difference between four small letters and a
            smudge. Lightening the weight without them would have been
            illegible.

            The size is an inline `style`, not `text-[7px]`. That class was the
            first version of this and it rendered *larger* than what it replaced:
            NativeWind compiles the class list at bundle time, and 7px appears
            nowhere else in the app, so the class resolved to nothing and the
            label fell back to the default body size. Same trap the wordmark in
            `discovery-header.tsx` hit, and the same answer — a measured
            dimension goes in `style`, where it cannot silently fail to exist.
          */
          <View className="absolute left-2.5 top-2.5 flex-row items-center gap-1 rounded-full bg-primary px-1.5 py-0.5">
            {hostel.verificationStatus === "VERIFIED" ? (
              <Ionicons
                color={colors.primaryForeground}
                name="shield-checkmark"
                size={8}
              />
            ) : null}
            <Text
              className="font-medium uppercase tracking-wide text-primary-foreground"
              style={{ fontSize: TYPE_TAG_SIZE }}
            >
              {HOSTEL_TYPE_LABELS[hostel.hostelType]}
            </Text>
          </View>
        ) : hostel.verificationStatus === "VERIFIED" ? (
          <View className="absolute left-3 top-3 flex-row items-center gap-1 rounded-full bg-card/95 px-2.5 py-1">
            <Ionicons color={colors.success} name="shield-checkmark" size={12} />
            <Text className="text-xs font-semibold">Verified</Text>
          </View>
        ) : null}

        {measured ? (
          // Bottom-left, which is the one corner of the photo nothing else uses:
          // the type pill has the top-left and the heart the top-right.
          <Pressable
            accessibilityHint="Opens a map of the route from you to this hostel"
            accessibilityLabel={`${formatDistance(distanceMeters as number)} away, show directions`}
            accessibilityRole="button"
            className="absolute bottom-1.5 left-2 flex-row items-center gap-0.5 rounded-full px-1 py-0.5 active:opacity-70"
            hitSlop={12}
            onPress={() => router.push(`/map?route=1&slug=${hostel.slug}`)}
            style={{ backgroundColor: colors.card }}
          >
            <Ionicons color={colors.primary} name="navigate" size={7} />
            {/* The number alone. "away" is the caption's job, and dropping it
                takes a third off a badge that sits on top of a photograph. */}
            <Text className="text-[8px] font-semibold text-foreground">
              {formatDistance(distanceMeters as number)}
            </Text>
          </Pressable>
        ) : null}

        {/* One row, so a card offering both actions cannot stack them on top of
            each other in the same corner. */}
        <View className="absolute right-3 top-3 flex-row gap-2">
          {onToggleCompare ? (
            <Pressable
              accessibilityLabel={
                selectedForCompare ? "Remove from compare" : "Add to compare"
              }
              accessibilityRole="button"
              accessibilityState={{ selected: selectedForCompare }}
              className="h-9 w-9 items-center justify-center rounded-full bg-card/95 active:opacity-70"
              hitSlop={6}
              onPress={() => {
                onToggleCompare(hostel);
              }}
            >
              <Ionicons
                color={selectedForCompare ? colors.primary : colors.mutedForeground}
                name={selectedForCompare ? "git-compare" : "git-compare-outline"}
                size={17}
              />
            </Pressable>
          ) : null}

          {onToggleSave ? (
            <SaveButton hostel={hostel} onToggle={onToggleSave} saved={saved} />
          ) : null}
        </View>
      </View>

      {isGrid ? (
        <View className="gap-1.5 p-3">
          <Text className="font-bold" numberOfLines={1} variant="label">
            {hostel.name}
          </Text>

          <View className="flex-row items-center gap-1">
            <Ionicons color={colors.mutedForeground} name="location-outline" size={11} />
            <Text className="flex-1" numberOfLines={1} variant="caption">
              {/* The badge above already carries the distance on this shape. */}
              {(measured ? place : subtitle) || "Location not published"}
            </Text>
          </View>

          {/* The soft brand pill the showcase card uses, so one hostel does not
              wear two different score badges on one screen. */}
          <View className="flex-row">
            <View
              className="flex-row items-center gap-1 rounded-lg px-2 py-0.5"
              style={{ backgroundColor: colors.brandSoft }}
            >
              {rating.kind === "rated" ? (
                <>
                  <Ionicons color={colors.primary} name="star" size={11} />
                  <Text className="text-xs font-bold">{rating.value}</Text>
                  <Text variant="caption">{`(${rating.count})`}</Text>
                </>
              ) : (
                <Text className="text-xs font-semibold">New</Text>
              )}
            </View>
          </View>

          {/* Wraps rather than truncating — see the showcase card for why a
              half-printed price is worse than a two-line one. */}
          <View className="flex-row flex-wrap items-baseline gap-1">
            <Text className="text-sm font-bold text-primary">
              {priceRange(hostel.pricing)}
            </Text>
            <Text variant="caption">/month</Text>
          </View>

          {showVacancy && vacancy ? (
            <View className="flex-row items-center gap-1">
              <Ionicons color={colors.primary} name="bed-outline" size={12} />
              <Text className="text-xs font-semibold text-primary">{vacancy}</Text>
            </View>
          ) : null}

          {/* Icons only — see the note at the top of the file for why the labels
              cannot come along at this width. The name is on the icon's own
              accessibility label, so a screen reader still reads them out. */}
          {hostel.facilities.length > 0 ? (
            <View className="mt-0.5 flex-row flex-wrap gap-1.5">
              {hostel.facilities.slice(0, 4).map((facility) => (
                <View
                  accessibilityLabel={facility}
                  className="h-7 w-7 items-center justify-center rounded-full border border-border"
                  key={facility}
                >
                  <Ionicons
                    color={colors.mutedForeground}
                    name={facilityIcon(facility)}
                    size={13}
                  />
                </View>
              ))}
            </View>
          ) : null}
        </View>
      ) : (
      <View className="gap-1.5 p-3">
        <View className="flex-row items-start gap-2">
          <Text className="flex-1" numberOfLines={1} variant="subtitle">
            {hostel.name}
          </Text>

          {rating.kind === "rated" ? (
            <View className="flex-row items-center gap-1">
              <Ionicons color={colors.warning} name="star" size={12} />
              <Text className="text-sm font-semibold">{rating.value}</Text>
              <Text variant="caption">{`(${rating.count})`}</Text>
            </View>
          ) : (
            /*
              "New", never "0 ★". A brand-new hostel shown as one star gets
              filtered out of every search and never earns its first review.
            */
            <View className="rounded-full bg-muted px-2 py-0.5">
              <Text variant="caption">New</Text>
            </View>
          )}
        </View>

        <Text numberOfLines={1} variant="caption">
          {subtitle}
        </Text>

        <View className="flex-row items-baseline gap-1">
          <Text className="font-semibold text-primary">{priceRange(hostel.pricing)}</Text>
          <Text variant="caption">/ month</Text>
        </View>

        <View className="mt-1 flex-row flex-wrap items-center gap-x-3 gap-y-1">
          {vacancy ? (
            <View className="flex-row items-center gap-1">
              <Ionicons color={colors.mutedForeground} name="bed-outline" size={12} />
              <Text variant="caption">{vacancy}</Text>
            </View>
          ) : null}

          {/* Two facilities, not ten: the card is a reason to tap, not a spec
              sheet, and a wrapped block of chips pushes the price out of view. */}
          {hostel.facilities.slice(0, 2).map((facility) => (
            <View className="flex-row items-center gap-1" key={facility}>
              <Ionicons
                color={colors.mutedForeground}
                name={facilityIcon(facility)}
                size={12}
              />
              <Text variant="caption">{facility}</Text>
            </View>
          ))}

          {hostel.food?.mealsPerDay ? (
            <View className="flex-row items-center gap-1">
              <Ionicons
                color={colors.mutedForeground}
                name="restaurant-outline"
                size={12}
              />
              <Text variant="caption">{`${hostel.food.mealsPerDay} meals`}</Text>
            </View>
          ) : null}
        </View>
      </View>
      )}
    </Pressable>
  );
}
