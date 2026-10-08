import type { StyleSpecification } from "@maplibre/maplibre-react-native";

import { mapLayer, type MapLayerId } from "@/lib/leaflet";

/**
 * What the native map draws, per map style.
 *
 * **Standard is vector**, from OpenFreeMap: free, no key, no request limit,
 * commercial use allowed. Vector means the phone draws the streets itself, so
 * names stay sharp at every zoom and on every screen density, rotation and
 * tilt cost nothing, and a tile is a fraction of a PNG's bytes. `liberty` also
 * carries 3D buildings, which is what the tilted navigation view shows.
 * `dark` follows the app's dark mode.
 *
 * Satellite and Terrain stay raster (Esri, OpenTopoMap) — the same sources and
 * credits the Leaflet map uses, from `lib/leaflet.ts`.
 *
 * `routeBelow` is the first label layer of the style: our route line goes
 * under it, so street names stay readable on top of the route, as in Google.
 */

const OPENFREEMAP = "https://tiles.openfreemap.org/styles";

/** Our own pin labels need glyphs, and raster styles carry none. */
const GLYPHS = "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf";

export const LABEL_FONT = ["Noto Sans Bold"];

type NativeStyle = {
  attribution: string;
  mapStyle: string | StyleSpecification;
  routeBelow?: string;
};

function rasterStyle(id: MapLayerId, tiles: string[], maxzoom: number): StyleSpecification {
  return {
    glyphs: GLYPHS,
    layers: [{ id, source: id, type: "raster" }],
    sources: { [id]: { maxzoom, tileSize: 256, tiles, type: "raster" } },
    version: 8,
  };
}

const SATELLITE = rasterStyle("satellite", [mapLayer("satellite").url], mapLayer("satellite").maxZoom);

const TERRAIN = rasterStyle(
  "terrain",
  ["a", "b", "c"].map((sub) => mapLayer("terrain").url.replace("{s}", sub)),
  mapLayer("terrain").maxZoom,
);

export const VECTOR_ATTRIBUTION = "OpenFreeMap © OpenMapTiles · © OpenStreetMap contributors";

export function nativeStyle(id: MapLayerId, dark: boolean): NativeStyle {
  if (id === "satellite") {
    return { attribution: mapLayer("satellite").attribution, mapStyle: SATELLITE };
  }

  if (id === "terrain") {
    return { attribution: mapLayer("terrain").attribution, mapStyle: TERRAIN };
  }

  return dark
    ? { attribution: VECTOR_ATTRIBUTION, mapStyle: `${OPENFREEMAP}/dark`, routeBelow: "water_name" }
    : {
        attribution: VECTOR_ATTRIBUTION,
        mapStyle: `${OPENFREEMAP}/liberty`,
        routeBelow: "road_one_way_arrow",
      };
}
