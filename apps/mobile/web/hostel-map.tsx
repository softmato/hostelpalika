import { useMemo, useRef } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";

import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { boundsCenter, type Coordinates, hostelCoordinates } from "@/lib/geo";
import { nearbyGlyph } from "@/lib/hostel-nearby";
import {
  ATTRIBUTION,
  inlineJson,
  LEAFLET_CSS,
  LEAFLET_CSS_SRI,
  LEAFLET_JS,
  LEAFLET_JS_SRI,
  TILE_URL,
} from "@/lib/leaflet";
import { priceRange } from "@/lib/hostel-display";
import type { NearbyPlace, PublicHostel } from "@/lib/public-api";

/**
 * Hostels on a map — Leaflet and OpenStreetMap tiles, inside a `WebView`.
 *
 * ## Why not `react-native-maps`
 *
 * It needs a Google Maps **Android** API key, and there is none: `.env` carries
 * `GOOGLE_CLIENT_ID`, which is OAuth and unrelated. Getting one means a billing
 * account, a key to rotate, and a per-load cost on a screen we want everyone to
 * open. The web app already made this call — `components/maps/leaflet-map.tsx`
 * draws the same OSM tiles — so this matches what the product already ships
 * rather than introducing a second map provider for one platform.
 *
 * The trade is real and worth naming: a WebView is heavier than a native map
 * view, pinch and pan are the browser's rather than the platform's, and the
 * whole thing is blank without a network. That last one is why the map is an
 * addition to the distance sort and never the only way to see nearby hostels —
 * the list is sorted with or without this.
 *
 * ## The HTML is built once per data change
 *
 * `source={{ html }}` remounts the WebView whenever the string changes, which
 * throws away the user's pan and zoom. So the markup is memoised on the marker
 * payload, not rebuilt every render.
 *
 * ## Tiles stay light in dark mode
 *
 * The usual trick — `filter: invert(1) hue-rotate(180deg)` — turns parks purple
 * and makes labels unreadable at small sizes. A light map in a dark app reads as
 * a photo, which is what a map is; an inverted one reads as broken.
 */

/* The CDN build, the tiles and the attribution live in `lib/leaflet.ts`: the
   directions map loads the same ones, and an SRI hash that drifts from its
   version renders as a blank grey box rather than as an error. */

type Marker = {
  lat: number;
  lng: number;
  name: string;
  price: string;
  slug: string;
};

/**
 * A place *around* a hostel rather than a hostel — a campus, a clinic, a bus
 * stop. Drawn as a small neutral dot with a one-character glyph, deliberately
 * unlike the brand-coloured teardrop a hostel gets: the one thing a reader must
 * never have to work out on this map is which pin is the place they are
 * considering living in.
 */
type PlaceMarker = {
  distance: string;
  glyph: string;
  lat: number;
  lng: number;
  name: string;
};

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
  /**
   * Take the whole space the parent gives instead of a fixed `height`, for the
   * browse screen's Map view where the map *is* the page.
   *
   * A parent using this must not be scrollable: a full-bleed map inside a
   * vertical `ScrollView` puts two pan gestures on the same pixels and the map
   * loses roughly half of them, which reads as the map being unresponsive
   * rather than as a gesture conflict.
   */
  fill?: boolean;
  /** Ignored when `fill` is set. */
  height?: number;
  hostels: PublicHostel[];
  /** The device's position, when it has been given. Drawn as a separate dot. */
  me: Coordinates | null;
  /**
   * Colleges, hospitals, bus stops around the hostel — the cached
   * OpenStreetMap lookup on the hostel document. Set on the detail screen, where
   * the map is answering "what is around it", and left off on browse, where the
   * map is answering "where are the hostels" and forty grey dots would bury the
   * answer.
   */
  nearby?: readonly NearbyPlace[];
  /** Where a tap on a `preview` map goes. Ignored otherwise. */
  onPress?: () => void;
  /**
   * Optional: the detail screen's map has one pin and it is the hostel already
   * on screen, so "View hostel" in its popup would be a link back to itself.
   * Without a handler the popup is just the name and the price.
   */
  onSelect?: (slug: string) => void;
  /**
   * Draw the map, but do not let anyone drive it.
   *
   * **Required for any map inside a scrolling screen**, which is the rule this
   * component's header states and the reason browse turns `<Screen scroll>` off
   * for its map view: a pannable map inside a vertical `ScrollView` puts two pan
   * gestures on the same pixels, and roughly half of each are lost to the other.
   * That reads as a broken map *and* a sticky page.
   *
   * A fixed `height` does not avoid it — a 220dp map in a scrolling page has the
   * same conflict over a smaller area, which is worse, because a reader
   * scrolling past it drags the map by accident instead of scrolling.
   *
   * So preview mode does two things: Leaflet's own drag, zoom and keyboard
   * handlers are switched off in the page, and the WebView is made
   * `pointerEvents: "none"` so no touch reaches it at all. The belt and the
   * braces are both wanted — the first stops the page reacting, the second
   * guarantees the ScrollView sees every gesture regardless of what the page
   * does. The whole thing becomes a picture with a tap target on it, and
   * `onPress` is where that tap should lead: a full-screen map that owns its
   * gestures.
   */
  preview?: boolean;
}) {
  const { colors } = useAppTheme();
  const webviewRef = useRef<WebView>(null);

  const markers = useMemo<Marker[]>(
    () =>
      hostels.flatMap((hostel) => {
        const point = hostelCoordinates(hostel);

        // An un-geocoded hostel has no pin. It is still in the list below —
        // dropping it from the map is honest, dropping it from both is not.
        return point
          ? [
              {
                lat: point.lat,
                lng: point.lng,
                name: hostel.name,
                price: priceRange(hostel.pricing),
                slug: hostel.slug,
              },
            ]
          : [];
      }),
    [hostels],
  );

  const places = useMemo<PlaceMarker[]>(
    () =>
      (nearby ?? []).flatMap((place) =>
        place.coordinates
          ? [
              {
                distance: formatMetres(place.distance),
                glyph: nearbyGlyph(place.type),
                lat: place.coordinates.lat,
                lng: place.coordinates.lng,
                name: place.name,
              },
            ]
          : [],
      ),
    [nearby],
  );

  const html = useMemo(
    () =>
      buildHtml(
        markers,
        places,
        me,
        // A preview cannot open a popup, so the popup's link is pointless there.
        Boolean(onSelect) && !preview,
        preview,
        colors.primary,
        colors.background,
      ),
    [colors.background, colors.primary, markers, me, onSelect, places, preview],
  );

  const onMessage = (event: WebViewMessageEvent) => {
    const slug = event.nativeEvent.data;

    // The page only ever posts a slug it was given, but it is still untrusted
    // input crossing a bridge, so it is matched against the markers rather
    // than pushed into a route.
    if (markers.some((marker) => marker.slug === slug)) {
      onSelect?.(slug);
    }
  };

  if (markers.length === 0) {
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

  return (
    <View
      className={`overflow-hidden rounded-2xl border border-border ${fill ? "flex-1" : ""}`}
      style={
        fill
          ? { backgroundColor: colors.muted }
          : { backgroundColor: colors.muted, height }
      }
    >
      <WebView
        // Nothing here needs storage, cookies or a file handle; the page is a
        // fixed string that renders coordinates.
        allowFileAccess={false}
        androidLayerType="hardware"
        domStorageEnabled={false}
        javaScriptEnabled
        onMessage={onMessage}
        originWhitelist={["*"]}
        ref={webviewRef}
        renderError={() => (
          <View className="flex-1 items-center justify-center bg-card px-6">
            <Text className="text-center" variant="muted">
              The map needs a connection. The list below still works.
            </Text>
          </View>
        )}
        scrollEnabled={false}
        setSupportMultipleWindows={false}
        source={{ html }}
        style={{
          backgroundColor: colors.muted,
          flex: 1,
          // The gesture half of preview mode — see the prop's note. Without this
          // the WebView still swallows the touch even with Leaflet's handlers
          // off, and the page it sits in scrolls only from the margins.
          pointerEvents: preview ? "none" : "auto",
        }}
      />

      {preview && onPress ? (
        <Pressable
          accessibilityLabel="Open the full map"
          accessibilityRole="button"
          onPress={onPress}
          style={StyleSheet.absoluteFill}
        />
      ) : null}
    </View>
  );
}

/** Metres or kilometres, matching the web's `formatDistance`. */
function formatMetres(meters: number): string {
  return meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${meters} m`;
}

/** The whole page, as one string. */
function buildHtml(
  markers: Marker[],
  places: PlaceMarker[],
  me: Coordinates | null,
  linkHostels: boolean,
  preview: boolean,
  accent: string,
  background: string,
): string {
  /*
   * The view is framed on the **hostels only**.
   *
   * Folding the nearby places into the bounds would zoom out to fit whatever
   * OpenStreetMap found furthest away — a bus route terminus two kilometres off
   * — and shrink the hostel to a dot in the middle of a district. The places are
   * context for the pin, so the pin decides the frame; the ones that fall outside
   * it are still reachable by panning, and they are also already listed in full
   * under the map.
   */
  const { center, zoom } = boundsCenter(
    markers.map((marker) => ({ lat: marker.lat, lng: marker.lng })),
  );

  const payload = inlineJson({
    accent,
    center,
    linkHostels,
    markers,
    me,
    places,
    preview,
    zoom,
  });

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
<link rel="stylesheet" href="${LEAFLET_CSS}" integrity="${LEAFLET_CSS_SRI}" crossorigin="anonymous" />
<style>
  html, body, #map { height: 100%; margin: 0; padding: 0; background: ${background}; }
  .pin {
    background: ${accent};
    border: 2px solid #ffffff;
    border-radius: 50% 50% 50% 0;
    box-shadow: 0 1px 4px rgba(0,0,0,.4);
    height: 18px;
    transform: rotate(-45deg);
    width: 18px;
  }
  .me {
    background: #1d7fe0;
    border: 3px solid #ffffff;
    border-radius: 50%;
    box-shadow: 0 1px 4px rgba(0,0,0,.4);
    height: 16px;
    width: 16px;
  }
  .place {
    align-items: center;
    background: ${background};
    border: 1.5px solid ${accent};
    border-radius: 50%;
    box-shadow: 0 1px 3px rgba(0,0,0,.3);
    display: flex;
    font: 9px -apple-system, Roboto, sans-serif;
    height: 16px;
    justify-content: center;
    opacity: .92;
    width: 16px;
  }
  .leaflet-popup-content { font: 13px -apple-system, Roboto, sans-serif; margin: 10px 12px; }
  .leaflet-popup-content b { display: block; margin-bottom: 2px; }
</style>
</head>
<body>
<div id="map"></div>
<script src="${LEAFLET_JS}" integrity="${LEAFLET_JS_SRI}" crossorigin="anonymous"></script>
<script>
(function () {
  var data = ${payload};

  /*
   * NOTE: no backticks anywhere below -- this is inside a JS template literal.
   *
   * In preview mode every handler Leaflet installs is switched off at
   * construction. The pointerEvents: "none" style on the WebView already stops
   * touches reaching this page, so this is the second of the two guards on the
   * prop -- it also keeps popups from opening on a map nobody can pan back.
   */
  var map = L.map('map', {
    attributionControl: true,
    boxZoom: !data.preview,
    doubleClickZoom: !data.preview,
    dragging: !data.preview,
    keyboard: !data.preview,
    scrollWheelZoom: !data.preview,
    tap: !data.preview,
    touchZoom: !data.preview,
    zoomControl: false
  }).setView([data.center.lat, data.center.lng], data.zoom);

  L.tileLayer(${JSON.stringify(TILE_URL)}, {
    attribution: ${JSON.stringify(ATTRIBUTION)},
    maxZoom: 18
  }).addTo(map);

  var pin = L.divIcon({ className: '', html: '<div class="pin"></div>', iconAnchor: [9, 18], iconSize: [18, 18] });

  data.markers.forEach(function (marker) {
    var link = data.linkHostels
      ? '<br/><a href="#" data-slug="' + escapeHtml(marker.slug) + '">View hostel</a>'
      : '';

    L.marker([marker.lat, marker.lng], { icon: pin })
      .addTo(map)
      .bindPopup('<b>' + escapeHtml(marker.name) + '</b>' + escapeHtml(marker.price) + link);
  });

  /*
   * NOTE: this comment is inside the generated page's <script>, which is inside
   * a JS template literal. No backticks below — one would close the template and
   * the compiler error lands here rather than where the string was opened.
   *
   * Places are drawn after the hostels, so Leaflet's default z-ordering (later
   * marker wins) would put a campus dot over the teardrop of a hostel that sits
   * inside the campus. The negative zIndexOffset is what stops that, and that
   * collision is the most likely one on this map rather than a hypothetical.
   */
  (data.places || []).forEach(function (place) {
    L.marker([place.lat, place.lng], {
      icon: L.divIcon({
        className: '',
        html: '<div class="place">' + escapeHtml(place.glyph) + '</div>',
        iconAnchor: [8, 8],
        iconSize: [16, 16]
      }),
      zIndexOffset: -100
    })
      .addTo(map)
      .bindPopup('<b>' + escapeHtml(place.name) + '</b>' + escapeHtml(place.distance) + ' away');
  });

  if (data.me) {
    L.marker([data.me.lat, data.me.lng], {
      icon: L.divIcon({ className: '', html: '<div class="me"></div>', iconAnchor: [8, 8], iconSize: [16, 16] })
    }).addTo(map).bindPopup('You are here');
  }

  // Fit every pin once the layout has settled. Leaflet measures the container,
  // and inside a WebView that container has zero height on the first frame.
  setTimeout(function () {
    map.invalidateSize();

    if (data.markers.length > 1) {
      map.fitBounds(data.markers.map(function (marker) { return [marker.lat, marker.lng]; }), {
        padding: [28, 28]
      });
    }
  }, 60);

  // Delegated, because popups are created and destroyed as they open and close.
  document.addEventListener('click', function (event) {
    var slug = event.target && event.target.getAttribute && event.target.getAttribute('data-slug');

    if (slug) {
      event.preventDefault();
      window.ReactNativeWebView.postMessage(slug);
    }
  });

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function (character) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character];
    });
  }
})();
</script>
</body>
</html>`;
}
