import { describe, expect, it } from "vitest";

import { type FoldEntry, foldStock, supplierLedger, type UsageEntry, usageRows } from "./stock-balance";

const MAIN = "main";
const BRANCH = "branch";
const RICE = "rice";
const VEG = "veg";
const kinds = new Map([
  [RICE, "STORE" as const],
  [VEG, "DAILY" as const],
]);

let clock = 0;

function entry(partial: Partial<FoldEntry> & Pick<FoldEntry, "kind" | "lines">): FoldEntry {
  clock += 1;

  return {
    createdAt: new Date(clock * 1000),
    hostelId: MAIN,
    when: "in",
    receivedAt: null,
    status: partial.kind === "SEND" ? "PENDING" : "DONE",
    toHostelId: null,
    ...partial,
  };
}

const line = (
  itemId: string,
  qty: number,
  receivedQty: number | null = null,
  extra: { rate?: number; systemQty?: number } = {},
) => ({
  itemId,
  qty,
  rate: extra.rate ?? null,
  receivedQty,
  systemQty: extra.systemQty ?? null,
});

describe("foldStock", () => {
  it("answers how much went where, and what an old Count found missing", () => {
    const entries = [
      entry({ kind: "BUY", lines: [line(RICE, 200)] }),
      entry({ kind: "SEND", lines: [line(RICE, 60, 58)], receivedAt: new Date(10_000), status: "RECEIVED", toHostelId: BRANCH }),
      entry({ kind: "SEND", lines: [line(RICE, 20)], toHostelId: BRANCH }),
      entry({ hostelId: BRANCH, kind: "COUNT", lines: [line(RICE, 40)], createdAt: new Date(20_000) }),
      entry({ kind: "SEND", lines: [line(RICE, 5)], status: "CANCELLED", toHostelId: BRANCH }),
    ];

    const result = foldStock(entries, kinds, [MAIN, BRANCH]);
    const main = result.byItem.get(RICE)!.get(MAIN)!;
    const branch = result.byItem.get(RICE)!.get(BRANCH)!;

    expect(main).toMatchObject({ bought: 200, in: 200, left: 120, out: 80 });
    // 58 came of 60; 20 still in the jeep; the count (no book figure: it sets the Left) found 18 gone.
    expect(branch).toMatchObject({ adjusted: -18, counted: 40, in: 58, left: 40, onWay: 20, short: 2 });
  });

  it("puts goods in a branch's store only once Got it is tapped", () => {
    const send = entry({ kind: "SEND", lines: [line(RICE, 25)], toHostelId: BRANCH });
    const count = entry({ hostelId: BRANCH, kind: "COUNT", lines: [line(RICE, 10)] });
    const received = { ...send, receivedAt: new Date(count.createdAt.getTime() + 1), status: "RECEIVED" as const };

    const branch = foldStock([received, count], kinds, [BRANCH]).byItem.get(RICE)!.get(BRANCH)!;

    // Counted 10 while the sack was on the way, then it arrived.
    expect(branch).toMatchObject({ left: 35, used: 0 });
  });

  it("treats a daily item as used the day it comes", () => {
    const entries = [
      entry({ kind: "BUY", lines: [line(VEG, 10)] }),
      entry({ kind: "SEND", lines: [line(VEG, 4)], receivedAt: new Date(99_000), status: "RECEIVED", toHostelId: BRANCH }),
    ];
    const result = foldStock(entries, kinds, [MAIN, BRANCH]);

    expect(result.byItem.get(VEG)!.get(MAIN)!.used).toBe(6);
    expect(result.byItem.get(VEG)!.get(BRANCH)!.used).toBe(4);
  });

  it("leaves another month's entries out of the month's figures but not out of Left", () => {
    const entries = [
      entry({ kind: "BUY", lines: [line(RICE, 50)], when: "before" }),
      entry({ kind: "USE", lines: [line(RICE, 10)] }),
      entry({ kind: "BUY", lines: [line(RICE, 30)], when: "after" }),
    ];
    const main = foldStock(entries, kinds, [MAIN]).byItem.get(RICE)!.get(MAIN)!;

    // Opening 50, used 10 → closing 40; the later Bought is in Left only.
    expect(main).toMatchObject({ bought: 0, closing: 40, left: 70, opening: 50, used: 10 });
  });

  it("does not show a building it was not asked about", () => {
    const entries = [entry({ kind: "SEND", lines: [line(RICE, 5)], toHostelId: BRANCH })];

    expect(foldStock(entries, kinds, [BRANCH]).byItem.get(RICE)!.has(MAIN)).toBe(false);
  });

  it("values what went out at the weighted average cost of the moment", () => {
    const entries = [
      entry({ kind: "BUY", lines: [line(RICE, 100, null, { rate: 80 })] }),
      entry({ kind: "USE", lines: [line(RICE, 50)] }),
      // 50 left at 80, 50 more at 110 → average 95.
      entry({ kind: "BUY", lines: [line(RICE, 50, null, { rate: 110 })] }),
      entry({ kind: "WASTE", lines: [line(RICE, 10)] }),
    ];
    const result = foldStock(entries, kinds, [MAIN]);
    const main = result.byItem.get(RICE)!.get(MAIN)!;

    expect(result.avgCost.get(RICE)).toBe(95);
    expect(main).toMatchObject({ boughtValue: 13_500, left: 90, used: 50, usedValue: 4_000, wasted: 10, wastedValue: 950 });
  });

  it("applies a Count as the gap from the book, and only once approved", () => {
    const entries = [
      entry({ kind: "OPENING", lines: [line(RICE, 40)] }),
      // Counted 35 when the book said 40, then 5 more were used before approval.
      entry({ kind: "COUNT", lines: [line(RICE, 35, null, { systemQty: 40 })] }),
      entry({ kind: "USE", lines: [line(RICE, 5)] }),
      entry({ kind: "COUNT", lines: [line(RICE, 1, null, { systemQty: 30 })], status: "PENDING" }),
    ];
    const main = foldStock(entries, kinds, [MAIN]).byItem.get(RICE)!.get(MAIN)!;

    expect(main).toMatchObject({ adjusted: -5, closing: 30, counted: 35, in: 40, left: 30, used: 5 });
  });
});

describe("supplierLedger", () => {
  const day = (n: number) => new Date(Date.UTC(2026, 9, n));

  it("runs a balance through bills and payments, skipping cancelled ones", () => {
    const ledger = supplierLedger(
      1_000,
      [
        { createdAt: day(2), id: "b1", on: day(2), paid: 2_000, status: "DONE", total: 5_000 },
        { createdAt: day(3), id: "b2", on: day(3), paid: 0, status: "CANCELLED", total: 9_999 },
        { createdAt: day(6), id: "b3", on: day(6), paid: 0, status: "DONE", total: 1_500 },
      ],
      [{ amount: 3_000, createdAt: day(4), id: "p1", on: day(4), status: "DONE" }],
      day(1),
    );

    expect(ledger.rows.map((row) => [row.id, row.balance])).toEqual([
      ["opening", 1_000],
      ["b1", 4_000],
      ["p1", 1_000],
      ["b3", 2_500],
    ]);
    expect(ledger).toMatchObject({ billed: 6_500, due: 2_500, paid: 5_000 });
  });
});

describe("usageRows", () => {
  const usage = (partial: Partial<UsageEntry> & Pick<UsageEntry, "kind" | "lines">): UsageEntry => ({
    byCook: false,
    day: "2026-10-09",
    hostelId: MAIN,
    status: "DONE",
    toHostelId: null,
    ...partial,
  });
  const qty = (itemId: string, value: number, receivedQty: number | null = null) => ({ itemId, qty: value, receivedQty });

  it("adds up Use per day and building, and says how much the kitchen entered", () => {
    const rows = usageRows(
      [
        usage({ byCook: true, kind: "USE", lines: [qty(RICE, 8)] }),
        usage({ kind: "USE", lines: [qty(RICE, 2)] }),
        usage({ kind: "WASTE", lines: [qty(RICE, 1)] }),
        usage({ kind: "USE", lines: [qty(RICE, 5)], status: "CANCELLED" }),
        usage({ byCook: true, day: "2026-10-08", kind: "USE", lines: [qty(RICE, 7)] }),
        usage({ day: "2026-10-01", kind: "USE", lines: [qty(RICE, 99)] }),
      ],
      kinds,
      [MAIN],
      "2026-10-03",
      "2026-10-09",
    );

    expect(rows).toEqual([
      { byCook: 8, day: "2026-10-09", hostelId: MAIN, itemId: RICE, used: 10, wasted: 1 },
      { byCook: 7, day: "2026-10-08", hostelId: MAIN, itemId: RICE, used: 7, wasted: 0 },
    ]);
  });

  it("counts a daily item as used where it ended up the day it came", () => {
    const rows = usageRows(
      [
        usage({ kind: "BUY", lines: [qty(VEG, 10)] }),
        usage({ kind: "SEND", lines: [qty(VEG, 4, 3)], status: "RECEIVED", toHostelId: BRANCH }),
        usage({ kind: "BUY", lines: [qty(RICE, 50)] }),
      ],
      kinds,
      [MAIN, BRANCH],
      "2026-10-09",
      "2026-10-09",
    );

    expect(rows.map((row) => [row.hostelId, row.itemId, row.used])).toEqual([
      [BRANCH, VEG, 3],
      [MAIN, VEG, 6],
    ]);
  });
});
