import { Ionicons } from "@expo/vector-icons";
import { useCallback, useRef, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useSystemInsets } from "@/hooks/use-system-insets";
import { readApiError } from "@/lib/api-contract";
import type { Coordinates } from "@/lib/geo";
import { requestDeviceLocation } from "@/lib/location";
import { toastError } from "@/lib/toast";
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

/**
 * The link-reading half of {@link MapLinkField}, for a form that draws its own
 * field: wire `onChangeText` and `onEndEditing` to it, and show `status`.
 */
export function useMapLinkReader({
  near,
  onChange,
  onPinned,
  value,
}: {
  near: string;
  onChange: (value: string) => void;
  onPinned: (match: LocationMatch) => void;
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

  return {
    onChangeText: (next: string) => {
      onChange(next);

      if (!next.trim()) {
        readFor.current = "";
        setStatus(null);
      } else if (next.length - value.length > 8) {
        // A jump this size is a paste: read it now.
        void read(next);
      }
    },
    onEndEditing: () => void read(value),
    status,
  };
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
  const { onChangeText, onEndEditing, status } = useMapLinkReader({ near, onChange, onPinned, value });

  return (
    <View className="gap-3">
      <Input
        autoCapitalize="none"
        autoCorrect={false}
        error={status?.error ? status.text : undefined}
        hint={status?.text ?? "Google Maps → your hostel → Share → Copy link"}
        keyboardType="url"
        label="Google Maps link"
        onChangeText={onChangeText}
        onEndEditing={onEndEditing}
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

/** Where an empty picker opens: Kathmandu, zoomed out enough to find a ward. */
const KATHMANDU = { lat: 27.7172, lng: 85.324 };

export type PinSearchHit = Coordinates & { displayName?: string };

/**
 * Placing the pin by hand: the map pans under a pin fixed at the centre, the
 * way every ride app does it, so a thumb never has to land on a 20-point
 * marker. Search (a place, a pasted map link, `lat,lng`) and the phone's own
 * position both just move the map; "Use this spot" returns wherever the centre
 * is. Full screen, because a pannable map inside a scrolling step steals the
 * page's scroll.
 */
export function PinPickerModal<Hit extends PinSearchHit>({
  initial,
  onClose,
  onPick,
  open,
  search,
}: {
  initial: Coordinates | null;
  onClose: () => void;
  /** The centre, and the search hit it came from while the map has not moved since. */
  onPick: (pick: Coordinates & { hit?: Hit }) => void;
  open: boolean;
  search: (query: string) => Promise<Hit[]>;
}) {
  const { colors } = useAppTheme();
  const insets = useSystemInsets();
  const map = useRef<WebView>(null);
  const [center, setCenter] = useState<Coordinates | null>(initial);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [busy, setBusy] = useState<"locate" | "search" | null>(null);
  const [fromHit, setFromHit] = useState<Hit | null>(null);
  // Built once per open, so moving the map never reloads it.
  const [html, setHtml] = useState<string | null>(null);

  if (open && html === null) {
    setHtml(pickerPage(initial ?? KATHMANDU, initial ? 17 : 13, colors.muted));
  } else if (!open && html !== null) {
    setHtml(null);
  }

  const flyTo = (to: Coordinates) => {
    map.current?.injectJavaScript(`window.flyTo(${to.lat}, ${to.lng}); true;`);
    setCenter(to);
  };

  const runSearch = async () => {
    if (query.trim().length < 2 || busy) return;
    setBusy("search");
    setHits([]);

    try {
      const results = (await search(query.trim())).filter((hit) => Number.isFinite(hit.lat) && Number.isFinite(hit.lng));

      if (results.length === 1) {
        flyTo(results[0]);
        setFromHit(results[0]);
      } else {
        setHits(results);
      }

      if (!results.length) toastError("No place found", "Try a nearby landmark, or move the map.");
    } catch (error) {
      toastError("Could not search", readApiError(error));
    } finally {
      setBusy(null);
    }
  };

  const locate = async () => {
    setBusy("locate");
    const outcome = await requestDeviceLocation();
    setBusy(null);

    if (outcome.kind === "granted") {
      flyTo(outcome.coordinates);
      setFromHit(null);
    } else {
      toastError("Location is off", "Search for the place instead, or move the map.");
    }
  };

  return (
    <Modal animationType="slide" onRequestClose={onClose} statusBarTranslucent visible={open}>
      <View className="flex-1 bg-background" style={{ paddingBottom: insets.bottom, paddingTop: insets.top }}>
        <View className="flex-row items-center gap-2 px-3 py-2">
          <Pressable accessibilityLabel="Close" accessibilityRole="button" className="h-11 w-11 items-center justify-center" onPress={onClose}>
            <Ionicons color={colors.foreground} name="close" size={24} />
          </Pressable>
          <View className="flex-1">
            <Input
              autoCapitalize="none"
              autoCorrect={false}
              leading={<Ionicons color={colors.mutedForeground} name="search" size={18} />}
              onChangeText={setQuery}
              onSubmitEditing={() => void runSearch()}
              placeholder="Place, map link or lat, lng"
              returnKeyType="search"
              value={query}
            />
          </View>
        </View>

        <View className="flex-1">
          {html ? (
            <WebView
              allowFileAccess={false}
              androidLayerType="hardware"
              domStorageEnabled={false}
              javaScriptEnabled
              onMessage={(event: WebViewMessageEvent) => {
                try {
                  const next = JSON.parse(event.nativeEvent.data) as Coordinates & { moved?: boolean };
                  setCenter({ lat: next.lat, lng: next.lng });
                  if (next.moved) setFromHit(null);
                } catch {
                  // Not ours.
                }
              }}
              originWhitelist={["*"]}
              ref={map}
              setSupportMultipleWindows={false}
              source={{ html }}
              style={{ backgroundColor: colors.muted, flex: 1 }}
            />
          ) : null}

          {/* The pin is ours, not the map's: its tip sits on the centre. */}
          <View className="absolute inset-0 items-center justify-center" style={{ pointerEvents: "none" }}>
            <View style={{ marginTop: -40 }}>
              <Ionicons color={colors.primary} name="location" size={44} />
            </View>
          </View>

          <Pressable
            accessibilityLabel="Go to my location"
            accessibilityRole="button"
            className="absolute bottom-4 right-4 h-12 w-12 items-center justify-center rounded-full border border-border bg-card active:opacity-70"
            disabled={busy !== null}
            onPress={() => void locate()}
          >
            <Ionicons color={colors.primary} name={busy === "locate" ? "hourglass-outline" : "locate"} size={22} />
          </Pressable>

          <View className="absolute bottom-1 left-1 rounded bg-card px-1.5 py-0.5" style={{ pointerEvents: "none" }}>
            <Text className="text-[9px] text-muted-foreground" variant={null}>
              {ATTRIBUTION}
            </Text>
          </View>

          {busy === "search" || hits.length ? (
            <View className="absolute left-3 right-3 top-2 max-h-72 overflow-hidden rounded-2xl border border-border bg-card">
              {busy === "search" ? (
                <View className="p-3"><Skeleton height={48} /></View>
              ) : (
                <ScrollView keyboardShouldPersistTaps="handled">
                  {hits.map((hit) => (
                    <Pressable
                      accessibilityRole="button"
                      className="min-h-14 flex-row items-center gap-3 border-b border-border px-4 py-2 active:opacity-70"
                      key={`${hit.lat},${hit.lng}`}
                      onPress={() => {
                        flyTo(hit);
                        setFromHit(hit);
                        setHits([]);
                      }}
                    >
                      <Ionicons color={colors.mutedForeground} name="location-outline" size={20} />
                      <Text className="flex-1" numberOfLines={2}>{hit.displayName ?? `${hit.lat.toFixed(5)}, ${hit.lng.toFixed(5)}`}</Text>
                    </Pressable>
                  ))}
                </ScrollView>
              )}
            </View>
          ) : null}
        </View>

        <View className="gap-2 px-4 pt-3">
          <Text className="text-center" variant="caption">Move the map until the pin sits on your door</Text>
          <Button
            disabled={!center}
            label="Use this spot"
            onPress={() => {
              if (center) onPick({ ...center, hit: fromHit ?? undefined });
            }}
          />
        </View>
      </View>
    </Modal>
  );
}

function pickerPage(start: Coordinates, zoom: number, background: string): string {
  const payload = inlineJson({ lat: start.lat, lng: start.lng, zoom });

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
<link rel="stylesheet" href="${LEAFLET_CSS}" integrity="${LEAFLET_CSS_SRI}" crossorigin="anonymous" />
<style>html, body, #map { height: 100%; margin: 0; padding: 0; background: ${background}; }</style>
</head>
<body>
<div id="map"></div>
<script src="${LEAFLET_JS}" integrity="${LEAFLET_JS_SRI}" crossorigin="anonymous"></script>
<script>
(function () {
  var start = ${payload};
  var flying = false;
  var map = L.map('map', { attributionControl: false, zoomControl: false }).setView([start.lat, start.lng], start.zoom);
  L.tileLayer(${JSON.stringify(TILE_URL)}, { maxZoom: 19 }).addTo(map);
  var post = function (moved) {
    var c = map.getCenter();
    window.ReactNativeWebView.postMessage(JSON.stringify({ lat: c.lat, lng: c.lng, moved: moved }));
  };
  map.on('moveend', function () { post(!flying); flying = false; });
  window.flyTo = function (lat, lng) { flying = true; map.setView([lat, lng], 17); };
  setTimeout(function () { map.invalidateSize(); post(false); }, 60);
})();
</script>
</body>
</html>`;
}
