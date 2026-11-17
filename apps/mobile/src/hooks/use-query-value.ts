import { useContext, useEffect, useState } from "react";

import { ShownHostelContext } from "@/lib/active-hostel";
import { readQuery, subscribeQuery, type Query } from "@/lib/query-cache";

/**
 * Watch a cached answer without ever asking for it.
 *
 * `useResource` owns a question: it fetches, retries, refreshes on focus and
 * exposes loading and error. This owns nothing — it reads whatever
 * `lib/query-cache` already holds under a key and re-renders when that key is
 * written. If nobody has loaded it, this returns `null` and keeps returning
 * `null`, which is the entire point.
 *
 * ## What it is for
 *
 * Chrome that reflects a screen's data from outside that screen. The cook
 * portal's tab bar draws "meals still to call" off `cook:today`, which the Today
 * tab loads for its own four buttons. A `useResource` in the layout would make
 * that a second request on every entry into the group, for a number that is
 * decoration next to the screen it came from — the badge is worth showing when
 * the payload is there and worth nothing at all when it is not.
 *
 * The admin group solves the same problem the other way, with
 * `AdminAlertsProvider` owning the fetch, and that is right for *it*: the alert
 * counts belong to no single tab. This is for the case where a tab already owns
 * the data and something outside it wants to look.
 *
 * ## Not `useSyncExternalStore`
 *
 * `readQuery` builds a fresh `{ data, fresh }` wrapper on every call, so the
 * identity check that hook performs would never settle. The subscription is
 * driven into state instead, and `subscribeQuery` fires on *writes* rather than
 * on invalidation — a key marked stale has not changed, and re-rendering the tab
 * bar because something is due a refetch would be a render for no new fact.
 */
export function useQueryValue<T>(query: Query<T>): T | null {
  const { key } = query;

  // Lazily, so the value is present in the *first* render rather than appearing
  // a frame later — a badge that pops in after the bar has drawn reads as a
  // notification arriving, which it is not.
  const [value, setValue] = useState<T | null>(() => readQuery<T>(key)?.data ?? null);

  const [watchedKey, setWatchedKey] = useState(key);
  // A branch switch swaps data under mounted screens: a new branch is a new key (`useResource`).
  const hostel = useContext(ShownHostelContext);
  const [watchedHostel, setWatchedHostel] = useState(hostel);

  if (key !== watchedKey || hostel !== watchedHostel) {
    setWatchedKey(key);
    setWatchedHostel(hostel);
    setValue(readQuery<T>(key)?.data ?? null);
  }

  useEffect(
    () => subscribeQuery(key, () => setValue(readQuery<T>(key)?.data ?? null)),
    [key, hostel],
  );

  return value;
}
