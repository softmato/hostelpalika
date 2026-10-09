import { roundQty, type StockEntryKind, type StockEntryStatus, type StockKind } from "@hostel/shared/expenses/stock";

/**
 * The stock arithmetic, with no database in it (docs/INVENTORY_PLAN.md §3).
 *
 * Stock is a **ledger**: every change is a movement row, and what is left is
 * their sum. Nothing is stored — the warden cash box's rule — so a figure can
 * always be rebuilt and two screens can never disagree.
 *
 * - In: Bought, Opening stock, a Send arriving (Got it, what actually came)
 * - Out: Used, Wasted, a Send leaving
 * - Adjust: an approved Count — what was found minus what the book said then
 *
 * ## Time
 *
 * Movements are applied in the order they were *made* (`createdAt`), and goods
 * coming from another building at Got it (`receivedAt`): a sack is not in the
 * branch's store while it is still in the jeep. Which month a figure belongs to
 * is the entry's own day (`when`).
 *
 * ## Cost
 *
 * Weighted average, per item across the whole group: each Bought with a price
 * moves the average, nothing else does. Every movement out is valued at the
 * average *at that moment*, so a month's Used is what it really cost even if
 * rice got dearer later.
 */

export type FoldLine = {
  itemId: string;
  qty: number;
  /** BUY / OPENING: rupees per unit, if known. */
  rate: number | null;
  /** SEND: what came, once Got it was tapped. */
  receivedQty: number | null;
  /** COUNT: what the book said when it was counted. `null` on old Counts, which set the Left. */
  systemQty: number | null;
};

export type FoldEntry = {
  createdAt: Date;
  hostelId: string;
  kind: StockEntryKind;
  lines: FoldLine[];
  receivedAt: Date | null;
  status: StockEntryStatus;
  toHostelId: string | null;
  /** Where the entry's day falls against the month on screen. */
  when: "after" | "before" | "in";
};

export type ItemAtPlace = {
  /** This month: signed — what Counts found extra (+) or missing (−). */
  adjusted: number;
  adjustedValue: number;
  /** This month: bought here. */
  bought: number;
  boughtValue: number;
  /** End of the month on screen. Equals `left` for the current month. */
  closing: number;
  /** Last approved Count here, or `null` if never counted. */
  counted: number | null;
  countedAt: Date | null;
  /** This month: everything that came in — bought, opening stock, arrived from another building. */
  in: number;
  /** Now, across all time. */
  left: number;
  /** Sent here, Got it not tapped yet. */
  onWay: number;
  /** Start of the month on screen. */
  opening: number;
  /** This month: sent from here. */
  out: number;
  /** This month: sent here, arrived less. */
  short: number;
  /**
   * This month: STORE — issued with Use. DAILY — what came in minus what was
   * sent on, because a daily item is used the day it comes.
   */
  used: number;
  usedValue: number;
  /** This month: thrown away. */
  wasted: number;
  wastedValue: number;
};

export function emptyAtPlace(): ItemAtPlace {
  return {
    adjusted: 0,
    adjustedValue: 0,
    bought: 0,
    boughtValue: 0,
    closing: 0,
    counted: null,
    countedAt: null,
    in: 0,
    left: 0,
    onWay: 0,
    opening: 0,
    out: 0,
    short: 0,
    used: 0,
    usedValue: 0,
    wasted: 0,
    wastedValue: 0,
  };
}

type Move =
  | "buy"
  | "count"
  | "opening"
  | "receive"
  | "sendOut"
  | "use"
  | "waste";

type Event = {
  at: Date;
  itemId: string;
  move: Move;
  place: string;
  qty: number;
  rate: number | null;
  /** SEND received: what was sent, for the short. */
  sent: number;
  systemQty: number | null;
  when: FoldEntry["when"];
};

export type StockFold = {
  /** Weighted average cost per unit now, or `null` if no Bought ever had a price. */
  avgCost: Map<string, number | null>;
  /** `item → place → figures`, for the places asked about. */
  byItem: Map<string, Map<string, ItemAtPlace>>;
};

/**
 * Entries may arrive in any order; cancelled ones and Counts still waiting for
 * approval are skipped. Every building's movements are walked (the average
 * cost is the group's), but figures are kept only for `places`.
 */
export function foldStock(
  entries: readonly FoldEntry[],
  kinds: ReadonlyMap<string, StockKind>,
  places: readonly string[],
): StockFold {
  const wanted = new Set(places);
  const byItem = new Map<string, Map<string, ItemAtPlace>>();
  const onWay: { itemId: string; place: string; qty: number }[] = [];
  const events: Event[] = [];

  const row = (itemId: string, place: string) => {
    let byPlace = byItem.get(itemId);

    if (!byPlace) {
      byPlace = new Map();
      byItem.set(itemId, byPlace);
    }

    let found = byPlace.get(place);

    if (!found) {
      found = emptyAtPlace();
      byPlace.set(place, found);
    }

    return found;
  };

  for (const entry of entries) {
    if (entry.status === "CANCELLED") continue;
    if (entry.kind === "COUNT" && entry.status === "PENDING") continue;

    for (const line of entry.lines) {
      if (!kinds.has(line.itemId)) continue;

      const base = {
        at: entry.createdAt,
        itemId: line.itemId,
        place: entry.hostelId,
        qty: line.qty,
        rate: line.rate,
        sent: 0,
        systemQty: line.systemQty,
        when: entry.when,
      };

      switch (entry.kind) {
        case "BUY":
          events.push({ ...base, move: "buy" });
          break;
        case "OPENING":
          events.push({ ...base, move: "opening" });
          break;
        case "USE":
          events.push({ ...base, move: "use" });
          break;
        case "WASTE":
          events.push({ ...base, move: "waste" });
          break;
        case "COUNT":
          events.push({ ...base, move: "count" });
          break;
        case "SEND":
          events.push({ ...base, move: "sendOut" });

          if (entry.toHostelId) {
            if (entry.status === "PENDING") {
              onWay.push({ itemId: line.itemId, place: entry.toHostelId, qty: line.qty });
            } else {
              events.push({
                ...base,
                at: entry.receivedAt ?? entry.createdAt,
                move: "receive",
                place: entry.toHostelId,
                qty: line.receivedQty ?? line.qty,
                sent: line.qty,
              });
            }
          }
          break;
      }
    }
  }

  events.sort((a, b) => a.at.getTime() - b.at.getTime());

  const avg = new Map<string, number | null>();
  const groupQty = new Map<string, number>();
  const left = new Map<string, number>();
  const periodDelta = new Map<string, number>();

  for (const event of events) {
    const key = `${event.itemId}|${event.place}`;
    const before = left.get(key) ?? 0;
    const cost = avg.get(event.itemId) ?? null;
    const held = groupQty.get(event.itemId) ?? 0;
    let delta = 0;

    switch (event.move) {
      case "buy":
      case "opening":
        delta = event.qty;

        if (event.rate !== null && event.qty > 0) {
          avg.set(
            event.itemId,
            cost === null || held <= 0 ? event.rate : (held * cost + event.qty * event.rate) / (held + event.qty),
          );
        }
        break;
      case "receive":
        delta = event.qty;
        break;
      case "use":
      case "waste":
      case "sendOut":
        delta = -event.qty;
        break;
      case "count":
        delta = event.systemQty !== null ? event.qty - event.systemQty : event.qty - before;
        break;
    }

    left.set(key, before + delta);
    groupQty.set(event.itemId, held + delta);

    if (!wanted.has(event.place)) continue;

    const target = row(event.itemId, event.place);
    const unitCost = cost ?? 0;

    if (event.move === "count") {
      target.counted = event.qty;
      target.countedAt = event.at;
    }

    if (event.when === "before") {
      target.opening += delta;
      continue;
    }

    if (event.when === "after") continue;

    periodDelta.set(key, (periodDelta.get(key) ?? 0) + delta);

    switch (event.move) {
      case "buy":
        target.bought += event.qty;
        target.boughtValue += event.qty * (event.rate ?? unitCost);
        target.in += event.qty;
        break;
      case "opening":
        target.in += event.qty;
        break;
      case "receive":
        target.in += event.qty;
        target.short += Math.max(0, event.sent - event.qty);
        break;
      case "sendOut":
        target.out += event.qty;
        break;
      case "use":
        target.used += event.qty;
        target.usedValue += event.qty * unitCost;
        break;
      case "waste":
        target.wasted += event.qty;
        target.wastedValue += event.qty * unitCost;
        break;
      case "count":
        target.adjusted += delta;
        target.adjustedValue += delta * unitCost;
        break;
    }
  }

  for (const pending of onWay) {
    if (wanted.has(pending.place)) row(pending.itemId, pending.place).onWay += pending.qty;
  }

  for (const [itemId, byPlace] of byItem) {
    const daily = kinds.get(itemId) === "DAILY";
    const cost = avg.get(itemId) ?? 0;

    for (const [place, target] of byPlace) {
      const key = `${itemId}|${place}`;

      target.left = left.get(key) ?? 0;
      target.closing = target.opening + (periodDelta.get(key) ?? 0);

      if (daily) {
        // Used the day it came: nothing sits on a shelf to count or value.
        target.used = Math.max(0, target.in - target.out);
        target.usedValue = target.used * cost;
        target.left = 0;
        target.opening = 0;
        target.closing = 0;
      }

      for (const field of ["adjusted", "bought", "closing", "in", "left", "onWay", "opening", "out", "short", "used", "wasted"] as const) {
        target[field] = roundQty(target[field]);
      }

      for (const field of ["adjustedValue", "boughtValue", "usedValue", "wastedValue"] as const) {
        target[field] = Math.round(target[field]);
      }
    }
  }

  for (const itemId of kinds.keys()) {
    const cost = avg.get(itemId);

    avg.set(itemId, cost === undefined || cost === null ? null : Math.round(cost * 100) / 100);
  }

  return { avgCost: avg, byItem };
}

/* -------------------------------------------------------------------------- */
/* Supplier ledger                                                            */
/* -------------------------------------------------------------------------- */

export type LedgerBill = {
  createdAt: Date;
  id: string;
  on: Date;
  paid: number;
  status: StockEntryStatus;
  total: number;
};

export type LedgerPayment = {
  amount: number;
  createdAt: Date;
  id: string;
  on: Date;
  status: "CANCELLED" | "DONE";
};

export type LedgerRow = {
  /** What the hostel owes after this row. Negative: paid ahead. */
  balance: number;
  /** Signed effect on what is owed: a bill adds `total − paid`, a payment takes off. */
  change: number;
  createdAt: Date;
  id: string;
  kind: "BILL" | "OPENING" | "PAYMENT";
  on: Date;
};

/**
 * Bills (credit) against payments (debit) for one supplier, oldest first, each
 * with the balance after it. Cancelled rows are left out — they never happened.
 */
export function supplierLedger(
  openingDue: number,
  bills: readonly LedgerBill[],
  payments: readonly LedgerPayment[],
  openedAt: Date,
) {
  const rows: Omit<LedgerRow, "balance">[] = [
    ...bills
      .filter((bill) => bill.status !== "CANCELLED")
      .map((bill) => ({
        change: bill.total - bill.paid,
        createdAt: bill.createdAt,
        id: bill.id,
        kind: "BILL" as const,
        on: bill.on,
      })),
    ...payments
      .filter((payment) => payment.status !== "CANCELLED")
      .map((payment) => ({
        change: -payment.amount,
        createdAt: payment.createdAt,
        id: payment.id,
        kind: "PAYMENT" as const,
        on: payment.on,
      })),
  ].sort((a, b) => a.on.getTime() - b.on.getTime() || a.createdAt.getTime() - b.createdAt.getTime());

  let balance = openingDue;
  const ledger: LedgerRow[] = openingDue
    ? [{ balance, change: openingDue, createdAt: openedAt, id: "opening", kind: "OPENING", on: openedAt }]
    : [];

  for (const entry of rows) {
    balance += entry.change;
    ledger.push({ ...entry, balance });
  }

  return {
    billed: bills.filter((bill) => bill.status !== "CANCELLED").reduce((sum, bill) => sum + bill.total, 0),
    due: balance,
    paid:
      bills.filter((bill) => bill.status !== "CANCELLED").reduce((sum, bill) => sum + bill.paid, 0) +
      payments.filter((payment) => payment.status !== "CANCELLED").reduce((sum, payment) => sum + payment.amount, 0),
    rows: ledger,
  };
}

/* -------------------------------------------------------------------------- */
/* Usage                                                                      */
/* -------------------------------------------------------------------------- */

export type UsageEntry = {
  /** Was it the kitchen's login that entered it. */
  byCook: boolean;
  /** `YYYY-MM-DD`, the entry's own day. */
  day: string;
  hostelId: string;
  kind: StockEntryKind;
  lines: { itemId: string; qty: number; receivedQty: number | null }[];
  status: StockEntryStatus;
  toHostelId: string | null;
};

export type UsageRow = {
  /** Of `used`, what the kitchen's login entered. */
  byCook: number;
  day: string;
  hostelId: string;
  itemId: string;
  used: number;
  wasted: number;
};

/**
 * What was used and thrown away, per day, item and building, between two days
 * inclusive — the warden's "how much went today, this week, this month".
 *
 * - **Store** items: every Use, and every Waste (kept apart).
 * - **Daily** items are used the day they come, so what came in *is* what was
 *   used: bought here, plus what arrived from another building, minus what was
 *   sent on. A day that sent more than it bought counts as nothing, not less.
 *
 * Counts are left out: what a count finds missing was never seen being used,
 * and the reports show it as missing on its own.
 */
export function usageRows(
  entries: readonly UsageEntry[],
  kinds: ReadonlyMap<string, StockKind>,
  places: readonly string[],
  from: string,
  to: string,
): UsageRow[] {
  const wanted = new Set(places);
  const rows = new Map<string, UsageRow>();

  const add = (day: string, hostelId: string, itemId: string, change: Partial<Omit<UsageRow, "day" | "hostelId" | "itemId">>) => {
    if (!wanted.has(hostelId)) return;

    const key = `${day}|${hostelId}|${itemId}`;
    const row = rows.get(key) ?? { byCook: 0, day, hostelId, itemId, used: 0, wasted: 0 };

    row.used += change.used ?? 0;
    row.wasted += change.wasted ?? 0;
    row.byCook += change.byCook ?? 0;
    rows.set(key, row);
  };

  for (const entry of entries) {
    if (entry.status === "CANCELLED" || entry.day < from || entry.day > to) continue;

    for (const line of entry.lines) {
      const kind = kinds.get(line.itemId);

      if (!kind) continue;

      if (kind === "STORE") {
        if (entry.kind === "USE") add(entry.day, entry.hostelId, line.itemId, { byCook: entry.byCook ? line.qty : 0, used: line.qty });
        if (entry.kind === "WASTE") add(entry.day, entry.hostelId, line.itemId, { wasted: line.qty });
        continue;
      }

      if (entry.kind === "BUY" || entry.kind === "OPENING") add(entry.day, entry.hostelId, line.itemId, { used: line.qty });

      if (entry.kind === "SEND") {
        add(entry.day, entry.hostelId, line.itemId, { used: -line.qty });

        if (entry.toHostelId && entry.status === "RECEIVED") {
          add(entry.day, entry.toHostelId, line.itemId, { used: line.receivedQty ?? line.qty });
        }
      }
    }
  }

  return [...rows.values()]
    .map((row) => ({
      ...row,
      byCook: roundQty(Math.max(0, row.byCook)),
      used: roundQty(Math.max(0, row.used)),
      wasted: roundQty(row.wasted),
    }))
    .filter((row) => row.used > 0 || row.wasted > 0)
    .sort((a, b) => b.day.localeCompare(a.day) || a.itemId.localeCompare(b.itemId) || a.hostelId.localeCompare(b.hostelId));
}
