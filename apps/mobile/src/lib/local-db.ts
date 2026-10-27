/**
 * The signed-in account's own SQLite file: a key-value table and a write queue.
 *
 * Generic on purpose — the query cache (`lib/query-cache-persist`) keeps one
 * `kv` row per cache key, the offline writes (`lib/offline-writes`) sit in
 * `queue`, and anything else that needs a small durable store or an outbox
 * (the usage watcher) uses the same two tables under its own key prefix or
 * queue `kind`.
 *
 * ## One file per account
 *
 * `account-<id>.db`. Opening another account deletes the last one's file, and
 * signing out deletes it too, so a handset passed between an owner and a warden
 * never hands one the other's roster. A role change on the same account (a
 * warden promoted, a resident moved out to PUBLIC) empties the file: every
 * cached answer and every queued write was made under the old role.
 *
 * Everything but `openAccountDb` is synchronous — expo-sqlite's sync calls are
 * a few hundred microseconds for a row, which is what lets a screen read its
 * cached answer in its first render. Nothing here throws: a failing disk costs
 * the instant paint, never the screen.
 *
 * The PWA gets an IndexedDB stand-in with the same exports (`web/local-db.ts`).
 */

import * as SQLite from "expo-sqlite";

export type KvRow = { key: string; storedAt: number; value: string };

export type QueuedWrite = {
  attempts: number;
  createdAt: number;
  id: number;
  kind: string;
  payload: string;
};

let db: SQLite.SQLiteDatabase | null = null;
let openId: string | null = null;

function fileFor(accountId: string) {
  return `account-${accountId.replace(/[^\w-]/g, "")}.db`;
}

function close() {
  try {
    db?.closeSync();
  } catch {
    // Closing a handle that already failed is nothing to report.
  }
  db = null;
}

/** Opens (or switches to) this account's file. `null` closes and deletes the last one. */
export async function openAccountDb(accountId: string | null, role: string | null) {
  if (accountId !== openId) {
    const previous = openId;
    close();
    openId = accountId;

    if (previous) {
      try {
        SQLite.deleteDatabaseSync(fileFor(previous));
      } catch {
        // Already gone.
      }
    }

    if (!accountId) return;

    try {
      db = SQLite.openDatabaseSync(fileFor(accountId));
      db.execSync(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL, stored_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS queue (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS meta (name TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
      `);
    } catch {
      close();
      return;
    }
  }

  if (!db) return;

  try {
    const saved = db.getFirstSync<{ value: string }>("SELECT value FROM meta WHERE name = 'role'");
    if (saved && saved.value !== (role ?? "")) {
      db.execSync("DELETE FROM kv; DELETE FROM queue;");
    }
    db.runSync("INSERT OR REPLACE INTO meta (name, value) VALUES ('role', ?)", [role ?? ""]);
  } catch {
    // The role check failing leaves the file as it was.
  }
}

export function kvGet(key: string): KvRow | null {
  try {
    const row = db?.getFirstSync<{ stored_at: number; value: string }>(
      "SELECT value, stored_at FROM kv WHERE key = ?",
      [key],
    );
    return row ? { key, storedAt: row.stored_at, value: row.value } : null;
  } catch {
    return null;
  }
}

/** `value: null` deletes the row. One transaction for the batch. */
export function kvPut(rows: readonly { key: string; storedAt: number; value: string | null }[]) {
  const handle = db;
  if (!handle || rows.length === 0) return;

  try {
    handle.withTransactionSync(() => {
      for (const row of rows) {
        if (row.value === null) {
          handle.runSync("DELETE FROM kv WHERE key = ?", [row.key]);
        } else {
          handle.runSync(
            "INSERT OR REPLACE INTO kv (key, value, stored_at) VALUES (?, ?, ?)",
            [row.key, row.value, row.storedAt],
          );
        }
      }
    });
  } catch {
    // A failed save costs the next cold start its instant paint.
  }
}

/** Every row, or those under one key prefix. */
export function kvClear(prefix = "") {
  try {
    db?.runSync("DELETE FROM kv WHERE substr(key, 1, ?) = ?", [prefix.length, prefix]);
  } catch {
    // Nothing to do.
  }
}

/** Drops rows written before `before` (ms), and all but the newest `keep`. */
export function kvPrune(before: number, keep: number) {
  try {
    db?.runSync("DELETE FROM kv WHERE stored_at < ?", [before]);
    db?.runSync(
      "DELETE FROM kv WHERE key NOT IN (SELECT key FROM kv ORDER BY stored_at DESC LIMIT ?)",
      [keep],
    );
  } catch {
    // Nothing to do.
  }
}

export function enqueueWrite(kind: string, payload: unknown): number | null {
  try {
    const result = db?.runSync(
      "INSERT INTO queue (kind, payload, created_at) VALUES (?, ?, ?)",
      [kind, JSON.stringify(payload), Date.now()],
    );
    return result ? Number(result.lastInsertRowId) : null;
  } catch {
    return null;
  }
}

/** Oldest first. */
export function listQueuedWrites(kind?: string): QueuedWrite[] {
  try {
    const rows =
      db?.getAllSync<{
        attempts: number;
        created_at: number;
        id: number;
        kind: string;
        payload: string;
      }>(
        kind
          ? "SELECT * FROM queue WHERE kind = ? ORDER BY id"
          : "SELECT * FROM queue ORDER BY id",
        kind ? [kind] : [],
      ) ?? [];
    return rows.map((row) => ({
      attempts: row.attempts,
      createdAt: row.created_at,
      id: row.id,
      kind: row.kind,
      payload: row.payload,
    }));
  } catch {
    return [];
  }
}

export function dropQueuedWrite(id: number) {
  try {
    db?.runSync("DELETE FROM queue WHERE id = ?", [id]);
  } catch {
    // Sent twice at worst; every queued kind is safe to repeat or refused as a duplicate.
  }
}

export function bumpQueuedWrite(id: number) {
  try {
    db?.runSync("UPDATE queue SET attempts = attempts + 1 WHERE id = ?", [id]);
  } catch {
    // Nothing to do.
  }
}
