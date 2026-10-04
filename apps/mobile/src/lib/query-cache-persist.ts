import { loadActiveHostel } from "@/lib/active-hostel";

import AsyncStorage from "@react-native-async-storage/async-storage";

import {
  type PersistedEntry,
  restoreQueryCache,
  setQueryCachePersister,
  snapshotQueryCache,
} from "@/lib/query-cache";

/**
 * The disk half of `lib/query-cache`, kept apart so that module stays loadable
 * in node tests.
 *
 * Writes are debounced — the portal warm-up files thirty answers in a burst and
 * one write covers them all. The snapshot is capped because Android's
 * AsyncStorage row limit is about 2 MB and a row past it fails to *read*, which
 * would cost every cached answer rather than the oldest few.
 */

const STORAGE_KEY = "hostelpalika:query-cache:v1";
const WRITE_DELAY_MS = 1_000;
const MAX_CHARS = 1_500_000;

let timer: ReturnType<typeof setTimeout> | null = null;

function flush() {
  timer = null;

  const kept: string[] = [];
  let size = 2;

  for (const entry of snapshotQueryCache()) {
    let json: string;

    try {
      json = JSON.stringify(entry);
    } catch {
      continue;
    }

    if (size + json.length + 1 > MAX_CHARS) {
      break;
    }

    kept.push(json);
    size += json.length + 1;
  }

  const write =
    kept.length > 0
      ? AsyncStorage.setItem(STORAGE_KEY, `[${kept.join(",")}]`)
      : AsyncStorage.removeItem(STORAGE_KEY);

  void write.catch(() => {
    // A failed save costs the next cold start its instant paint, nothing more.
  });
}

/** Awaited by `PersistGate`'s `onBeforeLift`, so the first screen can seed from it. */
export async function hydrateQueryCache() {
  await loadActiveHostel();
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);

    if (raw) {
      restoreQueryCache(JSON.parse(raw) as PersistedEntry[]);
    }
  } catch {
    // A corrupt snapshot is dropped; the screens load as they did before.
    void AsyncStorage.removeItem(STORAGE_KEY).catch(() => {});
  }

  setQueryCachePersister((reason) => {
    if (reason === "clear") {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }

      void AsyncStorage.removeItem(STORAGE_KEY).catch(() => {});
      return;
    }

    timer ??= setTimeout(flush, WRITE_DELAY_MS);
  });
}
