"use client";

import {
  ArrowLeft,
  ArrowUp,
  Car,
  CircleAlert,
  CornerUpLeft,
  CornerUpRight,
  Flag,
  Footprints,
  Layers,
  LocateFixed,
  Maximize,
  MapPin,
  Minus,
  Navigation,
  Plus,
  RotateCw,
  Search,
  Star,
  X,
} from "@/components/icons";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { MapHandle, MapMarker } from "@/components/maps/map-canvas";
import { MediaLightbox, type LightboxItem } from "@/components/media-lightbox";
import { useDeviceLocation, type DeviceLocation } from "@/hooks/use-device-location";
import { useGuidance, type Guidance, type GuidanceStatus } from "@/hooks/use-guidance";
import { useHostels } from "@/hooks/use-hostels";
import { formatDistance, hostelCoordinates } from "@/lib/maps/geo";
import { searchHostels } from "@/lib/maps/hostel-search";
import { MAP_LAYERS, type MapLayerId } from "@/lib/maps/layers";
import { cardinalFor, formatManeuverDistance, instructionFor } from "@/lib/maps/navigation";
import { haversineMeters } from "@/lib/maps/nearby";
import {
  fetchRoadRoute,
  type RoadRoute,
  type RouteMode,
  type RouteStep,
} from "@/lib/maps/routing";
import type { Coordinates } from "@/lib/maps/types";
import { cn } from "@/lib/utils";

import {
  DEFAULT_HOSTEL_IMAGE,
  mapPublicHostelToSummary,
  type PublicHostel,
} from "./public-hostel-data";
import { formatMoney, PublicShell } from "./shared";

/**
 * The whole catalogue on one map: search, pick, and find the way.
 *
 * ## It is not the browse page's map, and the difference matters
 *
 * `/hostels` plots the rows a set of filters produced — type, facility, budget,
 * city — and is a view onto a *result set*. This is the whole catalogue,
 * searched by name and place, and it is the only page that routes. Merging them
 * would mean one screen whose pins mean different things depending on how it was
 * opened.
 *
 * ## Everything on it is the platform's own catalogue
 *
 * Pins, results and the panel are all `/public/hostels` — the same payload the
 * browse page renders. There is no place search, no geocoder and no third-party
 * POI layer: a map that finds "hostels near Baneshwor" and offers you one that
 * is not on the platform is a map that sends people somewhere the app cannot
 * help them. Searching narrows what is already here.
 *
 * ## It reads like Google Maps, not like the phone screen scaled up
 *
 * A full-viewport map with floating panels over it: the search card top-left,
 * one panel under it that changes contents — results, then the hostel, then
 * directions, then the guidance card — and the controls stacked on the right.
 * Below `md` the panel becomes a bottom sheet, which is what Google Maps itself
 * does on a narrow window.
 *
 * ## What a browser cannot do, it says
 *
 * Rotation needs a compass and a laptop has none, so on a desktop the map stays
 * north-up, the compass control reads `—` and nothing looks broken. Geolocation
 * needs a secure context, and where there is none the panel says so rather than
 * leaving Start to fail as "no position". See `WEB_MAP_PLAN.md` §4.2.
 */

/**
 * Leaflet touches `window` at import time, so the canvas is only ever loaded in
 * the browser. The `ref` below reaches it through this wrapper because React 19
 * passes `ref` as an ordinary prop, which `next/dynamic` spreads into the lazy
 * component — on React 18 this would have needed a callback prop instead.
 */
const MapCanvas = dynamic(
  () => import("@/components/maps/map-canvas").then((mod) => mod.MapCanvas),
  {
    loading: () => <div className="absolute inset-0 animate-pulse bg-muted" />,
    ssr: false,
  },
);

/**
 * How long the reader has to stop typing before the map answers.
 *
 * Under about 150ms is indistinguishable from no debounce at all — the work
 * still happens per keystroke for anyone typing at a normal speed. Over about
 * 400ms and the reader has finished the word, looked up, and started wondering.
 */
const SEARCH_DEBOUNCE_MS = 250;

/**
 * Rows in the result list before it stops and says how many are left.
 *
 * The list floats over the map, and the map is the thing the search just
 * changed: sixty rows would cover every pin they refer to.
 */
const MAX_RESULTS = 8;

/**
 * How close the map sits while navigating. Close enough to tell one junction
 * from the next, which is the only question the map is being asked by then.
 */
const NAVIGATION_ZOOM = 17;

const HOSTEL_TYPE_LABELS: Record<PublicHostel["hostelType"], string> = {
  BOYS: "Boys",
  CO_LIVING: "Co-living",
  GIRLS: "Girls",
};

/** What is open on the map: a hostel, and whether its route is being drawn. */
type Choice = { directions: boolean; id: string | null };

/** The state before anybody has chosen anything, and after they close the panel. */
const NOTHING_CHOSEN: Choice = { directions: false, id: null };

export function PublicMapPage() {
  const searchParams = useSearchParams();
  const slug = searchParams?.get("slug") ?? null;
  const routeParam = searchParams?.get("route") ?? null;

  const map = useRef<MapHandle>(null);
  const { data, isLoading } = useHostels();
  const nearby = useDeviceLocation();
  const me = nearby.coordinates;

  const [query, setQuery] = useState("");
  /*
   * Whether the field has the caret. The result list hangs off this as well as
   * off the query, so that choosing a result — or clicking the map — puts the
   * map back on screen whole, rather than leaving eight hostels floating over
   * the one just chosen.
   */
  const [searching, setSearching] = useState(false);
  const [mode, setMode] = useState<RouteMode>("car");
  const [layer, setLayer] = useState<MapLayerId>("standard");
  const [layersOpen, setLayersOpen] = useState(false);
  /*
   * `null` means "the reader has not chosen anything yet", which is different
   * from having chosen nothing — the first falls back to the hostel in the URL,
   * the second is an empty map after they closed the panel. Derived rather than
   * synced in an effect: a `setState` in an effect watching the deep-linked
   * hostel re-opens the panel every time the payload refreshes, and fights the
   * reader for the selection.
   */
  const [choice, setChoice] = useState<Choice | null>(null);

  const all = useMemo(() => data?.hostels ?? [], [data]);

  /*
   * Only hostels with coordinates get a pin — an un-geocoded listing has no
   * place on a map, and putting it at 0,0 would drag the whole view into the
   * Gulf of Guinea. It is still reachable everywhere else on the site.
   */
  const placed = useMemo(
    () => all.filter((hostel) => hostelCoordinates(hostel) !== null),
    [all],
  );

  /*
   * Two values, and the difference between them is the whole point.
   *
   * `query` is the field: it must never lag, because an input bound to
   * debounced state drops characters and jumps the caret. `search` is what the
   * *map* is asked for, and it only moves once the reader has stopped typing.
   *
   * Emptying the box skips the wait. The delay exists to avoid answering a
   * half-typed question; "show me everything again" is not half of anything,
   * and a quarter-second of the old, narrower set after a clear looks stuck.
   */
  const [settled, setSettled] = useState("");

  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(query), SEARCH_DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [query]);

  const search = query.trim() ? settled : query;
  const matches = useMemo(() => searchHostels(placed, search), [placed, search]);

  /** True while the reader is mid-word: the field has moved on, the map has not. */
  const settling = query.trim() !== search.trim();

  const markers = useMemo<MapMarker[]>(
    () =>
      matches.flatMap((hostel) => {
        const point = hostelCoordinates(hostel);

        return point
          ? [{ id: hostel.id, lat: point.lat, lng: point.lng, name: hostel.name }]
          : [];
      }),
    [matches],
  );

  /*
   * Opened from a link elsewhere: `?slug=…&route=1` opens on that hostel with
   * directions already running. It is the *initial* choice, not an override —
   * one click on any pin and the reader's own choice wins from then on.
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
   * The route itself.
   *
   * A plain effect rather than TanStack Query, and deliberately: a query key is
   * a string in a cache that outlives this page, and the reader's coordinates
   * are not something to leave lying in one. The dependencies are the four
   * numbers rather than the two objects, because `me` and `destination` are
   * fresh objects on most renders and depending on them refetches in a loop.
   *
   * `null` from the router is a real answer — no road between these two points
   * — and the map falls back to the dashed straight line.
   */
  const meLat = me?.lat ?? null;
  const meLng = me?.lng ?? null;
  const toLat = destination?.lat ?? null;
  const toLng = destination?.lng ?? null;

  /*
   * One string naming the route currently wanted, or `null` for "none". Both
   * the answer and whether we are still waiting are *derived* from it, which is
   * what keeps every `setState` here inside the promise callback rather than in
   * the effect body — a synchronous one there is a cascading render, and the
   * lint rule that forbids it is right.
   */
  const routeKey =
    directions && meLat !== null && meLng !== null && toLat !== null && toLng !== null
      ? `${mode}:${meLat},${meLng}:${toLat},${toLng}`
      : null;

  const [answer, setAnswer] = useState<{ key: string; route: RoadRoute | null } | null>(
    null,
  );

  useEffect(() => {
    if (!routeKey || meLat === null || meLng === null || toLat === null || toLng === null) {
      return;
    }

    let cancelled = false;

    void fetchRoadRoute(
      { lat: meLat, lng: meLng },
      { lat: toLat, lng: toLng },
      mode,
    ).then((route) => {
      if (!cancelled) {
        setAnswer({ key: routeKey, route });
      }
    });

    return () => {
      cancelled = true;
    };
  }, [meLat, meLng, mode, routeKey, toLat, toLng]);

  // The answer only counts for the route it was asked about: changing profile
  // mid-route must not show the walking line under a driving heading.
  const road = answer && answer.key === routeKey ? answer.route : null;
  const roadLoading = routeKey !== null && answer?.key !== routeKey;

  /*
   * Guidance owns its own position — at navigation accuracy, from its own
   * subscription — so from the moment Start is pressed the map, the arrow and
   * the panel all read from it rather than from the coarse `me` the rest of the
   * page uses.
   */
  const guidance = useGuidance({ destination, mode, route: road });
  const navigating = guidance.isNavigating;
  const arrived = guidance.status === "arrived";
  const here = guidance.position ?? me;

  const straightLine = me && destination ? haversineMeters(me, destination) : null;

  const line = useMemo(() => {
    /*
     * While navigating, the line is whatever guidance is following — the
     * original route or the latest reroute — and it is drawn as it came back
     * from the router, without the two straight hops from the reader to the
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

    return road
      ? { dashed: false, points: [me, ...road.points, destination] }
      : { dashed: true, points: [me, destination] };
  }, [destination, directions, guidance.route, me, navigating, road]);

  /*
   * Navigation drives the map rather than rendering it, and it does so in two
   * effects rather than one.
   *
   * A single effect depending on both the position and the heading means every
   * compass sample — ten or so a second — calls `follow`, and `follow` is a
   * `setView`. Split, a fix moves the map and a compass sample only turns it,
   * and the 2° gate in the canvas drops most of those.
   *
   * The zoom is passed **once**, on the first fix of a session. After that the
   * map keeps whatever zoom it is on, so a reader who zooms out to see the next
   * two junctions stays there instead of being pulled back to 17.
   */
  const zoomed = useRef(false);

  useEffect(() => {
    if (!navigating) {
      zoomed.current = false;
      return;
    }

    if (!guidance.position) {
      return;
    }

    map.current?.follow(guidance.position, zoomed.current ? null : NAVIGATION_ZOOM, null);
    zoomed.current = true;
  }, [guidance.position, navigating]);

  /*
   * Heading-up or north-up, and the compass is the switch.
   *
   * Turning with the reader is right while walking — the turn on screen is the
   * turn in front of you — and wrong the moment they stop to work out where
   * they are, because every label is upside down. Google puts that choice on
   * the compass; so does this. It is cleared by `startGuidance` rather than by
   * an effect watching `navigating`, which makes it a per-session choice rather
   * than a remembered preference.
   */
  const [northUp, setNorthUp] = useState(false);

  const startGuidance = useCallback(() => {
    setNorthUp(false);
    guidance.start();
  }, [guidance]);

  useEffect(() => {
    if (!navigating) {
      return;
    }

    if (northUp) {
      map.current?.setBearing(0);
      return;
    }

    if (guidance.heading !== null) {
      map.current?.setBearing(guidance.heading);
    }
  }, [guidance.heading, navigating, northUp]);

  /*
   * And back to north-up when it ends, however it ended. A map left rotated
   * after the reader pressed Stop is a map whose compass looks broken.
   */
  useEffect(() => {
    if (!navigating) {
      map.current?.setBearing(0);
    }
  }, [navigating]);

  /*
   * Arrival, acknowledged. Guidance has already stopped itself and dropped both
   * subscriptions by the time this is reachable — this is only the panel being
   * dismissed, and it lands on the hostel: its photos and its price, which is
   * the state the reader started from and the one they want now they are
   * standing outside it. Stopping *mid-route* deliberately does not do this: it
   * leaves directions open, because somebody who stopped by accident wants
   * Start again, not a photo strip.
   */
  const finishArrival = useCallback(() => {
    guidance.stop();
    setChoice({ directions: false, id: selectedId });
  }, [guidance, selectedId]);

  const close = useCallback(() => setChoice(NOTHING_CHOSEN), []);

  /**
   * A hostel chosen from the list rather than from its pin.
   *
   * It ends in exactly the state a pin click ends in — that hostel selected,
   * its panel open, no route — reached the other way round: the pin for a
   * hostel you searched for is often off screen, which is what makes a bare
   * count of matches a dead end.
   *
   * The query is deliberately **not** cleared. Somebody searching "Baneshwor"
   * is usually looking through the answers, not at one of them, and a field
   * that empties itself makes them type it again to see the second.
   */
  const openResult = useCallback((hostel: PublicHostel) => {
    const point = hostelCoordinates(hostel);

    setChoice({ directions: false, id: hostel.id });
    setSearching(false);

    if (point) {
      map.current?.center(point, 16);
    }
  }, []);

  const showResults = searching && query.trim().length > 0;

  return (
    <PublicShell active="map" footer={false}>
      <div className="relative h-[calc(100dvh-4rem)] w-full overflow-hidden">
        <MapCanvas
          layer={layer}
          markers={markers}
          me={here}
          meAccuracyMeters={navigating ? guidance.accuracyMeters : null}
          meHeading={navigating ? guidance.heading : null}
          onSelect={(id) => {
            // Changing hostel drops the old route rather than leaving a line to
            // somewhere the panel no longer describes.
            setChoice({ directions: false, id });

            // And it closes the result list. The panel is one surface: while
            // the field still had the caret and a query in it, the results kept
            // the slot and the hostel just chosen on the map opened *behind*
            // them, which read as the pin having done nothing.
            if (id) {
              setSearching(false);
            }
          }}
          ref={map}
          route={line}
          selectedId={selectedId}
        />

        {/* ----------------------------------------------------------------
            Everything floating over the map is `z-20`, and that number is
            small on purpose.
            ----------------------------------------------------------------
            Leaflet's panes climb to 700, which is what tempts you into four
            digits here — but the rotation stage carries a `transform`, and a
            transform makes a stacking context, so every one of those panes is
            trapped inside the canvas and cannot reach past it. Beating the
            canvas itself is all that is needed.

            It matters because the number is not local: `MediaLightbox` portals
            to `document.body` at `z-[100]`, so a four-digit panel here is a
            panel that floats on top of the photo viewer it just opened.
        */}
        <div className="absolute left-3 right-3 top-3 z-20 md:left-4 md:right-auto md:top-4 md:w-104">
          <div className="flex h-12 items-center gap-2.5 rounded-xl border border-border bg-card px-3.5 shadow-lg">
            <Search className="size-4 shrink-0 text-muted-foreground" />

            <input
              aria-label="Search hostels on the map"
              className="h-full min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
              onBlur={() => {
                // A click on a result fires after blur, so the list has to
                // outlive the blur by a frame or the row never receives it.
                window.setTimeout(() => setSearching(false), 150);
              }}
              onChange={(event) => setQuery(event.target.value)}
              onFocus={() => setSearching(true)}
              placeholder="Search hostels by name or area"
              type="search"
              value={query}
            />

            {query ? (
              <button
                aria-label="Clear search"
                className="shrink-0 rounded-full p-1 text-muted-foreground transition hover:bg-muted hover:text-foreground"
                onClick={() => setQuery("")}
                type="button"
              >
                <X className="size-4" />
              </button>
            ) : null}
          </div>
        </div>

        {/* ----------------------------------------------------------------
            One panel, four contents.
            ----------------------------------------------------------------
            Results while searching, then the hostel, then its directions, then
            the guidance card — rather than three stacked things that each have
            to know when to hide. On a wide window it is the column under the
            search card; below `md` it is a sheet across the bottom, which is
            what Google Maps does at that size.
        */}
        <div className="pointer-events-none absolute inset-x-3 bottom-3 z-20 md:inset-x-auto md:bottom-auto md:left-4 md:top-20 md:w-104">
          {showResults ? (
            <div className="pointer-events-auto max-h-[45dvh] overflow-y-auto overscroll-contain rounded-xl border border-border bg-card shadow-lg md:max-h-[min(28rem,calc(100dvh-11rem))]">
              {settling && !search.trim() ? (
                <p className="px-3 py-3 text-xs text-muted-foreground">Searching…</p>
              ) : matches.length === 0 ? (
                <p className="px-3 py-3 text-sm text-muted-foreground">
                  {`No hostels match “${search.trim()}”.`}
                </p>
              ) : (
                <>
                  {matches.slice(0, MAX_RESULTS).map((hostel) => (
                    <ResultRow
                      hostel={hostel}
                      key={hostel.id}
                      me={me}
                      onPick={openResult}
                    />
                  ))}

                  {matches.length > MAX_RESULTS ? (
                    <p className="px-3 py-2 text-[11px] text-muted-foreground">
                      {`${matches.length - MAX_RESULTS} more are on the map — type a little more to narrow it down.`}
                    </p>
                  ) : null}
                </>
              )}
            </div>
          ) : selected ? (
            <div className="pointer-events-auto max-h-[55dvh] overflow-y-auto overscroll-contain rounded-xl border border-border bg-card shadow-lg md:max-h-[calc(100dvh-7rem)]">
              {navigating || arrived ? (
                <NavigationPanel
                  guidance={guidance}
                  hostel={selected}
                  onStop={arrived ? finishArrival : guidance.stop}
                />
              ) : directions ? (
                <DirectionsPanel
                  canStart={Boolean(me && road)}
                  distance={road?.distanceMeters ?? straightLine}
                  exact={Boolean(road)}
                  guidanceStatus={guidance.status}
                  hostel={selected}
                  loading={roadLoading}
                  me={me}
                  mode={mode}
                  nearby={nearby}
                  onBack={() => setChoice({ directions: false, id: selectedId })}
                  onClose={close}
                  onMode={setMode}
                  onStart={startGuidance}
                  seconds={road?.durationSeconds ?? 0}
                  starting={guidance.status === "starting"}
                />
              ) : (
                <HostelPanel
                  distance={straightLine}
                  hostel={selected}
                  onClose={close}
                  onDirections={() => setChoice({ directions: true, id: selectedId })}
                />
              )}
            </div>
          ) : isLoading ? (
            <div className="pointer-events-auto rounded-xl border border-border bg-card px-3 py-3 text-xs text-muted-foreground shadow-lg">
              Loading the catalogue…
            </div>
          ) : null}
        </div>

        {/* ----------------------------------------------------------------
            Controls.
            ----------------------------------------------------------------
            Bottom-right on a wide window, which is where a mouse expects them.
            Below `md` they move to the top-right instead: the panel is a bottom
            sheet at that size and would sit straight on top of them.
        */}
        <div className="absolute right-3 top-20 z-20 flex flex-col items-end gap-2 md:bottom-6 md:right-4 md:top-auto">
          {/*
            Zoom buttons are worth adding here even though the phone has none: a
            desktop reader with a mouse expects them, and Leaflet's own control
            would rotate off screen, so they are rendered natively like the rest.
          */}
          <div className="overflow-hidden rounded-xl border border-border bg-card shadow-lg">
            <MapButton
              bare
              label="Zoom in"
              onClick={() => map.current?.zoomBy(1)}
            >
              <Plus className="size-5" />
            </MapButton>
            <div className="h-px bg-border" />
            <MapButton
              bare
              label="Zoom out"
              onClick={() => map.current?.zoomBy(-1)}
            >
              <Minus className="size-5" />
            </MapButton>
          </div>

          <MapButton
            busy={nearby.isBusy}
            label={navigating ? "Back to my position" : "Centre on me"}
            onClick={() => {
              /*
               * While navigating this is the way back. The map stops following
               * the moment the reader drags or scrolls — otherwise it would
               * fight them for it — so something has to hand it back, and this
               * is the button that already means "put me on screen".
               *
               * It re-centres at the navigation zoom rather than 15: coming
               * back mid-route to a wider view than the one being navigated is
               * a second surprise on top of the one they were fixing.
               */
              if (here) {
                map.current?.center(here, navigating ? NAVIGATION_ZOOM : 15);
                return;
              }

              nearby.enable();
            }}
          >
            <LocateFixed className="size-5" />
          </MapButton>

          <MapButton label="Show every hostel" onClick={() => map.current?.fitAll()}>
            <Maximize className="size-5" />
          </MapButton>

          <div className="relative">
            <MapButton
              active={layersOpen}
              label="Map style"
              onClick={() => setLayersOpen((open) => !open)}
            >
              <Layers className="size-5" />
            </MapButton>

            {/*
              A panel rather than a cycling button: three sources, and a button
              that rotates through them hides what the other two are until you
              have pressed it twice.
            */}
            {layersOpen ? (
              /*
                It opens *away* from the edge it is pinned to. Below `md` the
                controls sit under the search card at the top, so the menu drops
                downwards; on a desktop they sit at the bottom of the window and
                the same menu ran straight off the bottom of the screen, with
                "Terrain" — and half of "Standard" — unreachable. So there it
                opens upward instead.
              */
              <div className="absolute right-0 top-13 w-44 overflow-hidden rounded-xl border border-border bg-card shadow-lg md:bottom-14 md:top-auto">
                {MAP_LAYERS.map((option) => (
                  <button
                    aria-pressed={option.id === layer}
                    className={cn(
                      "flex w-full items-center gap-2 border-b border-border px-3 py-2.5 text-left text-xs font-semibold transition last:border-b-0 hover:bg-muted",
                      option.id === layer ? "text-brand-teal" : "text-foreground",
                    )}
                    key={option.id}
                    onClick={() => {
                      setLayer(option.id);
                      setLayersOpen(false);
                    }}
                    type="button"
                  >
                    <span
                      aria-hidden
                      className={cn(
                        "size-2.5 rounded-full border",
                        option.id === layer
                          ? "border-brand-teal bg-brand-teal"
                          : "border-muted-foreground/60",
                      )}
                    />
                    {option.label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          {/*
            Only while navigating, because that is the only state where north is
            not up. A compass on a north-up map is a needle that never moves.
          */}
          {navigating ? (
            <Compass
              facing={guidance.heading}
              northUp={northUp}
              onClick={() => setNorthUp((current) => !current)}
            />
          ) : null}
        </div>
      </div>
    </PublicShell>
  );
}

/* ------------------------------------------------------------------ controls */

function MapButton({
  active = false,
  bare = false,
  busy = false,
  children,
  label,
  onClick,
}: {
  /** Drawn as pressed while the thing it opens is open. */
  active?: boolean;
  /** Inside a group that already has the border and the shadow. */
  bare?: boolean;
  busy?: boolean;
  children: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-label={label}
      aria-pressed={active}
      className={cn(
        // Sized for the pointer that will use it: a finger on a phone, and a
        // mouse on a desktop where the map is the whole window and these are
        // the only controls on it. 40px was the phone's number applied to both.
        "flex size-11 items-center justify-center transition md:size-12",
        bare ? "text-foreground hover:bg-muted" : "rounded-xl border border-border shadow-lg",
        bare
          ? ""
          : active
            ? "bg-brand-teal-soft text-brand-teal"
            : "bg-card text-foreground hover:bg-muted",
        busy && "opacity-60",
      )}
      disabled={busy}
      onClick={onClick}
      title={label}
      type="button"
    >
      {children}
    </button>
  );
}

/**
 * Which way is north, and which way the reader is facing.
 *
 * Two readings in one control. The needle points at true north *on the screen*
 * — so it is upright on a north-up map and turns as the map turns — and the two
 * letters under it say where the device is pointing, which is the question "am
 * I walking the right way" actually asks.
 *
 * Clicking locks the map north-up and clicking again lets it follow the
 * heading, which is what the same button does in every other map application.
 * On a machine with no compass `facing` is always `null`: the needle stays up
 * and the letters read `—`, which is the truth rather than a guess.
 */
function Compass({
  facing,
  northUp,
  onClick,
}: {
  facing: number | null;
  northUp: boolean;
  onClick: () => void;
}) {
  // The map is rotated by minus the heading, so north on screen is at minus
  // that again — which is the heading itself, unless the map is locked
  // north-up and north is simply up.
  const needle = northUp || facing === null ? 0 : -facing;

  return (
    <button
      aria-label={northUp ? "Follow the direction I am facing" : "Face north"}
      aria-pressed={northUp}
      className="flex size-11 flex-col items-center justify-center rounded-xl border border-border bg-card shadow-lg transition hover:bg-muted md:size-12"
      onClick={onClick}
      type="button"
    >
      <Navigation
        className="size-4 fill-brand-teal text-brand-teal"
        style={{ transform: `rotate(${needle}deg)` }}
      />
      <span className="text-[9px] font-bold text-muted-foreground">
        {facing === null ? "—" : cardinalFor(facing)}
      </span>
    </button>
  );
}

/* ------------------------------------------------------------------- panels */

/**
 * One search result: enough to tell two hostels apart, and nothing more.
 *
 * Name, place, distance, price — the four things somebody scanning a list of
 * hostels with similar names is actually choosing between. Not a photograph:
 * this list is a step on the way to the panel that has eight of them, and a row
 * tall enough for a thumbnail is a list that fits three answers instead of
 * eight.
 *
 * The distance is only drawn when there is a fix, and it is the straight-line
 * one — the same number the cards elsewhere on the site show, computed the same
 * way — so a hostel does not change how far away it is depending on which page
 * is asking. The routed distance costs a network request per row and belongs on
 * the one hostel that gets chosen.
 */
function ResultRow({
  hostel,
  me,
  onPick,
}: {
  hostel: PublicHostel;
  me: Coordinates | null;
  onPick: (hostel: PublicHostel) => void;
}) {
  const summary = mapPublicHostelToSummary(hostel);
  const point = hostelCoordinates(hostel);
  const distance = me && point ? haversineMeters(me, point) : null;

  return (
    <button
      className="flex w-full items-center gap-3 border-b border-border px-3 py-2.5 text-left transition last:border-b-0 hover:bg-muted"
      // `onMouseDown` rather than `onClick`: the input's blur handler closes
      // this list, and mousedown lands first.
      onMouseDown={() => onPick(hostel)}
      type="button"
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-brand-teal-soft text-brand-teal">
        <MapPin className="size-4" />
      </span>

      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-foreground">
          {hostel.name}
        </span>
        <span className="block truncate text-[11px] text-muted-foreground">
          {[
            [summary.area, summary.city].filter(Boolean).join(", ") ||
              "Location not published",
            distance === null ? null : formatDistance(distance),
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </span>

      <span className="shrink-0 text-xs font-bold text-brand-teal">
        {summary.price > 0 ? formatMoney(summary.price) : "—"}
      </span>
    </button>
  );
}

/** The header every panel shares: a name, and a way out. */
function PanelHeader({
  onBack,
  onClose,
  title,
}: {
  onBack?: () => void;
  onClose: () => void;
  title: string;
}) {
  return (
    <div className="flex items-center gap-2 px-3 pt-3">
      {onBack ? (
        <button
          aria-label="Back to the hostel"
          className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-foreground transition hover:bg-border"
          onClick={onBack}
          type="button"
        >
          <ArrowLeft className="size-4" />
        </button>
      ) : null}

      <h2 className="min-w-0 flex-1 truncate text-sm font-bold text-foreground">{title}</h2>

      <button
        aria-label="Close"
        className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-foreground transition hover:bg-border"
        onClick={onClose}
        type="button"
      >
        <X className="size-4" />
      </button>
    </div>
  );
}

/**
 * The panel a pin opens: enough to decide, and two ways onward.
 *
 * It reuses the listing's own summary shape (`mapPublicHostelToSummary`) so a
 * hostel's price, rating and area read identically here and on a card — a map
 * that quoted a different number from the page it links to is a map nobody
 * would trust twice.
 *
 * A hostel with no photographs gets a single placeholder rather than a
 * collapsed row, because a panel that changes height depending on the listing
 * is a panel that jumps as you click between pins.
 */
function HostelPanel({
  distance,
  hostel,
  onClose,
  onDirections,
}: {
  distance: number | null;
  hostel: PublicHostel;
  onClose: () => void;
  onDirections: () => void;
}) {
  const summary = mapPublicHostelToSummary(hostel);

  /*
   * The photographs, and the one thing worth knowing about them: opening one
   * uses the same `MediaLightbox` the hostel's own page uses, rather than a
   * second viewer built for this panel. The strip is 26rem wide at most, so a
   * room shot in it is a thumbnail — the viewer is where it becomes a
   * photograph, and it already does zoom, arrow keys and Escape.
   */
  const [lightbox, setLightbox] = useState<number | null>(null);

  const photos = useMemo(
    () =>
      hostel.photos
        .map((photo) => photo.url)
        .filter((url): url is string => Boolean(url))
        .slice(0, 12),
    [hostel.photos],
  );

  const items = useMemo<LightboxItem[]>(
    () => photos.map((src) => ({ src, title: hostel.name })),
    [hostel.name, photos],
  );

  const location =
    [summary.area, summary.city].filter(Boolean).join(", ") || "Location not published";

  return (
    <div className="pb-4">
      <PanelHeader onClose={onClose} title={hostel.name} />

      {/*
        A scroller with its own padding rather than a padded parent, so the
        first photo lines up with the text under it and the last one still runs
        to the edge instead of stopping short of it.
      */}
      <div className="mt-3 flex snap-x snap-mandatory gap-2 overflow-x-auto px-4 pb-1">
        {photos.length > 0 ? (
          photos.map((url, index) => (
            <button
              aria-label={`Open photo ${index + 1} of ${photos.length}`}
              className="h-28 w-40 shrink-0 snap-start overflow-hidden rounded-xl bg-muted ring-offset-2 ring-offset-card transition hover:ring-2 hover:ring-brand-teal"
              key={url}
              onClick={() => setLightbox(index)}
              type="button"
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- hostel
                  photos come from R2 and from Unsplash at no fixed size, and
                  the optimizer is not worth a per-host remote pattern for a
                  strip that is mostly scrolled past. */}
              <img
                alt=""
                className="size-full object-cover transition duration-300 hover:scale-105"
                loading="lazy"
                src={url}
              />
            </button>
          ))
        ) : (
          <div
            className="h-28 w-40 shrink-0 rounded-xl bg-muted bg-cover bg-center opacity-60"
            style={{ backgroundImage: `url("${DEFAULT_HOSTEL_IMAGE}")` }}
          />
        )}
      </div>

      <div className="space-y-3 px-4 pt-3">
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <MapPin className="size-3.5 shrink-0" />
          <span className="truncate">{location}</span>
        </p>

        {/*
          The facts, as a row of chips rather than a paragraph. Rating, type and
          distance are three different kinds of thing and a reader picks out the
          one they came for; run together in a sentence they have to read all
          three to find it.
        */}
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="inline-flex items-center gap-1 rounded-md bg-brand-teal-soft px-2 py-1 text-[11px] font-bold text-foreground">
            {summary.rating > 0 ? (
              <>
                <Star className="size-3 fill-warning text-warning" />
                {summary.rating}
                <span className="font-normal text-muted-foreground">
                  ({summary.reviews})
                </span>
              </>
            ) : (
              "New"
            )}
          </span>

          <span className="rounded-md bg-muted px-2 py-1 text-[11px] font-semibold text-foreground">
            {HOSTEL_TYPE_LABELS[hostel.hostelType]}
          </span>

          {summary.vacancy > 0 ? (
            <span className="rounded-md bg-muted px-2 py-1 text-[11px] font-semibold text-foreground">
              {`${summary.vacancy} vacant`}
            </span>
          ) : null}

          {distance === null ? null : (
            <span className="rounded-md bg-muted px-2 py-1 text-[11px] font-semibold text-muted-foreground">
              {`${formatDistance(distance)} away`}
            </span>
          )}
        </div>

        <p className="text-lg font-extrabold leading-none text-foreground">
          {summary.price > 0 ? formatMoney(summary.price) : "Price on request"}
          {summary.price > 0 ? (
            <span className="text-[11px] font-normal text-muted-foreground"> / month</span>
          ) : null}
        </p>

        {summary.facilities.length > 0 ? (
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {summary.facilities.slice(0, 5).join(" · ")}
          </p>
        ) : null}

        <div className="flex gap-2 pt-0.5">
          <button
            className="flex-1 rounded-lg bg-brand-teal px-3 py-2.5 text-xs font-semibold text-white transition hover:brightness-110"
            onClick={onDirections}
            type="button"
          >
            Directions
          </button>

          <Link
            className="flex-1 rounded-lg border border-border px-3 py-2.5 text-center text-xs font-semibold text-foreground transition hover:bg-muted"
            href={`/hostels/${hostel.slug}`}
          >
            View details
          </Link>
        </div>
      </div>

      {lightbox === null ? null : (
        <MediaLightbox
          index={lightbox}
          items={items}
          onClose={() => setLightbox(null)}
          onIndexChange={setLightbox}
        />
      )}
    </div>
  );
}

/**
 * Directions, once a hostel is chosen: how far, how long, and by what.
 *
 * The distance shown is the routed one when there is a route and the
 * straight-line one when there is not — and the wording changes with it,
 * because "5.3 km on foot" and "2.6 km in a straight line" are different claims
 * and the dashed line on the map is already saying which one is on screen.
 */
function DirectionsPanel({
  canStart,
  distance,
  exact,
  guidanceStatus,
  hostel,
  loading,
  me,
  mode,
  nearby,
  onBack,
  onClose,
  onMode,
  onStart,
  seconds,
  starting,
}: {
  /** A fix **and** a road route. Neither alone is something to navigate along. */
  canStart: boolean;
  distance: number | null;
  /** True when the number came from the router rather than from haversine. */
  exact: boolean;
  guidanceStatus: GuidanceStatus;
  hostel: PublicHostel;
  loading: boolean;
  /** The reader. Its absence is the whole difference between the two states. */
  me: Coordinates | null;
  mode: RouteMode;
  nearby: DeviceLocation;
  onBack: () => void;
  onClose: () => void;
  onMode: (mode: RouteMode) => void;
  onStart: () => void;
  seconds: number;
  starting: boolean;
}) {
  const minutes = Math.max(1, Math.round(seconds / 60));

  /*
   * Why Start is not going to work, when it is not.
   *
   * Five ways this can fail — refused, no secure context, no fix, no road, and
   * a browser too old to have the API — and each gets its own sentence, because
   * "it didn't work" leaves the reader clicking a grey button. There is no
   * "open settings" among them: a browser has no such screen to send anyone to,
   * only its own site permissions, which is what the wording says instead.
   */
  const trouble =
    guidanceStatus === "dismissed" || nearby.status === "dismissed"
      ? "The location request was dismissed. Press it again and choose Allow — nothing is saved, and it is only used while this page is open."
      : guidanceStatus === "denied" || nearby.status === "denied"
        ? "Location is blocked for this site. Allow it in your browser's site permissions — the padlock beside the address — then press Start again."
        : guidanceStatus === "insecure" || nearby.status === "insecure"
          ? "This browser will only share a location over a secure (https) connection, so directions cannot follow you here."
          : guidanceStatus === "unavailable"
            ? "No position came back — check that location services are switched on, then press Start again."
            : me && !exact && !loading
              ? "There is no road route to this hostel, so there is nothing to navigate along."
              : null;

  /*
   * A block is the only state where pressing the button again cannot help —
   * the browser answers it without a prompt. Every other refusal keeps the
   * button live, because it is the thing that fixes them.
   */
  const blocked = guidanceStatus === "denied" || nearby.status === "denied";

  return (
    <div className="pb-3">
      <PanelHeader onBack={onBack} onClose={onClose} title={hostel.name} />

      <div className="space-y-3 px-3 pt-3">
        {/*
          The toggle, and the way in. Two graphs, two genuinely different
          answers — see `lib/maps/routing.ts` — and Start beside them rather
          than under the numbers, because the profile is the thing you choose
          *before* setting off.

          Start is disabled until there is both a fix and a route: without a
          position there is nothing to follow, and without a route there is
          nothing to follow it along. A Start button that spins forever is the
          one outcome worth designing out.
        */}
        <div className="flex items-center gap-2">
          <div className="flex flex-1 gap-1 rounded-lg bg-muted p-1">
            <ModeTab
              active={mode === "car"}
              icon={<Car className="size-3.5" />}
              label="Vehicle"
              onClick={() => onMode("car")}
            />
            <ModeTab
              active={mode === "foot"}
              icon={<Footprints className="size-3.5" />}
              label="Walk"
              onClick={() => onMode("foot")}
            />
          </div>

          <button
            className="rounded-lg bg-brand-teal px-4 py-2 text-xs font-semibold text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!canStart || starting}
            onClick={onStart}
            type="button"
          >
            {starting ? "Starting…" : "Start"}
          </button>
        </div>

        {trouble ? (
          <p className="flex items-start gap-2 text-[11px] text-muted-foreground">
            <CircleAlert className="mt-px size-3.5 shrink-0" />
            <span>{trouble}</span>
          </p>
        ) : null}

        {me ? (
          <div>
            <p className="flex items-center gap-2 text-base font-bold text-foreground">
              <Navigation className="size-4 text-brand-teal" />
              {distance === null
                ? "—"
                : exact
                  ? `${formatDistance(distance)} ${mode === "foot" ? "on foot" : "by road"}`
                  : `${formatDistance(distance)} in a straight line`}
            </p>

            <p className="mt-0.5 text-[11px] text-muted-foreground">
              {loading
                ? "Tracing the route…"
                : exact
                  ? `About ${minutes} min ${mode === "foot" ? "walking" : "driving"}`
                  : "No route came back, so this is the direct distance — the dashed line on the map."}
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              Turn on location to draw the way there. Your position is used on
              this page and never saved.
            </p>

            <button
              className="w-full rounded-lg border border-border px-3 py-2 text-xs font-semibold text-foreground transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
              // Disabled only when the browser will refuse without asking.
              // After a dismissed prompt this stays live, because clicking it
              // is exactly what brings the prompt back.
              disabled={nearby.isBusy || blocked}
              onClick={nearby.enable}
              type="button"
            >
              {nearby.isBusy
                ? "Finding you…"
                : blocked
                  ? "Location blocked in this browser"
                  : nearby.status === "dismissed"
                    ? "Try again"
                    : "Use my location"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function ModeTab({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-pressed={active}
      className={cn(
        "flex flex-1 items-center justify-center gap-1.5 rounded-md py-1.5 text-xs font-semibold transition",
        active
          ? "bg-card text-brand-teal shadow-sm"
          : "text-muted-foreground hover:text-foreground",
      )}
      onClick={onClick}
      type="button"
    >
      {icon}
      {label}
    </button>
  );
}

/**
 * The panel while it is actually guiding: one instruction, and a way out.
 *
 * Everything on it is sized by how long the reader can look at it, which on a
 * pavement is about a second. So the maneuver is the only large thing — an
 * arrow, the distance to it, and the instruction under it — and the trip totals
 * sit small underneath, because "how far is left" is a question you ask when
 * you have stopped walking.
 *
 * Stop is full width and always in the same place. Leaving must be one click,
 * and one that cannot be missed while moving.
 */
function NavigationPanel({
  guidance,
  hostel,
  onStop,
}: {
  guidance: Guidance;
  hostel: PublicHostel;
  onStop: () => void;
}) {
  const { remainingMeters, remainingSeconds, rerouting, stale, status, step } = guidance;
  const minutes =
    remainingSeconds === null ? null : Math.max(1, Math.round(remainingSeconds / 60));

  /*
   * Arrived. The hook has already taken both subscriptions down and the map has
   * turned back to north-up, so all that is left is to say so and get out of
   * the way — one button, which lands on the hostel's own panel.
   */
  if (status === "arrived") {
    return (
      <div className="space-y-3 p-3">
        <div className="flex items-center gap-3">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-brand-teal-soft text-brand-teal">
            <Flag className="size-6" />
          </span>

          <div className="min-w-0">
            <p className="text-lg font-bold text-foreground">You have arrived</p>
            <p className="truncate text-xs text-muted-foreground">{hostel.name}</p>
          </div>
        </div>

        <button
          className="w-full rounded-lg bg-brand-teal px-3 py-2 text-xs font-semibold text-white transition hover:brightness-110"
          onClick={onStop}
          type="button"
        >
          Done
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-3 p-3">
      <div className="flex items-center gap-3">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-brand-teal-soft text-brand-teal">
          <ManeuverIcon step={step?.step} />
        </span>

        <div className="min-w-0">
          <p className="text-lg font-bold text-foreground">
            {step ? formatManeuverDistance(step.distanceMeters) : "On the way"}
          </p>
          <p className="line-clamp-2 text-xs text-muted-foreground">
            {step
              ? instructionFor(step.step)
              : `Follow the route on the map to ${hostel.name}`}
          </p>
        </div>
      </div>

      {/*
        The one line that is not the maneuver. `stale` means the reader is off
        the route and no replacement came back, so what is drawn is a route from
        where they were — saying that plainly is the whole point, because the
        alternative is a line that quietly stops being guidance.
      */}
      <p
        className={cn(
          "flex items-center gap-2 text-[11px]",
          stale ? "text-muted-foreground" : "text-foreground",
        )}
      >
        {stale ? (
          <CircleAlert className="size-3.5 shrink-0" />
        ) : (
          <Navigation className="size-3.5 shrink-0 text-brand-teal" />
        )}
        <span className="truncate">
          {rerouting
            ? "Off the route — finding a new one…"
            : stale
              ? "Off the route, and no new one came back. The line is from where you were."
              : [
                  remainingMeters === null ? null : formatDistance(remainingMeters),
                  minutes === null ? null : `${minutes} min left`,
                ]
                  .filter(Boolean)
                  .join(" · ") || `Heading to ${hostel.name}`}
        </span>
      </p>

      <button
        className="w-full rounded-lg border border-border px-3 py-2 text-xs font-semibold text-foreground transition hover:bg-muted"
        onClick={onStop}
        type="button"
      >
        Stop
      </button>
    </div>
  );
}

/**
 * An icon for the maneuver.
 *
 * Deliberately coarse: left, right, straight, back, and the two that are their
 * own shape (a roundabout and the flag at the end). A glanceable arrow that
 * says "left" is worth more than a precise one that has to be studied to tell a
 * slight left from a sharp one — the words underneath carry that distinction.
 */
function ManeuverIcon({ step }: { step: RouteStep | undefined }) {
  const className = "size-6";

  if (!step) {
    return <Navigation className={className} />;
  }

  const { modifier, type } = step.maneuver;

  if (type === "arrive") {
    return <Flag className={className} />;
  }

  if (type === "roundabout" || type === "rotary") {
    return <RotateCw className={className} />;
  }

  if (modifier === "uturn") {
    return <ArrowLeft className={className} />;
  }

  if (modifier?.includes("left")) {
    return <CornerUpLeft className={className} />;
  }

  if (modifier?.includes("right")) {
    return <CornerUpRight className={className} />;
  }

  return <ArrowUp className={className} />;
}
