import { useEffect, useState } from "react";

/**
 * Groups of rows trimmed to the first `limit` rows until the push has landed,
 * then all of them.
 *
 * A long list built in one render held the whole body blank for a second or
 * more on every open — the rows were in the cache, the JS thread was busy
 * drawing them. The top of the list is what fits on a phone anyway; the rest
 * arrives while nobody is looking at it yet.
 *
 * ponytail: fixed 300 ms ≈ one push transition; window the list (FlatList) if
 * one screen ever needs thousands of rows.
 */
export function useFirstRows<G extends { rows: readonly unknown[] }>(groups: readonly G[], limit = 12): G[] {
  const [all, setAll] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setAll(true), 300);

    return () => clearTimeout(timer);
  }, []);

  if (all) return groups as G[];

  const shown: G[] = [];
  let left = limit;

  for (const group of groups) {
    if (left <= 0) break;
    shown.push(group.rows.length <= left ? group : { ...group, rows: group.rows.slice(0, left) });
    left -= group.rows.length;
  }

  return shown;
}
