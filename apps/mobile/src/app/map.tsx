import { Ionicons, MaterialIcons } from "@expo/vector-icons";
import { Image } from "expo-image";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { type ErrorBoundaryProps, router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Keyboard, Pressable, ScrollView, TextInput, View } from "react-native";

import { facilityIcon, SaveButton } from "@/components/hostel-card";
import { MapExplorer, type MapHandle, type MapMarker } from "@/components/map-explorer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet } from "@/components/ui/sheet";
import { ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useAppDispatch, useAppSelector } from "@/hooks/redux";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useCommuteTimes } from "@/hooks/use-commute";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import {
  useGuidance,
  type Guidance,
  type GuidanceStatus,
} from "@/hooks/use-guidance";
import { useNearby } from "@/hooks/use-nearby";
import { useResource } from "@/hooks/use-resource";
import { useSavedHostels } from "@/hooks/use-saved";
import { useSystemInsets } from "@/hooks/use-system-insets";
import { useVoiceGuidance } from "@/hooks/use-voice-guidance";
import { API_BASE_URL } from "@/lib/api";
import { type Coordinates, haversineMeters, hostelCoordinates } from "@/lib/geo";
import { searchHostels } from "@/lib/hostel-search";
import { type MapLayerId, MAP_LAYERS } from "@/lib/leaflet";
import { cardinalFor, formatManeuverDistance, instructionFor } from "@/lib/navigation";
import { formatTime } from "@/lib/format";
import { formatDistance, locationLabel, priceRange, ratingDisplay } from "@/lib/hostel-display";
import { baseStyle } from "@/lib/map-styles";
import { absoluteMediaUrl } from "@/lib/media";
import { openConfirm } from "@/lib/confirm";
import { saveRouteOffline } from "@/lib/offline-route";
import { toastError, toastSuccess } from "@/lib/toast";
import {
  announceArrival,
  HOSTEL_TYPE_LABELS,
  searchPlaces,
  type PublicHostel,
} from "@/lib/public-api";
import { publicQuery } from "@/lib/public-queries";
import {
  fetchRoadRoutes,
  type RoadRoute,
  type RouteMode,
  type RouteStep,
} from "@/lib/routing";
import { setCommutePlace, setNavigationVoiceMuted } from "@/store/slices/uiSlice";

/**
 * The map, as a screen rather than a panel: search, pick, and find the way.
 *
 * ## What it replaced, and what it did not
 *
 * The per-hostel directions screen is gone — it drew one route and could do
 * nothing else — and `/directions/[slug]` redirects here, so anything already
 * linking to it lands on the same hostel with directions running.
 *
 * The browse screen's map view **stays**, and the difference is worth keeping
 * straight: that one plots the rows a set of filters produced (type, facility,
 * budget, city) and is a view onto a result set. This one is the whole
 * catalogue, searched by name and place, and it is the only one that routes.
 * Merging them would mean one screen whose pins mean different things depending
 * on how it was opened.
 *
 * Reached from the distance badge on any card that has one, and from
 * `/map?slug=…&route=1` anywhere else.
 *
 * ## Everything on it is the platform's own catalogue
 *
 * Pins, search results and the card below are `listPublicHostels()` — the same
 * 60-row payload the browse screen renders. There is no place search, no
 * geocoder and no third-party POI layer: a map that finds "hostels near
 * Baneshwor" and offers you one that is not on the platform is a map that sends
 * people somewhere the app cannot help them. Searching narrows what is already
 * here, by name, area and city.
 *
 * ## Smoothness is an architectural choice, not a setting
 *
 * The map page is built once and driven by `injectJavaScript` — see
 * `components/map-explorer.tsx`. That is what makes typing in the search field
 * move pins instead of reloading a browser. Everything the reader interacts with
 * *around* the map — the field, the card, the mode toggle — is native, so none
 * of it waits on the WebView, and the photo strip is `expo-image` with its own
 * cache rather than `<img>` tags inside the page.
 *
 * ## Two profiles, and they are genuinely different graphs
 *
 * Car and foot go to separate OSRM deployments (`lib/routing.ts`). Between the
 * two hostels in the live catalogue that is 4.9 km / 7 min against 5.3 km /
 * 70 min — the toggle changes the answer, which is the only reason to offer it.
 */

/** Tall enough to see a room in, short enough to leave the map most of the screen. */
const PHOTO_STRIP_HEIGHT = 104;

/**
 * How long the reader has to stop typing before the map answers.
 *
 * Under about 150ms is indistinguishable from no debounce at all — the work
 * still happens per keystroke for anyone typing at a normal speed. Over about
 * 400ms and the reader has finished the word, looked up, and started wondering.
 * 250 is the usual landing spot for a search-as-you-type field, and it is what
 * turns "Kritika" from seven passes over the catalogue into one.
 */
const SEARCH_DEBOUNCE_MS = 250;

/**
 * Rows in the result list before it stops and says how many are left.
 *
 * The list floats over the map, and the map is the thing the search just
 * changed: sixty rows would cover every pin they refer to. Eight is about a
 * third of the screen — enough that a real answer is usually visible without
 * scrolling, little enough that the map is still a map.
 */
const MAX_RESULTS = 8;

/**
 * How far down the screen the list may reach before it scrolls inside itself.
 *
 * Eight rows do not all fit on a small phone, and a list that grows to whatever
 * its contents need would push past the map controls on the right and, on a
 * short screen, past the card at the bottom. Measured rather than written as a
 * class, like every other dimension in this app: NativeWind compiles class names
 * at bundle time and an arbitrary value used nowhere else can resolve to nothing.
 */
const RESULTS_MAX_HEIGHT = 300;

/**
 * The lock this screen takes on the display while it is guiding.
 *
 * A tag rather than the default, so this can only ever release its own lock:
 * `deactivateKeepAwake` with no tag would also release one taken by something
 * else, and a video player that stopped keeping the screen on because somebody
 * finished walking to a hostel is a bug nobody would find.
 */
const NAVIGATION_WAKE_TAG = "map.navigation";

/** What is open on the map: a hostel, and whether its route is being drawn. */
type Choice = {
  directions: boolean;
  id: string | null;
};

/** The state before anybody has tapped anything, and after they close the card. */
const NOTHING_CHOSEN: Choice = { directions: false, id: null };

/**
 * A map that throws stays a map screen with a way back, not a white app.
 *
 * Without this, any render error under the map — the native layer bridge has
 * thrown before — unmounts the whole tree, and the reader is left on a blank
 * screen they can only swipe away. Expo Router mounts this in place of the
 * screen; "Try again" renders it afresh.
 */
export function ErrorBoundary({ retry }: ErrorBoundaryProps) {
  const { colors } = useAppTheme();

  return (
    <View className="flex-1" style={{ backgroundColor: colors.background }}>
      <ErrorState
        icon="map-outline"
        message="Something on the map failed to draw. Try again, or go back and open it later."
        onRetry={() => void retry()}
        title="The map stopped"
      />
      <View className="items-center pb-12">
        <Button label="Go back" onPress={() => router.back()} variant="ghost" />
      </View>
    </View>
  );
}

export default function MapScreen() {
  const { route: routeParam, slug } = useLocalSearchParams<{
    route?: string;
    slug?: string;
  }>();
  const { colors, isDark } = useAppTheme();
  const insets = useSystemInsets();
  const map = useRef<MapHandle>(null);
  const saved = useSavedHostels();

  const hostelsQuery = publicQuery.hostels();
  const hostels = useResource<PublicHostel[]>(hostelsQuery.load, {
    cacheKey: hostelsQuery.key,
    topics: hostelsQuery.topics,
  });

  const nearby = useNearby({ auto: true });
  const me = nearby.coordinates;

  const [query, setQuery] = useState("");
  /*
   * Whether the field has the caret. The result list hangs off this as well as
   * off the query, so that tapping a result — or the map — puts the map back on
   * screen whole, rather than leaving a list of eight hostels floating over the
   * one the reader just chose.
   */
  const [searching, setSearching] = useState(false);
  const field = useRef<TextInput>(null);
  const [mode, setMode] = useState<RouteMode>("car");
  /*
   * `null` means "the reader has not chosen anything yet", which is different
   * from having chosen nothing — the first falls back to the hostel in the URL,
   * the second is an empty map after they closed the card. Derived rather than
   * synced in an effect: a `setState` in an effect that watches the deep-link
   * hostel re-opens the card every time the payload refreshes, and fights the
   * reader for the selection.
   */
  const [choice, setChoice] = useState<Choice | null>(null);

  const all = useMemo(() => hostels.data ?? [], [hostels.data]);

  /*
   * Only hostels with coordinates get a pin — an un-geocoded listing has no
   * place on a map, and putting it at 0,0 would drag the whole view into the
   * Gulf of Guinea. It is still reachable everywhere else in the app.
   */
  const placed = useMemo(
    () => all.filter((hostel) => hostelCoordinates(hostel) !== null),
    [all],
  );

  /*
   * Two values, and the difference between them is the whole fix.
   *
   * `query` is the field: it must never lag, because a `TextInput` bound to
   * debounced state drops characters and jumps the caret. `search` is what the
   * *map* is asked for, and it only moves once the reader has stopped typing —
   * every keystroke used to re-filter the catalogue, rebuild the marker array
   * and inject all sixty pins into the WebView, which is six wasted passes for
   * a six-letter word and pins that twitch while you type.
   *
   * Emptying the box skips the wait. The delay exists to avoid answering a
   * half-typed question; "show me everything again" is not half of anything, and
   * a quarter-second of the old, narrower set after a clear looks stuck.
   */
  const settled = useDebouncedValue(query, SEARCH_DEBOUNCE_MS);
  const search = query.trim() ? settled : query;

  const found = useMemo(() => searchHostels(placed, search), [placed, search]);

  /*
   * "My college / office": travel time from that place to every pin, by the
   * profile the toggle is on. One router `table` request for the catalogue;
   * the place lives on this phone only (`ui.commutePlace`).
   */
  const dispatch = useAppDispatch();
  const { minutesTo, place: commute } = useCommuteTimes(placed, mode);
  /** Only hostels within this many minutes of the place; null shows them all. */
  const [within, setWithin] = useState<15 | 30 | null>(null);
  const matches = useMemo(
    () =>
      within && commute
        ? found.filter((hostel) => (minutesTo(hostel.id) ?? Infinity) <= within)
        : found,
    [commute, found, minutesTo, within],
  );
  const [placeSheet, setPlaceSheet] = useState(false);

  /** True while the reader is mid-word: the field has moved on, the map has not. */
  const settling = query.trim() !== search.trim();

  const markers = useMemo<MapMarker[]>(
    () =>
      matches.flatMap((hostel) => {
        const point = hostelCoordinates(hostel);

        return point
          ? [
              {
                id: hostel.id,
                lat: point.lat,
                lng: point.lng,
                // The time to the reader's college rides on the pin's own label.
                name: minutesTo(hostel.id)
                  ? `${hostel.name} · ${minutesTo(hostel.id)} min`
                  : hostel.name,
              },
            ]
          : [];
      }),
    [matches, minutesTo],
  );

  /*
   * Opened from a card's distance badge: `?slug=…&route=1` opens on that hostel
   * with directions already running. It is the *initial* choice, not an
   * override — one tap on any pin and the reader's own choice wins from then on.
   */
  const wanted = useMemo(
    () => (slug ? (all.find((hostel) => hostel.slug === slug) ?? null) : null),
    [all, slug],
  );

  const linked = useMemo<Choice | null>(
    () => (wanted ? { directions: routeParam === "1", id: wanted.id } : null),
    [routeParam, wanted],
  );

  const { directions, id: selectedId } = choice ?? linked ?? NOTHING_CHOSEN;

  const selected = useMemo(
    () => all.find((hostel) => hostel.id === selectedId) ?? null,
    [all, selectedId],
  );

  const destination = useMemo(
    () => (selected ? hostelCoordinates(selected) : null),
    [selected],
  );


  // Centring is a message to the map, not React state — which is what an effect
  // is actually for. It fires when the linked hostel arrives with the payload.
  useEffect(() => {
    const point = wanted ? hostelCoordinates(wanted) : null;

    if (point) {
      map.current?.center(point, 15);
    }
  }, [wanted]);

  /*
   * The route itself. `null` from the router is a real answer — no road between
   * these two points — and the map falls back to the dashed straight line, which
   * is what `dashed` on the payload below says.
   */
  const roads = useResource<RoadRoute[]>(
    useCallback(
      async () =>
        directions && me && destination ? await fetchRoadRoutes(me, destination, mode) : [],
      [destination, directions, me, mode],
    ),
    { refetchOnFocus: false },
  );
  const routes = useMemo(() => roads.data ?? [], [roads.data]);

  /*
   * Which route the reader picked. Keyed by hostel and profile, so choosing
   * another hostel or switching Walk/Vehicle starts back at the router's best
   * one without an effect to reset it.
   */
  const routeKey = `${selectedId}:${mode}`;
  const [picked, setPicked] = useState({ index: 0, key: "" });
  const chosenIndex = picked.key === routeKey && picked.index < routes.length ? picked.index : 0;
  const chosen = routes[chosenIndex] ?? null;

  /*
   * Guidance owns its own position — at navigation accuracy, from its own
   * subscription — so from the moment Start is pressed the map, the arrow and
   * the card all read from it rather than from the coarse `me` the rest of the
   * screen uses. See `hooks/use-guidance.ts` for why that accuracy exists only
   * while this is running.
   */
  const guidance = useGuidance({ destination, mode, route: chosen });
  const navigating = guidance.isNavigating;
  const arrived = guidance.status === "arrived";
  const here = guidance.position ?? me;

  const voiceMuted = useAppSelector((state) => state.ui.navigationVoiceMuted === true);

  const gate = selected?.arrivalGuide ?? null;
  /** Within 200 m: the last lanes, where "find the gate" earns its place. */
  const nearGate =
    navigating && guidance.remainingMeters !== null && guidance.remainingMeters <= 200;

  useVoiceGuidance({
    gateNote: gate?.note || undefined,
    guidance,
    mode,
    muted: voiceMuted,
    nearGate,
    place: selected?.name ?? "the hostel",
  });

  const straightLine = me && destination ? haversineMeters(me, destination) : null;

  const line = useMemo(() => {
    /*
     * While navigating, the line is whatever guidance is following — the
     * original route or the latest reroute — and it is drawn as it came back
     * from the router, without the two straight hops from the device to the
     * first point and from the last point to the door. Those are honest enough
     * on a planning screen; under a turn-by-turn arrow they look like an
     * instruction to walk through whatever is in the way.
     */
    if (navigating) {
      return guidance.route ? { dashed: false, points: guidance.route.points } : null;
    }

    if (!directions || !me || !destination) {
      return null;
    }

    return chosen
      ? { dashed: false, points: [me, ...chosen.points, destination] }
      : { dashed: true, points: [me, destination] };
  }, [chosen, destination, directions, guidance.route, me, navigating]);

  // The routes not chosen, drawn grey and tappable — planning only.
  const others = useMemo(
    () =>
      directions && !navigating
        ? routes.flatMap((route, index) => (index === chosenIndex ? [] : [{ index, route }]))
        : [],
    [chosenIndex, directions, navigating, routes],
  );
  const alternatives = useMemo(
    () => others.map(({ route }) => ({ dashed: false, points: route.points })),
    [others],
  );

  /*
   * Navigation drives the map rather than rendering it, and it does so in two
   * effects rather than one.
   *
   * The first version had a single effect depending on both the position and
   * the heading, which meant every compass sample — ten or so a second — called
   * `follow`, and `follow` is a `setView`. A pinch was undone within a tenth of
   * a second, and the bridge carried ten scripts a second to do it. Split, a
   * fix moves the map and a compass sample only turns it, and the 2° gate in
   * `MapExplorer` drops most of those before they cross.
   *
   * The zoom is passed **once**, on the first fix of a session. After that the
   * page keeps whatever zoom the map is on, so a reader who pinches out to see
   * the next two junctions stays there instead of being pulled back to 17.
   */

  /*
   * Heading-up or north-up, and the compass is the switch.
   *
   * Turning with the reader is right while walking — the turn on screen is the
   * turn in front of you — and wrong the moment they stop to work out where
   * they are, because every label is upside down and the street they can see
   * signposted is not where the map says. Google puts that choice on the
   * compass; so does this. It is cleared by `startGuidance` rather than by an
   * effect watching `navigating` — a `setState` in an effect body is a
   * cascading render and the lint rule that forbids it is right — which also
   * makes it a per-session choice rather than a remembered preference.
   */
  const [northUp, setNorthUp] = useState(false);
  const [layer, setLayer] = useState<MapLayerId>("standard");
  const [layersOpen, setLayersOpen] = useState(false);
  /** The chosen hostel's surroundings — pharmacy, bus stop, college — on the map. */
  const [showAround, setShowAround] = useState(true);
  /** Navigating, but the reader dragged the map away: offer the way back. */
  const [detached, setDetached] = useState(false);
  const [bannerHeight, setBannerHeight] = useState(0);

  /** The map along the route, saved on Start so a dead zone still draws streets. */
  const [offline, setOffline] = useState<"saving" | "saved" | null>(null);
  const signedIn = useAppSelector((state) => state.auth.account !== null);
  /** The hostel was told this trip — keyed by hostel so another trip asks again. */
  const [toldFor, setToldFor] = useState<string | null>(null);
  const [telling, setTelling] = useState(false);

  const startGuidance = useCallback(() => {
    setNorthUp(false);
    setDetached(false);
    guidance.start();

    // Vector tiles only: the street map is what guidance needs, and photo
    // tiles are many times the bytes.
    const style = baseStyle(isDark).url;

    if (chosen) {
      setOffline("saving");
      void saveRouteOffline(chosen.points, style).then((ok) => setOffline(ok ? "saved" : null));
    }
  }, [chosen, guidance, isDark]);

  const recentre = useCallback(() => {
    map.current?.recentre();
    setDetached(false);
  }, []);


  /*
   * Arrival, acknowledged. Guidance has already stopped itself and dropped both
   * subscriptions by the time this is reachable — this is only the card being
   * dismissed, and it lands on `PreviewCard`: the hostel selected, its photos
   * and its price, which is the state the reader started from and the one they
   * want now they are standing outside it. Stopping *mid-route* deliberately
   * does not do this: it leaves directions open, because somebody who stopped
   * by accident wants Start again, not a photo strip.
   */
  const finishArrival = useCallback(() => {
    guidance.stop();
    // `selectedId`, not the previous choice: a reader who arrived at a
    // deep-linked hostel has never set `choice`, and reading it there would
    // close the card instead of opening the preview.
    setChoice({ directions: false, id: selectedId });
  }, [guidance, selectedId]);

  /*
   * Keep the display on, but only while actually guiding.
   *
   * A phone that sleeps thirty seconds into a walk is a navigation app that
   * does not work, and pressing the power button at every junction is not a
   * workaround. It is an effect keyed on `navigating` rather than a bare
   * `useKeepAwake()`, which would hold the lock for as long as the map screen
   * is open — including while somebody browses hostels from a sofa.
   *
   * `expo-keep-awake` is autolinked through `expo`, so this needs no rebuild;
   * the explicit dependency in `package.json` is there so the import does not
   * break the day that transitive version moves.
   */
  useEffect(() => {
    if (!navigating) {
      return;
    }

    void activateKeepAwakeAsync(NAVIGATION_WAKE_TAG);

    return () => {
      void deactivateKeepAwake(NAVIGATION_WAKE_TAG);
    };
  }, [navigating]);

  const close = useCallback(() => setChoice(NOTHING_CHOSEN), []);

  /**
   * A hostel chosen from the list rather than from its pin.
   *
   * It ends in exactly the state a pin tap ends in — that hostel selected, its
   * card open, no route — reached the other way round: the pin for a hostel you
   * searched for is often off screen, which is what made the old count pill a
   * dead end. So this centres as well as selects, at a zoom close enough to read
   * the street the hostel is on rather than the district it is in.
   *
   * The query is deliberately **not** cleared. Somebody searching "Baneshwor"
   * is usually looking through the answers, not at one of them, and a field that
   * empties itself makes them type it again to see the second.
   */
  const openResult = useCallback((hostel: PublicHostel) => {
    const point = hostelCoordinates(hostel);

    setChoice({ directions: false, id: hostel.id });

    if (point) {
      map.current?.center(point, 16);
    }

    // Blur closes the list (it hangs off `searching`); the dismiss is for
    // Android, where blurring a field does not always take the keyboard with it.
    field.current?.blur();
    Keyboard.dismiss();
  }, []);

  return (
    <View className="flex-1" style={{ backgroundColor: colors.background }}>
      <MapExplorer
        layer={layer}
        markers={markers}
        me={here}
        meAccuracyMeters={navigating ? guidance.accuracyMeters : null}
        meHeading={navigating ? guidance.heading : null}
        alternatives={alternatives}
        mode={mode}
        navigating={navigating}
        nearby={showAround && selected ? selected.nearbyPlaces : undefined}
        northUp={northUp}
        onSelect={(id) => {
          // A tap on empty map while a route is up is a pan that missed, not
          // "close everything" — Google keeps the route too. Only the card's
          // own Back / X (or another pin) leaves directions.
          if (id === null && (directions || navigating)) {
            return;
          }

          // Changing hostel drops the old route rather than leaving a line to
          // somewhere the card no longer describes.
          setChoice({ directions: false, id });
        }}
        onLongPress={(point) =>
          openConfirm({
            confirmLabel: "Set",
            message: "Hostels will show how long it takes from here. It is saved on this phone only.",
            onConfirm: () => {
              dispatch(setCommutePlace({ ...point, name: "Pinned place" }));
              setWithin(null);
            },
            title: "My college or office is here",
          })
        }
        onPickAlternative={(index) => {
          const other = others[index];

          if (other) {
            setPicked({ index: other.index, key: routeKey });
          }
        }}
        onTouched={() => {
          if (navigating) {
            setDetached(true);
          }
        }}
        ref={map}
        route={line}
        selectedId={selectedId}
      />

      {/*
        While navigating the top of the screen is the next turn, as in Google
        Maps — searching for another hostel mid-route is not a thing anyone does.
      */}
      {navigating && selected ? (
        <NavBanner guidance={guidance} hostel={selected} onHeight={setBannerHeight} />
      ) : null}

      {/* ---- the search field, floating over the map ---- */}
      {navigating ? null : (
        <View className="absolute left-0 right-0 px-4" style={{ top: insets.top + 8 }}>
          <View
            className="flex-row items-center gap-2 rounded-2xl border border-border px-3"
            style={{ backgroundColor: colors.card, height: 48 }}
          >
            <Pressable
              accessibilityLabel="Go back"
              accessibilityRole="button"
              hitSlop={8}
              onPress={() => router.back()}
            >
              <Ionicons color={colors.foreground} name="arrow-back" size={20} />
            </Pressable>

            <TextInput
              className="h-full flex-1 text-sm text-foreground"
              onBlur={() => setSearching(false)}
              onChangeText={setQuery}
              onFocus={() => setSearching(true)}
              placeholder="Search hostels on the map"
              placeholderTextColor={colors.mutedForeground}
              ref={field}
              returnKeyType="search"
              value={query}
            />

            {query ? (
              <Pressable
                accessibilityLabel="Clear search"
                accessibilityRole="button"
                hitSlop={8}
                onPress={() => setQuery("")}
              >
                <Ionicons color={colors.mutedForeground} name="close-circle" size={18} />
              </Pressable>
            ) : (
              <Ionicons color={colors.mutedForeground} name="search" size={18} />
            )}
          </View>

          {/*
            The results, as a list, once the typing has stopped.
            =================================================

            This was a count — "3 hostels" — on the reasoning that the pins *are*
            the results and a list over the map would cover the thing the search
            just changed. The second half of that is still true, which is why the
            list is capped at `MAX_RESULTS` and closes the moment anything is
            chosen; the first half was not. A pin is only a result you can act on
            if you can *see* it, and the hostel somebody just typed the name of is
            usually the one off the edge of the screen. The count told them it
            existed and gave them no way to reach it.

            It hangs off `searching` as well as the query so it is a thing that
            appears while you are looking for something, rather than a panel that
            sits on the map from the first keystroke until the box is emptied.

            While the first word is still being typed there is nothing worth
            showing — `search` is empty, so `matches` is the whole catalogue, and
            eight arbitrary hostels flashing up before the real answer is noise.
            Once there *is* an answer on screen, later keystrokes leave it there
            and let it change: a quarter-second of slightly stale rows reads as
            fast, and a quarter-second of "Searching…" between every letter reads
            as slow.
          */}
          {!searching ? (
          <View className="mt-2 flex-row gap-2">
            <Pressable
              accessibilityRole="button"
              className="flex-row items-center gap-1.5 rounded-full border border-border px-3 py-1.5 active:opacity-80"
              onPress={() => setPlaceSheet(true)}
              style={{ backgroundColor: colors.card, maxWidth: 220 }}
            >
              <Ionicons color={colors.primary} name="school-outline" size={14} />
              <Text className="text-xs font-semibold text-foreground" numberOfLines={1} variant={null}>
                {commute ? `To ${commute.name}` : "My college / office"}
              </Text>
            </Pressable>

            {commute ? (
              <Pressable
                accessibilityRole="button"
                className="flex-row items-center gap-1.5 rounded-full border px-3 py-1.5 active:opacity-80"
                onPress={() => setWithin((current) => (current === null ? 15 : current === 15 ? 30 : null))}
                style={{
                  backgroundColor: within ? colors.brandSoft : colors.card,
                  borderColor: within ? colors.primary : colors.border,
                }}
              >
                <Ionicons
                  color={within ? colors.primary : colors.mutedForeground}
                  name={mode === "foot" ? "walk-outline" : "car-outline"}
                  size={14}
                />
                <Text
                  className={`text-xs font-semibold ${within ? "text-primary" : "text-foreground"}`}
                  variant={null}
                >
                  {within ? `Within ${within} min` : "Any time"}
                </Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}

        {searching && query.trim() ? (
            <View
              className="mt-2 overflow-hidden rounded-2xl border border-border"
              style={{ backgroundColor: colors.card, maxHeight: RESULTS_MAX_HEIGHT }}
            >
              {settling && !search.trim() ? (
                <View className="px-3 py-3">
                  <Text variant="caption">Searching…</Text>
                </View>
              ) : matches.length === 0 ? (
                <View className="px-3 py-3">
                  <Text variant="muted">{`No hostels match "${search.trim()}"`}</Text>
                </View>
              ) : (
                <ScrollView
                  /*
                    Without this the first tap is spent dismissing the keyboard and
                    the row never fires — the classic "I had to tap it twice".
                  */
                  keyboardShouldPersistTaps="handled"
                  showsVerticalScrollIndicator={false}
                >
                  {matches.slice(0, MAX_RESULTS).map((hostel) => (
                    <ResultRow
                    commuteMinutes={minutesTo(hostel.id)}
                    hostel={hostel}
                    key={hostel.id}
                    me={me}
                    onPress={openResult}
                  />
                  ))}

                  {matches.length > MAX_RESULTS ? (
                    <View className="px-3 py-2">
                      <Text variant="caption">
                        {`${matches.length - MAX_RESULTS} more are on the map — type a little more to narrow it down.`}
                      </Text>
                    </View>
                  ) : null}
                </ScrollView>
              )}
            </View>
          ) : null}
        </View>
      )}

      {/* ---- map controls ---- */}
      <View
        className="absolute right-4 gap-2"
        style={{
          top: navigating ? Math.max(bannerHeight, insets.top + 96) + 12 : insets.top + 72,
        }}
      >
        <MapButton
          disabled={nearby.isBusy}
          label={navigating ? "Back to my position" : "Centre on me"}
          name="locate"
          onPress={() => {
            /*
             * While navigating this is the way back. The page stops following
             * the moment the reader drags or pinches — otherwise it would fight
             * them for the map — so something has to hand it back, and this is
             * the button that already means "put me on screen". `center` clears
             * that flag, so the next fix follows again.
             *
             * It re-centres at the navigation zoom rather than 15: coming back
             * mid-route to a wider view than the one being navigated is a second
             * surprise on top of the one they were fixing.
             */
            if (navigating) {
              recentre();
              return;
            }

            if (here) {
              map.current?.center(here, 15);
              return;
            }

            void nearby.enable();
          }}
        />
        {/* Framing the catalogue mid-route would only be undone by the next fix. */}
        {navigating ? null : (
          <MapButton
            label="Show every hostel"
            name="scan-outline"
            onPress={() => map.current?.fitAll()}
          />
        )}

        <MapButton
          active={layersOpen}
          label="Map style"
          name="layers-outline"
          onPress={() => setLayersOpen((open) => !open)}
        />

        {/*
          Only while navigating, because that is the only state where north is
          not up. A compass on a north-up map is a needle that never moves.
        */}
        {/* Remembered across trips, like Google's speaker button. */}
        {navigating ? (
          <MapButton
            label={voiceMuted ? "Turn voice on" : "Mute voice"}
            name={voiceMuted ? "volume-mute-outline" : "volume-high-outline"}
            onPress={() => dispatch(setNavigationVoiceMuted(!voiceMuted))}
          />
        ) : null}

        {navigating ? (
          <Compass
            facing={guidance.heading}
            northUp={northUp}
            onPress={() => setNorthUp((current) => !current)}
          />
        ) : null}

        {/*
          A panel rather than a cycling button: three sources, and a button that
          rotates through them hides what the other two are until you have
          pressed it twice.
        */}
        {layersOpen ? (
          <View
            className="absolute right-0 top-24 w-36 overflow-hidden rounded-2xl border border-border"
            style={{ backgroundColor: colors.card }}
          >
            {MAP_LAYERS.map((option) => (
              <Pressable
                accessibilityLabel={option.label}
                accessibilityRole="button"
                accessibilityState={{ selected: option.id === layer }}
                className="flex-row items-center gap-2 border-b border-border px-3 py-2.5 active:opacity-70"
                key={option.id}
                onPress={() => {
                  setLayer(option.id);
                  setLayersOpen(false);
                }}
              >
                <Ionicons
                  color={option.id === layer ? colors.primary : colors.mutedForeground}
                  name={option.id === layer ? "radio-button-on" : "radio-button-off"}
                  size={15}
                />

                <Text
                  className={option.id === layer ? "font-semibold text-primary" : ""}
                  variant="label"
                >
                  {option.label}
                </Text>
              </Pressable>
            ))}

            <Pressable
              accessibilityLabel="Places around the hostel"
              accessibilityRole="switch"
              accessibilityState={{ checked: showAround }}
              className="flex-row items-center gap-2 px-3 py-2.5 active:opacity-70"
              onPress={() => setShowAround((on) => !on)}
            >
              <Ionicons
                color={showAround ? colors.primary : colors.mutedForeground}
                name={showAround ? "checkbox" : "square-outline"}
                size={15}
              />
              <Text className={showAround ? "font-semibold text-primary" : ""} variant="label">
                Around
              </Text>
            </Pressable>
          </View>
        ) : null}
      </View>

      {/* ---- the selected hostel ---- */}
      {selected ? (
        <View
          className="absolute bottom-0 left-0 right-0 px-3"
          style={{ paddingBottom: Math.max(insets.bottom, 12) }}
        >
          {navigating && detached ? (
            <Pressable
              accessibilityRole="button"
              className="mb-2 flex-row items-center gap-1.5 self-start rounded-full border border-border px-4 py-2.5 active:opacity-80"
              onPress={recentre}
              style={{ backgroundColor: colors.card }}
            >
              <Ionicons color={colors.primary} name="navigate" size={16} />
              <Text className="font-semibold text-primary" variant="label">
                Re-centre
              </Text>
            </Pressable>
          ) : null}

          {gate && (nearGate || arrived) ? <GateCard guide={gate} /> : null}

          {navigating || arrived ? (
            <NavCard
              guidance={guidance}
              hostel={selected}
              offline={offline}
              onTell={
                signedIn && toldFor !== selected.id
                  ? () => {
                      const minutes = Math.max(1, Math.round((guidance.remainingSeconds ?? 600) / 60));

                      setTelling(true);
                      void announceArrival(selected.slug, minutes, mode)
                        .then(() => {
                          setToldFor(selected.id);
                          toastSuccess("Hostel told", `They know you are about ${minutes} min away.`);
                        })
                        .catch(() => toastError("Could not reach the hostel"))
                        .finally(() => setTelling(false));
                    }
                  : undefined
              }
              telling={telling}
              told={toldFor === selected.id}
              onStop={arrived ? finishArrival : guidance.stop}
            />
          ) : directions ? (
            <RouteCard
              canStart={Boolean(me && chosen)}
              choices={routes}
              chosen={chosenIndex}
              distance={chosen?.distanceMeters ?? straightLine}
              exact={Boolean(chosen)}
              hostel={selected}
              loading={roads.loading || roads.refreshing}
              me={me}
              mode={mode}
              nearby={nearby}
              onBack={() => setChoice({ directions: false, id: selectedId })}
              onClose={close}
              onChoose={(index) => setPicked({ index, key: routeKey })}
              onMode={setMode}
              guidanceStatus={guidance.status}
              onStart={startGuidance}
              seconds={chosen?.durationSeconds ?? 0}
              starting={guidance.status === "starting"}
            />
          ) : (
            <PreviewCard
              commute={
                commute && minutesTo(selected.id)
                  ? `${minutesTo(selected.id)} min ${mode === "foot" ? "walk" : "drive"} to ${commute.name}`
                  : null
              }
              distance={
                me && destination ? haversineMeters(me, destination) : null
              }
              hostel={selected}
              onClose={close}
              onDirections={() => setChoice({ directions: true, id: selectedId })}
              saved={saved.ids.has(selected.id)}
              onToggleSave={saved.toggle}
            />
          )}
        </View>
      ) : null}

      <PlaceSheet
        current={commute}
        onClear={() => {
          dispatch(setCommutePlace(null));
          setWithin(null);
          setPlaceSheet(false);
        }}
        onClose={() => setPlaceSheet(false)}
        onPick={(place) => {
          dispatch(setCommutePlace(place));
          setPlaceSheet(false);
        }}
        open={placeSheet}
      />
    </View>
  );
}

/**
 * "My college / office": search by name, or long-press the map. The place is
 * kept on this phone; the search goes through our server's geocoder proxy.
 */
function PlaceSheet({
  current,
  onClear,
  onClose,
  onPick,
  open,
}: {
  current: { lat: number; lng: number; name: string } | null;
  onClear: () => void;
  onClose: () => void;
  onPick: (place: { lat: number; lng: number; name: string }) => void;
  open: boolean;
}) {
  const { colors } = useAppTheme();
  const [text, setText] = useState("");
  const settled = useDebouncedValue(text.trim(), 600);
  const [results, setResults] = useState<{ lat: number; lng: number; name: string }[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (settled.length < 3) {
      return;
    }

    let live = true;

    void Promise.resolve()
      .then(() => {
        if (live) setBusy(true);
        return searchPlaces(settled);
      })
      .then((places) => {
        if (live) setResults(places);
      })
      .catch(() => {
        if (live) setResults([]);
      })
      .finally(() => {
        if (live) setBusy(false);
      });

    return () => {
      live = false;
    };
  }, [settled]);

  return (
    // Tall: a search whose answers arrive under the field needs the room, and
    // the sheet's own keyboard handling keeps the field above the keyboard.
    <Sheet onClose={onClose} open={open} tall title="My college or office">
      <View className="gap-3 pb-2">
        <Input
          hint="Every hostel then shows how long it takes from there. Or long-press the map to drop a pin."
          label="Search"
          onChangeText={setText}
          placeholder="e.g. Pulchowk Campus"
          value={text}
        />

        {busy ? <Text variant="caption">Searching…</Text> : null}

        {settled.length >= 3 && !busy && results.length === 0 ? (
          <Text variant="muted">{`Nothing found for "${settled}".`}</Text>
        ) : null}

        {results.map((place) => (
          <Pressable
            accessibilityRole="button"
            className="flex-row items-center gap-3 rounded-2xl border border-border px-3 py-2.5 active:opacity-70"
            key={`${place.lat},${place.lng}`}
            onPress={() => onPick({ ...place, name: place.name.split(",")[0] ?? place.name })}
          >
            <Ionicons color={colors.primary} name="school-outline" size={16} />
            <Text className="flex-1" numberOfLines={2} variant="label">
              {place.name}
            </Text>
          </Pressable>
        ))}

        {current ? (
          <Button label={`Clear "${current.name}"`} onPress={onClear} variant="ghost" />
        ) : null}
      </View>
    </Sheet>
  );
}

/**
 * Which way is north, and which way the reader is facing.
 *
 * Two readings in one control. The needle points at true north on the screen —
 * so it is upright on a north-up map and turns as the map turns — and the two
 * letters under it say where the *device* is pointing, which is the question
 * "am I walking the right way" actually asks. Eight points only; see
 * `cardinalFor`.
 *
 * Tapping it locks the map north-up and tapping again lets it follow the
 * heading, which is what the same button does in every other map application.
 */
function Compass({
  facing,
  northUp,
  onPress,
}: {
  /** The device's heading, or null before the compass has settled. */
  facing: number | null;
  northUp: boolean;
  onPress: () => void;
}) {
  const { colors } = useAppTheme();

  // The map is rotated by minus the heading, so north on screen is at minus
  // that again — which is the heading itself, unless the map is locked north-up
  // and north is simply up.
  const needle = northUp || facing === null ? 0 : -facing;

  return (
    <Pressable
      accessibilityLabel={northUp ? "Follow the direction I am facing" : "Face north"}
      accessibilityRole="button"
      accessibilityState={{ selected: northUp }}
      className="h-11 w-11 items-center justify-center rounded-full border border-border active:opacity-70"
      onPress={onPress}
      style={{ backgroundColor: colors.card }}
    >
      <Ionicons
        color={colors.primary}
        name="navigate"
        size={15}
        // Ionicons' navigate glyph points up-right; the -45 makes it point up,
        // and the needle rotation is applied on top of that.
        style={{ transform: [{ rotate: `${needle - 45}deg` }] }}
      />

      <Text className="text-[9px] font-bold text-muted-foreground">
        {facing === null ? "—" : cardinalFor(facing)}
      </Text>
    </Pressable>
  );
}

function MapButton({
  active = false,
  disabled = false,
  label,
  name,
  onPress,
}: {
  /** Drawn as pressed while the thing it opens is open. */
  active?: boolean;
  disabled?: boolean;
  label: string;
  name: keyof typeof Ionicons.glyphMap;
  onPress: () => void;
}) {
  const { colors } = useAppTheme();

  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ disabled, expanded: active }}
      className="h-11 w-11 items-center justify-center rounded-full border border-border active:opacity-70"
      disabled={disabled}
      onPress={onPress}
      style={{
        backgroundColor: active ? colors.brandSoft : colors.card,
        opacity: disabled ? 0.6 : 1,
      }}
    >
      <Ionicons color={active ? colors.primary : colors.foreground} name={name} size={19} />
    </Pressable>
  );
}

/**
 * One search result: enough to tell two hostels apart, and nothing more.
 *
 * Name, place, distance, price — the four things somebody scanning a list of
 * hostels with similar names is actually choosing between. Not a photograph:
 * this list is a step on the way to the card that has eight of them, and a row
 * tall enough for a thumbnail is a list that fits three answers instead of eight.
 *
 * The distance is only drawn when there is a fix, and it is the straight-line
 * one — the same number the cards elsewhere in the app show, computed the same
 * way (`haversineMeters`), so a hostel does not change how far away it is
 * depending on which screen is asking. The routed distance costs a network
 * request per row and belongs on the one hostel that gets chosen.
 */
function ResultRow({
  commuteMinutes,
  hostel,
  me,
  onPress,
}: {
  /** Minutes to the reader's college or office, when one is set. */
  commuteMinutes: number | null;
  hostel: PublicHostel;
  /** The device, when it has a fix. Its absence simply drops the distance. */
  me: Coordinates | null;
  onPress: (hostel: PublicHostel) => void;
}) {
  const { colors } = useAppTheme();

  const point = hostelCoordinates(hostel);
  const distance = me && point ? haversineMeters(me, point) : null;

  return (
    <Pressable
      accessibilityLabel={hostel.name}
      accessibilityRole="button"
      className="flex-row items-center gap-3 border-b border-border px-3 py-2.5 active:opacity-70"
      onPress={() => onPress(hostel)}
    >
      <View
        className="h-8 w-8 items-center justify-center rounded-full"
        style={{ backgroundColor: colors.brandSoft }}
      >
        <Ionicons color={colors.primary} name="location" size={15} />
      </View>

      <View className="flex-1 gap-0.5">
        <Text className="font-semibold" numberOfLines={1} variant="label">
          {hostel.name}
        </Text>

        <Text numberOfLines={1} variant="caption">
          {[
            locationLabel(hostel.location) || "Location not published",
            distance === null ? null : formatDistance(distance),
            commuteMinutes === null ? null : `${commuteMinutes} min to your place`,
          ]
            .filter(Boolean)
            .join(" · ")}
        </Text>
      </View>

      <Text className="text-xs font-bold text-primary">{priceRange(hostel.pricing)}</Text>
    </Pressable>
  );
}

/**
 * The card a pin opens: enough to decide, and two ways onward.
 *
 * The photo strip is the part worth explaining. It is `expo-image` in a native
 * `ScrollView`, not `<img>` inside the map page — so it scrolls at native speed,
 * shares the cache with every other card in the app, and cannot block the map's
 * own gestures. A hostel with no photographs gets a single placeholder tile
 * rather than a collapsed row, because a card that changes height depending on
 * the listing is a card that jumps as you tap between pins.
 */
function PreviewCard({
  commute,
  distance,
  hostel,
  onClose,
  onDirections,
  onToggleSave,
  saved,
}: {
  /** "12 min walk to IOE Pulchowk", when a place is set. */
  commute: string | null;
  distance: number | null;
  hostel: PublicHostel;
  onClose: () => void;
  onDirections: () => void;
  onToggleSave: (hostel: PublicHostel) => void;
  saved: boolean;
}) {
  const { colors } = useAppTheme();

  const rating = ratingDisplay(hostel.ratingSummary);
  const photos = hostel.photos
    .map((photo) => absoluteMediaUrl(photo.url, API_BASE_URL))
    .filter((uri): uri is string => Boolean(uri))
    .slice(0, 8);

  return (
    <View
      className="gap-3 rounded-3xl border border-border p-3"
      style={{ backgroundColor: colors.card }}
    >
      <ScrollView
        contentContainerStyle={{ gap: 8 }}
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ height: PHOTO_STRIP_HEIGHT }}
      >
        {photos.length > 0 ? (
          photos.map((uri) => (
            <Image
              contentFit="cover"
              key={uri}
              source={{ uri }}
              style={{
                backgroundColor: colors.muted,
                borderRadius: 14,
                height: PHOTO_STRIP_HEIGHT,
                width: 148,
              }}
              transition={120}
            />
          ))
        ) : (
          <View
            className="items-center justify-center rounded-2xl"
            style={{
              backgroundColor: colors.muted,
              height: PHOTO_STRIP_HEIGHT,
              width: 148,
            }}
          >
            <Ionicons color={colors.mutedForeground} name="image-outline" size={22} />
          </View>
        )}
      </ScrollView>

      <View className="flex-row items-start gap-2">
        <View className="flex-1 gap-0.5">
          <Text className="font-bold" numberOfLines={1} variant="subtitle">
            {hostel.name}
          </Text>

          <View className="flex-row items-center gap-1">
            <Ionicons color={colors.mutedForeground} name="location-outline" size={12} />
            <Text className="flex-1" numberOfLines={1} variant="caption">
              {locationLabel(hostel.location) || "Location not published"}
            </Text>
          </View>
        </View>

        <SaveButton hostel={hostel} onToggle={onToggleSave} saved={saved} />

        <Pressable
          accessibilityLabel="Close"
          accessibilityRole="button"
          className="h-9 w-9 items-center justify-center rounded-full active:opacity-70"
          hitSlop={6}
          onPress={onClose}
          style={{ backgroundColor: colors.muted }}
        >
          <Ionicons color={colors.foreground} name="close" size={16} />
        </Pressable>
      </View>

      <View className="flex-row flex-wrap items-center gap-2">
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

        <Text className="text-xs font-semibold text-foreground">
          {HOSTEL_TYPE_LABELS[hostel.hostelType]}
        </Text>

        {distance !== null ? (
          <Text variant="caption">{`${formatDistance(distance)} from you`}</Text>
        ) : null}

        {commute ? (
          <View className="flex-row items-center gap-1">
            <Ionicons color={colors.primary} name="school-outline" size={11} />
            <Text className="text-xs font-semibold text-primary" variant={null}>
              {commute}
            </Text>
          </View>
        ) : null}
      </View>

      <View className="flex-row flex-wrap items-center gap-x-3 gap-y-1">
        <Text className="text-sm font-bold text-primary">{priceRange(hostel.pricing)}</Text>
        <Text variant="caption">/month</Text>

        {hostel.facilities.slice(0, 3).map((facility) => (
          <View className="flex-row items-center gap-1" key={facility}>
            <Ionicons
              color={colors.mutedForeground}
              name={facilityIcon(facility)}
              size={11}
            />
            <Text className="text-[10px] text-muted-foreground">{facility}</Text>
          </View>
        ))}
      </View>

      <View className="flex-row gap-2">
        <View className="flex-1">
          <Button label="Directions" onPress={onDirections} />
        </View>
        <View className="flex-1">
          <Button
            label="View details"
            onPress={() => router.push(`/hostel/${hostel.slug}`)}
            variant="outline"
          />
        </View>
      </View>
    </View>
  );
}

/**
 * Directions, once a hostel is chosen: how far, how long, and by what.
 *
 * The distance shown is the routed one when there is a route and the
 * straight-line one when there is not — and the wording changes with it, because
 * "5.3 km on foot" and "2.6 km in a straight line" are different claims and the
 * dashed line on the map is already saying which one is on screen.
 */
function RouteCard({
  canStart,
  choices,
  chosen,
  distance,
  exact,
  guidanceStatus,
  hostel,
  loading,
  me,
  mode,
  nearby,
  onBack,
  onChoose,
  onClose,
  onMode,
  onStart,
  seconds,
  starting,
}: {
  /** A fix **and** a road route. Neither alone is something to navigate along. */
  canStart: boolean;
  /** Every route the router offered, best first. Two or more get a picker. */
  choices: RoadRoute[];
  chosen: number;
  distance: number | null;
  /** True when the number came from the router rather than from haversine. */
  exact: boolean;
  /** How the last attempt to start guidance ended, if there was one. */
  guidanceStatus: GuidanceStatus;
  hostel: PublicHostel;
  loading: boolean;
  /** The device. Its absence is the whole difference between this card's two states. */
  me: Coordinates | null;
  mode: RouteMode;
  nearby: ReturnType<typeof useNearby>;
  onBack: () => void;
  onChoose: (index: number) => void;
  onClose: () => void;
  onMode: (mode: RouteMode) => void;
  onStart: () => void;
  seconds: number;
  /** Permission asked, or waiting on the first fix. */
  starting: boolean;
}) {
  const { colors } = useAppTheme();

  const minutes = Math.max(1, Math.round(seconds / 60));
  const blocked = nearby.status === "blocked" || guidanceStatus === "blocked";

  /*
   * Why Start is not going to work, when it is not.
   *
   * Four ways this screen can fail to navigate — refused, blocked, no fix, no
   * route — and each gets its own sentence, because "it didn't work" leaves the
   * reader tapping a grey button. The `me === null` branch below already covers
   * the case where there is no position at all, along with the action that
   * fixes it; this line is for everything that is only discovered once Start
   * has been pressed, plus the one case where there is a fix but no road.
   */
  const trouble =
    guidanceStatus === "denied"
      ? "Navigation needs your location and the request was refused. Press Start to ask again."
      : guidanceStatus === "blocked"
        ? "Location is blocked for this app, so navigation cannot follow you. Open settings to allow it."
        : guidanceStatus === "unavailable"
          ? "No position came back — check that location is switched on, then press Start again."
          : me && !exact && !loading
            ? "There is no road route to this hostel, so there is nothing to navigate along."
            : null;

  return (
    <View
      className="gap-3 rounded-3xl border border-border p-3"
      style={{ backgroundColor: colors.card }}
    >
      <View className="flex-row items-center gap-2">
        <Pressable
          accessibilityLabel="Back to the hostel"
          accessibilityRole="button"
          className="h-9 w-9 items-center justify-center rounded-full active:opacity-70"
          hitSlop={6}
          onPress={onBack}
          style={{ backgroundColor: colors.muted }}
        >
          <Ionicons color={colors.foreground} name="arrow-back" size={16} />
        </Pressable>

        <Text className="flex-1 font-bold" numberOfLines={1} variant="label">
          {hostel.name}
        </Text>

        <Pressable
          accessibilityLabel="Close"
          accessibilityRole="button"
          className="h-9 w-9 items-center justify-center rounded-full active:opacity-70"
          hitSlop={6}
          onPress={onClose}
          style={{ backgroundColor: colors.muted }}
        >
          <Ionicons color={colors.foreground} name="close" size={16} />
        </Pressable>
      </View>

      {/*
        The toggle, and the way in. Two graphs, two genuinely different answers
        — see routing.ts — and Start beside them rather than under the numbers,
        because the profile is the thing you choose *before* setting off and
        this keeps the pair in one row.

        Start is disabled until there is both a fix and a route: without a
        position there is nothing to follow, and without a route there is
        nothing to follow it along. A Start button that spins forever is the one
        outcome worth designing out.
      */}
      <View className="flex-row items-center gap-2">
        <View
          className="flex-1 flex-row gap-1 rounded-2xl p-1"
          style={{ backgroundColor: colors.muted }}
        >
          <ModeTab active={mode === "car"} icon="car-outline" label="Vehicle" onPress={() => onMode("car")} />
          <ModeTab active={mode === "foot"} icon="walk-outline" label="Walk" onPress={() => onMode("foot")} />
        </View>

        <Button
          disabled={!canStart}
          label="Start"
          loading={starting}
          onPress={onStart}
          size="sm"
        />
      </View>

      {/*
        Route choices, as Google offers them: time first, distance under it.
        The same choices are the grey lines on the map, and either one picks.
      */}
      {choices.length > 1 ? (
        <View className="flex-row gap-2">
          {choices.map((choice, index) => {
            const on = index === chosen;

            return (
              <Pressable
                accessibilityLabel={`Route ${index + 1}`}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                className="flex-1 items-center rounded-xl border px-2 py-1.5 active:opacity-80"
                key={index}
                onPress={() => onChoose(index)}
                style={{
                  backgroundColor: on ? colors.brandSoft : "transparent",
                  borderColor: on ? colors.primary : colors.border,
                }}
              >
                <Text
                  className={`text-sm font-bold ${on ? "text-primary" : "text-foreground"}`}
                  variant={null}
                >
                  {`${Math.max(1, Math.round(choice.durationSeconds / 60))} min`}
                </Text>
                <Text variant="caption">{formatDistance(choice.distanceMeters)}</Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}

      {trouble ? (
        <View className="flex-row items-start gap-2">
          <Ionicons
            color={colors.mutedForeground}
            name="alert-circle-outline"
            size={14}
            style={{ marginTop: 2 }}
          />

          <Text className="flex-1" variant="caption">
            {trouble}
          </Text>
        </View>
      ) : null}

      {/*
        Blocked *with* a fix already in hand — permission revoked after this
        screen read a position. The branch below only offers Settings when there
        is no position at all, so without this the message names an action the
        reader has no way to take.
      */}
      {blocked && me ? (
        <Button label="Open settings" onPress={nearby.openSettings} size="sm" variant="outline" />
      ) : null}

      {me ? (
        <View className="gap-0.5">
          <View className="flex-row items-center gap-2">
            <Ionicons color={colors.primary} name="navigate" size={15} />
            <Text className="text-lg font-bold text-foreground">
              {distance === null
                ? "—"
                : exact
                  ? `${formatDistance(distance)} ${mode === "foot" ? "on foot" : "by road"}`
                  : `${formatDistance(distance)} in a straight line`}
            </Text>
          </View>

          <Text variant="caption">
            {loading
              ? "Tracing the route…"
              : exact
                ? `About ${minutes} min ${mode === "foot" ? "walking" : "driving"}`
                : "No route came back, so this is the direct distance — the dashed line above."}
          </Text>
        </View>
      ) : (
        <View className="gap-2">
          <Text variant="muted">
            {blocked
              ? "Location is switched off for this app, so there is nothing to measure from."
              : "Turn on location to draw the way there. Your position is used on this screen and never saved."}
          </Text>

          <Button
            label={blocked ? "Open settings" : "Use my location"}
            loading={nearby.isBusy}
            onPress={() => {
              if (blocked) {
                nearby.openSettings();
                return;
              }

              void nearby.enable();
            }}
            variant="outline"
          />
        </View>
      )}
    </View>
  );
}

/**
 * The bottom card while guiding — the trip, and a way out — and the arrival.
 *
 * The maneuver itself is `NavBanner`, across the top. Ending is one tap on the
 * round X, always in the same corner, so it cannot be missed while moving.
 */
function NavCard({
  guidance,
  hostel,
  offline,
  onStop,
  onTell,
  telling,
  told,
}: {
  guidance: Guidance;
  hostel: PublicHostel;
  offline: "saving" | "saved" | null;
  onStop: () => void;
  /** "I'm on my way" to the hostel's staff. Absent when signed out or already sent. */
  onTell?: () => void;
  telling: boolean;
  told: boolean;
}) {
  const { colors } = useAppTheme();

  const { arrivesAt, remainingMeters, remainingSeconds, rerouting, stale, status } = guidance;
  const minutes = remainingSeconds === null ? null : Math.max(1, Math.round(remainingSeconds / 60));

  /*
   * Arrived. The hook has already taken both subscriptions down and the map has
   * turned back to north-up, so all that is left is to say so and get out of
   * the way — one button, which lands on the hostel's own card.
   */
  if (status === "arrived") {
    return (
      <View
        className="gap-3 rounded-3xl border border-border p-3"
        style={{ backgroundColor: colors.card }}
      >
        <View className="flex-row items-center gap-3">
          <View
            className="h-12 w-12 items-center justify-center rounded-2xl"
            style={{ backgroundColor: colors.brandSoft }}
          >
            <Ionicons color={colors.primary} name="flag" size={26} />
          </View>

          <View className="flex-1 gap-0.5">
            <Text className="text-xl font-bold text-foreground">You have arrived</Text>

            <Text numberOfLines={2} variant="muted">
              {hostel.name}
            </Text>
          </View>
        </View>

        <Button label="Done" onPress={onStop} />
      </View>
    );
  }

  const cover = hostel.photos
    .map((photo) => absoluteMediaUrl(photo.url, API_BASE_URL))
    .find((uri): uri is string => Boolean(uri));

  /*
   * The hostel's own sheet, still there while guiding — as Google keeps the
   * place card under the turn banner — with the way out as a labelled button
   * rather than a lone X that reads as "close this card". The next turn is not
   * here; it is the banner across the top.
   *
   * The one line that can replace the totals is `stale`: the reader is off the
   * route and no replacement came back, so what is drawn is a route from where
   * they were — saying that plainly is the whole point, because the
   * alternative is a line that quietly stops being guidance.
   */
  return (
    <View
      className="gap-3 rounded-3xl border border-border p-3"
      style={{ backgroundColor: colors.card }}
    >
      <View className="flex-row items-center gap-3">
        {cover ? (
          <Image
            contentFit="cover"
            source={{ uri: cover }}
            style={{ borderRadius: 14, height: 48, width: 48 }}
          />
        ) : (
          <View
            className="h-12 w-12 items-center justify-center rounded-2xl"
            style={{ backgroundColor: colors.brandSoft }}
          >
            <Ionicons color={colors.primary} name="business-outline" size={22} />
          </View>
        )}

        <View className="flex-1 gap-0.5">
          <Text className="font-bold" numberOfLines={1} variant="label">
            {hostel.name}
          </Text>
          <Text numberOfLines={1} variant="caption">
            {locationLabel(hostel.location)}
          </Text>
        </View>

        <Text className="text-xl font-bold text-primary" variant={null}>
          {minutes === null ? "On the way" : `${minutes} min`}
        </Text>
      </View>

      <View className="gap-0.5">
        <Text numberOfLines={2} variant="caption">
          {rerouting
            ? "Off the route — finding a new one…"
            : stale
              ? "Off the route, and no new one came back. The line is from where you were."
              : [
                  remainingMeters === null ? null : formatDistance(remainingMeters),
                  arrivesAt === null ? null : `arrive ${formatTime(new Date(arrivesAt))}`,
                  offline === "saved" ? "map saved offline" : null,
                ]
                  .filter(Boolean)
                  .join(" · ") || `Heading to ${hostel.name}`}
        </Text>
      </View>

      <View className="flex-row gap-2">
        <Button
          className="flex-1"
          label="Exit"
          onPress={onStop}
          size="sm"
          variant="danger"
        />

        {onTell || told ? (
          <Button
            className="flex-1"
            disabled={!onTell || telling}
            label={told ? "Hostel told" : "Tell hostel"}
            loading={telling}
            onPress={onTell}
            size="sm"
            variant="outline"
          />
        ) : null}
      </View>
    </View>
  );
}

/**
 * The next turn, across the top of the screen — where Google Maps puts it, and
 * painted like every accent header here: a brand block with rounded bottom
 * corners. Everything on it is sized for a one-second glance from a pavement:
 * the turn arrow, the distance to it, and the street.
 */
function NavBanner({
  guidance,
  hostel,
  onHeight,
}: {
  guidance: Guidance;
  hostel: PublicHostel;
  /** The map controls hang below it. */
  onHeight: (height: number) => void;
}) {
  const { colors } = useAppTheme();
  const insets = useSystemInsets();
  const { status, step } = guidance;

  return (
    <View
      className="absolute left-0 right-0 top-0 flex-row items-center gap-3 rounded-b-3xl px-4 pb-4"
      onLayout={(event) => onHeight(event.nativeEvent.layout.height)}
      style={{ backgroundColor: colors.primary, paddingTop: insets.top + 12 }}
    >
      <MaterialIcons color={colors.primaryForeground} name={maneuverIcon(step?.step)} size={44} />

      <View className="flex-1 gap-0.5">
        <Text className="text-2xl font-bold text-primary-foreground" variant={null}>
          {status === "starting"
            ? "Finding you…"
            : step
              ? formatManeuverDistance(step.distanceMeters)
              : "On the way"}
        </Text>

        <Text
          className="text-base font-semibold text-primary-foreground"
          numberOfLines={2}
          variant={null}
        >
          {step ? instructionFor(step.step) : `Follow the route to ${hostel.name}`}
        </Text>
      </View>
    </View>
  );
}

/**
 * "Find the gate" — the hostel's own note and photo of its entrance, shown in
 * the last 200 m and on arrival. Kathmandu addresses stop a few lanes short.
 */
function GateCard({ guide }: { guide: { note: string; photoUrl: string } }) {
  const { colors } = useAppTheme();
  const photo = guide.photoUrl ? absoluteMediaUrl(guide.photoUrl, API_BASE_URL) : null;

  return (
    <View
      className="mb-2 flex-row items-center gap-3 rounded-3xl border border-border p-2.5"
      style={{ backgroundColor: colors.card }}
    >
      {photo ? (
        <Image
          contentFit="cover"
          source={{ uri: photo }}
          style={{ backgroundColor: colors.muted, borderRadius: 14, height: 64, width: 64 }}
        />
      ) : (
        <View
          className="h-16 w-16 items-center justify-center rounded-2xl"
          style={{ backgroundColor: colors.brandSoft }}
        >
          <Ionicons color={colors.primary} name="flag" size={24} />
        </View>
      )}

      <View className="flex-1 gap-0.5">
        <Text className="font-bold" variant="label">
          Finding the gate
        </Text>
        <Text numberOfLines={3} variant="caption">
          {guide.note || "Look for the entrance in the photo."}
        </Text>
      </View>
    </View>
  );
}

/**
 * The maneuver as a Material turn arrow — Google's own set, the one Maps
 * draws: slight, plain and sharp turns, forks, merges, roundabouts. The words
 * underneath still carry the street and the exit number.
 */
function maneuverIcon(step: RouteStep | undefined): keyof typeof MaterialIcons.glyphMap {
  if (!step) {
    return "straight";
  }

  const { modifier = "", type } = step.maneuver;
  const side = modifier.includes("left") ? "left" : "right";

  if (type === "arrive") {
    return "place";
  }

  if (type === "roundabout" || type === "rotary") {
    return side === "left" ? "roundabout-left" : "roundabout-right";
  }

  if (modifier === "uturn") {
    return "u-turn-left";
  }

  if (type === "fork") {
    return side === "left" ? "fork-left" : "fork-right";
  }

  if (type === "merge") {
    return "merge";
  }

  if (!modifier.includes("left") && !modifier.includes("right")) {
    return "straight";
  }

  if (modifier.startsWith("slight")) {
    return side === "left" ? "turn-slight-left" : "turn-slight-right";
  }

  if (modifier.startsWith("sharp")) {
    return side === "left" ? "turn-sharp-left" : "turn-sharp-right";
  }

  return side === "left" ? "turn-left" : "turn-right";
}

function ModeTab({
  active,
  icon,
  label,
  onPress,
}: {
  active: boolean;
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
}) {
  const { colors } = useAppTheme();

  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      className="h-9 flex-1 flex-row items-center justify-center gap-1.5 rounded-xl active:opacity-80"
      onPress={onPress}
      style={{ backgroundColor: active ? colors.card : "transparent" }}
    >
      <Ionicons
        color={active ? colors.primary : colors.mutedForeground}
        name={icon}
        size={15}
      />
      <Text
        className={`text-xs font-semibold ${active ? "text-primary" : "text-muted-foreground"}`}
      >
        {label}
      </Text>
    </Pressable>
  );
}
