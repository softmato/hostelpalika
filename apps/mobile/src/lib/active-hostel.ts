import { createContext } from "react";

import { setQueryCacheScope } from "@/lib/query-cache";

import AsyncStorage from "@react-native-async-storage/async-storage";

/**
 * The hostel an owner with branches is working in.
 *
 * Every request carries it as `x-hostel-id` (`lib/api.ts`), and the server
 * narrows the account to that one hostel (`activeHostel` in the web app's
 * `api-auth.ts`) — so every screen works on the branch chosen in the switcher
 * without knowing branches exist. Unset means the main hostel.
 *
 * The cache follows the selected branch; switching preserves other branches.
 */

const KEY = "hostelpalika.activeHostelId";

/** Where requests and the cache point: moves the moment a hostel is picked. */
let active: string | null = null;
/** What the screens are on: follows `active` once the new hostel's Home is cached. */
let shown: string | null = null;
let loaded: Promise<void> | null = null;
const listeners = new Set<() => void>();

/** Read once from disk; every later call answers from memory. */
export function loadActiveHostel() {
  loaded ??= AsyncStorage.getItem(KEY)
    .then((value) => {
      active = value;
      shown = value;
      setQueryCacheScope(value);
    })
    .catch(() => undefined);

  return loaded;
}

export function getActiveHostelId() {
  return shown;
}

/** The hostel picked in the switcher — ahead of `getActiveHostelId` while its Home loads. */
export function getChosenHostelId() {
  return active;
}

/**
 * The branch a screen's data is for — what `useResource` keys on, so a switch
 * swaps data under mounted screens instead of rebuilding them. Provided by the
 * admin layout, and per tab scene by `RoleTabs`: the focused tab gets a switch
 * at once, a hidden one in a deferred render. `null` outside the admin portal.
 */
export const ShownHostelContext = createContext<string | null>(null);

/**
 * **Overall** — every branch at once, picked in the switcher like a branch.
 *
 * It is a view, not a hostel: there is nothing to write to. The tabs render the
 * stacked all-branches screens (`components/overall/`), which read each branch
 * with its own explicit header, and every write starts by switching to the one
 * branch it belongs to. Requests made without a header go to the main hostel.
 */
export const OVERALL = "overall";

export function isOverall(id: string | null = active) {
  return id === OVERALL;
}

/** The id to send as `x-hostel-id`: never the Overall sentinel, which the server would ignore anyway. */
export function getRequestHostelId() {
  return active === OVERALL ? null : active;
}

export function subscribeActiveHostel(listener: () => void) {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

/**
 * Pass `null` to go back to the main hostel — and on sign-out, so the next account starts clean.
 *
 * With `warm`, requests and the cache point at the new hostel first and the
 * screens stay on the old one until `warm` settles. Remounting straight away
 * left Home blank while a branch with nothing cached loaded (owner, 2026-11-16).
 */
export async function setActiveHostelId(
  id: string | null,
  warm?: () => Promise<unknown>,
) {
  await loadActiveHostel();

  if (id === active) return;

  active = id;
  setQueryCacheScope(id);

  if (warm) {
    // The switcher shows the pick straight away; the screens wait.
    listeners.forEach((listener) => listener());
    await warm().catch(() => undefined);
    // A later pick overtook this one.
    if (active !== id) return;
  }

  shown = id;
  listeners.forEach((listener) => listener());

  await (
    id ? AsyncStorage.setItem(KEY, id) : AsyncStorage.removeItem(KEY)
  ).catch(() => undefined);
}
