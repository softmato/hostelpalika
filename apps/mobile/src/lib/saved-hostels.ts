/**
 * Favourites, and the snapshot that makes them work offline.
 *
 * ## These live on the device, and only on the device
 *
 * There is no favourites collection on the server — no route, no model, nothing
 * (docs/mockups/mobile/README.md §"What these need from the server"). The heart
 * in the mockups was therefore cut along with the Saved tab. What is here
 * instead is honest about its scope: a list held in Redux, persisted by
 * `redux-persist`, that never leaves the phone. Sign in on another device and it
 * is empty, which is why the section says so.
 *
 * ## Why a snapshot rather than a list of ids
 *
 * `/public/hostels` returns the **first 60, cheapest-first**, with no
 * pagination. A saved hostel can therefore be missing from the payload the home
 * screen holds — priced out of the window, filtered, or delisted entirely — and
 * a Favourites row built from `ids ∩ payload` would quietly drop it. The user
 * saved it; it has to still be there.
 *
 * So each entry carries the few strings the card draws. The section renders from
 * those alone, which also means it survives a cold offline start, and
 * `refreshedSnapshots` folds in newer values whenever the hostel does come back
 * in a payload.
 *
 * ## The photo is stored unresolved
 *
 * `coverUrl` is the raw, usually **relative**, value from the payload
 * (`/api/v1/files/<id>/url`) — not the absolute URL the `<Image>` needs. Photo
 * URLs are resolved against `API_BASE_URL` at render time (see `lib/media.ts`),
 * and that base is a LAN address in development. Persisting the resolved form
 * would bake yesterday's IP onto disk and the favourite would render as a grey
 * box on the next launch.
 */

import { cardPhotoUrl, coverPhoto, locationLabel, priceRange } from "@/lib/hostel-display";
import type { PublicHostel } from "@/lib/public-api";

export type SavedHostel = {
  /** Raw payload URL, usually relative. Resolve at render — see above. */
  coverUrl: string | null;
  id: string;
  name: string;
  /** `Ghattekulo, Kathmandu` — already formatted, so the card does no work. */
  place: string;
  /** `NPR 7,000` or `NPR 7,000 – 9,000`, as of the last refresh. */
  price: string;
  savedAt: number;
  slug: string;
};

export function savedSnapshot(
  hostel: PublicHostel,
  savedAt: number = Date.now(),
): SavedHostel {
  return {
    coverUrl: cardPhotoUrl(coverPhoto(hostel.photos)) ?? null,
    id: hostel.id,
    name: hostel.name,
    place: locationLabel(hostel.location),
    price: priceRange(hostel.pricing),
    savedAt,
    slug: hostel.slug,
  };
}

/**
 * Folds fresher values into the saved list, and returns `null` when nothing
 * moved.
 *
 * The null is the point: this runs from an effect on every home payload, and
 * dispatching an identical array would write to disk — and re-render every
 * consumer — on each pull-to-refresh. `savedAt` is preserved, so refreshing a
 * price never reorders the list.
 */
export function refreshedSnapshots(
  items: SavedHostel[],
  hostels: PublicHostel[],
): SavedHostel[] | null {
  if (items.length === 0 || hostels.length === 0) {
    return null;
  }

  const live = new Map(hostels.map((hostel) => [hostel.id, hostel]));
  let changed = false;

  const next = items.map((item) => {
    const hostel = live.get(item.id);

    if (!hostel) {
      // Not in this payload — outside the 60, filtered, or delisted. Keep what
      // we have rather than dropping a hostel the user chose to save.
      return item;
    }

    const fresh = savedSnapshot(hostel, item.savedAt);
    const same =
      fresh.coverUrl === item.coverUrl &&
      fresh.name === item.name &&
      fresh.place === item.place &&
      fresh.price === item.price &&
      fresh.slug === item.slug;

    if (same) {
      return item;
    }

    changed = true;

    return fresh;
  });

  return changed ? next : null;
}
