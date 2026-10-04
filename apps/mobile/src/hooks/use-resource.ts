import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";

import type { RealtimeTopic } from "@/constants/topics";
import { readApiError } from "@/lib/api-contract";
import {
  DEFAULT_MAX_AGE_MS,
  DEFAULT_STALE_MS,
  fetchQuery,
  readQuery,
  subscribeQuery,
  writeQuery,
} from "@/lib/query-cache";
import { subscribeTopics } from "@/lib/resource-bus";
import { toastError } from "@/lib/toast";

/**
 * One GET, with the four states every screen has to render.
 *
 * The web has TanStack Query for this; mobile deliberately does not, because
 * the offline cache in M8 is Redux-persist's job and two caches that disagree
 * is worse than one. What screens actually need from a query library is this
 * hook's surface, so this is that and nothing more.
 *
 * Six things here are not obvious:
 *
 * 1. **`loading` is the first load only.** A pull-to-refresh that swapped the
 *    list for a spinner would throw away the thing the user is looking at, and
 *    a background revalidate that did it would flicker on every tab switch.
 *    Those set `refreshing` instead, and the stale data stays on screen.
 *
 * 2. **Responses are matched to the request that asked for them.** Pull to
 *    refresh while the first load is still in flight and the two land in
 *    whatever order the network decides; without the sequence check the older
 *    payload wins and the screen shows data the user already refreshed away.
 *
 * 3. **Refocus revalidates silently.** Paying an invoice happens in a browser
 *    handoff or on another screen, so returning to a tab is when stale numbers
 *    are most likely and least excusable. The first focus is skipped — the
 *    mount effect already covers it.
 *
 * 4. **Raising the spinner belongs to the caller, not to the fetch.** `loading`
 *    starts `true`, so the mount fetch has nothing to set before its first
 *    `await`; `reload()` and `refresh()` set their own flag in the event
 *    handler. That is what keeps the fetch effect free of a synchronous
 *    `setState` — a real extra render on every screen, and one
 *    `react-hooks/set-state-in-effect` traces into the callee to find.
 *
 * 5. **`topics` makes a screen live.** Naming the domain topics it reads
 *    subscribes it to `lib/resource-bus`, which the realtime socket publishes
 *    to on `resource:changed`. The refetch is silent, for the same reason a
 *    refocus is: an admin verifying a payment elsewhere must not blank the
 *    screen someone is reading. A screen with no `topics` is simply not live,
 *    which is the correct default — every screen refetching on every event is
 *    how a socket turns into a request storm.
 *
 * 6. **A new `load` is a new question, and it refetches.** See below — this is
 *    the part that was missing, and it made every filter in the app inert.
 *
 * ## Why the fetch effect keys off `load`
 *
 * It originally did not. `run` was a `useCallback` with an empty dependency
 * array and the effect depended on `[run]`, so it fired once on mount and never
 * again; a screen whose loader closed over a filter got a fresh closure into
 * `loadRef` and no request. Browse-hostels ignored its search box and every
 * filter in its sheet, the notification bell's All/Unread tabs did nothing, and
 * Community was worse — `loadMore` *did* read the new filter, so scrolling
 * stacked page 2 of the new query under page 1 of the old one.
 *
 * Keying on `load` is safe because every one of the 43 call sites wraps its
 * loader in `useCallback`. An unmemoised inline arrow would be a new identity
 * every render and would fetch in a loop, so **keep the loader memoised** — that
 * is now a requirement of this hook rather than a nicety.
 *
 * `loadRef` still exists: `refresh`, `reload` and the topic subscription have to
 * call the *current* loader, and they are not re-created when it changes.
 *
 * ## Four fetch modes, because failure means something different in each
 *
 * The mode decides only one thing — what happens when the request fails — but
 * that one thing is the difference between a screen that degrades and a screen
 * that throws away what the user was reading:
 *
 * | mode      | started by            | on failure                             |
 * |-----------|-----------------------|----------------------------------------|
 * | `initial` | mount                 | error state; there is nothing to keep  |
 * | `requery` | the loader changed    | error state, data cleared              |
 * | `refresh` | pull-to-refresh       | keep the data, toast the failure       |
 * | `silent`  | refocus, socket event | keep everything, say nothing           |
 *
 * `requery` clears deliberately. The rows on screen answer the *previous*
 * question, so leaving them under a filter the user just applied would read as
 * the filter having matched them.
 *
 * `refresh` is the reverse and is why the toast exists. Screens branch
 * `error ? <ErrorState/> : …` before they look at `data`, so setting `error`
 * here would replace a working dashboard with a full-screen retry because the
 * phone went into a lift. The data is still good and still on screen; the
 * failure is worth a line, not the whole viewport.
 *
 * ## `cacheKey` — the answer outliving the screen
 *
 * Optional, and off by default: without one this hook behaves exactly as it did,
 * holding its payload in component state and losing it on unmount. That is the
 * right default for a screen visited once.
 *
 * With one, the payload is read from and written to `lib/query-cache`, and four
 * things change:
 *
 * 1. **A revisit paints before it asks.** The cached answer seeds the first
 *    render, so `loading` is already `false` and the mount fetch is a *silent*
 *    revalidate behind data the user can read — or, if the answer is still
 *    fresh, no fetch at all.
 * 2. **A prefetch counts.** `prefetchAdminPortal()` writing this key before the
 *    screen mounts is indistinguishable from having visited it, which is the
 *    whole point of the warm-up.
 * 3. **Two screens on one key stay in step.** They subscribe to it, so whoever
 *    fetches last updates both.
 * 4. **A changed key paints from the cache too.** Money's month strip is the
 *    case: scrubbing back to a month already looked at is instant, and the
 *    revalidate behind it is silent rather than a spinner.
 *
 * The key must contain everything that changes the answer. `adminQuery.money`
 * puts the period in it for exactly that reason — a filter missing from the key
 * is a screen showing another month's invoices, which is a worse bug than the
 * inert-filter one above because it looks right.
 *
 * `staleMs` is when to re-ask behind the data (default 2min) and `maxAgeMs` is
 * when to stop showing it at all (default 15min) — `query-cache.ts` has the
 * reasoning for two numbers rather than one.
 */

export type Resource<T> = {
  data: T | null;
  error: string | null;
  /** First load, with nothing to show yet. Render `<LoadingState>`. */
  loading: boolean;
  refresh: () => void;
  /** True for a pull-to-refresh *and* while a changed loader is in flight. */
  refreshing: boolean;
  /** Full reload with the spinner — for the `<ErrorState>` retry button. */
  reload: () => void;
  /** Local, optimistic edit. Replaced by whatever the next fetch returns. */
  setData: (updater: (current: T | null) => T | null) => void;
};

type FetchMode = "initial" | "refresh" | "requery" | "silent";

export function useResource<T>(
  load: () => Promise<T>,
  {
    cacheKey,
    maxAgeMs = DEFAULT_MAX_AGE_MS,
    refetchOnFocus = true,
    staleMs = DEFAULT_STALE_MS,
    topics,
  }: {
    /** Names this question in `lib/query-cache`. Omit to keep the old behaviour. */
    cacheKey?: string;
    maxAgeMs?: number;
    refetchOnFocus?: boolean;
    staleMs?: number;
    topics?: readonly RealtimeTopic[];
  } = {},
): Resource<T> {
  /*
   * What the cache had at mount, read once.
   *
   * In a lazy initialiser rather than in an effect, because the point is to have
   * it in the *first* render: a revisit that painted empty and filled in on the
   * next frame is the flicker this is here to remove.
   */
  const [seed] = useState(() =>
    cacheKey ? readQuery<T>(cacheKey, { maxAgeMs, staleMs }) : null,
  );

  const [data, setData] = useState<T | null>(seed?.data ?? null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(seed === null);
  const [refreshing, setRefreshing] = useState(false);

  /*
   * The key this render is showing, so a *changed* key can paint from the cache
   * before it asks.
   *
   * Adjusted during render — React's own pattern for deriving state from a
   * changing input, and deliberately not an effect: an effect would commit an
   * empty screen first and then fill it, which is the flicker again, and it is
   * what `react-hooks/set-state-in-effect` exists to prevent.
   */
  const [renderedKey, setRenderedKey] = useState(cacheKey);

  if (cacheKey !== renderedKey) {
    setRenderedKey(cacheKey);

    const cached = cacheKey ? readQuery<T>(cacheKey, { maxAgeMs, staleMs }) : null;

    if (cached) {
      setData(cached.data);
    }
  }

  /*
   * The loader that produced whatever is on screen, boxed so React cannot
   * mistake it for a state updater.
   *
   * This is what makes "a changed query is in flight" a *derived* value rather
   * than another piece of state: comparing it to the current `load` during
   * render is pure, and it needs no `setState` in the effect that starts the
   * fetch — which is the one thing `react-hooks/set-state-in-effect` forbids
   * and the reason the spinner could not simply be raised there.
   */
  const [settled, setSettled] = useState<{ loader: () => Promise<T> } | null>(() =>
    // Seeded from the cache counts as settled: the screen has an answer on it,
    // so the *next* loader identity is a requery and must raise the spinner.
    // Left null it would stay null until the first fetch finished, and the first
    // month change on Money would have no spinner behind it.
    seed ? { loader: load } : null,
  );
  const requerying = settled !== null && settled.loader !== load;

  // `refresh`, `reload` and the topic subscription are created once but must
  // call the loader the screen is holding *now*.
  const loadRef = useRef(load);

  useEffect(() => {
    loadRef.current = load;
  });

  /*
   * Mirrors `data` for the catch block below.
   *
   * Read through a ref rather than closed over, because `run` must keep a stable
   * identity: the fetch effect depends on it, so a `run` that changed with every
   * payload would re-fetch on its own result, for ever.
   */
  const dataRef = useRef<T | null>(null);

  useEffect(() => {
    dataRef.current = data;
  });

  /*
   * Where a result is filed, read the same way and for the same reason: `run`
   * must keep a stable identity, so the key and the topic list cannot be closed
   * over.
   */
  const cacheRef = useRef<{ key?: string; topics: readonly RealtimeTopic[] }>({
    key: cacheKey,
    topics: topics ?? [],
  });

  useEffect(() => {
    cacheRef.current = { key: cacheKey, topics: topics ?? [] };
  });

  const mounted = useRef(true);
  const sequence = useRef(0);

  /*
   * Set by the optimistic `setData` below, cleared once the edit is filed.
   *
   * Only *deliberate* edits are written back. Filing every `data` change would
   * re-stamp the entry's timestamp on each fetch, which would quietly make a
   * stale answer look fresh to the next screen that mounts on the same key —
   * the one failure mode that would turn this cache into a source of wrong
   * numbers rather than of fewer requests.
   */
  const edited = useRef(false);

  useEffect(() => {
    if (!edited.current) {
      return;
    }

    edited.current = false;

    const cache = cacheRef.current;

    if (cache.key && data !== null) {
      writeQuery(cache.key, data, cache.topics);
    }
  }, [data]);

  useEffect(() => {
    mounted.current = true;

    return () => {
      mounted.current = false;
    };
  }, []);

  /*
   * Fetches, and touches no state until after the first `await`.
   *
   * Raising the spinner is the caller's job — `reload`/`refresh` do it in the
   * event handler where a synchronous render is expected and cheap. Keeping it
   * out of here is what lets the fetch effect call `run` at all:
   * `react-hooks/set-state-in-effect` traces into the callee, so a single
   * synchronous `setState` anywhere in this function would make every effect
   * that calls it a cascading render.
   */
  const run = useCallback(async (mode: FetchMode) => {
    const ticket = ++sequence.current;
    // Captured, not re-read: `settled` has to name the loader this response
    // actually came from, or a filter changed mid-flight leaves the spinner up.
    const loader = loadRef.current;
    const cache = cacheRef.current;

    try {
      /*
       * `fetchQuery` both deduplicates and files the result. Deduplication is
       * what keeps the portal's warm-up honest: entering the group prefetches
       * four tabs while Home is already asking for two of the same reads, and
       * without it that is the request storm this layer exists to remove,
       * arriving one frame earlier.
       *
       * A failure is deliberately not filed. Whatever was cached stays cached,
       * which is what lets a `silent` revalidate fail into no change at all.
       */
      const result = cache.key
        ? await fetchQuery(cache.key, loader, cache.topics)
        : await loader();

      if (!mounted.current || ticket !== sequence.current) {
        return;
      }

      setData(result);
      setError(null);
    } catch (caught) {
      if (!mounted.current || ticket !== sequence.current) {
        return;
      }

      // A background revalidate keeps whatever is already on screen. Replacing
      // a working list with an error because the phone walked into a lift is
      // not an improvement.
      if (mode === "silent") {
        return;
      }

      /*
       * A pull-to-refresh with data already on screen is the same story with a
       * gesture behind it: the user asked, so say something — but a toast, not
       * the error state, which every screen renders in place of its content.
       */
      if (mode === "refresh" && dataRef.current !== null) {
        toastError("Couldn't refresh", readApiError(caught));
        return;
      }

      setError(readApiError(caught));
      setData(null);
    } finally {
      if (mounted.current && ticket === sequence.current) {
        setLoading(false);
        setRefreshing(false);
        // In `finally`, so a failed requery clears the derived spinner too —
        // on `try` alone it would spin for ever. Same reference in, same
        // reference out, so React bails out of the re-render when nothing moved.
        setSettled((current) => (current?.loader === loader ? current : { loader }));
      }
    }
  }, []);

  /*
   * Mount, and every time the question changes.
   *
   * The ref is what tells the two apart without reading state: the first pass
   * is the initial load (`loading` is already `true`), and every later identity
   * of `load` is a requery, whose spinner comes from `requerying` above.
   */
  const started = useRef(false);

  useEffect(() => {
    const first = !started.current;
    started.current = true;

    /*
     * Read here rather than reusing `seed`, because this effect also runs when
     * the key changes and the question it is asking is about *this* key.
     */
    const cached = cacheKey ? readQuery<T>(cacheKey, { maxAgeMs, staleMs }) : null;

    /*
     * A fresh answer is asked nothing. Without this, walking the five tabs would
     * re-run every loader on every hop — the cache would spare the spinner and
     * keep the requests, which is half a fix.
     *
     * "Fresh" is not "recent": a topic publish marks the entry stale the moment
     * the server says the data moved, so this never holds a figure that is known
     * to have changed.
     */
    if (cached?.fresh) {
      return;
    }

    /*
     * With something already on screen the fetch is silent whichever way it got
     * there — seeded at mount or painted from the cache on a key change. Both
     * mean the same thing: there is an answer the user is reading, and a failed
     * revalidate must not take it away.
     */
    void run(cached ? "silent" : first ? "initial" : "requery");
  }, [cacheKey, load, maxAgeMs, run, staleMs]);

  /*
   * Two screens on one key, kept in step.
   *
   * More and Home both read the hostel; Money and Home both read the period
   * summary. Whoever fetches last updates the other, without either knowing the
   * other exists.
   *
   * A cleared key is deliberately *not* propagated: `clearQueryCache()` runs on
   * sign-out, and nulling the data under every mounted admin screen would flash
   * an error state on the way to the login route. The route change unmounts them
   * a frame later.
   */
  useEffect(() => {
    if (!cacheKey) {
      return;
    }

    return subscribeQuery(cacheKey, () => {
      const next = readQuery<T>(cacheKey, { maxAgeMs, staleMs });

      if (next) {
        // The same object that was written, so React bails out of the re-render
        // when this screen is the one that wrote it.
        setData(next.data);
      }
    });
  }, [cacheKey, maxAgeMs, staleMs]);

  const firstFocus = useRef(true);

  useFocusEffect(
    useCallback(() => {
      if (firstFocus.current) {
        firstFocus.current = false;
        return;
      }

      if (refetchOnFocus && !(cacheKey && readQuery(cacheKey, { maxAgeMs, staleMs })?.fresh)) {
        void run("silent");
      }
    }, [cacheKey, maxAgeMs, refetchOnFocus, run, staleMs]),
  );

  /*
   * Live updates. The topic list is nearly always an inline array literal, so
   * it has a new identity every render — joining it gives the effect a stable
   * dependency instead of resubscribing on each one.
   *
   * Silent rather than `refresh()`: a socket event is not a gesture, and showing
   * a pull-to-refresh spinner for something the user did not ask for reads as
   * the screen having a mind of its own.
   */
  const topicKey = topics?.join(",") ?? "";

  useEffect(() => {
    if (!topicKey) {
      return;
    }

    return subscribeTopics(topicKey.split(",") as RealtimeTopic[], () => {
      void run("silent");
    });
  }, [run, topicKey]);

  return {
    data,
    error,
    loading,
    refresh: useCallback(() => {
      setRefreshing(true);
      void run("refresh");
    }, [run]),
    refreshing: refreshing || requerying,
    reload: useCallback(() => {
      setLoading(true);
      void run("initial");
    }, [run]),
    setData: useCallback((updater: (current: T | null) => T | null) => {
      // Flagged rather than written here: the updater form is what gives call
      // sites the latest value, and a cache write inside a state updater is a
      // side effect React is free to run twice. The effect below files it once
      // the render it caused has committed.
      edited.current = true;
      setData((current) => updater(current));
    }, []),
  };
}
