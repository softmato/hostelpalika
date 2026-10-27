/**
 * The few writes that may wait for a network: stock use/waste/count, a typed
 * complaint, an expense. Each carries a `clientRequestId` the server dedupes on,
 * so a write that did reach the server before the answer was lost files once.
 *
 * Money that moves between people never waits: payments, staff cash and
 * anything with a receipt are online only. Night status has its own queue
 * (`lib/night-status-queue`) because it is answered from the notification
 * shade with the app closed.
 *
 * Sent oldest first on launch, on every return to the foreground, once a minute
 * while anything waits, and before sign-out (the file goes with the account).
 */

import { AppState } from "react-native";

import { isOfflineError, readApiError } from "@/lib/api-contract";
import { createResidentComplaint } from "@/lib/complaints-api";
import { addExpense, type ExpenseAudience, type NewExpense } from "@/lib/expenses-api";
import { dropQueuedWrite, enqueueWrite, listQueuedWrites } from "@/lib/local-db";
import { invalidateAllQueries } from "@/lib/query-cache";
import { addStockEntry, type NewStockEntry } from "@/lib/stock-api";
import { toastError, toastSuccess } from "@/lib/toast";

type Writes = {
  complaint: Parameters<typeof createResidentComplaint>[0] & { clientRequestId: string };
  expense: { audience: ExpenseAudience; input: NewExpense };
  stock: NewStockEntry;
};
type Kind = keyof Writes;

const SEND: { [K in Kind]: (payload: Writes[K]) => Promise<unknown> } = {
  complaint: (payload) => createResidentComplaint(payload),
  expense: ({ audience, input }) => addExpense(audience, input),
  stock: (payload) => addStockEntry(payload),
};

const LABEL: Record<Kind, string> = {
  complaint: "Complaint",
  expense: "Expense",
  stock: "Stock",
};

/**
 * Sends now; with no network, keeps it for later and says so. `"queued"` means
 * the caller should treat it as saved (close the form) — the server has not
 * seen it yet. A server refusal still throws, as before.
 */
export async function sendOrQueue<K extends Kind>(kind: K, payload: Writes[K]) {
  try {
    await SEND[kind](payload);
    return "sent" as const;
  } catch (caught) {
    if (!isOfflineError(readApiError(caught))) throw caught;
    if (enqueueWrite(kind, payload) === null) throw caught;
    toastSuccess("Saved on this phone", "It sends by itself when you are back online.");
    ensureTimer();
    return "queued" as const;
  }
}

let flushing: Promise<void> | null = null;

export function flushOfflineWrites(): Promise<void> {
  flushing ??= (async () => {
    let sent = 0;
    for (const item of listQueuedWrites()) {
      const kind = item.kind as Kind;
      if (!(kind in SEND)) {
        dropQueuedWrite(item.id);
        continue;
      }
      try {
        await SEND[kind](JSON.parse(item.payload) as never);
        dropQueuedWrite(item.id);
        sent += 1;
      } catch (caught) {
        const message = readApiError(caught);
        // Still offline: stop and keep the rest in order.
        if (isOfflineError(message)) break;
        // Refused for good (closed month, removed item): say so once, drop it,
        // so one bad write never blocks the ones behind it.
        dropQueuedWrite(item.id);
        toastError(`${LABEL[kind]} saved offline was not accepted`, message);
      }
    }
    if (sent > 0) {
      invalidateAllQueries();
      toastSuccess("Sent", `${sent} saved ${sent === 1 ? "change" : "changes"} reached the server.`);
    }
  })().finally(() => {
    flushing = null;
  });
  return flushing;
}

let timer: ReturnType<typeof setInterval> | null = null;

function ensureTimer() {
  timer ??= setInterval(() => {
    if (listQueuedWrites().length === 0) {
      if (timer) clearInterval(timer);
      timer = null;
      return;
    }
    void flushOfflineWrites();
  }, 60_000);
}

/** Once, at boot (after the account's file is open). */
export function startOfflineWrites() {
  if (listQueuedWrites().length > 0) {
    ensureTimer();
    void flushOfflineWrites();
  }
  AppState.addEventListener("change", (state) => {
    if (state === "active" && listQueuedWrites().length > 0) void flushOfflineWrites();
  });
}
