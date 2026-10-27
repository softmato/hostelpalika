import { loadActiveHostel } from "@/lib/active-hostel";
import { kvClear, kvGet, kvPrune, kvPut, openAccountDb } from "@/lib/local-db";
import {
  type PersistedEntry,
  peekQueryEntry,
  RESTORED_MAX_AGE_MS,
  setQueryCacheDisk,
} from "@/lib/query-cache";
import { store } from "@/store";

/**
 * The disk half of `lib/query-cache`, kept apart so that module stays loadable
 * in node tests.
 *
 * One `kv` row per cache key in the account's SQLite file. Nothing is read up
 * front: the cache asks for a key's row the first time a screen reads it. Writes
 * are batched — the portal warm-up files thirty answers in a burst and one
 * transaction covers them all — and only the keys that changed are written.
 */

const PREFIX = "q:";
const WRITE_DELAY_MS = 1_000;
/** Rows kept on disk; well above the in-memory cap, since only screens read them. */
const MAX_ROWS = 2_000;

const dirty = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;

function flush() {
  timer = null;
  const rows = [...dirty].map((key) => {
    const entry = peekQueryEntry(key);
    let value: string | null = null;
    if (entry) {
      try {
        value = JSON.stringify({ data: entry.data, topics: entry.topics });
      } catch {
        value = null;
      }
    }
    return { key: PREFIX + key, storedAt: entry?.storedAt ?? 0, value };
  });
  dirty.clear();
  kvPut(rows.filter((row) => row.value !== null));
}

function read(key: string): PersistedEntry | null {
  const row = kvGet(PREFIX + key);
  if (!row) return null;
  const saved = JSON.parse(row.value) as Pick<PersistedEntry, "data" | "topics">;
  return { data: saved.data, key, storedAt: row.storedAt, topics: saved.topics ?? [] };
}

type Owner = { id: string; role: string } | null;

function ownerOf(): Owner {
  const account = store.getState().auth.account;
  return account ? { id: account.id, role: account.role } : null;
}

/**
 * Awaited by `PersistGate`'s `onBeforeLift`: opens this account's file before
 * any screen reads, and follows the account from then on — sign-out, another
 * account, a role change (`lib/local-db` says what each one does to the file).
 */
export async function hydrateQueryCache() {
  await loadActiveHostel();

  let owner = ownerOf();
  await openAccountDb(owner?.id ?? null, owner?.role ?? null);
  kvPrune(Date.now() - RESTORED_MAX_AGE_MS, MAX_ROWS);

  store.subscribe(() => {
    const next = ownerOf();
    if (next?.id === owner?.id && next?.role === owner?.role) return;
    owner = next;
    // A pending batch belongs to the account that is leaving.
    dirty.clear();
    void openAccountDb(next?.id ?? null, next?.role ?? null);
  });

  setQueryCacheDisk({
    clear() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      dirty.clear();
      kvClear(PREFIX);
    },
    read,
    write(key) {
      dirty.add(key);
      timer ??= setTimeout(flush, WRITE_DELAY_MS);
    },
  });
}
