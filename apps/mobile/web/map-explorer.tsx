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
  type MapLayerId,
  MAP_LAYERS,
} from "@/lib/leaflet";

/**
 * The map every other map screen turned into: pins, a selection, and a route.
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
 * id }` and `{ type: "clear" }` — nothing else is honoured, and the id is
 * matched against the markers this component was given before it is passed on.
 * The page is third-party JavaScript (Leaflet, from a CDN, with an SRI hash) and
 * is treated as untrusted input in both directions.
 */

/**
 * Deliberately four fields.
 *
 * This object is serialised into a script and injected on every search
 * keystroke, so it carries what the *map* needs and nothing the card needs —
 * price, rating, photos and facilities are read from the hostel itself, natively,
 * when a pin is tapped. A marker payload that grew to the full listing would put
 * sixty hostels' photo arrays through a string bridge to draw sixty 18px dots.
 */
export type MapMarker = {
  /** The hostel id. Comes back over the bridge, so it is matched, never trusted. */
  id: string;
  lat: number;
  lng: number;
  /** The long-press tooltip, and what a screen reader announces for the pin. */
  name: string;
};

export type MapHandle = {
  /** Centre on a point — "locate me", or a search result being chosen. */
  center: (point: Coordinates, zoom?: number) => void;
  /** Frame every pin currently on the map. */
  fitAll: () => void;
  /**
   * Navigation mode: put the map here.
   *
   * A `null` zoom keeps whatever zoom the map is on — which is what makes a
   * reader's pinch survive the next fix — so the zoom is worth passing only on
   * the first fix of a session. A `null` bearing leaves the rotation alone.
   */
  follow: (point: Coordinates, zoom: number | null, bearing: number | null) => void;
  /**
   * A compass sample with no new fix.
   *
   * Both this and `follow` drop a bearing that has moved less than two degrees
   * from the last one injected: a magnetometer at rest jitters by about that
   * much, and forwarding every sample is a script across the bridge several
   * times a second to turn the map by nothing the reader can see.
   */
  setBearing: (bearing: number) => void;
};

export type MapExplorerProps = {
  /** Which tile source to draw. The attribution chip follows it. */
  layer?: MapLayerId;
  markers: MapMarker[];
  /** The device, when it has a fix. Drawn as a blue dot, never as a pin. */
  me: Coordinates | null;
  /**
   * Radial uncertainty of that fix, in metres, drawn as a circle around it.
   *
   * Navigation only. The coarse reading the rest of the app takes is accurate
   * to a suburb, and a circle that size is a blue wash over the whole screen.
   */
  meAccuracyMeters?: number | null;
  /** Which way the device is facing. Turns the dot into an arrow. */
  meHeading?: number | null;
  onSelect: (id: string | null) => void;
  /**
   * The line to draw, in order. `null` clears it.
   *
   * `dashed` says the line is the straight one between two points rather than
   * a road, and the map draws it differently for a reason: a straight line
   * through a riverbank rendered as a solid route is a direction to walk into a
   * river. The card says so too, but the map itself should not lie.
   */
  route: { dashed: boolean; points: Coordinates[] } | null;
  selectedId: string | null;
};

/**
 * Degrees of compass movement worth an injection. Below this the map turns by
 * less than the reader can see, and a magnetometer at rest jitters by about
 * this much all on its own.
 */
const BEARING_EPSILON_DEGREES = 2;

export const MapExplorer = forwardRef<MapHandle, MapExplorerProps>(function MapExplorer(
  { layer = "standard", markers, me, meAccuracyMeters, meHeading, onSelect, route, selectedId },
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

  useImperativeHandle(
    ref,
    () => ({
      center: (point, zoom = 15) =>
        call(`window.__map.center(${point.lat}, ${point.lng}, ${zoom})`),
      fitAll: () => call("window.__map.fitAll()"),
      follow: (point, zoom, bearing) => {
        const turn = worthSending(bearing) ? bearing : null;

        call(
          `window.__map.follow(${point.lat}, ${point.lng}, ${inlineJson(zoom)}, ${inlineJson(turn)})`,
        );
      },
      setBearing: (bearing) => {
        if (worthSending(bearing)) {
          call(`window.__map.setBearing(${bearing})`);
        }
      },
    }),
    [call, worthSending],
  );

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

      // An id the page was never given cannot select anything. This is the one
      // place a string from inside the WebView could reach navigation.
      if (type === "select" && typeof id === "string" && ids.has(id)) {
        onSelect(id);
      }
    },
    [ids, onSelect],
  );

  /*
   * Four effects, one per thing the page holds, so a change to any of them
   * costs exactly one small script and never touches the rest. `ready` is in
   * every dependency list: it flips once, and that pass sets the full state.
   */
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

  return (
    <View className="flex-1" style={{ backgroundColor: colors.muted }}>
      <WebView
        allowFileAccess={false}
        androidLayerType="hardware"
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
    border-bottom: 20px solid #1d7fe0;
    border-left: 9px solid transparent;
    border-right: 9px solid transparent;
    filter: drop-shadow(0 0 1.5px #ffffff) drop-shadow(0 1px 2px rgba(0,0,0,.45));
    height: 0;
    transition: transform 300ms linear;
    transform-origin: 50% 60%;
    width: 0;
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
  var map = L.map('map', { attributionControl: false, zoomControl: false })
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

    var replacement = L.tileLayer(next.url, {
      maxZoom: next.maxZoom,
      subdomains: next.subdomains || []
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

  /*
   * The square has to be the diagonal of the window, and it has to be resized
   * whenever the window is — a keyboard opening counts. invalidateSize runs
   * after every change, or Leaflet keeps loading tiles for the size it last
   * measured,
   * which shows up as grey bands sliding in from the edges as the map turns.
   */
  function fitStage() {
    var width = stage.clientWidth;
    var height = stage.clientHeight;
    var side = Math.ceil(Math.sqrt(width * width + height * height));

    canvas.style.width = side + 'px';
    canvas.style.height = side + 'px';
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
   * Exact at north-up, which is the only state that fits anything: navigation
   * follows, it does not fit. At a bearing the visible region is a rotated
   * rectangle and this is merely generous, which is the harmless direction.
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
  var selected = null;
  var fitted = false;

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

      // Frame the catalogue once, on the first set that has anything in it.
      // Refitting on every search would yank the map out from under somebody
      // who had panned somewhere deliberately.
      if (!fitted && list.length > 0) {
        fitted = true;
        window.__map.fitAll();
      }
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
        if (meMarker) { map.removeLayer(meMarker); meMarker = null; meKind = null; }
        if (meCircle) { map.removeLayer(meCircle); meCircle = null; }
        return;
      }

      var kind = typeof heading === 'number' ? 'arrow' : 'dot';
      var latlng = [point.lat, point.lng];

      if (meMarker && meKind === kind) {
        meMarker.setLatLng(latlng);
      } else {
        if (meMarker) { map.removeLayer(meMarker); }

        meMarker = L.marker(latlng, {
          icon: kind === 'arrow'
            ? L.divIcon({ className: '', html: '<div class="me-arrow"></div>', iconAnchor: [9, 12], iconSize: [18, 20] })
            : L.divIcon({ className: '', html: '<div class="me"></div>', iconAnchor: [8, 8], iconSize: [16, 16] }),
          // Above the pins: the reader is looking for themselves first, and a
          // hostel marker sitting on top of the arrow is the one pin they
          // cannot move out of the way.
          zIndexOffset: 1000
        }).addTo(map);
        meKind = kind;
      }

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

      line = L.polyline(latlngs, {
        color: payload.dashed ? '#1d7fe0' : ${JSON.stringify(accent)},
        dashArray: payload.dashed ? '6 8' : null,
        opacity: 0.9,
        weight: 5
      }).addTo(map);

      // A new route frames itself; the same route arriving again does not. And
      // neither happens while the reader is holding the map — see "touched".
      if (changed && !touched) {
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

    setBearing: function (heading) {
      bearing = typeof heading === 'number' ? heading : 0;
      canvas.style.setProperty('--bearing', (-bearing) + 'deg');
    },

    center: function (lat, lng, zoom) {
      // An explicit instruction: it hands the map back, so following resumes.
      touched = false;

      map.setView([lat, lng], zoom, { animate: true });
    },

    /**
     * Navigation's one call: put the map here, at this zoom, turned this way.
     *
     * No animation, on purpose. A fix arrives every second or two, and
     * Leaflet's pan animation restarted by each one is a map that never
     * settles — it slides continuously towards a position it never reaches.
     * The smoothness comes from the stage's CSS transition instead, which is
     * animating a rotation nothing else is fighting over.
     *
     * A null heading leaves the bearing alone: a fix with no new compass sample
     * should not straighten the map out. A null zoom likewise keeps the zoom
     * the map is on, which is how a reader's pinch survives the next fix.
     */
    follow: function (lat, lng, zoom, heading) {
      // The bearing still tracks the reader even when the view does not: the
      // map should say which way they are facing wherever they have panned to.
      if (typeof heading === 'number') {
        window.__map.setBearing(heading);
      }

      if (touched) {
        return;
      }

      map.setView([lat, lng], typeof zoom === 'number' ? zoom : map.getZoom(), {
        animate: false
      });
    },

    fitAll: function () {
      var points = Object.keys(byId).map(function (key) { return byId[key].getLatLng(); });

      touched = false;

      if (points.length === 1) {
        map.setView(points[0], 15, { animate: true });
      } else if (points.length > 1) {
        map.fitBounds(points, fitPadding([50, 50], [50, 50]));
      }
    }
  };

  // A tap on the map itself, not on a pin, closes the card.
  map.on('click', function () { post({ type: 'clear' }); });

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
