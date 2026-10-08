# Map — plan

**Created 2026-10-08.** The user wants a map that is smoother than the Leaflet
WebView it replaces and does things Google Maps does not do for someone finding
or reaching a hostel — all of it free to run.

This file is the tracker. Work at the first unticked box; `[x]` means *built and
statically checked* (typecheck, lint, tests); **device** notes what still needs
a real phone. **[server]** `apps/web` API, **[app]** `apps/mobile`, **[web]** the
Next.js portal, **[pwa]** the app's web export (`apps/mobile/web/` stand-ins).

---

## 1. Decisions already made

| Question | Decision |
|---|---|
| Engine | Native **MapLibre** (`@maplibre/maplibre-react-native` 11.4.1, new architecture). The map is drawn by the GPU on the phone, not a web page. |
| Tiles | **OpenFreeMap** vector tiles — free, no key, no request limit, commercial use allowed. `liberty` style in light mode, `dark` in dark mode. Satellite (Esri) and Terrain (OpenTopoMap) stay as raster choices. |
| PWA | Keeps the Leaflet map: it moves to `web/map-explorer.tsx` as a stand-in with the same props. MapLibre RN has no web build. |
| Navigation camera | MapLibre's own follow mode: `course` (direction of travel) by car, `heading` (compass) on foot, tilted 50°, the arrow low on the screen. A drag ends follow; **Re-centre** brings it back. |
| Offline | Pressing Start saves the map along the route (a corridor of small boxes, zoom 13–17) as an offline pack. The latest three trips are kept, older ones deleted. |
| Find the gate | `Hostel.arrivalGuide` = a short note + one photo, written by the owner or a warden. Public on the listing. Shown within 200 m of the hostel and on arrival, and read out. |
| My college / office | Saved **on the phone only** (a place the user chose, not a GPS trail). Set by search (our server proxies Nominatim, Nepal only, cached) or by long-pressing the map. Times come from one OSRM `table` request per mode, cached. |
| Route choices | OSRM `alternatives=2`. The other routes are drawn grey and can be tapped; the card lists them with time and distance. |
| Tell the hostel | Signed-in users only. Sends the **arrival time**, never a position, to the hostel's owner and wardens (in-app + push). At most once per person per hostel every 10 minutes. |
| What's around | The selected hostel's stored `nearbyPlaces` (already on every listing) drawn as small category dots with names; a switch in the map-style panel. |

## 2. Work, in order

- [x] **1. Engine** [app][pwa] — *2026-10-08: code done, typecheck + lint clean; PWA stand-in `web/map-explorer.tsx` registered in `metro.config.js`; MapLibre plugin in `app.json`.* — native `MapExplorer` with the same props and handle: pins with labels (GPU, no overlap), selection, route with casing, the user's puck, near-me opening view, fit all, map styles incl. dark mode. Leaflet version moved to the PWA stand-in. **device**
- [x] **2. Navigation camera** [app] — *2026-10-08: native follow/tilt/lead/Re-centre, north-up holds bearing 0; R8 keep rule for `org.maplibre.reactnative.**` added by `plugins/withReleaseMinify.js`.* — native follow (course/heading), 3D tilt, arrow low on screen, Re-centre on drag, north-up compass. **device**
- [x] **3. Route choices** [app] — *2026-10-08: `fetchRoadRoutes` (alternatives=2, tested); picked route keyed by hostel+mode; grey lines + time/distance chips.* — alternatives from the router, drawn and tappable, listed on the card; navigation follows the chosen one.
- [x] **4. What's around** [app][pwa] — *2026-10-08: `nearby` prop from the listing's `nearbyPlaces`; "Around" switch in the map-style panel.* — selected hostel's nearby places on the map, with a switch.
- [x] **5. Offline route** [app] — *2026-10-08: `lib/offline-route.ts` (corridor boxes tested, z13–17, newest 3 trips kept, 60 s timeout per pack); PWA stand-in answers false; "map saved offline" on the nav card.* — offline pack along the route on Start, keep the latest three, "Saved for offline" shown on the card. **device**
- [x] **6. Tell the hostel I'm coming** [server][app] — *2026-10-08: `POST /public/hostels/[slug]/arriving` (signed in, IP limit + 10-min repeat check, tested); "Tell hostel" pill on the nav card. Needs a web deploy.* — endpoint, staff notification, button while navigating.
- [x] **7. Find the gate** [server][web][app] — *2026-10-08: `Hostel.arrivalGuide` (note ≤240, https photo) in the profile PATCH + both serializers; editors: web profile → Location → Finding the gate, app Manage → Settings → Finding the gate; map shows `GateCard` within 200 m and on arrival, voice reads it. Needs a web deploy.* — field, editors (web profile + app manage), public payload, shown near the hostel and on arrival, spoken.
- [x] **8. My college / office** [server][app] — *2026-10-08: `GET /public/places?q=` (Nominatim/Google via `searchPlaces`, rate limited, cached); place in `ui.commutePlace` (phone only); `fetchTravelTimes` (OSRM table, tested); minutes on pin labels, result rows and the preview card; Any time → 15 → 30 min chip; long-press to pin. Browse-list cards get it with item 9.* — place search proxy, saved place, travel times on pins, cards and results, "within N min" filter.
- [x] **9. Browse and hostel-page maps** [app][pwa] — *2026-10-08: native `HostelMap` (preview = one button, labels carry name + price, tap opens the hostel); Leaflet version is `web/hostel-map.tsx`; browse cards show walking minutes to the saved place (`hooks/use-commute.ts`). The admin pin picker (`hostel-pin-picker.tsx`) is still Leaflet.* — `HostelMap` on the same engine; Leaflet version to the PWA stand-in. **device**

## 3. Release

A new native build: MapLibre and `expo-speech` are native modules, so no OTA
from this tree reaches an existing install. The user runs EAS builds.

## 4. What is left

Every item is built and statically checked (typecheck, lint, 1,513 app tests).
Nothing here has run on a phone yet. In order:

1. **Web deploy** — `arriving`, `places`, `arrivalGuide` and the read-all/QuestionCall
   server changes live there; the app calls fail quietly until it ships.
2. **APK** — MapLibre and `expo-speech` are native; the user runs the build.
3. **Device run** — the opening view, pan smoothness, navigation tilt and follow,
   Re-centre after a drag, voice, an offline pack completing, dark mode style,
   and a release (R8) build opening the map.

## 5. First device run (2026-10-08, release build v22)

The map opened, panned and drew pins on a real phone. Three problems, all fixed
in JS (no native change, so they ship as an OTA on the v22 runtime):

- [x] **Directions turned the whole app white.** Logcat: `Error: \`id\` cannot be
  changed` from a `<Layer>` in a `GeoJSONSource`. MapLibre RN's sources drop
  `null` children and key the rest by position, so the casing that appears when
  the road route replaces the dashed line took the route line's slot. Every
  layer inside a source now has a `key`; the dashed line and the road route
  are separate sources (a dropped `line-dasharray` is never reset natively);
  `/map` has an `ErrorBoundary` with Try again / Go back.
- [x] **Satellite / Terrain flashed blank.** They were whole styles, and a style
  swap clears the map until the new one draws. Now the street style loads once
  and they are overlays — Esri imagery under the street labels, AWS terrarium
  hill shading under the roads — stacked with two invisible anchor layers
  (`lib/map-styles.ts`). Dark mode remounts the map at the same view. The route
  anchor also moved: in dark mode it was under every road.
- [x] **Opened too close.** Opening view now frames up to 8 hostels within 5 km,
  never a box smaller than ~3 km, zoom 13 when none are near.
- [x] **Pins.** The green dot is a branded pin (`scripts/gen_map_pins.mjs`: green
  teardrop, white rim, HP mark), on both native maps; the chosen one is larger
  and on top. The PWA's Leaflet pins are still the CSS teardrop.

Second pass, after that OTA:

- [x] **Arrow froze while standing still.** The puck was GPS-course in a vehicle;
  it is compass heading in every mode now (the camera still follows the road in
  a vehicle).
- [x] **A tap on the map dropped the route.** Ignored while directions or
  navigation are up; Back / X / another pin still leave.
- [x] **Navigation card** is the hostel's sheet (photo, name, area, minutes) with
  a labelled Exit and Tell hostel, instead of a lone X.
- [x] **College / office sheet** opens tall; `Sheet` already keeps the field above
  the keyboard.
- [x] **Walking took the longer way.** `walkingChoices` (`lib/routing.ts`, tested):
  on foot the car router's roads are candidates too, re-timed at walking pace,
  and choices are ordered shortest first. Vehicle is unchanged.
- [x] **Walking minutes on pins and cards** — `fetchTravelTimes` on foot asks the
  road table too and takes `walkingSeconds` (the shorter of the foot time and
  the road length at the walker's pace), so the pin agrees with the drawn route.
