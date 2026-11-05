import type { Coordinates } from "./types";
import { fetchUpstream } from "./upstream-fetch";

/**
 * What a pasted map link (or a raw coordinate pair) resolved to.
 *
 * `shortLink` needs a server round trip — goo.gl/maps and maps.app.goo.gl carry
 * no coordinates at all until the redirect is followed.
 */
export type ParsedMapLink =
  | { coordinates: Coordinates; kind: "coordinates"; label?: string }
  | { kind: "place"; query: string }
  | { kind: "shortLink"; url: string };

/** A bare pair the admin copied out of a map ("27.7172, 85.3240"). */
const BARE_PAIR = /^@?(-?\d{1,2}(?:\.\d+)?)\s*[,\s]\s*(-?\d{1,3}(?:\.\d+)?)$/;

/**
 * Google's own marker position, e.g. `!3d27.6935!4d85.3419`. This is the place
 * itself, unlike the `@` segment which is only where the viewport happened to
 * sit when the link was copied — usually close, occasionally a street off.
 */
const DATA_PIN = /!3d(-?\d{1,2}(?:\.\d+)?)!4d(-?\d{1,3}(?:\.\d+)?)/;

/** `/@27.6935,85.3419,17z` — the viewport centre. */
const AT_SEGMENT = /@(-?\d{1,2}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)/;

/** OpenStreetMap's permalink hash, `#map=17/27.6935/85.3419`. */
const OSM_HASH = /map=\d+(?:\.\d+)?\/(-?\d{1,2}(?:\.\d+)?)\/(-?\d{1,3}(?:\.\d+)?)/;

/** Query params that different map apps use to carry a point or a place name. */
const POINT_PARAMS = [
  "q",
  "query",
  "ll",
  "sll",
  "center",
  "daddr",
  "destination",
  "viewpoint",
];

/**
 * Hosts whose links are opaque redirects until followed.
 *
 * `share.google` is what Google's Share sheet hands out now — the hostel whose
 * owner sent us `https://share.google/g7znZy6lJWDsMM2rq` is the reason it is
 * here. Without it that paste resolves to nothing and the agent is told the
 * link contains no location, which is untrue and unactionable.
 */
const SHORTENERS = [
  "goo.gl",
  "maps.app.goo.gl",
  "g.co",
  "share.google",
  "osm.org",
];

function toCoordinates(lat: string, lng: string): Coordinates | null {
  const parsed = { lat: Number(lat), lng: Number(lng) };
  if (!Number.isFinite(parsed.lat) || !Number.isFinite(parsed.lng)) {
    return null;
  }
  if (Math.abs(parsed.lat) > 90 || Math.abs(parsed.lng) > 180) {
    return null;
  }
  // 0,0 is Null Island — always a parse artefact, never a hostel.
  if (parsed.lat === 0 && parsed.lng === 0) {
    return null;
  }
  return parsed;
}

/** Human-friendly place name out of a `/place/New+Baneshwor/` style segment. */
function placeFromPath(pathname: string): string | null {
  const match = pathname.match(/\/(?:place|search|dir)\/([^/@]+)/);
  if (!match?.[1]) {
    return null;
  }

  const name = decodeURIComponent(match[1].replace(/\+/g, " ")).trim();
  // Google puts `data=...` and coordinate blobs in this slot too; neither is a
  // name a geocoder can do anything with.
  if (!name || /^[\d.,\s+-]+$/.test(name) || name.startsWith("data=")) {
    return null;
  }
  return name;
}

/**
 * Read a pasted Google Maps (or OSM / Apple Maps) link, or a raw coordinate
 * pair, without any network call.
 *
 * Admins overwhelmingly know exactly where their hostel is on Google Maps and
 * nowhere else — pasting that link is the shortest path from "I know the spot"
 * to an accurate pin, so it is worth supporting every shape those links take.
 *
 * Returns null when the text is just an ordinary place query.
 */
export function parseMapLink(raw: string): ParsedMapLink | null {
  const value = raw.trim();
  if (!value) {
    return null;
  }

  const bare = value.match(BARE_PAIR);
  if (bare?.[1] && bare[2]) {
    const coordinates = toCoordinates(bare[1], bare[2]);
    if (coordinates) {
      return { coordinates, kind: "coordinates" };
    }
  }

  const looksLikeUrl = /^https?:\/\//i.test(value) || /^(www\.|maps\.)/i.test(value);
  if (!looksLikeUrl) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (SHORTENERS.some((short) => host === short || host.endsWith(`.${short}`))) {
    return { kind: "shortLink", url: url.toString() };
  }

  const whole = url.href;
  const place = placeFromPath(url.pathname);

  const dataPin = whole.match(DATA_PIN);
  if (dataPin?.[1] && dataPin[2]) {
    const coordinates = toCoordinates(dataPin[1], dataPin[2]);
    if (coordinates) {
      return { coordinates, kind: "coordinates", ...(place ? { label: place } : {}) };
    }
  }

  for (const key of POINT_PARAMS) {
    const param = url.searchParams.get(key)?.trim();
    if (!param) {
      continue;
    }

    const pair = param.match(BARE_PAIR);
    if (pair?.[1] && pair[2]) {
      const coordinates = toCoordinates(pair[1], pair[2]);
      if (coordinates) {
        return { coordinates, kind: "coordinates" };
      }
    }
  }

  // OSM's own marker params, used by its "share" panel.
  const mlat = url.searchParams.get("mlat");
  const mlon = url.searchParams.get("mlon");
  if (mlat && mlon) {
    const coordinates = toCoordinates(mlat, mlon);
    if (coordinates) {
      return { coordinates, kind: "coordinates" };
    }
  }

  const osmHash = url.hash.match(OSM_HASH);
  if (osmHash?.[1] && osmHash[2]) {
    const coordinates = toCoordinates(osmHash[1], osmHash[2]);
    if (coordinates) {
      return { coordinates, kind: "coordinates" };
    }
  }

  const atSegment = whole.match(AT_SEGMENT);
  if (atSegment?.[1] && atSegment[2]) {
    const coordinates = toCoordinates(atSegment[1], atSegment[2]);
    if (coordinates) {
      return { coordinates, kind: "coordinates", ...(place ? { label: place } : {}) };
    }
  }

  // No point anywhere in the link — fall back to whatever it names, which the
  // caller can push through the ordinary geocoder.
  if (place) {
    return { kind: "place", query: place };
  }

  for (const key of POINT_PARAMS) {
    const param = url.searchParams.get(key)?.trim();
    if (param && !/^[\d.,\s+-]+$/.test(param)) {
      return { kind: "place", query: param };
    }
  }

  return null;
}

/**
 * Follow a shortened map link to the real one. Server-only: the browser cannot
 * read the redirect target cross-origin, and this must not become an open
 * redirect-follower, so callers pass only hosts `parseMapLink` classified as
 * shorteners.
 */
export async function resolveShortLink(url: string): Promise<ParsedMapLink | null> {
  const response = await fetchUpstream(url, {
    headers: {
      // The bare-bones client gets a consent interstitial with no coordinates.
      "Accept-Language": "en",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36",
    },
    redirect: "follow",
  });

  if (!response) {
    return null;
  }

  const fromFinalUrl =
    response.url && response.url !== url ? parseMapLink(response.url) : null;
  if (fromFinalUrl && fromFinalUrl.kind !== "shortLink") {
    return fromFinalUrl;
  }

  // Some short links land on a consent or app-interstitial page that carries the
  // real URL in the markup rather than in the redirect chain.
  const body = await response.text().catch(() => "");
  if (!body) {
    return null;
  }

  const dataPin = body.match(DATA_PIN);
  if (dataPin?.[1] && dataPin[2]) {
    const coordinates = toCoordinates(dataPin[1], dataPin[2]);
    if (coordinates) {
      return { coordinates, kind: "coordinates" };
    }
  }

  const atSegment = body.match(AT_SEGMENT);
  if (atSegment?.[1] && atSegment[2]) {
    const coordinates = toCoordinates(atSegment[1], atSegment[2]);
    if (coordinates) {
      return { coordinates, kind: "coordinates" };
    }
  }

  return null;
}
