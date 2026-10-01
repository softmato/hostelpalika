import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import { router } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, useWindowDimensions, View } from "react-native";

import { DiscoveryHeader } from "@/components/discovery-header";
import { HostelCard } from "@/components/hostel-card";
import { HostelShowcase } from "@/components/hostel-showcase";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { CardRow } from "@/components/ui/list-row";
import { Screen } from "@/components/ui/screen";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useAppSelector } from "@/hooks/redux";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useNearby } from "@/hooks/use-nearby";
import { useResource } from "@/hooks/use-resource";
import { useSavedHostels } from "@/hooks/use-saved";
import { API_BASE_URL } from "@/lib/api";
import { cityImageUrl } from "@/lib/city-images";
import { sortByDistance } from "@/lib/geo";
import {
  type CitySummary,
  featuredCities,
  showcaseHostels,
  topRatedHostels,
  withVacantBeds,
} from "@/lib/home-sections";
import { locationLabel } from "@/lib/hostel-display";
import { absoluteMediaUrl } from "@/lib/media";
import type { MyJoinRequest } from "@/lib/join-api";
import type { PublicHostel } from "@/lib/public-api";
import { publicQuery } from "@/lib/public-queries";
import type { SavedHostel } from "@/lib/saved-hostels";
import type { MobileSiteConfig } from "@/lib/site-config-api";

/**
 * The public home — the app's landing page, signed in or out.
 *
 * ## Why this is a component and not just a screen
 *
 * It was two: `(public)`, a signed-out stack with a floating Log in pill, and
 * `(browse)`, the tabs an account got. The pill is gone and so is the group —
 * one shell renders for everyone now (see `constants/roles.ts`), and this
 * component is what both used to share. It stays a component because `browseHref`
 * still differs between the tab that owns Search and any future caller that has
 * to push it.
 *
 * **The Log in pill is what this screen lost.** It hovered over the home screen
 * of someone who had opened the app to look at hostels and had no account to
 * sign in with, and it asked for the one thing a new user does not have before
 * showing them anything. Signing in is now a card at the top of the Profile tab,
 * which is where someone goes when they want their account.
 *
 * ## The screen is the discovery mockup, section for section
 *
 * Header, search, **Top Picks For You**, **Popular Cities**, **Nearby
 * Hostels**. That is the mockup's page and that is its order, and the screen
 * follows it top to bottom.
 *
 * One row comes after it, below everything the design draws: **Top Rated**,
 * which is the only row on the screen an unreviewed hostel cannot appear in —
 * see `topRatedHostels` for why that makes it a section rather than a seventh
 * way to shuffle the same sixty listings.
 *
 * Three things in the mockup are deliberately absent:
 *
 * - **The quick filter row** — All · Boys · Girls · Wi-Fi · Food · More, six
 *   tiles that never filtered this screen; each one pushed the browse screen
 *   with a query string, which is what the search field above them does and
 *   what the filter button beside it does properly, with every type, facility,
 *   room type and budget band rather than four of them. It cost the first
 *   screenful of a screen whose job is showing hostels.
 * - **"Why students trust …"** — four hard-coded claims with nothing behind
 *   them. `Verified` is already a chip on every card that earns it, which is the
 *   same claim made where it can be checked.
 * - **Its tab bar** — this app's tabs come from `(browse)/_layout.tsx`.
 *
 * ## What this replaced
 *
 * Six carousels: Popular right now, Premium hostels, Newly listed, Browse by
 * city as a chip row, Browse by facility, and a map. All six were slices of the
 * same 60-row payload under different headings — a reader scrolling the page met
 * the same hostels three times and learned that the headings did not mean
 * anything. Top Picks is now the one ranked row, the cities row got photographs
 * instead of chips, and the map lives on the browse screen, which has the whole
 * result set behind it rather than a six-row slice.
 *
 * **Saved survives, and only when it has something in it.** It is the one row
 * here that is not a slice of the payload — it is the device's own shortlist,
 * written by the heart on every card, and the Profile tab links to it. On a
 * fresh install it renders nothing, so the mockup's page is exactly what a new
 * user sees.
 */

/** Enough to be worth a row; more than this and the cards stop being scannable. */
const MAX_CITIES = 8;

/** `Screen`'s `px-5` on both sides. Cards are inset from the page, not full-bleed. */
const PAGE_INSET = 40;

/** The gap between cards in every horizontal row on this screen. */
const ROW_GAP = 12;

/**
 * How much of the page a hostel card takes in those rows.
 *
 * Two cards filling the row exactly is the mockup's proportion, and it was the
 * first thing tried — but a card at half a 360dp screen is 154dp wide, and that
 * is the width at which the name truncates, the price gives up its `/month` and
 * the four facility circles wrap. At 62% the card is 174dp, everything on it
 * fits, and the second card is cut by the screen edge, which is the clearest
 * possible statement that the row scrolls.
 */
const CARD_WIDTH_RATIO = 0.62;

export type PublicHomeProps = {
  /**
   * Where "View all", the search field and the quick filters go. The browse
   * tabs switch to their own `search` tab rather than pushing `/hostels`,
   * because pushing a root-stack screen from inside a tab navigator leaves the
   * tab bar behind.
   */
  browseHref: string;
  insideTabs?: boolean;
};

/**
 * A join request this person sent and the hostel has not added yet. Without
 * it, checking on the request — or fixing one that was sent back — meant
 * finding the WhatsApp link again. Signed out, or nothing open: nothing drawn.
 */
function MyJoinRequestRow() {
  const account = useAppSelector((state) => state.auth.account);

  return account ? <MyJoinRequestFor userId={account.id} /> : null;
}

function MyJoinRequestFor({ userId }: { userId: string }) {
  const query = publicQuery.myJoinRequest(userId);
  const mine = useResource<MyJoinRequest>(query.load, { cacheKey: query.key, topics: query.topics });
  const request = mine.data?.request;

  if (!request) return null;

  const returned = request.status === "REJECTED";

  return (
    <CardRow
      icon={returned ? "alert-circle-outline" : "time-outline"}
      onPress={() => router.push(`/join/${request.token}`)}
      subtitle={
        returned
          ? `${request.reason || "Something needs fixing"} · Fix it and send again`
          : "Waiting for the hostel to check it"
      }
      title={
        returned
          ? `${request.hostelName} sent your request back`
          : `Request sent to ${request.hostelName}`
      }
      tone={returned ? "warning" : "neutral"}
    />
  );
}

export function PublicHome({ browseHref, insideTabs = false }: PublicHomeProps) {
  const [query, setQuery] = useState("");
  /*
   * The row locates itself — see `useNearby`. Silently when permission is
   * already granted, with one dialogue on an install that has never seen it,
   * and never again after a refusal.
   */
  const nearby = useNearby({ auto: true });
  const saved = useSavedHostels();

  const hostelsQuery = publicQuery.hostels();
  const hostels = useResource<PublicHostel[]>(hostelsQuery.load, {
    cacheKey: hostelsQuery.key,
    topics: hostelsQuery.topics,
  });

  /*
   * Its own request, and a failure here is not an error state. The cities row is
   * one section of a screen whose other four render from the listing payload —
   * if `/public/site-config` is slow or down, `featuredCities` falls back to the
   * cities the listings themselves name, which is what this row was before it
   * became configurable.
   */
  const siteQuery = publicQuery.siteConfig();
  const site = useResource<MobileSiteConfig>(siteQuery.load, {
    cacheKey: siteQuery.key,
    topics: siteQuery.topics,
  });

  // Memoised so the slices below are not recomputed on every keystroke in the
  // search field: `?? []` is a fresh array each render.
  const all = useMemo(() => hostels.data ?? [], [hostels.data]);

  /*
   * Keep the saved snapshots current from the payload the screen already has.
   * `sync` dispatches nothing when nothing differs, so this is a no-op on an
   * unchanged catalogue rather than a write to disk per refresh.
   */
  const { sync } = saved;

  useEffect(() => {
    sync(all);
  }, [all, sync]);

  const showcase = useMemo(() => showcaseHostels(all), [all]);
  const cities = useMemo(
    () =>
      featuredCities(
        (site.data?.locations ?? []).map((location) => location.city),
        all,
        MAX_CITIES,
      ),
    [all, site.data],
  );

  const search = useCallback(() => {
    router.push(
      query.trim() ? `${browseHref}?q=${encodeURIComponent(query)}` : browseHref,
    );
  }, [browseHref, query]);

  const seeAll = useCallback(() => router.push(browseHref), [browseHref]);

  return (
    <Screen
      header={
        <DiscoveryHeader
          browseHref={browseHref}
          onQueryChange={setQuery}
          onSearch={search}
          query={query}
        />
      }
      insideTabs={insideTabs}
      onRefresh={hostels.refresh}
      refreshing={hostels.refreshing}
      scroll
    >
      <View className="gap-7 pt-1">
        <MyJoinRequestRow />

        {hostels.error && all.length === 0 ? (
          <ErrorState message={hostels.error} onRetry={hostels.reload} />
        ) : (
          <>
            {/*
              Hidden together, not just the carousel. `HostelShowcase` renders
              nothing when no listing has a usable photo, and a "Top Picks For
              You" heading with a gap under it is worse than no section.
            */}
            {showcase.length > 0 || hostels.loading ? (
              <View className="gap-3">
                <RowHeader onSeeAll={seeAll} title="Top Picks For You" />
                <HostelShowcase
                  hostels={showcase}
                  loading={hostels.loading}
                  onToggleSave={saved.toggle}
                  savedIds={saved.ids}
                />
              </View>
            ) : null}

            <PopularCities
              browseHref={browseHref}
              cities={cities}
              loading={hostels.loading || site.loading}
              onSeeAll={seeAll}
            />

            <NearbyHostels
              hostels={all}
              nearby={nearby}
              onSeeAll={seeAll}
              saved={saved}
            />

            <RoomsAvailable
              hostels={all}
              loading={hostels.loading}
              onSeeAll={seeAll}
              saved={saved}
            />

            <TopRated hostels={all} onSeeAll={seeAll} saved={saved} />

            <SavedRow items={saved.items} onRemove={saved.remove} />
          </>
        )}
      </View>
    </Screen>
  );
}

/** Everything a card row needs from `useSavedHostels`, and nothing more. */
type SavedControls = Pick<ReturnType<typeof useSavedHostels>, "ids" | "toggle">;

/**
 * A section heading with "View all" beside it.
 *
 * Local rather than `<SectionHeader>`: this page's headings are the largest text
 * on the screen and their action carries an arrow, where `SectionHeader` is a
 * 16px title with a plain slot — the shape every *other* screen in the app uses.
 * Growing it a `size` prop would put a home-screen-only branch inside a
 * component thirty screens render.
 */
function RowHeader({
  onSeeAll,
  subtitle,
  title,
}: {
  onSeeAll?: () => void;
  subtitle?: React.ReactNode;
  title: string;
}) {
  const { colors } = useAppTheme();

  return (
    <View className="flex-row items-start justify-between gap-3">
      <View className="flex-1">
        <Text className="text-2xl font-bold tracking-tight text-foreground">{title}</Text>
        {subtitle}
      </View>

      {onSeeAll ? (
        <Pressable
          accessibilityLabel={`View all ${title}`}
          accessibilityRole="button"
          className="mt-1 flex-row items-center gap-1 active:opacity-70"
          hitSlop={8}
          onPress={onSeeAll}
        >
          <Text className="text-sm font-semibold text-primary">View all</Text>
          <Ionicons color={colors.primary} name="arrow-forward" size={14} />
        </Pressable>
      ) : null}
    </View>
  );
}

/**
 * "Popular Cities" — the busiest cities in the payload, with a photograph each.
 *
 * Deep-links to `?city=`, which the browse screen narrows **on the client**. The
 * server has no city filter: its `area` matches `location.area` only, so a
 * hostel in "Ghattekulo, Kathmandu" does not match `?area=Kathmandu`. Both the
 * count here and the results there are derived from the same 60-row payload, so
 * they agree — see `inCity` in `lib/home-sections.ts`.
 *
 * **The count is exact, not "320+".** The mockup rounds up to a marketing
 * number; this is the number of listings the card will actually show you, and a
 * card promising 320 that opens onto 9 is the last time anybody taps one.
 *
 * Hidden below two cities: a "Popular Cities" row with one card in it is a
 * heading that describes nothing.
 */
function PopularCities({
  browseHref,
  cities,
  loading,
  onSeeAll,
}: {
  browseHref: string;
  cities: CitySummary[];
  loading: boolean;
  onSeeAll: () => void;
}) {
  if (loading && cities.length === 0) {
    return (
      <View className="gap-3">
        <RowHeader title="Popular Cities" />
        <Skeleton height={168} radius={16} />
      </View>
    );
  }

  /*
   * One city is still a row worth drawing — it is the city every listing in the
   * catalogue is in, and its card is the fastest way into a filtered list. This
   * was hidden below two, which is why a catalogue that is entirely Kathmandu
   * showed no Popular Cities section at all.
   */
  if (cities.length === 0) {
    return null;
  }

  return (
    <View className="gap-3">
      <RowHeader onSeeAll={onSeeAll} title="Popular Cities" />

      <ScrollView
        contentContainerClassName="gap-3 pr-5"
        horizontal
        showsHorizontalScrollIndicator={false}
      >
        {cities.map((row) => (
          <CityCard browseHref={browseHref} city={row} key={row.city} />
        ))}
      </ScrollView>
    </View>
  );
}

/**
 * One city card, sized from the window rather than fixed.
 *
 * `w-56` — 224dp — put one and a half cards on a 360dp handset, which reads as a
 * card that failed to fit rather than a row that scrolls. Two and a bit is the
 * proportion the mockup shows, and it is the one that tells the reader there is
 * more to the right. Measured, not a percentage: a percentage of the page and a
 * gap between the cards overflow by a fraction of a pixel, which is the same
 * trap `<Grid>` exists to avoid.
 */
function CityCard({ browseHref, city }: { browseHref: string; city: CitySummary }) {
  const { colors } = useAppTheme();
  const { width } = useWindowDimensions();

  const uri = cityImageUrl(city.city);
  const listings = `${city.count} ${city.count === 1 ? "hostel" : "hostels"}`;
  const cardWidth = Math.round((width - PAGE_INSET) * 0.44);

  return (
    <Pressable
      accessibilityLabel={`${city.city}, ${listings}`}
      accessibilityRole="button"
      className="overflow-hidden rounded-2xl border border-border bg-card active:opacity-80"
      onPress={() => router.push(`${browseHref}?city=${encodeURIComponent(city.city)}`)}
      style={{ width: cardWidth }}
    >
      {uri ? (
        <Image
          accessibilityLabel={city.city}
          contentFit="cover"
          source={{ uri }}
          style={{ backgroundColor: colors.muted, height: 112, width: "100%" }}
          transition={150}
        />
      ) : (
        /*
          No photograph for this city — see `lib/city-images.ts`. A tinted block
          with the pin, rather than dropping the card: the listings behind it are
          real, and a city missing from the row is a city nobody can browse.
        */
        <View
          className="items-center justify-center bg-brand-soft"
          style={{ height: 112 }}
        >
          <Ionicons color={colors.primary} name="location-outline" size={26} />
        </View>
      )}

      <View className="gap-0.5 px-3 py-2.5">
        <Text className="font-bold" numberOfLines={1} variant="label">
          {city.city}
        </Text>
        <Text numberOfLines={1} variant="caption">
          {listings}
        </Text>
      </View>
    </Pressable>
  );
}

/** What a card row needs per hostel. Distance is Nearby's; the others have none. */
type RowCard = {
  distanceMeters?: number | null;
  hostel: PublicHostel;
};

/**
 * A horizontal row of hostel cards, two to a screen.
 *
 * ## Why this is not `<Grid>`
 *
 * "Nearby Hostels" was a two-column grid, which is the wrong shape twice over.
 * It made the cards a different width from every other row on the page — the
 * cities scroll, the showcase scrolls, and this one wrapped — and with four
 * listings it put a second row of cards below the fold, so the section owned
 * half a screenful and pushed everything under it out of sight. The mockup draws
 * one row of two with more to the right, which is what this is.
 *
 * The width is measured from the window rather than written as `w-[62%]`:
 * NativeWind compiles its stylesheet from the classes it can see, so a
 * percentage used nowhere else in the app resolves to nothing until the bundler
 * is rebuilt. `snapToInterval` then makes a flick land on a card edge rather
 * than halfway through a photograph.
 */
function HostelCardRow({
  cards,
  saved,
  showVacancy = false,
}: {
  cards: RowCard[];
  saved: SavedControls;
  showVacancy?: boolean;
}) {
  const { width } = useWindowDimensions();

  const cardWidth = Math.round((width - PAGE_INSET) * CARD_WIDTH_RATIO);

  return (
    <ScrollView
      contentContainerStyle={{ gap: ROW_GAP }}
      decelerationRate="fast"
      horizontal
      showsHorizontalScrollIndicator={false}
      snapToAlignment="start"
      snapToInterval={cardWidth + ROW_GAP}
    >
      {cards.map(({ distanceMeters, hostel }) => (
        // The card itself is `w-full`; the wrapper is what fixes the width, so
        // one component serves both this row and the full-width browse list.
        <View key={hostel.id} style={{ width: cardWidth }}>
          <HostelCard
            distanceMeters={distanceMeters}
            hostel={hostel}
            onToggleSave={saved.toggle}
            saved={saved.ids.has(hostel.id)}
            showVacancy={showVacancy}
            variant="grid"
          />
        </View>
      ))}
    </ScrollView>
  );
}

/**
 * "Nearby Hostels" — the closest listings, two to a screen.
 *
 * ## It locates itself
 *
 * The row used to render a pitch and a button, and nothing else until somebody
 * pressed it — so for most readers the section was a heading and a paragraph
 * where the design has hostels. It now fills itself on arrival: silently when
 * location is already granted, and otherwise with one dialogue, once per
 * install (`useNearby({ auto: true })`, policy in `lib/location.ts`).
 *
 * The pitch survives as the **fallback**, which is what it was always best at:
 * it says what the section does and that the position is not kept, and its
 * button is how somebody who refused, or whose fix failed, gets a second go.
 * The one thing that never happens is a dialogue on every launch.
 *
 * ## The place under the heading is the listings', not the device's
 *
 * `useNearby` returns coordinates and no label — there is no reverse geocoder in
 * this app, and adding one for a subtitle would be a third-party request on
 * every home screen. So the line names where the nearest listings are, which is
 * what the reader is about to scroll through, and it comes from data already on
 * screen rather than from the user's own position.
 *
 * ## Every refusal leaves a working screen
 *
 * Denied, blocked, no fix: the section says which, offers the one action that
 * can help, and the rest of the home screen is untouched. `useNearby` already
 * toasts the reason; this only has to not become a dead end.
 */
/** A grid card's height, near enough: photo, four lines and the padding. */
const NEARBY_SKELETON_HEIGHT = 232;

function NearbyHostels({
  hostels,
  nearby,
  onSeeAll,
  saved,
}: {
  hostels: PublicHostel[];
  nearby: ReturnType<typeof useNearby>;
  onSeeAll: () => void;
  saved: SavedControls;
}) {
  const { colors } = useAppTheme();

  // Only hostels that actually have coordinates: an un-geocoded listing has no
  // distance, and "0 m away" on a hostel nobody has placed is a lie the card
  // would tell confidently.
  const nearest = useMemo(() => {
    if (!nearby.coordinates) {
      return [];
    }

    return sortByDistance(hostels, nearby.coordinates)
      .filter((row) => row.distanceMeters !== null)
      .slice(0, 4);
  }, [hostels, nearby.coordinates]);

  const place = nearest[0] ? locationLabel(nearest[0].hostel.location) : "";
  const populated = nearby.isActive && nearest.length > 0;

  return (
    <View className="gap-3">
      <RowHeader
        onSeeAll={populated ? onSeeAll : undefined}
        subtitle={
          populated && place ? (
            <View className="mt-0.5 flex-row items-center gap-1">
              <Ionicons
                color={colors.mutedForeground}
                name="location-outline"
                size={13}
              />
              <Text className="flex-1" numberOfLines={1} variant="caption">
                {place}
              </Text>
            </View>
          ) : undefined
        }
        title="Nearby Hostels"
      />

      {nearby.isBusy ? (
        /*
          A card-shaped skeleton, not a spinner in the empty pitch: on the
          automatic attempt nobody pressed anything, so there is no control to
          spin — what the reader needs to know is that hostels are coming.
        */
        <Skeleton height={NEARBY_SKELETON_HEIGHT} radius={16} />
      ) : nearby.isActive ? (
        nearest.length === 0 ? (
          <Card>
            <Text variant="muted">
              None of the listed hostels have been placed on the map yet, so there is
              no distance to show. Everything else on this screen is unchanged.
            </Text>
          </Card>
        ) : (
          /*
            Three nearby hostels is a real case — only listings with coordinates
            get here — and a row of three scrolls where a grid of three leaves a
            hole. `HostelCardRow` keeps the card the same width either way.
          */
          <HostelCardRow cards={nearest} saved={saved} />
        )
      ) : (
        <Card className="gap-3">
          <Text variant="muted">
            {nearby.status === "blocked"
              ? "Location is switched off for this app. Turn it on in Settings to see the hostels closest to you."
              : nearby.status === "unavailable"
                ? "We couldn't get a position. Check that location is switched on, then try again."
                : "See which hostels are closest to you right now. Your location is used once, on this screen, and is never saved."}
          </Text>

          {nearby.status === "blocked" ? (
            <Button
              label="Open settings"
              onPress={nearby.openSettings}
              variant="outline"
            />
          ) : (
            <Button
              label={
                nearby.isBusy
                  ? "Finding you…"
                  : nearby.status === "unavailable"
                    ? "Try again"
                    : "Show hostels near me"
              }
              loading={nearby.isBusy}
              onPress={() => {
                void nearby.enable();
              }}
              variant="outline"
            />
          )}
        </Card>
      )}
    </View>
  );
}

/**
 * "Rooms Available Now" — the listings with a bed free today.
 *
 * ## The one question the rest of the screen ducks
 *
 * Every other row here will lead somebody to a hostel that is full: Top Picks
 * ranks, Popular Cities groups, Nearby measures. Finding out that the hostel you
 * picked has no space is a phone call or a trip across town, and it is the point
 * at which a discovery app stops being trusted. This row cannot contain one — a
 * full hostel is filtered out — and each card carries the count, so the heading
 * is checkable rather than a claim.
 *
 * It sits under Nearby rather than above it: distance is what somebody scrolling
 * this screen is choosing on, and availability is what they check next.
 *
 * **Absent when no hostel publishes its capacity**, which is a real state — the
 * field is optional at registration. A heading over an empty row would say
 * "nothing is available", which is the opposite of what it would mean.
 */
function RoomsAvailable({
  hostels,
  loading,
  onSeeAll,
  saved,
}: {
  hostels: PublicHostel[];
  loading: boolean;
  onSeeAll: () => void;
  saved: SavedControls;
}) {
  const available = useMemo(() => withVacantBeds(hostels), [hostels]);

  // Nothing on the first load either: this row has no skeleton because it does
  // not know whether it has anything to draw until the payload lands, and a
  // skeleton that resolves to nothing is a section that flickers in and out.
  if (loading || available.length === 0) {
    return null;
  }

  return (
    <View className="gap-3">
      <RowHeader onSeeAll={onSeeAll} title="Rooms Available Now" />
      <HostelCardRow
        cards={available.map((hostel) => ({ hostel }))}
        saved={saved}
        showVacancy
      />
    </View>
  );
}

/**
 * "Top Rated" — what students have actually scored well.
 *
 * ## It is a different set, not a different sort
 *
 * The page above it already ranks: the showcase leads with photographed,
 * verified, well-reviewed listings. What it cannot do is *exclude* — a catalogue
 * where nobody has reviewed anything still fills Top Picks, because a hostel
 * with no rating is still worth showing. This row is the opposite promise: every
 * card in it carries a real score from real reviews, so an unrated hostel cannot
 * be here and on a young catalogue the row does not exist at all. That is the
 * line the six deleted carousels never had — see the note at the top of the file.
 *
 * **Hidden below two.** One card under a plural heading is not a ranking, it is
 * the only hostel anybody has reviewed, and the showcase has already shown it.
 */
const MIN_TOP_RATED = 2;

function TopRated({
  hostels,
  onSeeAll,
  saved,
}: {
  hostels: PublicHostel[];
  onSeeAll: () => void;
  saved: SavedControls;
}) {
  const rated = useMemo(() => topRatedHostels(hostels), [hostels]);

  if (rated.length < MIN_TOP_RATED) {
    return null;
  }

  return (
    <View className="gap-3">
      <RowHeader onSeeAll={onSeeAll} title="Top Rated" />
      <HostelCardRow cards={rated.map((hostel) => ({ hostel }))} saved={saved} />
    </View>
  );
}

/**
 * "Saved" — the favourites row.
 *
 * Renders from the stored snapshot rather than from the listing payload, which
 * is what lets it survive a hostel dropping out of the server's first-60 window
 * and an offline launch (`lib/saved-hostels.ts`). The trade is that a price here
 * is as fresh as the last time that hostel appeared in a payload, which is why
 * the card carries no rating or vacancy: those move often enough that a stale one
 * would be a lie, while a name and a price are worth showing at their last known
 * value.
 *
 * Absent entirely when nothing is saved — which is also what keeps a fresh
 * install looking exactly like the mockup, whose page has no such row.
 */
function SavedRow({
  items,
  onRemove,
}: {
  items: SavedHostel[];
  onRemove: (id: string) => void;
}) {
  if (items.length === 0) {
    return null;
  }

  return (
    <View className="gap-3">
      <RowHeader title="Saved" />

      <ScrollView
        contentContainerClassName="gap-3 pr-5"
        horizontal
        showsHorizontalScrollIndicator={false}
      >
        {items.map((item) => (
          <SavedCard item={item} key={item.id} onRemove={onRemove} />
        ))}
      </ScrollView>
    </View>
  );
}

function SavedCard({
  item,
  onRemove,
}: {
  item: SavedHostel;
  onRemove: (id: string) => void;
}) {
  const { colors } = useAppTheme();

  const uri = absoluteMediaUrl(item.coverUrl, API_BASE_URL);

  return (
    <Pressable
      accessibilityLabel={`${item.name}, ${item.place}`}
      accessibilityRole="button"
      className="w-52 overflow-hidden rounded-2xl border border-border bg-card active:opacity-80"
      onPress={() => router.push(`/hostel/${item.slug}`)}
    >
      <View>
        {uri ? (
          <Image
            accessibilityLabel={item.name}
            contentFit="cover"
            source={{ uri }}
            style={{ backgroundColor: colors.muted, height: 100, width: "100%" }}
            transition={150}
          />
        ) : (
          <View
            className="items-center justify-center"
            style={{ backgroundColor: colors.muted, height: 100 }}
          >
            <Ionicons color={colors.mutedForeground} name="image-outline" size={24} />
          </View>
        )}

        {/*
          A filled heart, and it removes. Not `SaveButton`: that takes a
          `PublicHostel` and this row holds snapshots, which carry an id and a
          few strings and none of the fields a listing has.
        */}
        <Pressable
          accessibilityLabel={`Remove ${item.name} from saved`}
          accessibilityRole="button"
          className="absolute right-2 top-2 h-9 w-9 items-center justify-center rounded-full bg-card/95 active:opacity-70"
          hitSlop={6}
          onPress={() => onRemove(item.id)}
        >
          <Ionicons color={colors.primary} name="heart" size={18} />
        </Pressable>
      </View>

      <View className="gap-0.5 p-3">
        <Text className="font-semibold" numberOfLines={1} variant="label">
          {item.name}
        </Text>
        <Text numberOfLines={1} variant="caption">
          {item.place || "Location not published"}
        </Text>
        <Text className="font-semibold text-primary" variant="label">
          {item.price}
        </Text>
      </View>
    </Pressable>
  );
}
