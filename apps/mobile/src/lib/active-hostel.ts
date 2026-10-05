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

let active: string | null = null;
let loaded: Promise<void> | null = null;
const listeners = new Set<() => void>();

/** Read once from disk; every later call answers from memory. */
export function loadActiveHostel() {
  loaded ??= AsyncStorage.getItem(KEY)
    .then((value) => {
      active = value;
      setQueryCacheScope(value);
    })
    .catch(() => undefined);

  return loaded;
}

export function getActiveHostelId() {
  return active;
}

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

/** Pass `null` to go back to the main hostel — and on sign-out, so the next account starts clean. */
export async function setActiveHostelId(
  id: string | null,
) {
  await loadActiveHostel();

  if (id === active) return;

  active = id;
  setQueryCacheScope(id);
  listeners.forEach((listener) => listener());

  await (
    id ? AsyncStorage.setItem(KEY, id) : AsyncStorage.removeItem(KEY)
  ).catch(() => undefined);
}
