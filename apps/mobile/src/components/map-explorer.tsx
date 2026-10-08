import {
  Camera,
  type CameraRef,
  GeoJSONSource,
  Layer,
  Map,
  NativeUserLocation,
  type TrackUserLocation,
} from "@maplibre/maplibre-react-native";
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { ExpressionSpecification } from "@maplibre/maplibre-gl-style-spec";
import { useWindowDimensions, View } from "react-native";

import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { type Coordinates, haversineMeters, KATHMANDU } from "@/lib/geo";
import type { MapExplorerProps, MapHandle, MapRoute } from "@/lib/map-types";
import { LABEL_FONT, nativeStyle } from "@/lib/map-styles";

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
 * The reader's own streets, not the whole catalogue: their position framed
 * with the nearest few hostels within 2 km, or the neighbourhood at zoom 15.
 * Without a position yet it waits a moment, shows the catalogue, and flies to
 * the reader when the fix arrives. Any gesture, selection, route or button
 * settles it for good.
 */

const NAV_ZOOM = 17.5;
const NAV_PITCH = 50;
/** Top padding while navigating, as a share of the height: the puck sits low. */
const NAV_LEAD = 0.42;

const NEAR_METERS = 2_000;
const NEAR_PINS = 3;
/** The smallest box the opening view frames — a hostel next door is not zoom 20. */
const MIN_SPAN_DEGREES = 0.006;

/** Room for the search field above and the card below whenever we fit. */
const FIT_PADDING = { bottom: 240, left: 48, right: 64, top: 140 };
const NO_PADDING = { bottom: 0, left: 0, right: 0, top: 0 };

function boundsOf(points: Coordinates[]): [number, number, number, number] {
  const lats = points.map((point) => point.lat);
  const lngs = points.map((point) => point.lng);
  const [south, north] = [Math.min(...lats), Math.max(...lats)];
  const [west, east] = [Math.min(...lngs), Math.max(...lngs)];
  const padLat = Math.max(0, (MIN_SPAN_DEGREES - (north - south)) / 2);
  const padLng = Math.max(0, (MIN_SPAN_DEGREES - (east - west)) / 2);

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
  const style = nativeStyle(layer, isDark);
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
        camera.current?.fitBounds(boundsOf([me, ...near]), { duration, padding: FIT_PADDING });
      } else {
        camera.current?.flyTo({ center: [me.lng, me.lat], duration, zoom: 15 });
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

  return (
    <View className="flex-1" style={{ backgroundColor: colors.muted }}>
      <Map
        attribution={false}
        compass={false}
        logo={false}
        mapStyle={style.mapStyle}
        onDidFinishLoadingMap={() => setLoaded(true)}
        onLongPress={(event) => {
          const [lng, lat] = event.nativeEvent.lngLat;

          onLongPress?.({ lat, lng });
        }}
        onPress={() => onSelect(null)}
        onRegionWillChange={(event) => {
          if (event.nativeEvent.userInteraction) {
            touched.current = true;
          }
        }}
        style={{ flex: 1 }}
      >
        <Camera
          initialViewState={{ center: [KATHMANDU.lng, KATHMANDU.lat], zoom: 12 }}
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
              beforeId={style.routeBelow}
              id="alternatives-line"
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

        {route && route.points.length > 1 ? (
          <GeoJSONSource data={lineData(route.points)} id="route">
            {route.dashed ? null : (
              <Layer
                beforeId={style.routeBelow}
                id="route-casing"
                layout={{ "line-cap": "round", "line-join": "round" }}
                paint={{
                  "line-color": "#ffffff",
                  "line-width": ["interpolate", ["linear"], ["zoom"], 12, 7, 18, 15],
                }}
                type="line"
              />
            )}
            <Layer
              beforeId={style.routeBelow}
              id="route-line"
              layout={{ "line-cap": "round", "line-join": "round" }}
              paint={
                route.dashed
                  ? { "line-color": "#1d7fe0", "line-dasharray": [1.5, 1.5], "line-width": 4 }
                  : {
                      "line-color": colors.primary,
                      "line-width": ["interpolate", ["linear"], ["zoom"], 12, 4, 18, 10],
                    }
              }
              type="line"
            />
          </GeoJSONSource>
        ) : null}

        {places.features.length > 0 ? (
          <GeoJSONSource data={places} id="nearby">
            <Layer
              id="nearby-dot"
              paint={{
                "circle-color": colors.mutedForeground,
                "circle-radius": 5,
                "circle-stroke-color": "#ffffff",
                "circle-stroke-width": 1.5,
              }}
              type="circle"
            />
            <Layer
              id="nearby-label"
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
            id="hostel-dot"
            paint={{
              "circle-color": colors.primary,
              "circle-radius": ["case", selected, 11, 7],
              "circle-stroke-color": "#ffffff",
              "circle-stroke-width": ["case", selected, 3, 2],
            }}
            type="circle"
          />
          <Layer
            id="hostel-label"
            layout={{
              "symbol-sort-key": ["case", selected, 0, 1],
              "text-anchor": "top",
              "text-field": ["get", "name"],
              "text-font": LABEL_FONT,
              "text-max-width": 9,
              "text-offset": [0, 1],
              "text-size": ["case", selected, 13, 11],
            }}
            paint={{
              "text-color": colors.foreground,
              "text-halo-color": colors.card,
              "text-halo-width": 1.6,
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
        className="absolute bottom-1 left-1 rounded px-1.5 py-0.5"
        style={{ backgroundColor: `${colors.card}cc`, pointerEvents: "none" }}
      >
        <Text className="text-[9px]" variant="caption">
          {style.attribution}
        </Text>
      </View>
    </View>
  );
});
