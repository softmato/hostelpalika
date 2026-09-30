import { useCallback, useRef, useState } from "react";
import { StyleSheet, useWindowDimensions, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";

import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { readApiError } from "@/lib/api-contract";
import type { Coordinates } from "@/lib/geo";
import {
  ATTRIBUTION,
  inlineJson,
  LEAFLET_CSS,
  LEAFLET_CSS_SRI,
  LEAFLET_JS,
  LEAFLET_JS_SRI,
  TILE_URL,
} from "@/lib/leaflet";
import { type LocationMatch, lookupRegistrationLocation } from "@/lib/registration-api";

/**
 * The application's location, the simple way: the owner pastes their hostel's
 * Google Maps link and the map appears under it.
 *
 * The link is read on the server (`/public/hostels/register/geocode`) because a
 * `maps.app.goo.gl` short link carries no coordinates until its redirect is
 * followed. The pin is optional — an owner without a link still applies.
 */

export type PinAddress = NonNullable<LocationMatch["address"]>;

function looksLikeMapLink(value: string): boolean {
  const trimmed = value.trim();

  return (
    /^(https?:\/\/|www\.|maps\.)/i.test(trimmed) ||
    /^-?\d{1,2}\.\d+\s*,\s*-?\d{1,3}\.\d+$/.test(trimmed)
  );
}

export function MapLinkField({
  near,
  onChange,
  onPinned,
  pin,
  value,
}: {
  near: string;
  onChange: (value: string) => void;
  onPinned: (match: LocationMatch) => void;
  pin: Coordinates | null;
  value: string;
}) {
  const [status, setStatus] = useState<{ error: boolean; text: string } | null>(null);
  /** The link last read, so a blur after a paste does not read it twice. */
  const readFor = useRef("");

  const read = useCallback(
    async (link: string) => {
      const trimmed = link.trim();

      if (!looksLikeMapLink(trimmed) || readFor.current === trimmed) {
        return;
      }

      readFor.current = trimmed;
      setStatus({ error: false, text: "Finding it on the map…" });

      try {
        const [best] = await lookupRegistrationLocation({ near, q: trimmed });

        if (readFor.current !== trimmed) {
          return;
        }

        if (!best) {
          setStatus({
            error: true,
            text: "No location in that link. In Google Maps tap Share → Copy link.",
          });
          return;
        }

        onPinned(best);
        setStatus(null);
      } catch (error) {
        if (readFor.current === trimmed) {
          readFor.current = "";
          setStatus({ error: true, text: readApiError(error, "Could not read that link.") });
        }
      }
    },
    [near, onPinned],
  );

  return (
    <View className="gap-3">
      <Input
        autoCapitalize="none"
        autoCorrect={false}
        error={status?.error ? status.text : undefined}
        hint={status?.text ?? "Google Maps → your hostel → Share → Copy link"}
        keyboardType="url"
        label="Google Maps link"
        onChangeText={(next) => {
          onChange(next);

          if (!next.trim()) {
            readFor.current = "";
            setStatus(null);
          } else if (next.length - value.length > 8) {
            // A jump this size is a paste: read it now.
            void read(next);
          }
        }}
        onEndEditing={() => void read(value)}
        placeholder="https://maps.app.goo.gl/…"
        value={value}
        variant="line"
      />

      {pin ? (
        <View className="h-48 overflow-hidden rounded-2xl border border-border">
          {/* Keyed on the pin: the page is built once per mount. */}
          <PinPreview key={`${pin.lat},${pin.lng}`} pin={pin} />
        </View>
      ) : null}
    </View>
  );
}

/**
 * A still map with the pin on it. Not pannable: it sits inside a scrolling step,
 * where a draggable map steals the page's scroll (see `HostelMap`'s `preview`).
 */
export function PinPreview({ pin }: { pin: Coordinates }) {
  const { colors } = useAppTheme();
  const { height } = useWindowDimensions();
  const [ready, setReady] = useState(false);
  const [html] = useState(() => buildPage(pin, colors.primary, colors.muted));

  return (
    <View className="flex-1" style={{ backgroundColor: colors.muted }}>
      <WebView
        allowFileAccess={false}
        androidLayerType="hardware"
        domStorageEnabled={false}
        javaScriptEnabled
        onMessage={(event: WebViewMessageEvent) => {
          if (event.nativeEvent.data === "ready") {
            setReady(true);
          }
        }}
        originWhitelist={["*"]}
        renderError={() => (
          <View className="flex-1 items-center justify-center bg-card px-6">
            <Text className="text-center" variant="muted">
              The map needs a connection.
            </Text>
          </View>
        )}
        scrollEnabled={false}
        setSupportMultipleWindows={false}
        source={{ html }}
        style={{ backgroundColor: colors.muted, flex: 1, pointerEvents: "none" }}
      />

      {ready ? null : (
        <View style={[StyleSheet.absoluteFill, { pointerEvents: "none" }]}>
          <Skeleton height={height} radius={0} />
        </View>
      )}

      {/* OpenStreetMap's licence requires the credit to be visible. */}
      <View
        className="absolute bottom-1 left-1 rounded bg-card px-1.5 py-0.5"
        style={{ pointerEvents: "none" }}
      >
        <Text className="text-[9px] text-muted-foreground" variant={null}>
          {ATTRIBUTION}
        </Text>
      </View>
    </View>
  );
}

function buildPage(pin: Coordinates, accent: string, background: string): string {
  const payload = inlineJson(pin);

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
<link rel="stylesheet" href="${LEAFLET_CSS}" integrity="${LEAFLET_CSS_SRI}" crossorigin="anonymous" />
<style>
  html, body, #map { height: 100%; margin: 0; padding: 0; background: ${background}; }
  .pin { background: ${accent}; border: 2px solid #ffffff; border-radius: 50% 50% 50% 0;
    box-shadow: 0 1px 4px rgba(0,0,0,.4); height: 22px; transform: rotate(-45deg); width: 22px; }
</style>
</head>
<body>
<div id="map"></div>
<script src="${LEAFLET_JS}" integrity="${LEAFLET_JS_SRI}" crossorigin="anonymous"></script>
<script>
(function () {
  var pin = ${payload};
  var map = L.map('map', {
    attributionControl: false, boxZoom: false, doubleClickZoom: false, dragging: false,
    keyboard: false, scrollWheelZoom: false, tap: false, touchZoom: false, zoomControl: false
  }).setView([pin.lat, pin.lng], 17);
  L.tileLayer(${JSON.stringify(TILE_URL)}, { maxZoom: 19 }).addTo(map);
  L.marker([pin.lat, pin.lng], {
    icon: L.divIcon({ className: '', html: '<div class="pin"></div>', iconAnchor: [11, 22], iconSize: [22, 22] })
  }).addTo(map);
  setTimeout(function () {
    map.invalidateSize();
    window.ReactNativeWebView.postMessage('ready');
  }, 60);
})();
</script>
</body>
</html>`;
}
