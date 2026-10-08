import { Camera, GeoJSONSource, Layer, Map, NativeUserLocation } from "@maplibre/maplibre-react-native";
import { useMemo } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { type Coordinates, hostelCoordinates } from "@/lib/geo";
import { priceRange } from "@/lib/hostel-display";
import { LABEL_FONT, nativeStyle } from "@/lib/map-styles";
import type { NearbyPlace, PublicHostel } from "@/lib/public-api";

/**
 * Hostels on a map — the browse screen's map view and the hostel page's map.
 *
 * Native MapLibre on OpenFreeMap vector tiles, the same engine as `/map`
 * (`components/map-explorer.tsx`); the PWA keeps the Leaflet version from
 * `web/hostel-map.tsx`. Labels carry the name and the price, so a tap on a pin
 * opens the hostel straight away instead of a popup first.
 *
 * `preview` draws a map nobody can drive: inside a scrolling screen, two pan
 * gestures on the same pixels lose half of each to the other. The whole map is
 * then one button (`onPress`).
 *
 * The view is framed on the hostels only — folding the nearby places in would
 * zoom out to whatever OpenStreetMap found furthest away.
 */

/** A hostel next door is not zoom 20. */
const MIN_SPAN_DEGREES = 0.006;

export function HostelMap({
  fill = false,
  height = 260,
  hostels,
  me,
  nearby,
  onPress,
  onSelect,
  preview = false,
}: {
  /** Take the parent's height instead of `height`. */
  fill?: boolean;
  /** Ignored when `fill` is set. */
  height?: number;
  hostels: PublicHostel[];
  /** The device's position, when it has been given. Drawn as the blue puck. */
  me: Coordinates | null;
  /** Places around a single hostel, drawn as small named dots. */
  nearby?: readonly NearbyPlace[];
  /** Where a tap on a `preview` map goes. Ignored otherwise. */
  onPress?: () => void;
  /** A pin was tapped. Absent on a hostel's own page — it would link to itself. */
  onSelect?: (slug: string) => void;
  /** Draw the map, but do not let anyone drive it. */
  preview?: boolean;
}) {
  const { colors, isDark } = useAppTheme();
  const style = nativeStyle("standard", isDark);

  const pins = useMemo(
    () =>
      hostels.flatMap((hostel) => {
        const point = hostelCoordinates(hostel);

        return point ? [{ point, price: priceRange(hostel.pricing), hostel }] : [];
      }),
    [hostels],
  );

  const data = useMemo<GeoJSON.FeatureCollection>(
    () => ({
      features: pins.map(({ hostel, point, price }) => ({
        geometry: { coordinates: [point.lng, point.lat], type: "Point" },
        properties: { label: price ? `${hostel.name}\n${price}` : hostel.name, slug: hostel.slug },
        type: "Feature",
      })),
      type: "FeatureCollection",
    }),
    [pins],
  );

  const places = useMemo<GeoJSON.FeatureCollection>(
    () => ({
      features: (nearby ?? []).flatMap((place) =>
        place.coordinates
          ? [
              {
                geometry: {
                  coordinates: [place.coordinates.lng, place.coordinates.lat],
                  type: "Point" as const,
                },
                properties: { name: place.name },
                type: "Feature" as const,
              },
            ]
          : [],
      ),
      type: "FeatureCollection",
    }),
    [nearby],
  );

  const view = useMemo(() => {
    if (pins.length === 1) {
      return { center: [pins[0].point.lng, pins[0].point.lat] as [number, number], zoom: 15 };
    }

    const lats = pins.map(({ point }) => point.lat);
    const lngs = pins.map(({ point }) => point.lng);
    const [south, north] = [Math.min(...lats), Math.max(...lats)];
    const [west, east] = [Math.min(...lngs), Math.max(...lngs)];
    const padLat = Math.max(0, (MIN_SPAN_DEGREES - (north - south)) / 2);
    const padLng = Math.max(0, (MIN_SPAN_DEGREES - (east - west)) / 2);

    return {
      bounds: [west - padLng, south - padLat, east + padLng, north + padLat] as [
        number,
        number,
        number,
        number,
      ],
      padding: { bottom: 40, left: 40, right: 40, top: 40 },
    };
  }, [pins]);

  if (pins.length === 0) {
    return (
      <View
        className={`items-center justify-center rounded-2xl border border-border bg-card ${
          fill ? "flex-1" : ""
        }`}
        style={fill ? undefined : { height }}
      >
        <Text variant="muted">No hostels here have been placed on the map yet.</Text>
      </View>
    );
  }

  const interactive = !preview;

  return (
    <View
      className={`overflow-hidden rounded-2xl border border-border ${fill ? "flex-1" : ""}`}
      style={fill ? { backgroundColor: colors.muted } : { backgroundColor: colors.muted, height }}
    >
      <Map
        attribution={false}
        compass={false}
        doubleTapZoom={interactive}
        dragPan={interactive}
        logo={false}
        mapStyle={style.mapStyle}
        style={{ flex: 1 }}
        touchPitch={interactive}
        touchRotate={interactive}
        touchZoom={interactive}
      >
        <Camera initialViewState={view} />

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
          data={data}
          id="hostels"
          onPress={(event) => {
            const slug = event.nativeEvent.features[0]?.properties?.slug;

            // Only a slug this map was given can open anything.
            if (interactive && typeof slug === "string" && pins.some(({ hostel }) => hostel.slug === slug)) {
              onSelect?.(slug);
            }
          }}
        >
          <Layer
            id="hostel-dot"
            paint={{
              "circle-color": colors.primary,
              "circle-radius": 8,
              "circle-stroke-color": "#ffffff",
              "circle-stroke-width": 2.5,
            }}
            type="circle"
          />
          <Layer
            id="hostel-label"
            layout={{
              "text-anchor": "top",
              "text-field": ["get", "label"],
              "text-font": LABEL_FONT,
              "text-max-width": 9,
              "text-offset": [0, 1],
              "text-size": 11,
            }}
            paint={{
              "text-color": colors.foreground,
              "text-halo-color": colors.card,
              "text-halo-width": 1.6,
            }}
            type="symbol"
          />
        </GeoJSONSource>

        {me ? <NativeUserLocation /> : null}
      </Map>

      <View
        className="absolute bottom-1 left-1 rounded px-1.5 py-0.5"
        style={{ backgroundColor: `${colors.card}cc`, pointerEvents: "none" }}
      >
        <Text className="text-[9px]" variant="caption">
          {style.attribution}
        </Text>
      </View>

      {/* A preview is one button: the whole map opens the full one. */}
      {preview && onPress ? (
        <Pressable
          accessibilityLabel="Open the map"
          accessibilityRole="button"
          onPress={onPress}
          style={StyleSheet.absoluteFill}
        />
      ) : null}
    </View>
  );
}
