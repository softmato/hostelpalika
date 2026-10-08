import type { Coordinates } from "@/lib/geo";
import type { MapLayerId } from "@/lib/leaflet";
import type { NearbyPlace } from "@/lib/public-api";
import type { RouteMode } from "@/lib/routing";

/**
 * The contract both maps keep: the native MapLibre map in
 * `components/map-explorer.tsx` and the Leaflet page the PWA swaps in from
 * `web/map-explorer.tsx`. The screen talks to this, never to either engine.
 */

/**
 * Deliberately few fields: what the *map* needs to draw a pin. Price, rating
 * and photos are read from the hostel itself when a pin is tapped.
 */
export type MapMarker = {
  /** The hostel id. Comes back from a tap, so it is matched, never trusted. */
  id: string;
  lat: number;
  lng: number;
  name: string;
};

/**
 * A line to draw, in order. `dashed` means the straight line between two
 * points rather than a road — drawn differently, because a straight line
 * through a riverbank drawn as a road is a direction to walk into a river.
 */
export type MapRoute = { dashed: boolean; points: Coordinates[] };

export type MapHandle = {
  /** Centre on a point — "locate me", or a search result being chosen. */
  center: (point: Coordinates, zoom?: number) => void;
  /** Frame every pin currently on the map. */
  fitAll: () => void;
  /** Navigating: follow the reader again after they dragged the map away. */
  recentre: () => void;
};

export type MapExplorerProps = {
  /** Other routes the reader can switch to, drawn grey under the main one. */
  alternatives?: MapRoute[];
  /** Which way to draw the world. The attribution chip follows it. */
  layer?: MapLayerId;
  markers: MapMarker[];
  /** The device, when it has a fix. Drawn as the blue puck, never as a pin. */
  me: Coordinates | null;
  /** Radial uncertainty of that fix, in metres. Navigation only. */
  meAccuracyMeters?: number | null;
  /** Which way the device is facing. Turns the dot into an arrow. */
  meHeading?: number | null;
  /** Car follows the direction of travel; foot follows the compass. */
  mode?: RouteMode;
  /** Turn-by-turn is running: the map follows the reader, tilted, arrow low. */
  navigating?: boolean;
  /** Places around the selected hostel, drawn as small named dots. */
  nearby?: readonly NearbyPlace[];
  /** While navigating, keep north up instead of turning with the reader. */
  northUp?: boolean;
  /** A long press on the map — "set this as my college". */
  onLongPress?: (point: Coordinates) => void;
  /** An alternative route was tapped; its index in `alternatives`. */
  onPickAlternative?: (index: number) => void;
  onSelect: (id: string | null) => void;
  /** The reader dragged or pinched, so the map stopped following them. */
  onTouched?: () => void;
  route: MapRoute | null;
  selectedId: string | null;
};
