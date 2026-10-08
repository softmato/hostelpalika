import {
  Camera,
  type CameraRef,
  GeoJSONSource,
  Images,
  Layer,
  Map,
  NativeUserLocation,
  RasterDEMSource,
  RasterSource,
  type TrackUserLocation,
} from "@maplibre/maplibre-react-native";
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { ExpressionSpecification } from "@maplibre/maplibre-gl-style-spec";
import { useWindowDimensions, View } from "react-native";

import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { type Coordinates, haversineMeters, KATHMANDU } from "@/lib/geo";
import type { MapExplorerProps, MapHandle, MapRoute } from "@/lib/map-types";
import {
  baseStyle,
  HOSTEL_PIN,
  IMAGERY_ANCHOR,
  LABEL_FONT,
  PIN_OFFSET,
  pinImages,
  ROUTE_ANCHOR,
  SATELLITE,
  TERRAIN,
} from "@/lib/map-styles";

export type { MapHandle, MapMarker } from "@/lib/map-types";

/**
 * The map, drawn natively by MapLibre on the GPU.
 *
 * It replaced a Leaflet page inside a WebView — which is still what the PWA
 * runs, from `web/map-explorer.tsx`, behind the same props in
 * `lib/map-types.ts`. Here there is no page, no bridge and no injected
 * scripts: pins, labels, the route and the reader's puck are style layers the
 * GPU draws, labels never pile on top of each other (MapLibre places them with
 * collision detection), and a pinch is a native gesture.
 *
 * ## Every `<Layer>` inside a source carries a `key`
 *
 * MapLibre RN's sources drop `null` children and key the rest **by position**.
 * A layer that appears in front of another one (a casing under the route
 * line) therefore inherits the other's slot, React updates the old layer with
 * the new id, and the library throws "`id` cannot be changed" — which, with no
 * error boundary above it, was the whole app turning white the moment a road
 * route replaced the straight line. An explicit key is the slot.
 *
 * ## One style, for good
 *
 * The map loads the street style once, keyed by it, and Satellite / Terrain
 * are layers over it — see `lib/map-styles.ts` for why swapping styles was a
 * blank screen. A dark-mode switch is the only thing that changes the style,
 * and it remounts the map at the view it was showing.
 *
 * ## Navigation is the camera's own follow mode
 *
 * While navigating, MapLibre itself tracks the location — by the direction of
 * travel in a vehicle, by the compass on foot — tilted, at street zoom, with
 * the puck held low by the camera's top padding so the road ahead gets the
 * screen. A drag ends the follow natively and `onTouched` offers Re-centre;
 * `recentre()` resumes it. None of that is JavaScript running per frame.
 *
 * ## The opening view
 *
 * The hostels around the reader, not their street: their position framed
 * with the nearest few hostels within 5 km, never closer than a box about
 * 3 km across, or their area at zoom 13 when none are that near. Without a
 * position yet it waits a moment, shows the catalogue, and flies to the
 * reader when the fix arrives. Any gesture, selection, route or button
 * settles it for good.
 */

const NAV_ZOOM = 17.5;
const NAV_PITCH = 50;
/** Top padding while navigating, as a share of the height: the puck sits low. */
const NAV_LEAD = 0.42;

const NEAR_METERS = 5_000;
const NEAR_PINS = 8;
/** Zoom for the reader's area when no hostel is near enough to frame. */
const AREA_ZOOM = 13;
/** The opening view's smallest box: about 3 km, so the hostels around are on screen. */
const OPENING_SPAN_DEGREES = 0.03;
/** The smallest box anything else frames — a hostel next door is not zoom 20. */
const MIN_SPAN_DEGREES = 0.006;

/** Room for the search field above and the card below whenever we fit. */
const FIT_PADDING = { bottom: 240, left: 48, right: 64, top: 140 };
const NO_PADDING = { bottom: 0, left: 0, right: 0, top: 0 };

const OPENING_VIEW = { center: [KATHMANDU.lng, KATHMANDU.lat] as [number, number], zoom: 12 };

/** Our two stacking anchors live in a source with nothing in it. */
const EMPTY: GeoJSON.FeatureCollection = { features: [], type: "FeatureCollection" };

function boundsOf(
  points: Coordinates[],
  minSpan = MIN_SPAN_DEGREES,
): [number, number, number, number] {
  const lats = points.map((point) => point.lat);
  const lngs = points.map((point) => point.lng);
  const [south, north] = [Math.min(...lats), Math.max(...lats)];
  const [west, east] = [Math.min(...lngs), Math.max(...lngs)];
  const padLat = Math.max(0, (minSpan - (north - south)) / 2);
  const padLng = Math.max(0, (minSpan - (east - west)) / 2);

  return [west - padLng, south - padLat, east + padLng, north + padLat];
}

function lineData(points: Coordinates[]): GeoJSON.Feature {
  return {
    geometry: { coordinates: points.map((point) => [point.lng, point.lat]), type: "LineString" },
    properties: {},
    type: "Feature",
  };
}

/** Same test the page used: no reroute keeps the length and both ends. */
function shapeOf(route: MapRoute | null) {
  if (!route || route.points.length < 2) {
    return null;
  }

  const first = route.points[0];
  const last = route.points[route.points.length - 1];

  return `${route.points.length}:${first.lat},${first.lng}:${last.lat},${last.lng}`;
}

export const MapExplorer = forwardRef<MapHandle, MapExplorerProps>(function MapExplorer(
  {
    alternatives,
    layer = "standard",
    markers,
    me,
    mode = "car",
    navigating = false,
    nearby,
    northUp = false,
    onLongPress,
    onPickAlternative,
    onSelect,
    onTouched,
    route,
    selectedId,
  },
  ref,
) {
  const { colors, isDark } = useAppTheme();
  const { height } = useWindowDimensions();
  const camera = useRef<CameraRef>(null);
  const base = baseStyle(isDark);
  const [loaded, setLoaded] = useState(false);

  /*
   * Navigation follow, lost to a drag. Reset whenever navigation starts — the
   * render-time form of "on prop change", which needs no effect.
   */
  const [detached, setDetached] = useState(false);
  const [wasNavigating, setWasNavigating] = useState(navigating);

  if (wasNavigating !== navigating) {
    setWasNavigating(navigating);
    setDetached(false);
  }

  // Refs, not state: nothing renders from them and they change from gestures.
  const touched = useRef(false);
  const framed = useRef(false);
  const provisional = useRef(false);
  const lastShape = useRef<string | null>(null);
  /** Where the map was looking, so a dark-mode remount opens on the same view. */
  const lastView = useRef<{ bearing: number; center: [number, number]; pitch: number; zoom: number }>(
    null,
  );

  const follow: TrackUserLocation | undefined =
    navigating && !detached ? (northUp ? "default" : mode === "car" ? "course" : "heading") : undefined;

  const hostels = useMemo<GeoJSON.FeatureCollection>(
    () => ({
      features: markers.map((marker) => ({
        geometry: { coordinates: [marker.lng, marker.lat], type: "Point" },
        properties: { id: marker.id, name: marker.name },
        type: "Feature",
      })),
      type: "FeatureCollection",
    }),
    [markers],
  );

  const places = useMemo<GeoJSON.FeatureCollection>(
    () => ({
      features: (nearby ?? []).map((place) => ({
        geometry: {
          coordinates: [place.coordinates.lng, place.coordinates.lat],
          type: "Point",
        },
        properties: { name: place.name, type: place.type },
        type: "Feature",
      })),
      type: "FeatureCollection",
    }),
    [nearby],
  );

  const others = useMemo<GeoJSON.FeatureCollection>(
    () => ({
      features: (alternatives ?? []).map((alternative, index) => ({
        ...lineData(alternative.points),
        properties: { index },
      })),
      type: "FeatureCollection",
    }),
    [alternatives],
  );

  const line = useMemo(
    () => (route && route.points.length > 1 ? lineData(route.points) : null),
    [route],
  );

  function fitPins(duration: number) {
    if (markers.length === 1) {
      camera.current?.flyTo({ center: [markers[0].lng, markers[0].lat], duration, zoom: 15 });
    } else if (markers.length > 1) {
      camera.current?.fitBounds(boundsOf(markers), { duration, padding: FIT_PADDING });
    }
  }

  useImperativeHandle(ref, () => ({
    center: (point, zoom = 15) => {
      touched.current = false;
      framed.current = true;
      camera.current?.flyTo({ center: [point.lng, point.lat], duration: 600, zoom });
    },
    fitAll: () => {
      touched.current = false;
      framed.current = true;
      fitPins(600);
    },
    recentre: () => {
      camera.current?.setStop({ duration: 500, pitch: northUp ? 0 : NAV_PITCH, zoom: NAV_ZOOM });
      setDetached(false);
    },
  }));

  // The opening view — see the header.
  useEffect(() => {
    if (!loaded || framed.current || touched.current || navigating) {
      return;
    }

    if (me) {
      framed.current = true;

      const near = markers
        .map((marker) => ({ marker, meters: haversineMeters(me, marker) }))
        .filter((entry) => entry.meters <= NEAR_METERS)
        .sort((a, b) => a.meters - b.meters)
        .slice(0, NEAR_PINS)
        .map((entry) => entry.marker);
      const duration = provisional.current ? 800 : 0;

      if (near.length > 0) {
        camera.current?.fitBounds(boundsOf([me, ...near], OPENING_SPAN_DEGREES), {
          duration,
          padding: FIT_PADDING,
        });
      } else {
        camera.current?.flyTo({ center: [me.lng, me.lat], duration, zoom: AREA_ZOOM });
      }

      return;
    }

    if (provisional.current || markers.length === 0) {
      return;
    }

    const timer = setTimeout(() => {
      if (!framed.current && !touched.current) {
        provisional.current = true;
        fitPins(0);
      }
    }, 400);

    return () => clearTimeout(timer);
    // `fitPins` reads only `markers`, which is listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, markers, me, navigating]);

  // A chosen pin comes to the middle of the screen, above the card.
  useEffect(() => {
    const marker = markers.find((candidate) => candidate.id === selectedId);

    if (!loaded || !marker || navigating) {
      return;
    }

    framed.current = true;
    camera.current?.easeTo({ center: [marker.lng, marker.lat], duration: 300 });
    // Only the selection moves the camera; a search narrowing the pins does not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, selectedId]);

  // A new route frames itself; the same route arriving again does not.
  useEffect(() => {
    const shape = shapeOf(route);
    const changed = shape !== lastShape.current;

    lastShape.current = shape;

    if (!loaded || !route || !shape || !changed || touched.current || navigating) {
      return;
    }

    framed.current = true;
    camera.current?.fitBounds(boundsOf(route.points), { duration: 600, padding: FIT_PADDING });
  }, [loaded, navigating, route]);

  // Leaving navigation: flat, north up, no lead padding.
  useEffect(() => {
    if (loaded && !navigating) {
      camera.current?.setStop({ bearing: 0, duration: 500, padding: NO_PADDING, pitch: 0 });
    }
  }, [loaded, navigating]);

  const selected: ExpressionSpecification = ["==", ["get", "id"], selectedId ?? ""];

  const attribution =
    layer === "satellite"
      ? `${SATELLITE.attribution} · ${base.attribution}`
      : layer === "terrain"
        ? `${TERRAIN.attribution} · ${base.attribution}`
        : base.attribution;

  return (
    <View className="flex-1" style={{ backgroundColor: colors.muted }}>
      <Map
        attribution={false}
        compass={false}
        key={base.url}
        logo={false}
        mapStyle={base.url}
        onDidFinishLoadingMap={() => setLoaded(true)}
        onLongPress={(event) => {
          const [lng, lat] = event.nativeEvent.lngLat;

          onLongPress?.({ lat, lng });
        }}
        onPress={() => onSelect(null)}
        onRegionDidChange={(event) => {
          const { bearing, center, pitch, zoom } = event.nativeEvent;

          lastView.current = { bearing, center: [center[0], center[1]], pitch, zoom };
        }}
        onRegionWillChange={(event) => {
          if (event.nativeEvent.userInteraction) {
            touched.current = true;
          }
        }}
        style={{ flex: 1 }}
      >
        <Camera
          initialViewState={lastView.current ?? OPENING_VIEW}
          onTrackUserLocationChange={(event) => {
            if (navigating && event.nativeEvent.trackUserLocation === null) {
              setDetached(true);
              onTouched?.();
            }
          }}
          padding={navigating ? { bottom: 0, left: 0, right: 0, top: height * NAV_LEAD } : undefined}
          // North-up holds bearing 0 while still following; heading-up lets the follow turn it.
          bearing={navigating && northUp ? 0 : undefined}
          pitch={navigating ? (northUp ? 0 : NAV_PITCH) : undefined}
          ref={camera}
          trackUserLocation={follow}
          zoom={navigating ? NAV_ZOOM : undefined}
        />

        <Images images={pinImages(isDark)} />

        {/* The stacking anchors — see `lib/map-styles.ts`. Never drawn. */}
        <GeoJSONSource data={EMPTY} id="hp-anchors">
          <Layer
            beforeId={base.labelsFrom}
            id={ROUTE_ANCHOR}
            key={ROUTE_ANCHOR}
            layout={{ visibility: "none" }}
            type="line"
          />
          <Layer
            beforeId={ROUTE_ANCHOR}
            id={IMAGERY_ANCHOR}
            key={IMAGERY_ANCHOR}
            layout={{ visibility: "none" }}
            type="line"
          />
        </GeoJSONSource>

        {layer === "satellite" ? (
          <RasterSource
            id="satellite"
            maxzoom={SATELLITE.maxzoom}
            tileSize={256}
            tiles={SATELLITE.tiles}
          >
            <Layer beforeId={IMAGERY_ANCHOR} id="satellite-imagery" key="satellite-imagery" type="raster" />
          </RasterSource>
        ) : null}

        {layer === "terrain" ? (
          <RasterDEMSource
            encoding="terrarium"
            id="terrain"
            maxzoom={TERRAIN.maxzoom}
            tileSize={256}
            tiles={TERRAIN.tiles}
          >
            <Layer
              beforeId={base.reliefBelow}
              id="terrain-shade"
              key="terrain-shade"
              paint={{
                "hillshade-accent-color": isDark ? "rgba(0,0,0,0.3)" : "rgba(0,0,0,0.12)",
                "hillshade-exaggeration": 0.55,
                "hillshade-highlight-color": isDark ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.35)",
                "hillshade-shadow-color": isDark ? "rgba(0,0,0,0.6)" : "rgba(40,48,40,0.45)",
              }}
              type="hillshade"
            />
          </RasterDEMSource>
        ) : null}

        {others.features.length > 0 ? (
          <GeoJSONSource
            data={others}
            id="alternatives"
            onPress={(event) => {
              event.stopPropagation();
              const index = event.nativeEvent.features[0]?.properties?.index;

              if (typeof index === "number") {
                onPickAlternative?.(index);
              }
            }}
          >
            <Layer
              beforeId={ROUTE_ANCHOR}
              id="alternatives-line"
              key="alternatives-line"
              layout={{ "line-cap": "round", "line-join": "round" }}
              paint={{
                "line-color": colors.mutedForeground,
                "line-opacity": 0.6,
                "line-width": ["interpolate", ["linear"], ["zoom"], 12, 4, 18, 9],
              }}
              type="line"
            />
          </GeoJSONSource>
        ) : null}

        {/*
          The straight line and the road route are separate sources, not one
          layer restyled: a paint property that is dropped is not reset
          natively, so a dash once set stays on the road route forever.
        */}
        {line && route?.dashed ? (
          <GeoJSONSource data={line} id="straight">
            <Layer
              beforeId={ROUTE_ANCHOR}
              id="straight-line"
              key="straight-line"
              layout={{ "line-cap": "round", "line-join": "round" }}
              paint={{ "line-color": "#1d7fe0", "line-dasharray": [1.5, 1.5], "line-width": 4 }}
              type="line"
            />
          </GeoJSONSource>
        ) : null}

        {line && route && !route.dashed ? (
          <GeoJSONSource data={line} id="route">
            <Layer
              beforeId={ROUTE_ANCHOR}
              id="route-casing"
              key="route-casing"
              layout={{ "line-cap": "round", "line-join": "round" }}
              paint={{
                "line-color": "#ffffff",
                "line-width": ["interpolate", ["linear"], ["zoom"], 12, 7, 18, 15],
              }}
              type="line"
            />
            <Layer
              beforeId={ROUTE_ANCHOR}
              id="route-line"
              key="route-line"
              layout={{ "line-cap": "round", "line-join": "round" }}
              paint={{
                "line-color": colors.primary,
                "line-width": ["interpolate", ["linear"], ["zoom"], 12, 4, 18, 10],
              }}
              type="line"
            />
          </GeoJSONSource>
        ) : null}

        {/* Under the hostel pins: a pharmacy's dot never covers a hostel. */}
        {places.features.length > 0 ? (
          <GeoJSONSource data={places} id="nearby">
            <Layer
              beforeId="hostel-pin"
              id="nearby-dot"
              key="nearby-dot"
              paint={{
                "circle-color": colors.mutedForeground,
                "circle-radius": 5,
                "circle-stroke-color": "#ffffff",
                "circle-stroke-width": 1.5,
              }}
              type="circle"
            />
            <Layer
              beforeId="hostel-pin"
              id="nearby-label"
              key="nearby-label"
              layout={{
                "text-anchor": "top",
                "text-field": ["get", "name"],
                "text-font": LABEL_FONT,
                "text-max-width": 7,
                "text-offset": [0, 0.7],
                "text-size": 10,
              }}
              minzoom={14}
              paint={{
                "text-color": colors.mutedForeground,
                "text-halo-color": colors.card,
                "text-halo-width": 1.4,
              }}
              type="symbol"
            />
          </GeoJSONSource>
        ) : null}

        {/*
          The pins never hide behind each other's collision boxes — a hostel
          that vanishes because a street name was placed first is a hostel the
          reader never finds. Names give way instead. The chosen pin is its own
          layer so it draws largest and on top.
        */}
        <GeoJSONSource
          data={hostels}
          id="hostels"
          onPress={(event) => {
            event.stopPropagation();
            const id = event.nativeEvent.features[0]?.properties?.id;

            // Only an id this map was given can select anything.
            if (typeof id === "string" && markers.some((marker) => marker.id === id)) {
              onSelect(id);
            }
          }}
        >
          <Layer
            filter={["!=", ["get", "id"], selectedId ?? ""]}
            id="hostel-pin"
            key="hostel-pin"
            layout={{
              "icon-allow-overlap": true,
              "icon-anchor": "bottom",
              "icon-ignore-placement": true,
              "icon-image": HOSTEL_PIN,
              "icon-offset": PIN_OFFSET,
              "icon-size": ["interpolate", ["linear"], ["zoom"], 10, 0.5, 13, 0.62, 16, 0.78],
            }}
            type="symbol"
          />
          <Layer
            id="hostel-label"
            key="hostel-label"
            layout={{
              "symbol-sort-key": ["case", selected, 0, 1],
              "text-anchor": "top",
              "text-field": ["get", "name"],
              "text-font": LABEL_FONT,
              "text-max-width": 9,
              "text-offset": [0, 0.3],
              "text-size": ["case", selected, 13, 11],
            }}
            paint={{
              "text-color": colors.foreground,
              "text-halo-color": colors.card,
              "text-halo-width": 1.6,
            }}
            type="symbol"
          />
          <Layer
            filter={selected}
            id="hostel-pin-selected"
            key="hostel-pin-selected"
            layout={{
              "icon-allow-overlap": true,
              "icon-anchor": "bottom",
              "icon-ignore-placement": true,
              "icon-image": HOSTEL_PIN,
              "icon-offset": PIN_OFFSET,
              "icon-size": ["interpolate", ["linear"], ["zoom"], 10, 0.8, 16, 1],
            }}
            type="symbol"
          />
        </GeoJSONSource>

        {me || navigating ? (
          <NativeUserLocation
            mode={navigating ? (mode === "car" ? "course" : "heading") : "default"}
          />
        ) : null}
      </Map>

      {/*
        The tile licences require visible credit. Drawn natively over the map,
        and always on screen rather than behind an "i".
      */}
      <View
        className="absolute bottom-1 left-1 right-1 flex-row"
        style={{ pointerEvents: "none" }}
      >
        <View className="rounded px-1.5 py-0.5" style={{ backgroundColor: `${colors.card}cc` }}>
          <Text className="text-[9px]" variant="caption">
            {attribution}
          </Text>
        </View>
      </View>
    </View>
  );
});
