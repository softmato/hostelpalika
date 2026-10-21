/**
 * One viewer for every asset in the app.
 *
 * Tapping a payment proof, a food photo, a complaint attachment, a hostel
 * exterior or a community image all open the same full-screen surface. Before
 * this, each screen either did nothing on tap (most of them) or would have grown
 * its own modal — and a per-screen viewer is how you end up with pinch-to-zoom
 * on one image and not on the next one, and with the private-asset header
 * remembered in four places out of five.
 *
 * ## Why a plain module rather than context or Redux
 *
 * Same reasoning as `lib/upload-queue.ts`. Screens open the viewer from event
 * handlers, list rows and gesture callbacks, and threading a dispatch through
 * every one of those means every call site takes a prop it does not otherwise
 * need. It is also state with no meaning after a relaunch, so it must not reach
 * `redux-persist`.
 *
 * ## Public and private assets are not the same fetch
 *
 * A `PUBLIC` asset (hostel photos, community media) is a plain URL a bare
 * `<Image>` can follow. A `PRIVATE` one — payment proof, ID photo, complaint
 * attachment — is served by `files/[assetId]/url`, which authorises the caller
 * and 302s to R2, so it needs the bearer token on **our** route and must never
 * carry one to the redirect target (see `privateAssetSource` for the measured
 * reason). Getting that wrong renders a blank square, so the choice is made once
 * here rather than at each call site.
 *
 * Kept free of React Native so the decisions can be tested; the overlay is
 * `components/asset-viewer.tsx` and holds only presentation.
 */

import { absoluteMediaUrl } from "@/lib/media";

export type ViewerItem = {
  /**
   * A **private** `FileAsset` id, read through the authorising route. Mutually
   * exclusive with `url`; when both are present the id wins, because a private
   * asset that also has a URL means somebody handed us the redirect target.
   */
  assetId?: string;
  /** Shown under the image. The "what am I looking at" line. */
  caption?: string;
  /** Decides preview vs. hand-off. Absent is treated as an image. */
  mimeType?: string;
  /** Names the file when it is shared or saved. */
  title?: string;
  /** A **public** URL: absolute, or the API-relative form stored on hostels. */
  url?: string;
};

export type ViewerState = {
  index: number;
  items: readonly ViewerItem[];
};

/**
 * Keeps the index inside the collection whatever it is handed.
 *
 * An out-of-range index is not hypothetical: a gallery opens at the tapped
 * position, and a list that refreshed between render and tap can be shorter than
 * it was. Returning 0 shows the first item instead of a blank page.
 */
export function clampIndex(index: number, count: number): number {
  if (count <= 0 || !Number.isFinite(index)) {
    return 0;
  }

  return Math.min(Math.max(Math.trunc(index), 0), count - 1);
}

/**
 * Whether the viewer can draw this itself.
 *
 * Only a **known** non-image type is refused. An absent `mimeType` is treated as
 * an image because every asset the app opens this way is one, and refusing on
 * absence would send the common case down the hand-off path.
 */
export function isPreviewable(item: ViewerItem): boolean {
  if (!item.mimeType) {
    return true;
  }

  return item.mimeType.startsWith("image/") || isVideo(item);
}

/** A clip, played with `expo-video` instead of drawn with `<Image>`. */
export function isVideo(item: ViewerItem): boolean {
  return Boolean(item.mimeType?.startsWith("video/"));
}

/**
 * A file still on this phone — something just picked, not yet anyone else's to
 * download. Save has nothing to offer for it: the user already has it.
 */
export function isOnDevice(item: ViewerItem): boolean {
  return !item.assetId && /^(?:file|content):/i.test(item.url ?? "");
}

export type ViewerSource = {
  headers?: Record<string, string>;
  uri: string;
};

/**
 * The `<Image source>` for one item, or `null` when there is nothing to load.
 *
 * `baseUrl` is passed in rather than imported: `lib/api` pulls in React Native,
 * and this module is one of the few whose branching is worth testing.
 */
export function viewerSourceFor(
  item: ViewerItem,
  { baseUrl, token }: { baseUrl: string; token?: string | null },
): ViewerSource | null {
  if (item.assetId) {
    return {
      // No token means the caller is signed out, and a private asset is not
      // theirs to see. The request still goes out and answers 401, which the
      // overlay renders as "could not be loaded" — the honest outcome.
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      uri: `${baseUrl}/api/v1/files/${item.assetId}/url`,
    };
  }

  const resolved = absoluteMediaUrl(item.url, baseUrl);

  /*
   * Deliberately **no** Authorization header on this branch. A public URL is
   * either already absolute (an R2 public object, or an Unsplash demo photo) or
   * resolves to one, and R2 reads any `Authorization` header as SigV4 and
   * rejects the request outright — measured on 2026-08-17, see
   * `privateAssetSource`. A header added "just in case" here breaks exactly the
   * images that work today.
   */
  return resolved ? { uri: resolved } : null;
}

/** A filename for the share sheet: the title, or a stable fallback. */
export function viewerFileName(item: ViewerItem, index: number): string {
  const named = item.title?.trim() || item.caption?.trim();

  return named || `image-${index + 1}`;
}

/* -------------------------------------------------------------------------- */
/* The store                                                                  */
/* -------------------------------------------------------------------------- */

let state: ViewerState | null = null;
const listeners = new Set<() => void>();

function emit(next: ViewerState | null) {
  state = next;

  for (const listener of listeners) {
    listener();
  }
}

export function subscribeToAssetViewer(listener: () => void) {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

/**
 * Must return the same reference until something changes —
 * `useSyncExternalStore` compares by identity, and a fresh object every call is
 * an infinite render loop.
 */
export function getAssetViewerState(): ViewerState | null {
  return state;
}

/**
 * Opens the viewer on a collection.
 *
 * Callers pass **the whole gallery**, not the one item tapped, so the user can
 * swipe through the set the way they expect to — a photo grid that opens one
 * image and traps you there is the thing this replaces. `index` is where to
 * start.
 */
export function openAssetViewer(items: readonly ViewerItem[], index = 0) {
  const usable = items.filter((item) => Boolean(item.assetId || item.url));

  if (usable.length === 0) {
    return;
  }

  emit({ index: clampIndex(index, usable.length), items: usable });
}

export function setAssetViewerIndex(index: number) {
  if (!state) {
    return;
  }

  const next = clampIndex(index, state.items.length);

  if (next !== state.index) {
    emit({ ...state, index: next });
  }
}

export function closeAssetViewer() {
  if (state !== null) {
    emit(null);
  }
}
