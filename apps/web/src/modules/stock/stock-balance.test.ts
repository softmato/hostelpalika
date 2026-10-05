import { describe, expect, it } from "vitest";

import { type FoldEntry, foldStock } from "./stock-balance";

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
    inPeriod: true,
    receivedAt: null,
    status: partial.kind === "SEND" ? "PENDING" : "DONE",
    toHostelId: null,
    ...partial,
  };
}

const line = (itemId: string, qty: number, receivedQty: number | null = null) => ({
  itemId,
  qty,
  receivedQty,
});

describe("foldStock", () => {
  it("answers how much went where, and what a Count says was used", () => {
    const entries = [
      entry({ kind: "BUY", lines: [line(RICE, 200)] }),
      entry({ kind: "SEND", lines: [line(RICE, 60, 58)], receivedAt: new Date(10_000), status: "RECEIVED", toHostelId: BRANCH }),
      entry({ kind: "SEND", lines: [line(RICE, 20)], toHostelId: BRANCH }),
      entry({ hostelId: BRANCH, kind: "COUNT", lines: [line(RICE, 40)], createdAt: new Date(20_000) }),
      entry({ kind: "SEND", lines: [line(RICE, 5)], status: "CANCELLED", toHostelId: BRANCH }),
    ];

    const result = foldStock(entries, kinds, [MAIN, BRANCH]);
    const main = result.get(RICE)!.get(MAIN)!;
    const branch = result.get(RICE)!.get(BRANCH)!;

    expect(main).toMatchObject({ bought: 200, in: 200, left: 120, out: 80 });
    // 58 came of 60; 20 still in the jeep; the count found 18 gone.
    expect(branch).toMatchObject({ counted: 40, in: 58, left: 40, onWay: 20, short: 2, used: 18 });
  });

  it("puts goods in a branch's store only once Got it is tapped", () => {
    const send = entry({ kind: "SEND", lines: [line(RICE, 25)], toHostelId: BRANCH });
    const count = entry({ hostelId: BRANCH, kind: "COUNT", lines: [line(RICE, 10)] });
    const received = { ...send, receivedAt: new Date(count.createdAt.getTime() + 1), status: "RECEIVED" as const };

    const branch = foldStock([received, count], kinds, [BRANCH]).get(RICE)!.get(BRANCH)!;

    // Counted 10 while the sack was on the way, then it arrived.
    expect(branch).toMatchObject({ left: 35, used: 0 });
  });

  it("treats a daily item as used the day it comes", () => {
    const entries = [
      entry({ kind: "BUY", lines: [line(VEG, 10)] }),
      entry({ kind: "SEND", lines: [line(VEG, 4)], receivedAt: new Date(99_000), status: "RECEIVED", toHostelId: BRANCH }),
    ];
    const result = foldStock(entries, kinds, [MAIN, BRANCH]);

    expect(result.get(VEG)!.get(MAIN)!.used).toBe(6);
    expect(result.get(VEG)!.get(BRANCH)!.used).toBe(4);
  });

  it("leaves another month's entries out of the month's figures but not out of Left", () => {
    const entries = [entry({ inPeriod: false, kind: "BUY", lines: [line(RICE, 50)] })];
    const main = foldStock(entries, kinds, [MAIN]).get(RICE)!.get(MAIN)!;

    expect(main).toMatchObject({ bought: 0, left: 50 });
  });

  it("does not show a building it was not asked about", () => {
    const entries = [entry({ kind: "SEND", lines: [line(RICE, 5)], toHostelId: BRANCH })];

    expect(foldStock(entries, kinds, [BRANCH]).get(RICE)!.has(MAIN)).toBe(false);
  });
});
