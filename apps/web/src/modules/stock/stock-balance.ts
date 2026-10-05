import { roundQty, type StockEntryKind, type StockEntryStatus, type StockKind } from "@hostel/shared/expenses/stock";

/**
 * The stock arithmetic, with no database in it (docs/INVENTORY_PLAN.md §3).
 *
 * Every number on the stock screen is folded from the entries here, on every
 * read, and nothing is stored — the warden cash box's rule. A building's Left
 * is its last Count plus what came in since minus what left since; a Count
 * that finds less than that is what was **used**.
 *
 * Time order is when the entry was *made* (`createdAt`), and for goods coming
 * in, when the other side tapped Got it (`receivedAt`): a sack is not in the
 * branch's store while it is still in the jeep. The month a figure belongs to
 * is the entry's own day (`inPeriod(on)`).
 */

export type FoldEntry = {
  createdAt: Date;
  hostelId: string;
  /** Whether the entry's day falls in the month on screen. */
  inPeriod: boolean;
  kind: StockEntryKind;
  lines: { itemId: string; qty: number; receivedQty: number | null }[];
  receivedAt: Date | null;
  status: StockEntryStatus;
  toHostelId: string | null;
};

export type ItemAtPlace = {
  /** This month: bought here. */
  bought: number;
  /** Last Count here, or `null` if never counted. */
  counted: number | null;
  countedAt: Date | null;
  /** This month: bought here plus what arrived here. */
  in: number;
  /** Last Count plus everything since. Overstates until the next Count. */
  left: number;
  /** Sent here, Got it not tapped yet. */
  onWay: number;
  /** This month: sent from here. */
  out: number;
  /** This month: sent here, arrived less. */
  short: number;
  /**
   * This month: STORE — what Counts found missing; DAILY — what came in minus
   * what went out, because a daily item is used the day it comes.
   */
  used: number;
};

const EMPTY = (): ItemAtPlace => ({
  bought: 0,
  counted: null,
  countedAt: null,
  in: 0,
  left: 0,
  onWay: 0,
  out: 0,
  short: 0,
  used: 0,
});

type Event =
  | { at: Date; delta: number; kind: "move" }
  | { at: Date; inPeriod: boolean; kind: "count"; qty: number };

/**
 * `item → place → figures` for the places asked about. Entries may arrive in
 * any order; cancelled ones are skipped.
 */
export function foldStock(
  entries: readonly FoldEntry[],
  kinds: ReadonlyMap<string, StockKind>,
  places: readonly string[],
) {
  const wanted = new Set(places);
  const result = new Map<string, Map<string, ItemAtPlace>>();
  const events = new Map<string, Event[]>();

  const at = (itemId: string, place: string) => {
    let byPlace = result.get(itemId);

    if (!byPlace) {
      byPlace = new Map();
      result.set(itemId, byPlace);
    }

    let row = byPlace.get(place);

    if (!row) {
      row = EMPTY();
      byPlace.set(place, row);
    }

    return row;
  };

  const push = (itemId: string, place: string, event: Event) => {
    const key = `${itemId}|${place}`;
    const list = events.get(key) ?? [];

    list.push(event);
    events.set(key, list);
  };

  for (const entry of entries) {
    if (entry.status === "CANCELLED") continue;

    for (const line of entry.lines) {
      if (!kinds.has(line.itemId)) continue;

      if (entry.kind === "BUY" && wanted.has(entry.hostelId)) {
        const row = at(line.itemId, entry.hostelId);

        if (entry.inPeriod) {
          row.bought += line.qty;
          row.in += line.qty;
        }

        push(line.itemId, entry.hostelId, { at: entry.createdAt, delta: line.qty, kind: "move" });
      }

      if (entry.kind === "SEND") {
        if (wanted.has(entry.hostelId)) {
          if (entry.inPeriod) at(line.itemId, entry.hostelId).out += line.qty;

          push(line.itemId, entry.hostelId, { at: entry.createdAt, delta: -line.qty, kind: "move" });
        }

        if (entry.toHostelId && wanted.has(entry.toHostelId)) {
          const row = at(line.itemId, entry.toHostelId);

          if (entry.status === "PENDING") {
            row.onWay += line.qty;
          } else {
            const got = line.receivedQty ?? line.qty;

            if (entry.inPeriod) {
              row.in += got;
              row.short += Math.max(0, line.qty - got);
            }

            push(line.itemId, entry.toHostelId, {
              at: entry.receivedAt ?? entry.createdAt,
              delta: got,
              kind: "move",
            });
          }
        }
      }

      if (entry.kind === "COUNT" && wanted.has(entry.hostelId)) {
        at(line.itemId, entry.hostelId);
        push(line.itemId, entry.hostelId, {
          at: entry.createdAt,
          inPeriod: entry.inPeriod,
          kind: "count",
          qty: line.qty,
        });
      }
    }
  }

  for (const [key, list] of events) {
    const [itemId, place] = key.split("|") as [string, string];
    const row = at(itemId, place);

    list.sort((a, b) => a.at.getTime() - b.at.getTime());

    let left = 0;

    for (const event of list) {
      if (event.kind === "move") {
        left += event.delta;
        continue;
      }

      // ponytail: a Count that finds *more* than the book (a Bought nobody
      // entered) counts as nothing used rather than negative use.
      if (event.inPeriod) row.used += Math.max(0, left - event.qty);

      left = event.qty;
      row.counted = event.qty;
      row.countedAt = event.at;
    }

    row.left = left;
  }

  for (const [itemId, byPlace] of result) {
    const daily = kinds.get(itemId) === "DAILY";

    for (const row of byPlace.values()) {
      if (daily) row.used = Math.max(0, row.in - row.out);

      for (const field of ["bought", "in", "left", "onWay", "out", "short", "used"] as const) {
        row[field] = roundQty(row[field]);
      }
    }
  }

  return result;
}
