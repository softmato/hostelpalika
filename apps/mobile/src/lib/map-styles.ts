import type { ImageRequireSource } from "react-native";

import { mapLayer } from "@/lib/leaflet";

/**
 * What the native map draws.
 *
 * **The street map is the only style the map ever loads**, from OpenFreeMap:
 * free, no key, no request limit, commercial use allowed. Vector means the
 * phone draws the streets itself, so names stay sharp at every zoom and on
 * every screen density, rotation and tilt cost nothing, and a tile is a
 * fraction of a PNG's bytes. `liberty` also carries 3D buildings, which is
 * what the tilted navigation view shows. `dark` follows the app's dark mode.
 *
 * ## Satellite and Terrain are layers on top, not other styles
 *
 * They used to be whole styles of their own, and swapping a MapLibre style
 * throws the old one away before the new one has drawn a tile: the screen
 * went blank (black, on some GPUs) for as long as the first photo took to
 * arrive, and every pin and route was torn out and put back in whatever order
 * the native side kept them in. Now the street map stays loaded and:
 *
 * - **Satellite** lays Esri's imagery over it, *under* its labels — street and
 *   place names on the photo, as Google's satellite view has them.
 * - **Terrain** shades the hills from AWS's open elevation tiles, under the
 *   streets, rather than a second map (OpenTopoMap) whose own printed labels
 *   would sit under ours. The PWA's Leaflet map still uses OpenTopoMap.
 *
 * ## Stacking
 *
 * Two of our own invisible layers are mounted with the map, just under the
 * style's first label. Imagery always goes under `IMAGERY_ANCHOR`; route lines
 * always go under `ROUTE_ANCHOR`, which sits above it. So the route is drawn
 * over the photo and under the street names whichever was switched on first.
 * Pins and the reader's puck go on top of everything, labels included.
 */

const OPENFREEMAP = "https://tiles.openfreemap.org/styles";

/** Our own pin labels need glyphs; OpenFreeMap serves the styles' fonts. */
export const LABEL_FONT = ["Noto Sans Bold"];

export const VECTOR_ATTRIBUTION = "OpenFreeMap © OpenMapTiles · © OpenStreetMap contributors";

export const IMAGERY_ANCHOR = "hp-anchor-imagery";
export const ROUTE_ANCHOR = "hp-anchor-route";

export type BaseStyle = {
  attribution: string;
  /** The style's first label layer. Our anchors sit directly under it. */
  labelsFrom: string;
  /** The first layer above the land: hill shading goes under it, below every road. */
  reliefBelow: string;
  url: string;
};

/*
 * Layer ids read from the live styles. If OpenFreeMap renames one, MapLibre
 * waits for a layer that never comes and the route quietly never draws — so a
 * renamed id shows up as "no route line", not as a crash.
 */
const LIGHT: BaseStyle = {
  attribution: VECTOR_ATTRIBUTION,
  labelsFrom: "waterway_line_label",
  reliefBelow: "waterway_tunnel",
  url: `${OPENFREEMAP}/liberty`,
};

const DARK: BaseStyle = {
  attribution: VECTOR_ATTRIBUTION,
  labelsFrom: "highway_name_other",
  reliefBelow: "waterway",
  url: `${OPENFREEMAP}/dark`,
};

export function baseStyle(dark: boolean): BaseStyle {
  return dark ? DARK : LIGHT;
}

export const SATELLITE = {
  attribution: mapLayer("satellite").attribution,
  maxzoom: mapLayer("satellite").maxZoom,
  tiles: [mapLayer("satellite").url],
};

/** Terrarium-encoded elevation, AWS Open Data. Free, no key; z15 is its finest. */
export const TERRAIN = {
  attribution: "Elevation © Mapzen, AWS Terrain Tiles",
  maxzoom: 15,
  tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"],
};

/**
 * The hostel pin, drawn by `scripts/gen_map_pins.mjs`: brand-green teardrop,
 * white rim, the HP mark in a white disc. One per theme because the brand
 * green is.
 */
export const HOSTEL_PIN = "hostel-pin";

const PIN_LIGHT: ImageRequireSource = require("../../assets/images/map/hostel-pin.png");
const PIN_DARK: ImageRequireSource = require("../../assets/images/map/hostel-pin-dark.png");

// Built once: a fresh object per render would re-register the bitmap natively
// on every location fix.
const PINS_LIGHT = { [HOSTEL_PIN]: PIN_LIGHT };
const PINS_DARK = { [HOSTEL_PIN]: PIN_DARK };

export function pinImages(dark: boolean) {
  return dark ? PINS_DARK : PINS_LIGHT;
}

/**
 * The image is 40×50 with the tip 4 above its bottom edge (room for the
 * ground shadow). Anchored at the bottom and pushed down those 4, the tip —
 * not the shadow — is on the hostel.
 */
export const PIN_OFFSET: [number, number] = [0, 4];
