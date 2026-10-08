import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";

import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import type { Coordinates } from "@/lib/geo";
import { headingDifference } from "@/lib/navigation";
import {
  inlineJson,
  LEAFLET_CSS,
  LEAFLET_CSS_SRI,
  LEAFLET_JS,
  LEAFLET_JS_SRI,
  mapLayer,
  MAP_LAYERS,
} from "@/lib/leaflet";
import type { MapExplorerProps, MapHandle } from "@/lib/map-types";

export type { MapHandle, MapMarker } from "@/lib/map-types";

/** Street level while navigating — the native map's zoom, in Leaflet's whole steps. */
const NAVIGATION_ZOOM = 18;

/**
 * The PWA's map: a Leaflet page in the iframe stand-in for the WebView.
 *
 * The phone app draws natively with MapLibre (`src/components/map-explorer.tsx`);
 * MapLibre's React Native build has no web version, so `metro.config.js` swaps
 * this in for the web bundle. Both keep the contract in `lib/map-types.ts`.
 * Navigation's follow and turn, which MapLibre does natively, are done here in
 * effects from the reader's position and heading.
 *
 * ## The page is built once and then *driven*
 *
 * This is the whole performance story, and it is the one thing that must not be
 * undone. `source={{ html }}` remounts the WebView every time the string
 * changes — a fresh browser, a fresh Leaflet, fresh tiles over the network, and
 * the reader's pan and zoom thrown away. `HostelMap` rebuilds its page whenever
 * its markers change, which is fine for a static list and unusable for a screen
 * with a search field: every keystroke would reload the map.
 *
 * So the HTML here is created **once** (`useState` with a lazy initialiser, so
 * even a re-render cannot replace it) as an empty shell that exposes
 * `window.__map`. Everything after that — markers, the selection, the device
 * dot, the route — is `injectJavaScript`, which runs inside the page that is
 * already loaded. Typing in the search box moves pins; it does not reload a map.
 *
 * ## Injection is gated on `ready`
 *
 * A script injected before Leaflet has parsed is simply lost, and the failure
 * looks like an empty map with no error anywhere. The page posts `ready` when
 * `window.__map` exists, and every effect below depends on that flag — so the
 * first paint is always the full state, in one pass, however slow the CDN was.
 *
 * ## What crosses the bridge
 *
 * Out: JSON this component built. In: `{ type: "ready" }`, `{ type: "select",
 * id }`, `{ type: "clear" }` and `{ type: "touched" }` — nothing else is honoured, and the id is
 * matched against the markers this component was given before it is passed on.
 * The page is third-party JavaScript (Leaflet, from a CDN, with an SRI hash) and
 * is treated as untrusted input in both directions.
 */

/**
 * Degrees of compass movement worth an injection. Below this the map turns by
 * less than the reader can see, and a magnetometer at rest jitters by about
 * this much all on its own.
 */
const BEARING_EPSILON_DEGREES = 2;

export const MapExplorer = forwardRef<MapHandle, MapExplorerProps>(function MapExplorer(
  {
    alternatives,
    layer = "standard",
    markers,
    me,
    meAccuracyMeters,
    meHeading,
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
  const { colors } = useAppTheme();
  const webview = useRef<WebView>(null);
  const [ready, setReady] = useState(false);

  // Lazy initialiser: the shell is built on the first render and never again,
  // so the WebView's `source` is referentially stable for the life of the
  // screen. Colours are captured here; a theme switch mid-map keeps the tiles
  // it has, which is better than a reload for a change nobody makes twice.
  const [html] = useState(() =>
    buildShell({
      accent: colors.primary,
      background: colors.background,
      border: colors.border,
      card: colors.card,
      foreground: colors.foreground,
      mutedForeground: colors.mutedForeground,
    }),
  );

  const call = useCallback(
    (script: string) => {
      /*
       * The `ready` gate lives **here**, not only at the call sites.
       *
       * Every effect in this component already wrote `if (ready) { call(…) }` —
       * but the imperative handle below hands `call` straight to `app/map.tsx`,
       * which is outside that discipline and cannot see the flag. Its north-up
       * effect fires `setBearing(0)` on mount, long before the page has posted
       * `ready`, and `webview.current?.` does not help: the WebView exists, it is
       * the *page inside it* that has not run its script yet. So the injection
       * lands on a document where `window.__map` is undefined and throws
       *
       *   Uncaught TypeError: Cannot read properties of undefined
       *   (reading 'setBearing')
       *
       * inside the WebView, where nothing in React Native surfaces it — it shows
       * up only as a `chromium` line in logcat, which is how it survived this
       * long. Gating the one function every path goes through closes all of them
       * at once, and matches what this file's header already claims it does.
       */
      if (!ready) {
        return;
      }

      // The trailing `true;` is required on iOS: `injectJavaScript` warns when the
      // evaluated expression is not a primitive, and a Leaflet call returns an
      // object.
      webview.current?.injectJavaScript(`${script}; true;`);
    },
    [ready],
  );

  /*
   * The last bearing actually sent to the page. A ref, not state: it changes
   * several times a second, nothing renders from it, and under the React
   * Compiler it is only ever written from a handler — never during render.
   */
  const sentBearing = useRef<number | null>(null);

  const worthSending = useCallback((bearing: number | null) => {
    if (bearing === null) {
      return false;
    }

    if (
      sentBearing.current !== null &&
      headingDifference(sentBearing.current, bearing) <= BEARING_EPSILON_DEGREES
    ) {
      return false;
    }

    sentBearing.current = bearing;

    return true;
  }, []);

  const center = useCallback(
    (point: Coordinates, zoom = 15) =>
      call(`window.__map.center(${point.lat}, ${point.lng}, ${zoom})`),
    [call],
  );

  const setBearing = useCallback(
    (bearing: number) => {
      if (worthSending(bearing)) {
        call(`window.__map.setBearing(${bearing})`);
      }
    },
    [call, worthSending],
  );

  // The latest fix, for `recentre` — read from a handler, never during render.
  const here = useRef(me);

  useEffect(() => {
    here.current = me;
  }, [me]);

  useImperativeHandle(
    ref,
    () => ({
      center,
      fitAll: () => call("window.__map.fitAll()"),
      recentre: () => {
        if (here.current) {
          center(here.current, NAVIGATION_ZOOM);
        }
      },
    }),
    [call, center],
  );

  /*
   * Navigation follows, in two effects rather than one: a fix moves the map and
   * a compass sample only turns it, so a pinch is not undone ten times a second.
   * The zoom is passed once per session; after that the page keeps its own.
   */
  const zoomed = useRef(false);

  useEffect(() => {
    if (!navigating) {
      zoomed.current = false;
      return;
    }

    if (!me || !ready) {
      return;
    }

    call(
      `window.__map.follow(${me.lat}, ${me.lng}, ${inlineJson(zoomed.current ? null : NAVIGATION_ZOOM)}, null)`,
    );
    zoomed.current = true;
  }, [call, me, navigating, ready]);

  useEffect(() => {
    if (!navigating) {
      if (ready) {
        setBearing(0);
      }
      return;
    }

    if (northUp) {
      setBearing(0);
    } else if (typeof meHeading === "number") {
      setBearing(meHeading);
    }
  }, [meHeading, navigating, northUp, ready, setBearing]);

  const ids = useMemo(() => new Set(markers.map((marker) => marker.id)), [markers]);

  const onMessage = useCallback(
    (event: WebViewMessageEvent) => {
      let message: unknown;

      try {
        message = JSON.parse(event.nativeEvent.data);
      } catch {
        return;
      }

      if (typeof message !== "object" || message === null) {
        return;
      }

      const { id, type } = message as { id?: unknown; type?: unknown };

      if (type === "ready") {
        /*
         * Forget any bearing "sent" while the page was still loading.
         *
         * `worthSending` has a side effect — it records the value in
         * `sentBearing` and suppresses the next identical one. Now that `call`
         * drops injections before `ready`, a bearing could be recorded as sent
         * without ever reaching the page, and the map would then refuse to
         * rotate to that same heading once it was finally listening. Clearing it
         * here makes the first bearing after load unconditional.
         */
        sentBearing.current = null;
        setReady(true);
        return;
      }

      if (type === "clear") {
        onSelect(null);
        return;
      }

      if (type === "touched") {
        onTouched?.();
        return;
      }

      if (type === "alternative") {
        const { index } = message as { index?: unknown };

        if (typeof index === "number") {
          onPickAlternative?.(index);
        }
        return;
      }

      if (type === "longpress") {
        const { lat, lng } = message as { lat?: unknown; lng?: unknown };

        if (typeof lat === "number" && typeof lng === "number") {
          onLongPress?.({ lat, lng });
        }
        return;
      }

      // An id the page was never given cannot select anything. This is the one
      // place a string from inside the WebView could reach navigation.
      if (type === "select" && typeof id === "string" && ids.has(id)) {
        onSelect(id);
      }
    },
    [ids, onLongPress, onPickAlternative, onSelect, onTouched],
  );

  /*
   * Four effects, one per thing the page holds, so a change to any of them
   * costs exactly one small script and never touches the rest. `ready` is in
   * every dependency list: it flips once, and that pass sets the full state.
   */
  // First, so the canvas has its navigation size before any fix is followed.
  useEffect(() => {
    if (ready) {
      call(`window.__map.setNavigating(${navigating})`);
    }
  }, [call, navigating, ready]);

  useEffect(() => {
    if (ready) {
      call(`window.__map.setMarkers(${inlineJson(markers)})`);
    }
  }, [call, markers, ready]);

  useEffect(() => {
    if (ready) {
      call(
        `window.__map.setMe(${inlineJson(me)}, ${inlineJson(meHeading ?? null)}, ${inlineJson(meAccuracyMeters ?? null)})`,
      );
    }
  }, [call, me, meAccuracyMeters, meHeading, ready]);

  useEffect(() => {
    if (ready) {
      call(`window.__map.setRoute(${inlineJson(route)})`);
    }
  }, [call, ready, route]);

  useEffect(() => {
    if (ready) {
      call(`window.__map.select(${inlineJson(selectedId)})`);
    }
  }, [call, ready, selectedId]);

  useEffect(() => {
    if (ready) {
      call(`window.__map.setLayer(${inlineJson(layer)})`);
    }
  }, [call, layer, ready]);

  useEffect(() => {
    if (ready) {
      call(`window.__map.setAlternatives(${inlineJson(alternatives ?? [])})`);
    }
  }, [alternatives, call, ready]);

  useEffect(() => {
    if (ready) {
      call(`window.__map.setNearby(${inlineJson(nearby ?? [])})`);
    }
  }, [call, nearby, ready]);

  return (
    <View className="flex-1" style={{ backgroundColor: colors.muted }}>
      <WebView
        allowFileAccess={false}
        // No `androidLayerType="hardware"`: an offscreen layer is re-rendered
        // on every frame of a pan, which is what made dragging feel stuck.
        domStorageEnabled={false}
        javaScriptEnabled
        onMessage={onMessage}
        originWhitelist={["*"]}
        ref={webview}
        renderError={() => (
          <View className="flex-1 items-center justify-center bg-card px-6">
            <Text className="text-center" variant="muted">
              The map needs a connection. Search and the hostel list still work.
            </Text>
          </View>
        )}
        scrollEnabled={false}
        setSupportMultipleWindows={false}
        source={{ html }}
        style={{ backgroundColor: colors.muted, flex: 1 }}
      />
      {/*
        OpenStreetMap's licence requires this to be visible, so it is drawn
        outside the WebView: Leaflet's own control lives in a corner, and a
        rotated map turns its corners off the screen. Native also means it is
        correct in every mode without a second thing to keep upright.
      */}
      <View
        className="absolute bottom-1 left-1 rounded px-1.5 py-0.5"
        style={{ backgroundColor: `cc`, pointerEvents: "none" }}
      >
        <Text className="text-[9px]" variant="caption">
          {mapLayer(layer).attribution}
        </Text>
      </View>
    </View>
  );
});

/**
 * The empty page, with its API attached to `window.__map`.
 *
 * Everything below is written to be called repeatedly and cheaply: markers live
 * in one `LayerGroup` that is cleared and refilled (60 pins is nothing, and a
 * diff would be more code than it saves), the route is a single polyline
 * replaced in place, and selection only swaps a CSS class rather than rebuilding
 * a marker.
 */
function buildShell({
  accent,
  background,
  border,
  card,
  foreground,
  mutedForeground,
}: {
  accent: string;
  background: string;
  border: string;
  card: string;
  foreground: string;
  mutedForeground: string;
}): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
<link rel="stylesheet" href="${LEAFLET_CSS}" integrity="${LEAFLET_CSS_SRI}" crossorigin="anonymous" />
<style>
  html, body, #stage { height: 100%; margin: 0; padding: 0; background: ${background}; }

  /*
   * Rotation, without a rotation plugin.
   *
   * Leaflet 1.9 cannot turn its own canvas, so the whole map is turned in CSS
   * instead: #stage is the window the reader looks through, and #map is a
   * larger square spun inside it. The square's side is the diagonal of the
   * window (set in JS below), because a rectangle rotated inside its own bounds
   * shows bare background at the corners — at 45 degrees, a lot of it.
   *
   * --bearing is the rotation applied to the map, which is the *negative* of the
   * device heading: facing east (90) turns the world 90 anticlockwise so that
   * east is up. Getting that sign wrong gives a map that turns the wrong way,
   * which reads as a broken compass rather than a broken stylesheet.
   */
  #stage { position: absolute; inset: 0; overflow: hidden; }
  #map {
    left: 50%;
    position: absolute;
    top: 50%;
    /* Linear, not eased: the bearing arrives as a steady stream of samples, and
       an ease-out on each one makes a continuous turn stutter. */
    transition: transform 300ms linear;
    transform: translate(-50%, -50%) rotate(var(--bearing, 0deg));
    transform-origin: 50% 50%;
  }
  /*
   * Two elements, one pin. The stage above turns everything inside it, markers
   * included, so a pin left as one element hangs upside down whenever the
   * reader faces south. The wrapper undoes the stage's rotation — it is the
   * exact opposite of --bearing — and the pin inside keeps its own -45deg,
   * which is what makes a circle with one square corner look like a teardrop.
   * Both transforms on one element would mean multiplying them by hand on every
   * sample.
   */
  .pin-wrap {
    height: 100%;
    /* The label is absolutely positioned against this. */
    position: relative;
    transform: rotate(calc(-1 * var(--bearing, 0deg)));
    transition: transform 300ms linear;
    width: 100%;
  }
  .pin {
    background: ${accent};
    border: 2px solid #ffffff;
    border-radius: 50% 50% 50% 0;
    box-shadow: 0 1px 4px rgba(0,0,0,.4);
    height: 18px;
    transform: rotate(-45deg);
    transition: height .12s ease, width .12s ease;
    width: 18px;
  }
  /* The selected pin grows rather than changing colour: the palette has one
     accent, and a second colour here would read as a second kind of thing. */
  .pin.on { height: 26px; width: 26px; }
  /*
   * Every pin's name, drawn as part of the pin itself.
   *
   * Not a Leaflet tooltip, which was the first attempt: a tooltip is positioned
   * by writing transform: translate3d(...) on its own element, so the
   * counter-rotation cannot live there, and unbinding one left its node in the
   * pane — three selections, three labels on screen. Inside the icon the label
   * has neither problem. It is created and destroyed with the marker, and it
   * sits inside .pin-wrap, which is already counter-rotated, so it stays
   * upright at every bearing without knowing that rotation exists.
   */
  .pin-label {
    background: ${card};
    border: 1px solid ${border};
    border-radius: 8px;
    bottom: 22px;
    box-shadow: 0 1px 4px rgba(0,0,0,.3);
    color: ${foreground};
    font: 600 10px/1.3 system-ui, -apple-system, sans-serif;
    left: 50%;
    /*
     * Sixty of these share one screen, so an unselected name stays on a single
     * line and clips: the labels are there to tell the dots apart, and a wall
     * of wrapped text would hide the map they sit on.
     */
    max-width: 104px;
    overflow: hidden;
    padding: 2px 6px;
    /* The pin under it is the tap target; this is only ever read. */
    pointer-events: none;
    position: absolute;
    text-align: center;
    text-overflow: ellipsis;
    transform: translateX(-50%);
    white-space: nowrap;
    width: max-content;
  }
  /* The chosen one is the only label allowed to take room: it clears the bigger
     pin, shows the whole name, and is ringed in the accent — so it reads as the
     one being looked at even before the line underneath says so. */
  .pin-label.on {
    border-color: ${accent};
    bottom: 30px;
    font-size: 11px;
    line-height: 1.35;
    max-width: 160px;
    overflow: visible;
    padding: 3px 7px;
    white-space: normal;
  }
  .pin-label-sub {
    color: ${mutedForeground};
    font: 600 8px/1.5 system-ui, -apple-system, sans-serif;
    letter-spacing: .06em;
    text-transform: uppercase;
  }
  .me {
    background: #1d7fe0;
    border: 3px solid #ffffff;
    border-radius: 50%;
    box-shadow: 0 1px 4px rgba(0,0,0,.4);
    height: 16px;
    width: 16px;
  }
  /*
   * The same dot, once it knows which way it is pointing. Drawn pointing north
   * and rotated by the heading, so in north-up mode it points where the reader
   * is facing, and in navigation mode — where the stage is turned by the
   * negative of that same heading — the two cancel and it points up the screen.
   * One element that is right in both modes, rather than two markers.
   */
  .me-arrow {
    filter: drop-shadow(0 1px 3px rgba(0,0,0,.45));
    height: 34px;
    transition: transform 300ms linear;
    transform-origin: 50% 50%;
    width: 34px;
  }
</style>
</head>
<body>
<div id="stage"><div id="map"></div></div>
<script src="${LEAFLET_JS}" integrity="${LEAFLET_JS_SRI}" crossorigin="anonymous"></script>
<script>
(function () {
  function post(payload) {
    if (window.ReactNativeWebView) {
      window.ReactNativeWebView.postMessage(JSON.stringify(payload));
    }
  }

  // Leaflet failed to load — a blocked CDN or a stale SRI hash. Say nothing and
  // never post ready: the native side keeps its own UI and the map stays grey.
  if (typeof L === 'undefined') {
    return;
  }

  /*
   * No attribution control inside the page: it sits in a corner, and D.1 turns
   * the corners off-screen. OSM's licence is not optional, so the credit is
   * rendered natively over the map instead, where nothing rotates it.
   */
  /*
   * No tile fade: it is a per-frame opacity loop over every arriving tile,
   * running on the same thread as the drag.
   */
  var map = L.map('map', { attributionControl: false, fadeAnimation: false, zoomControl: false })
    .setView([27.7172, 85.324], 12);

  /*
   * The tile sources, injected from lib/leaflet.ts so the licence strings and
   * the zoom ceilings have exactly one home. Attribution is rendered natively
   * over the map (see D.5), which is why none is set here.
   */
  var layers = ${inlineJson(
    MAP_LAYERS.map(({ id, maxZoom, subdomains, url }) => ({ id, maxZoom, subdomains, url })),
  )};
  var layerId = null;
  var tiles = null;

  function applyLayer(id) {
    var next = null;

    for (var i = 0; i < layers.length; i += 1) {
      if (layers[i].id === id) {
        next = layers[i];
      }
    }

    if (!next || next.id === layerId) {
      return;
    }

    layerId = next.id;

    /*
     * Come down to the new source's ceiling before swapping. OpenTopoMap stops
     * at 17 where the others reach 19, and a map left at 18 over a layer that
     * has no tile there is a grey screen that reads as a broken switch.
     */
    if (map.getZoom() > next.maxZoom) {
      map.setZoom(next.maxZoom, { animate: false });
    }

    /*
     * Leaflet defaults to loading tiles only once a drag *ends* on mobile, so
     * every pan uncovered grey until the finger lifted — the "stuck" feel.
     * Load while moving, keep a wider ring of tiles around the view, and skip
     * the in-between zoom levels a pinch passes through.
     */
    var replacement = L.tileLayer(next.url, {
      keepBuffer: 4,
      maxZoom: next.maxZoom,
      subdomains: next.subdomains || [],
      updateWhenIdle: false,
      updateWhenZooming: false
    }).addTo(map);

    /*
     * The old layer goes only once the new one has drawn something. Removing it
     * first leaves the page's background colour on screen for as long as the
     * network takes, which on a photograph layer is long enough to look broken.
     */
    if (tiles) {
      var previous = tiles;

      replacement.once('load', function () { map.removeLayer(previous); });
      setTimeout(function () { map.removeLayer(previous); }, 3000);
    }

    tiles = replacement;
  }

  applyLayer('standard');

  var stage = document.getElementById('stage');
  var canvas = document.getElementById('map');
  var bearing = 0;
  var navigating = false;

  /* How far below the middle the reader's arrow sits while navigating, as a
     share of the screen: the road ahead gets the room, as in Google Maps. */
  var NAV_LEAD = 0.22;
  /* One fix a second (lib/location.ts), and the arrow and map glide over it. */
  var GLIDE_MS = 1000;

  /*
   * The canvas is the screen, except while navigating.
   *
   * Only navigation turns the map, and a turned rectangle shows bare corners,
   * so then the canvas is a square big enough to cover the screen at any angle
   * around the reader's arrow — and its centre, which is where Leaflet puts the
   * reader and what the square turns about, is moved down by the lead. Browsing
   * never turns, and a square there was 2–3x the tiles behind every drag.
   *
   * Resized with the window too — a keyboard opening counts. invalidateSize
   * runs after every change, or Leaflet keeps loading tiles for the size it
   * last measured.
   */
  function fitStage() {
    var width = stage.clientWidth;
    var height = stage.clientHeight;
    var lead = navigating ? Math.round(height * NAV_LEAD) : 0;

    if (navigating) {
      var half = Math.ceil(Math.sqrt(width * width / 4 + Math.pow(height / 2 + lead, 2)));

      canvas.style.width = 2 * half + 'px';
      canvas.style.height = 2 * half + 'px';
    } else {
      canvas.style.width = width + 'px';
      canvas.style.height = height + 'px';
    }

    canvas.style.top = 'calc(50% + ' + lead + 'px)';
    map.invalidateSize();
  }

  fitStage();
  window.addEventListener('resize', fitStage);

  /*
   * Padding for any fit, in a container the reader cannot see all of.
   *
   * Leaflet frames bounds inside *its own* container, and since D.1 that
   * container is the diagonal square, not the window — 936 px of map behind a
   * 668 px stage. Fitting a route to the square therefore leaves its ends off
   * both edges of the screen. Half the overflow on each axis is exactly the
   * strip that is not visible, and it is added to whatever padding the caller
   * already wanted for the card and the search field.
   *
   * Outside navigation the canvas is the screen and the overflow is zero;
   * navigation follows, it never fits.
   */
  function fitPadding(topLeft, bottomRight) {
    var overflowX = Math.max(0, (canvas.clientWidth - stage.clientWidth) / 2);
    var overflowY = Math.max(0, (canvas.clientHeight - stage.clientHeight) / 2);

    return {
      paddingBottomRight: [bottomRight[0] + overflowX, bottomRight[1] + overflowY],
      paddingTopLeft: [topLeft[0] + overflowX, topLeft[1] + overflowY]
    };
  }

  /*
   * Whether the reader has taken the map into their own hands.
   *
   * The bug this exists for: every scripted view change — a re-injected route,
   * a fix while following — used to run unconditionally, so a pinch or a drag
   * was undone by the next one, and on a screen that re-renders for its own
   * reasons that is a map which springs back the moment you touch it.
   *
   * So: one gesture and the map belongs to the reader. Nothing automatic moves
   * the view after that. Only an explicit instruction — the centre button, show
   * every hostel, pressing Start — takes it back, and each of those clears the
   * flag itself.
   *
   * The flag is set from the reader's own input rather than from Leaflet's
   * events, and that distinction is the whole reliability of it: zoomstart
   * fires for the map's own animations too, so inferring a gesture from it
   * means guarding every scripted move with a timer — and a pinch made inside
   * that timer is then swallowed, which is exactly the fault this is meant to
   * fix, moved somewhere harder to see.
   *
   * So: a real drag (Leaflet raises dragstart for nothing else), a pinch (a
   * touchstart carrying more than one finger), a wheel, a double-tap. A single
   * tap is deliberately not in that list — tapping a pin is not taking the map
   * over, and it must not stop the arrow being followed.
   */
  var touched = false;
  var surface = map.getContainer();

  function takeOver() {
    if (!touched) {
      post({ type: 'touched' });
    }

    touched = true;
  }

  map.on('dragstart', takeOver);
  surface.addEventListener('wheel', takeOver, { passive: true });
  surface.addEventListener('dblclick', takeOver);
  surface.addEventListener('touchstart', function (event) {
    if (event.touches && event.touches.length > 1) {
      takeOver();
    }
  }, { passive: true });

  var pins = L.layerGroup().addTo(map);
  var byId = {};
  var nameById = {};
  var meMarker = null;
  var meKind = null;
  var routeShape = null;
  var meCircle = null;
  var line = null;
  var casing = null;
  var others = L.layerGroup().addTo(map);
  var places = L.layerGroup().addTo(map);
  var selected = null;
  var meTarget = null;
  var glideFrame = null;
  var navZoom = null;

  /*
   * The opening view: the reader's own streets, not the whole catalogue.
   *
   * With a position, frame it with the nearest few hostels (when any are
   * close) or simply the neighbourhood around it. Without one yet, wait a
   * moment — the fix usually lands in the same breath as the pins — then show
   * the catalogue, and fly down to the reader when the fix does arrive. Any
   * gesture, selection, route or button press settles it for good.
   */
  var NEAR_METERS = 2000;
  var NEAR_PINS = 3;
  var framed = false;
  var provisional = false;
  var openingTimer = null;
  var meLatLng = null;

  function framePins() {
    var points = Object.keys(byId).map(function (key) { return byId[key].getLatLng(); });

    if (points.length === 1) {
      map.setView(points[0], 15, { animate: true });
    } else if (points.length > 1) {
      map.fitBounds(points, fitPadding([50, 50], [50, 50]));
    }
  }

  function frameOpening() {
    if (framed || touched || navigating) {
      return;
    }

    if (meLatLng) {
      framed = true;
      clearTimeout(openingTimer);

      var here = meLatLng;
      var near = Object.keys(byId)
        .map(function (key) { return byId[key].getLatLng(); })
        .filter(function (point) { return here.distanceTo(point) <= NEAR_METERS; })
        .sort(function (a, b) { return here.distanceTo(a) - here.distanceTo(b); })
        .slice(0, NEAR_PINS);

      // Room for the search field above and the card below.
      var bounds = L.latLngBounds([here].concat(near));
      var zoom = near.length > 0
        ? Math.max(13, Math.min(16, map.getBoundsZoom(bounds, false, L.point(96, 220))))
        : 15;
      var centre = near.length > 0 ? bounds.getCenter() : here;

      // A fly when the catalogue was already on screen; a cut when it was not.
      if (provisional) {
        map.flyTo(centre, zoom, { duration: 0.8 });
      } else {
        map.setView(centre, zoom, { animate: false });
      }

      return;
    }

    if (!provisional && openingTimer === null && Object.keys(byId).length > 0) {
      openingTimer = setTimeout(function () {
        if (!framed && !touched) {
          provisional = true;
          framePins();
        }
      }, 400);
    }
  }

  /*
   * Moves the reader's arrow. While navigating it glides to the new fix over
   * GLIDE_MS — the same second, at the same linear pace, as the map's pan in
   * follow — so the arrow holds still on screen while the streets slide under
   * it, instead of jumping once a second.
   */
  function placeMe(latlng) {
    var to = L.latLng(latlng);

    if (meTarget && meTarget.equals(to)) {
      return;
    }

    meTarget = to;

    if (glideFrame) {
      cancelAnimationFrame(glideFrame);
      glideFrame = null;
    }

    if (!navigating) {
      meMarker.setLatLng(to);
      return;
    }

    var from = meMarker.getLatLng();
    var start = null;

    function step(now) {
      if (start === null) {
        start = now;
      }

      var t = Math.min(1, (now - start) / GLIDE_MS);

      var at = [from.lat + (to.lat - from.lat) * t, from.lng + (to.lng - from.lng) * t];

      meMarker.setLatLng(at);

      if (meCircle) {
        meCircle.setLatLng(at);
      }

      glideFrame = t < 1 ? requestAnimationFrame(step) : null;
    }

    glideFrame = requestAnimationFrame(step);
  }

  /**
   * The pin, its hostel's name, and — when it is the chosen one — a line
   * underneath saying that this is the one being looked at.
   *
   * Built as DOM rather than as an HTML string, because the name is
   * hostel-supplied text: inlineJson protects the script it travels in, not the
   * markup it would land in. L.divIcon takes an element as readily as a string.
   */
  function icon(on, name) {
    var wrap = document.createElement('div');
    var body = document.createElement('div');

    wrap.className = 'pin-wrap';
    body.className = on ? 'pin on' : 'pin';
    wrap.appendChild(body);

    if (name) {
      var chip = document.createElement('div');

      chip.className = on ? 'pin-label on' : 'pin-label';
      chip.appendChild(document.createTextNode(name));

      if (on) {
        var sub = document.createElement('div');

        sub.className = 'pin-label-sub';
        sub.appendChild(document.createTextNode('Viewing now'));
        chip.appendChild(sub);
      }

      wrap.appendChild(chip);
    }

    return L.divIcon({
      className: '',
      html: wrap,
      iconAnchor: on ? [13, 26] : [9, 18],
      iconSize: on ? [26, 26] : [18, 18]
    });
  }

  window.__map = {
    setMarkers: function (list) {
      pins.clearLayers();
      byId = {};
      nameById = {};

      list.forEach(function (marker) {
        var pin = L.marker([marker.lat, marker.lng], {
          icon: icon(marker.id === selected, marker.name),
          title: marker.name,
          // Now that every pin carries a name, neighbouring labels overlap. The
          // chosen one is lifted out of that pile rather than being read
          // through it.
          zIndexOffset: marker.id === selected ? 1000 : 0
        });

        pin.on('click', function () { post({ id: marker.id, type: 'select' }); });
        pin.addTo(pins);
        byId[marker.id] = pin;
        nameById[marker.id] = marker.name;
      });

      // Framed once — see frameOpening. Refitting on every search would yank
      // the map out from under somebody who had panned somewhere deliberately.
      frameOpening();
    },

    /**
     * The device: a dot when it does not know which way it faces, an arrow when
     * it does, and a circle showing how sure the fix is.
     *
     * The marker is moved rather than replaced whenever it can be. Replacing it
     * on every fix throws away the arrow's CSS transition, so a heading that
     * eased round smoothly on paper snaps in ten-degree steps on screen — and
     * it is one more layer add/remove per second for no gain.
     */
    setMe: function (point, heading, accuracy) {
      if (!point) {
        if (meMarker) { map.removeLayer(meMarker); meMarker = null; meKind = null; meTarget = null; }
        if (meCircle) { map.removeLayer(meCircle); meCircle = null; }
        meLatLng = null;
        return;
      }

      var kind = typeof heading === 'number' ? 'arrow' : 'dot';
      var latlng = [point.lat, point.lng];

      meLatLng = L.latLng(latlng);

      if (meMarker && meKind === kind) {
        placeMe(latlng);
      } else {
        // Swapping dot for arrow mid-glide starts the new one where the old one was.
        var from = meMarker ? meMarker.getLatLng() : L.latLng(latlng);

        if (meMarker) { map.removeLayer(meMarker); }

        meMarker = L.marker(from, {
          // Google's navigation arrow: a broad chevron, outlined in white so it
          // reads over any street colour, big enough to see at a glance.
          icon: kind === 'arrow'
            ? L.divIcon({
                className: '',
                html: '<div class="me-arrow"><svg viewBox="0 0 34 34" width="34" height="34"><path d="M17 3 L29 30 L17 23.5 L5 30 Z" fill="#1d7fe0" stroke="#ffffff" stroke-width="3" stroke-linejoin="round"/></svg></div>',
                iconAnchor: [17, 17],
                iconSize: [34, 34]
              })
            : L.divIcon({ className: '', html: '<div class="me"></div>', iconAnchor: [8, 8], iconSize: [16, 16] }),
          // Above the pins: the reader is looking for themselves first, and a
          // hostel marker sitting on top of the arrow is the one pin they
          // cannot move out of the way.
          zIndexOffset: 1000
        }).addTo(map);
        meKind = kind;
        meTarget = from;
        placeMe(latlng);
      }

      frameOpening();

      if (kind === 'arrow') {
        var arrow = meMarker.getElement() && meMarker.getElement().querySelector('.me-arrow');

        if (arrow) {
          arrow.style.transform = 'rotate(' + heading + 'deg)';
        }
      }

      /*
       * The accuracy circle is the honest picture of the fix, and it is what
       * stops "the arrow is in the wrong place" being a mystery — a 30 m circle
       * says the map knows it could be anywhere in that yard. Drawn only while
       * navigating, because the coarse reading everywhere else is accurate to
       * a suburb and a circle that size is just a blue wash over the screen.
       */
      if (typeof accuracy === 'number' && accuracy > 0) {
        if (meCircle) {
          meCircle.setLatLng(latlng);
          meCircle.setRadius(accuracy);
        } else {
          meCircle = L.circle(latlng, {
            color: '#1d7fe0',
            fillColor: '#1d7fe0',
            fillOpacity: 0.12,
            interactive: false,
            opacity: 0.35,
            radius: accuracy,
            weight: 1
          }).addTo(map);
        }
      } else if (meCircle) {
        map.removeLayer(meCircle);
        meCircle = null;
      }
    },

    setRoute: function (payload) {
      if (line) {
        map.removeLayer(line);
        line = null;
      }

      if (casing) {
        map.removeLayer(casing);
        casing = null;
      }

      if (!payload || !payload.points || payload.points.length < 2) {
        // Clearing the line forgets the shape too, so choosing the same hostel
        // again frames it rather than deciding it has already been framed.
        routeShape = null;
        return;
      }

      var latlngs = payload.points.map(function (point) { return [point.lat, point.lng]; });

      /*
       * Whether this is a different route or the same one arriving again.
       *
       * The native side re-injects whenever its route object is a new identity,
       * which happens on any re-render that recomputes it — the position, the
       * hostel, the profile. Refitting on each of those reframed the map and
       * threw away the reader's zoom, which is the fault this was reported as.
       * Ends and length are enough to tell two routes apart: no reroute keeps
       * all three.
       */
      var shape = latlngs.length + ':' +
        latlngs[0].join(',') + ':' +
        latlngs[latlngs.length - 1].join(',');
      var changed = shape !== routeShape;

      routeShape = shape;

      // A white edge under a road route, so the line reads over any street
      // colour at street zoom — the way Google draws its own.
      if (!payload.dashed) {
        casing = L.polyline(latlngs, { color: '#ffffff', opacity: 0.95, weight: 10 }).addTo(map);
      }

      line = L.polyline(latlngs, {
        color: payload.dashed ? '#1d7fe0' : ${JSON.stringify(accent)},
        dashArray: payload.dashed ? '6 8' : null,
        opacity: payload.dashed ? 0.9 : 1,
        weight: payload.dashed ? 5 : 6
      }).addTo(map);

      // A new route frames itself; the same route arriving again does not. And
      // neither happens while the reader is holding the map — see "touched" —
      // nor while navigating, where the view belongs to follow.
      if (changed && !touched && !navigating) {
        framed = true;
        map.fitBounds(latlngs, fitPadding([40, 120], [40, 220]));
      }
    },

    select: function (id) {
      [selected, id].forEach(function (key) {
        if (key && byId[key]) {
          byId[key].setIcon(icon(key === id, nameById[key]));
          byId[key].setZIndexOffset(key === id ? 1000 : 0);
        }
      });

      selected = id;

      if (id && byId[id]) {
        framed = true;
        // Enough of a nudge to bring a pin out from behind the card at the
        // bottom of the screen, without the jump of a re-centre.
        map.panTo(byId[id].getLatLng(), { animate: true, duration: 0.25 });
      }
    },

    /**
     * Turn the map so the given device heading points up the screen.
     *
     * Takes the heading, not the rotation, and negates it here — one place in
     * the codebase knows about that sign, and it is this line.
     */
    setLayer: function (id) {
      applyLayer(id);
    },

    /* Other routes, grey and tappable, under the chosen one. */
    setAlternatives: function (list) {
      others.clearLayers();

      list.forEach(function (alternative, index) {
        if (!alternative.points || alternative.points.length < 2) {
          return;
        }

        var shape = L.polyline(alternative.points.map(function (point) { return [point.lat, point.lng]; }), {
          color: ${JSON.stringify(mutedForeground)},
          opacity: 0.6,
          weight: 6
        });

        shape.on('click', function (event) {
          L.DomEvent.stopPropagation(event);
          post({ index: index, type: 'alternative' });
        });
        shape.addTo(others);
      });

      if (line) {
        line.bringToFront();
      }
    },

    /* What is around the chosen hostel: small dots, named on tap. */
    setNearby: function (list) {
      places.clearLayers();

      list.forEach(function (place) {
        L.circleMarker([place.coordinates.lat, place.coordinates.lng], {
          color: '#ffffff',
          fillColor: ${JSON.stringify(mutedForeground)},
          fillOpacity: 1,
          radius: 5,
          weight: 1.5
        }).bindTooltip(document.createTextNode(place.name)).addTo(places);
      });
    },

    setBearing: function (heading) {
      bearing = typeof heading === 'number' ? heading : 0;
      canvas.style.setProperty('--bearing', (-bearing) + 'deg');
    },

    /*
     * Start and Stop. Starting is an explicit instruction, so it takes the map
     * back from a drag made while browsing — without that, a reader who had
     * panned before pressing Start was never followed at all.
     */
    setNavigating: function (on) {
      if (navigating === on) {
        return;
      }

      navigating = on;
      touched = false;
      navZoom = null;

      if (!on && glideFrame) {
        cancelAnimationFrame(glideFrame);
        glideFrame = null;
      }

      fitStage();
    },

    center: function (lat, lng, zoom) {
      // An explicit instruction: it hands the map back, so following resumes.
      touched = false;
      framed = true;

      if (navigating) {
        navZoom = zoom;
      }

      map.setView([lat, lng], zoom, { animate: true });
    },

    /**
     * Navigation's one call: put the map here, turned this way.
     *
     * The first fix of a session carries the zoom and flies down onto the
     * reader. Every fix after that is a linear pan lasting exactly as long as
     * the gap between fixes (GLIDE_MS), with the arrow gliding at the same
     * pace in placeMe — so the arrow stays put low on the screen and the
     * streets slide steadily under it, rather than jumping once a second.
     *
     * The zoom is held in navZoom rather than read back from the map: a fix
     * landing mid-flight would otherwise freeze the map at whatever zoom the
     * flight had reached. A null heading leaves the bearing alone.
     */
    follow: function (lat, lng, zoom, heading) {
      // The bearing still tracks the reader even when the view does not: the
      // map should say which way they are facing wherever they have panned to.
      if (typeof heading === 'number') {
        window.__map.setBearing(heading);
      }

      if (typeof zoom === 'number') {
        navZoom = zoom;
      }

      if (touched) {
        return;
      }

      if (typeof zoom === 'number') {
        map.flyTo([lat, lng], zoom, { duration: 0.8 });
        return;
      }

      map.setView([lat, lng], navZoom || map.getZoom(), {
        animate: true,
        pan: { duration: GLIDE_MS / 1000, easeLinearity: 1, noMoveStart: true }
      });
    },

    fitAll: function () {
      touched = false;
      framed = true;
      framePins();
    }
  };

  // A tap on the map itself, not on a pin, closes the card.
  map.on('click', function () { post({ type: 'clear' }); });

  // A long press — the browser's contextmenu on touch — offers "my college here".
  map.on('contextmenu', function (event) {
    post({ lat: event.latlng.lat, lng: event.latlng.lng, type: 'longpress' });
  });

  // Leaflet measures its container, and inside a WebView that container has no
  // height on the first frame.
  setTimeout(function () {
    map.invalidateSize();
    post({ type: 'ready' });
  }, 60);
})();
</script>
</body>
</html>`;
}
