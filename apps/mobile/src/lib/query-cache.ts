/**
 * One keyed store of server answers, shared by every screen that asks the same
 * question.
 *
 * ## Why this exists
 *
 * `use-resource` holds its payload in component state, which means the data dies
 * with the screen. In the browse and resident groups that is fine — those are a
 * handful of screens visited once. In the **warden portal** it is the whole
 * experience: five tabs and eleven Manage destinations, all reading the same
 * hostel, all reachable from one grid on Home, and every hop between them
 * blanked the screen and re-ran the same requests. Tapping Residents, going
 * back, and tapping it again cost two full loads and showed two spinners for
 * data that had not changed in between.
 *
 * So a screen that opts in names its question with a `cacheKey`, and the answer
 * outlives the screen. A second visit renders what is already here and
 * revalidates *behind* the data instead of on top of it — and a **prefetch** can
 * put the answer here before the screen is ever mounted, which is what
 * `lib/admin-queries.ts` uses to warm the portal.
 *
 * ## It survives a relaunch, and dies with the session
 *
 * This module stays free of storage; `lib/query-cache-persist.ts` snapshots it
 * to AsyncStorage and restores it before `PersistGate` lifts, so a cold start
 * paints the last answers and revalidates behind them.
 *
 * Restored entries are always stale (asked again on mount) and showable for
 * `RESTORED_MAX_AGE_MS` rather than `maxAgeMs` — a relaunch is usually more than
 * fifteen minutes after the last read. `clearQueryCache()` on sign-out wipes the
 * disk copy too, so a shared handset does not hand one account's roster to the
 * next.
 *
 * ## Freshness is two numbers, not one
 *
 * `staleMs` is when an answer stops being worth *trusting without asking* — the
 * screen still renders it and revalidates behind it. `maxAgeMs` is when it stops
 * being worth *showing*: past that the entry is dropped and the screen does an
 * ordinary first load with its spinner, because a quarter-hour-old figure
 * presented as current is how a screen loses an owner's trust for good.
 *
 * ## It is invalidated by the same topics screens already name
 *
 * `use-resource` subscribes mounted screens to `lib/resource-bus`; that covers
 * the screen being looked at and nothing else. An entry written with its topics
 * is marked stale when one of them is published, so the *unmounted* screens —
 * the four other tabs — revalidate on their next mount rather than rendering a
 * figure that moved while they were off screen.
 *
 * Kept free of React and of anything React Native, so the node-side tests can
 * load it.
 */

import type { RealtimeTopic } from "@/constants/topics";
import { subscribeAllTopics } from "@/lib/resource-bus";

// Scope is set before branch screens mount. Persisted keys include this scope.
let activeScope: string | null = null;
export function setQueryCacheScope(hostelId: string | null) {
  activeScope = hostelId;
}
function scopedKey(key: string) {
  return JSON.stringify([activeScope, key]);
}

type Entry = {
  data: unknown;
  /** Came off disk at launch and has not been re-fetched this session. */
  restored?: boolean;
  /** Set by a topic publish: still showable, but ask again on the next mount. */
  stale: boolean;
  /** Wall-clock ms of the write. */
  storedAt: number;
  topics: readonly RealtimeTopic[];
};

type Listener = () => void;

/** How old an answer may be before it is re-asked behind the data. */
export const DEFAULT_STALE_MS = 2 * 60_000;

/** How old an answer may be before it is not shown at all. */
export const DEFAULT_MAX_AGE_MS = 15 * 60_000;

/**
 * The cap, and why there is one.
 *
 * Keys are bounded in practice — the warden portal's entry wave alone is about
 * thirty per branch, since it warms every tab and door at once — and the ones that
 * multiply are the per-period money reads and per-resident records. An owner
 * scrubbing the month strip is the case that would otherwise grow this without
 * limit, so the oldest write is evicted past the cap. The cap sits well above
 * the wave so warming never evicts what it just warmed. Nothing held here is
 * large; this is a guard, not a budget.
 */
const MAX_ENTRIES = 600;

/** How long an answer restored from disk may still be painted while it revalidates. */
export const RESTORED_MAX_AGE_MS = 3 * 24 * 60 * 60_000;

const entries = new Map<string, Entry>();
const listeners = new Map<string, Set<Listener>>();

export type PersistedEntry = {
  data: unknown;
  key: string;
  storedAt: number;
  topics: readonly RealtimeTopic[];
};

/** Set by `lib/query-cache-persist.ts`; told when there is something to save or wipe. */
let persister: ((reason: "clear" | "write") => void) | null = null;

export function setQueryCachePersister(next: typeof persister) {
  persister = next;
}

/** Newest first, so a size-capped writer keeps the most recent answers. */
export function snapshotQueryCache(): PersistedEntry[] {
  return [...entries.entries()].reverse().map(([key, entry]) => ({
    data: entry.data,
    key,
    storedAt: entry.storedAt,
    topics: entry.topics,
  }));
}

/** Seeds the cache from disk. Never overwrites an answer fetched this session. */
export function restoreQueryCache(list: readonly PersistedEntry[]) {
  const now = Date.now();

  // Oldest first, so insertion order (and eviction) matches the original.
  for (const item of [...list].reverse()) {
    if (!item.key.startsWith("[")) continue;
    if (entries.has(item.key) || now - item.storedAt > RESTORED_MAX_AGE_MS) {
      continue;
    }

    entries.set(item.key, {
      data: item.data,
      restored: true,
      stale: true,
      storedAt: item.storedAt,
      topics: item.topics ?? [],
    });
  }
}

/**
 * In-flight requests, by key.
 *
 * This is the half of the job the cache would be pointless without: entering the
 * portal warms four tabs while Home is already loading two of the same reads,
 * and without deduplication that is the request storm this module exists to
 * remove, arriving one frame earlier. A second asker joins the first one's
 * promise.
 */
const inflight = new Map<string, Promise<unknown>>();

function notify(key: string) {
  const watching = listeners.get(key);

  if (!watching) {
    return;
  }

  // Copied before iterating: a listener that unsubscribes itself while being
  // notified would otherwise mutate the set mid-iteration.
  for (const listener of [...watching]) {
    try {
      listener();
    } catch {
      // One screen's failed re-render must not stop the others — same reasoning
      // as `publishTopics`.
    }
  }
}

/**
 * What a reader gets back: the answer, and whether it still counts as current.
 *
 * `fresh: false` does not mean "do not use this". It means "use it, and ask
 * again". The caller wanting the stricter reading passes `maxAgeMs`, which
 * returns `null` instead.
 */
export type CachedQuery<T> = {
  data: T;
  fresh: boolean;
};

export function readQuery<T>(
  key: string,
  { maxAgeMs = DEFAULT_MAX_AGE_MS, staleMs = DEFAULT_STALE_MS } = {},
): CachedQuery<T> | null {
  key = scopedKey(key);
  const entry = entries.get(key);

  if (!entry) {
    return null;
  }

  const age = Date.now() - entry.storedAt;

  if (
    age > (entry.restored ? Math.max(maxAgeMs, RESTORED_MAX_AGE_MS) : maxAgeMs)
  ) {
    // Dropped rather than handed back stale. Past `maxAgeMs` the screen is
    // better off with its own spinner than with a figure it must later un-tell.
    entries.delete(key);
    return null;
  }

  return { data: entry.data as T, fresh: !entry.stale && age <= staleMs };
}

export function writeQuery<T>(
  key: string,
  data: T,
  topics: readonly RealtimeTopic[] = [],
) {
  writeEntry(scopedKey(key), data, topics);
}

function writeEntry(key: string, data: unknown, topics: readonly RealtimeTopic[]) {
  if (entries.size >= MAX_ENTRIES && !entries.has(key)) {
    // Map iterates in insertion order and a re-write re-inserts below, so the
    // first key is the least recently written.
    const oldest = entries.keys().next();

    if (!oldest.done) {
      entries.delete(oldest.value);
    }
  }

  // Deleted first so a re-write moves to the back of the insertion order, which
  // is what keeps the eviction above least-recently-written.
  entries.delete(key);
  entries.set(key, { data, stale: false, storedAt: Date.now(), topics });

  notify(key);
  persister?.("write");
}

/**
 * Marks an answer as worth re-asking, without taking it off the screen.
 *
 * Deliberately not a delete: screens reading this key may be mounted, and
 * dropping the data under them would replace a working list with a spinner
 * because something unrelated moved on the server.
 */
export function invalidateQuery(key: string) {
  key = scopedKey(key);
  const entry = entries.get(key);

  if (entry) {
    entry.stale = true;
  }
}

/** The same, for every key whose loader reads one of these topics. */
export function invalidateQueriesForTopics(topics: readonly RealtimeTopic[]) {
  if (topics.length === 0) {
    return;
  }

  const moved = new Set<string>(topics);

  for (const entry of entries.values()) {
    if (entry.topics.some((topic) => moved.has(topic))) {
      entry.stale = true;
    }
  }
}

/**
 * One question, packaged: what to call it, what it reads, and which topics move
 * it.
 *
 * `topics` rides on the descriptor rather than on the screen because the cache
 * needs it for entries whose screen is **not** mounted, which is precisely the
 * case `use-resource`'s own subscription cannot cover.
 */
export type Query<T> = {
  key: string;
  load: () => Promise<T>;
  topics: readonly RealtimeTopic[];
};

const defined = new Map<string, Query<unknown>>();

/**
 * One descriptor object per key, for the life of the process.
 *
 * This is not a memo for speed — the objects are three fields — it is a
 * **correctness** requirement of `useResource`, whose own notes are blunt about
 * it: the hook refetches whenever the loader's identity changes, so a registry
 * handing back a fresh `() => listAdminResidents()` on every render would fetch
 * in a loop for ever. Returning the same object lets a screen pass `query.load`
 * straight in, with no `useCallback` and nothing to get wrong.
 *
 * The corollary is that a descriptor must be **pure in its key**: everything
 * that changes the answer goes in the key, or the first caller's arguments are
 * frozen in for everybody after them.
 *
 * Growth is bounded by distinct keys, and these are not cleared on sign-out —
 * they hold no data, only the shape of a question.
 */
export function defineQuery<T>(
  key: string,
  topics: readonly RealtimeTopic[],
  load: () => Promise<T>,
): Query<T> {
  const existing = defined.get(key);

  if (existing) {
    return existing as Query<T>;
  }

  const query: Query<T> = { key, load, topics };
  defined.set(key, query as Query<unknown>);

  return query;
}

/** Fires when this key is *written*. Invalidation is not a change to render. */
export function subscribeQuery(key: string, listener: Listener): () => void {
  key = scopedKey(key);
  const watching = listeners.get(key) ?? new Set<Listener>();
  watching.add(listener);
  listeners.set(key, watching);

  return () => {
    watching.delete(listener);

    if (watching.size === 0) {
      listeners.delete(key);
    }
  };
}

/**
 * Runs the loader, or joins the one already running for this key.
 *
 * Rejections propagate to every joined caller — `use-resource` has four
 * different things to do with a failure and this module knows none of them —
 * but they are **not** cached. A failed request leaves the previous answer
 * exactly where it was.
 */
export function fetchQuery<T>(
  key: string,
  load: () => Promise<T>,
  topics: readonly RealtimeTopic[] = [],
): Promise<T> {
  key = scopedKey(key);
  const existing = inflight.get(key) as Promise<T> | undefined;

  if (existing) {
    return existing;
  }

  const generation = cacheGeneration;
  const request = load()
    .then((data) => {
      if (generation === cacheGeneration) writeEntry(key, data, topics);
      return data;
    })
    .finally(() => {
      if (generation === cacheGeneration) inflight.delete(key);
    });

  inflight.set(key, request);

  return request;
}

/**
 * Warms a key and returns immediately.
 *
 * Three things it refuses to do, all of them the point:
 *
 * - It does not re-ask a question whose answer is still fresh, so warming the
 *   portal twice in a session costs nothing the second time.
 * - It does not start a second request for a key already in flight.
 * - It does not throw, ever. A prefetch is speculative by definition — a warden
 *   without `viewPayments` will be refused half of them — and a rejected promise
 *   nobody awaits is an unhandled rejection, not a message to anyone.
 */
export function prefetchQuery<T>(
  key: string,
  load: () => Promise<T>,
  {
    maxAgeMs = DEFAULT_MAX_AGE_MS,
    staleMs = DEFAULT_STALE_MS,
    topics = [] as readonly RealtimeTopic[],
  } = {},
): void {
  if (inflight.has(scopedKey(key))) {
    return;
  }

  if (readQuery<T>(key, { maxAgeMs, staleMs })?.fresh) {
    return;
  }

  void fetchQuery(key, load, topics).catch(() => {
    // See above. Whichever screen opens this key will ask again and report the
    // failure properly, on a surface that has somewhere to put the message.
  });
}

/**
 * Empties everything. Called from `endSession`, beside `persistor.purge()`.
 *
 * A hostel's roster, its invoices and its claim evidence must not survive into
 * the next account on a shared handset. This is the in-memory half of what the
 * purge does on disk.
 */
let cacheGeneration = 0;

export function clearQueryCache() {
  cacheGeneration += 1;
  entries.clear();
  inflight.clear();
  persister?.("clear");

  for (const key of [...listeners.keys()]) {
    notify(key);
  }
}

/*
 * The socket's own subscription, held for the life of the module.
 *
 * `use-resource` subscribes the screen being looked at; this subscribes the
 * cache behind the ones that are not, which is the entire difference between a
 * tab that comes back current and a tab that comes back showing a number that
 * moved while it was off screen.
 */
let unsubscribeBus = subscribeAllTopics(invalidateQueriesForTopics);

/** Test seam. Nothing in the app calls this. */
export function resetQueryCache() {
  activeScope = null;
  cacheGeneration += 1;
  entries.clear();
  inflight.clear();
  listeners.clear();
  defined.clear();
  unsubscribeBus();
  unsubscribeBus = subscribeAllTopics(invalidateQueriesForTopics);
}
