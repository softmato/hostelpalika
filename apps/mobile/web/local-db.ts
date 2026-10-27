/**
 * `lib/local-db` for the installable web app: the same exports over IndexedDB.
 *
 * IndexedDB is asynchronous and the native file is read synchronously, so the
 * account's rows are loaded into memory once, in `openAccountDb` (awaited before
 * the first screen), and every write goes to memory at once and to IndexedDB
 * behind it. One database per account, deleted on sign-out or another account,
 * emptied on a role change — the same rules as the phone.
 */

export type KvRow = { key: string; storedAt: number; value: string };

export type QueuedWrite = {
  attempts: number;
  createdAt: number;
  id: number;
  kind: string;
  payload: string;
};

let db: IDBDatabase | null = null;
let openId: string | null = null;
const kv = new Map<string, KvRow>();
const queue = new Map<number, QueuedWrite>();
let nextId = 1;

const nameFor = (accountId: string) => `hostelpalika-account-${accountId}`;

function request<T>(req: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function store(name: "kv" | "queue" | "meta") {
  return db?.transaction(name, "readwrite").objectStore(name) ?? null;
}

/** Fire and forget: memory already holds the truth for this tab. */
function write(name: "kv" | "queue" | "meta", work: (os: IDBObjectStore) => void) {
  try {
    const os = store(name);
    if (os) work(os);
  } catch {
    // Private mode or a full disk: this tab keeps working from memory.
  }
}

export async function openAccountDb(accountId: string | null, role: string | null) {
  if (accountId !== openId) {
    const previous = openId;
    db?.close();
    db = null;
    kv.clear();
    queue.clear();
    openId = accountId;

    if (previous && typeof indexedDB !== "undefined") {
      indexedDB.deleteDatabase(nameFor(previous));
    }
    if (!accountId || typeof indexedDB === "undefined") return;

    try {
      const opening = indexedDB.open(nameFor(accountId), 1);
      opening.onupgradeneeded = () => {
        const next = opening.result;
        next.createObjectStore("kv", { keyPath: "key" });
        next.createObjectStore("queue", { keyPath: "id" });
        next.createObjectStore("meta");
      };
      const opened = await request(opening);
      // Signed out (or switched) while this was opening.
      if (openId !== accountId) {
        opened.close();
        return;
      }
      db = opened;
      const tx = opened.transaction(["kv", "queue"], "readonly");
      const [rows, writes] = await Promise.all([
        request(tx.objectStore("kv").getAll() as IDBRequest<KvRow[]>),
        request(tx.objectStore("queue").getAll() as IDBRequest<QueuedWrite[]>),
      ]);
      for (const row of rows) kv.set(row.key, row);
      for (const item of writes) {
        queue.set(item.id, item);
        nextId = Math.max(nextId, item.id + 1);
      }
    } catch {
      db = null;
      return;
    }
  }

  if (!db) return;

  try {
    const meta = db.transaction("meta", "readonly").objectStore("meta");
    const saved = (await request(meta.get("role"))) as string | undefined;
    if (saved !== undefined && saved !== (role ?? "")) {
      kv.clear();
      queue.clear();
      write("kv", (os) => os.clear());
      write("queue", (os) => os.clear());
    }
    write("meta", (os) => os.put(role ?? "", "role"));
  } catch {
    // Left as it was.
  }
}

export function kvGet(key: string): KvRow | null {
  return kv.get(key) ?? null;
}

export function kvPut(rows: readonly { key: string; storedAt: number; value: string | null }[]) {
  for (const row of rows) {
    if (row.value === null) {
      kv.delete(row.key);
      write("kv", (os) => os.delete(row.key));
    } else {
      const next = { key: row.key, storedAt: row.storedAt, value: row.value };
      kv.set(row.key, next);
      write("kv", (os) => os.put(next));
    }
  }
}

export function kvClear(prefix = "") {
  for (const key of [...kv.keys()]) {
    if (key.startsWith(prefix)) {
      kv.delete(key);
      write("kv", (os) => os.delete(key));
    }
  }
}

export function kvPrune(before: number, keep: number) {
  const newest = [...kv.values()].sort((a, b) => b.storedAt - a.storedAt);
  newest.forEach((row, index) => {
    if (row.storedAt < before || index >= keep) {
      kv.delete(row.key);
      write("kv", (os) => os.delete(row.key));
    }
  });
}

export function enqueueWrite(kind: string, payload: unknown): number | null {
  const item: QueuedWrite = {
    attempts: 0,
    createdAt: Date.now(),
    id: nextId++,
    kind,
    payload: JSON.stringify(payload),
  };
  queue.set(item.id, item);
  write("queue", (os) => os.put(item));
  return item.id;
}

export function listQueuedWrites(kind?: string): QueuedWrite[] {
  return [...queue.values()]
    .filter((item) => !kind || item.kind === kind)
    .sort((a, b) => a.id - b.id);
}

export function dropQueuedWrite(id: number) {
  queue.delete(id);
  write("queue", (os) => os.delete(id));
}

export function bumpQueuedWrite(id: number) {
  const item = queue.get(id);
  if (!item) return;
  item.attempts += 1;
  write("queue", (os) => os.put(item));
}
