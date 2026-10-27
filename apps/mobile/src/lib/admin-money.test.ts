import { describe, expect, it } from "vitest";

import type { AdminInvoiceRow } from "@/lib/admin-api";
import {
  amountOwed,
  billRows,
  invoiceSegment,
  isFirstMonth,
  isProRated,
  notBilledReason,
  outstandingRows,
  projectedAmount,
  searchInvoiceRows,
} from "@/lib/admin-money";

function row(
  fullName: string,
  displayStatus: string,
  payment: { dueAmount: number; paidAmount: number } | null,
  resident: {
    moveInDate?: string;
    phone?: string;
    roomNumber?: string;
    roomType?: string;
  } = {},
): AdminInvoiceRow {
  return {
    displayStatus,
    payment: payment
      ? {
          dueAmount: payment.dueAmount,
          id: `invoice-${fullName}`,
          month: "2026-08",
          paidAmount: payment.paidAmount,
          status: displayStatus,
        }
      : null,
    resident: {
      fullName,
      id: `resident-${fullName}`,
      moveInDate: "2026-01-01T00:00:00.000Z",
      ...resident,
    },
  };
}

describe("the projection on an unbilled row", () => {
  function unbilled(notBilled: AdminInvoiceRow["notBilled"]): AdminInvoiceRow {
    return { ...row("Bimal", "NOT_BILLED", null), notBilled };
  }

  it("is what the month would cost", () => {
    expect(projectedAmount(unbilled({ amount: 5806, reason: "NOT_YET_RUN" }))).toBe(5806);
  });

  it("is nothing when the server could not price them", () => {
    // `null` is not zero. Nobody knows what this costs, and "would be NPR 0"
    // claims they owe nothing, which is a different and false statement.
    expect(
      projectedAmount(unbilled({ amount: null, reason: "FEE_SCHEDULE_MISSING" })),
    ).toBeNull();
    expect(projectedAmount(unbilled({ amount: 0, reason: "ALREADY_MOVED_OUT" }))).toBeNull();
  });

  it("is nothing on an API that does not send the field", () => {
    // A debug build talks to the deployed origin, so this build's fields can
    // simply be absent. The row then renders as it always did.
    expect(projectedAmount(row("Bimal", "NOT_BILLED", null))).toBeNull();
  });

  it("stays out of what is owed", () => {
    // The outstanding total is money somebody has been invoiced for. A
    // projection in it would inflate every figure on the screen.
    expect(amountOwed(unbilled({ amount: 5806, reason: "NOT_YET_RUN" }))).toBe(0);
  });

  it("says why in words, and says nothing for a code it does not know", () => {
    expect(notBilledReason(unbilled({ amount: 5806, reason: "NOT_YET_RUN" }))).toMatch(
      /billing run/,
    );
    expect(
      notBilledReason(unbilled({ amount: null, reason: "BED_TYPE_NOT_PRICED" })),
    ).toMatch(/room type/);
    expect(notBilledReason(unbilled({ amount: null, reason: "SOMETHING_NEW" }))).toBeNull();
    expect(notBilledReason(row("Bimal", "NOT_BILLED", null))).toBeNull();
  });
});

describe("amountOwed", () => {
  it("is the unpaid remainder, not the invoice total", () => {
    expect(amountOwed(row("Asha", "PARTIAL", { dueAmount: 8000, paidAmount: 3000 }))).toBe(
      5000,
    );
  });

  it("is zero for a resident nobody billed", () => {
    // NOT_BILLED needs attention, but nothing is *owed* — there is no invoice.
    expect(amountOwed(row("Bimal", "NOT_BILLED", null))).toBe(0);
  });

  it("never goes negative on an overpayment", () => {
    // Two months settled in one transfer. A negative owes-column would render
    // as a debt with a minus sign, which reads as an error rather than credit.
    expect(amountOwed(row("Chitra", "PAID", { dueAmount: 8000, paidAmount: 16000 }))).toBe(
      0,
    );
  });
});

describe("outstandingRows", () => {
  it("drops settled rows and keeps unbilled ones", () => {
    const rows = [
      row("Asha", "PAID", { dueAmount: 8000, paidAmount: 8000 }),
      row("Bimal", "NOT_BILLED", null),
      row("Chitra", "OVERDUE", { dueAmount: 8000, paidAmount: 0 }),
    ];

    // A resident nobody billed is the case the obvious "has an unpaid invoice"
    // filter hides, and it is the one with nothing chasing it.
    expect(outstandingRows(rows).map((entry) => entry.resident.fullName)).toEqual([
      "Chitra",
      "Bimal",
    ]);
  });

  it("puts the late ones first even when they owe less", () => {
    // The reason the Overdue segment could be retired. Sorting on the amount
    // alone buried a resident three weeks late under everyone merely unpaid for
    // a larger sum and not yet due — one is a phone call today, the other is a
    // reminder next week.
    const rows = [
      row("Asha", "UNPAID", { dueAmount: 12000, paidAmount: 0 }),
      row("Bimal", "OVERDUE", { dueAmount: 4000, paidAmount: 0 }),
    ];

    expect(outstandingRows(rows).map((entry) => entry.resident.fullName)).toEqual([
      "Bimal",
      "Asha",
    ]);
  });

  it("puts the biggest hole in the month first within a block", () => {
    const rows = [
      row("Asha", "PARTIAL", { dueAmount: 8000, paidAmount: 7000 }),
      row("Bimal", "UNPAID", { dueAmount: 12000, paidAmount: 0 }),
    ];

    expect(outstandingRows(rows)[0]?.resident.fullName).toBe("Bimal");
  });

  it("breaks ties on the name so the list does not reshuffle on refresh", () => {
    // Several residents owing exactly one month's rent is the normal case, and
    // an unstable sort moves the row somebody is reaching for under their thumb.
    const rows = [
      row("Chitra", "UNPAID", { dueAmount: 8000, paidAmount: 0 }),
      row("Asha", "UNPAID", { dueAmount: 8000, paidAmount: 0 }),
      row("Bimal", "UNPAID", { dueAmount: 8000, paidAmount: 0 }),
    ];

    expect(outstandingRows(rows).map((entry) => entry.resident.fullName)).toEqual([
      "Asha",
      "Bimal",
      "Chitra",
    ]);
  });

  it("does not mutate the array it was given", () => {
    // `money.data.invoices.rows` is the fetched payload; sorting it in place
    // would reorder the source behind React's back.
    const rows = [
      row("Chitra", "UNPAID", { dueAmount: 4000, paidAmount: 0 }),
      row("Asha", "UNPAID", { dueAmount: 9000, paidAmount: 0 }),
    ];

    outstandingRows(rows);

    expect(rows.map((entry) => entry.resident.fullName)).toEqual(["Chitra", "Asha"]);
  });
});

describe("invoiceSegment", () => {
  const rows = [
    row("Asha", "OVERDUE", { dueAmount: 9000, paidAmount: 0 }),
    row("Bimal", "UNPAID", { dueAmount: 8000, paidAmount: 0 }),
    row("Chitra", "NOT_BILLED", null),
    row("Deepa", "PAID", { dueAmount: 8000, paidAmount: 8000 }),
    row("Elina", "PARTIAL", { dueAmount: 8000, paidAmount: 3000 }),
  ];

  it("defaults to everyone who owes, late first then most owed", () => {
    expect(invoiceSegment(rows, "owing").map((entry) => entry.resident.fullName)).toEqual([
      "Asha",
      "Bimal",
      "Elina",
      "Chitra",
    ]);
  });

  it("shows the settled by name, since there is no amount to rank them by", () => {
    expect(invoiceSegment(rows, "settled").map((entry) => entry.resident.fullName)).toEqual([
      "Deepa",
    ]);
  });

  it("partitions the roster — every row is in exactly one segment", () => {
    // The property the four-segment control could not hold, and the reason it
    // is two now: `owing` used to contain `overdue` and `unbilled`, so the
    // counts on the control could not be added up.
    const owing = invoiceSegment(rows, "owing");
    const settled = invoiceSegment(rows, "settled");

    expect(owing.length + settled.length).toBe(rows.length);
    expect(owing.some((entry) => settled.includes(entry))).toBe(false);
  });

  it("never puts a settled row in the segment that owes", () => {
    // The whole tab is about money that has not arrived. A PAID row leaking
    // into `owing` would be a person somebody calls to chase a settled bill.
    expect(
      invoiceSegment(rows, "owing").some((entry) => entry.displayStatus === "PAID"),
    ).toBe(false);
  });

  it("does not mutate the array it was given", () => {
    const source = [...rows];

    invoiceSegment(source, "settled");

    expect(source.map((entry) => entry.resident.fullName)).toEqual(
      rows.map((entry) => entry.resident.fullName),
    );
  });
});

describe("searchInvoiceRows", () => {
  const rows = [
    row(
      "Asha Karki",
      "UNPAID",
      { dueAmount: 8000, paidAmount: 0 },
      { phone: "9801234567", roomNumber: "101", roomType: "DOUBLE_SHARING" },
    ),
    row(
      "Bimal Rai",
      "OVERDUE",
      { dueAmount: 9000, paidAmount: 0 },
      { phone: "9847654321", roomNumber: "204", roomType: "SINGLE" },
    ),
  ];

  it("returns everything for an empty or whitespace query", () => {
    // The field starts empty and must not start by hiding the list.
    expect(searchInvoiceRows(rows, "")).toHaveLength(2);
    expect(searchInvoiceRows(rows, "   ")).toHaveLength(2);
  });

  it("matches a name regardless of case", () => {
    expect(searchInvoiceRows(rows, "bimal").map((entry) => entry.resident.fullName)).toEqual([
      "Bimal Rai",
    ]);
  });

  it("matches a room number, which is how an admin at the desk knows somebody", () => {
    expect(searchInvoiceRows(rows, "101").map((entry) => entry.resident.fullName)).toEqual([
      "Asha Karki",
    ]);
  });

  it("matches a phone number", () => {
    expect(searchInvoiceRows(rows, "98476").map((entry) => entry.resident.fullName)).toEqual([
      "Bimal Rai",
    ]);
  });

  it("matches a name and a number typed together", () => {
    // The fields are joined before matching, so the needle can straddle two of
    // them the way somebody actually types a half-remembered row.
    expect(
      searchInvoiceRows(rows, "karki 9801").map((entry) => entry.resident.fullName),
    ).toEqual(["Asha Karki"]);
  });

  it("does not mutate the array it was given", () => {
    const source = [...rows];

    searchInvoiceRows(source, "asha");

    expect(source).toHaveLength(2);
  });
});

describe("the first-month note", () => {
  const moved = (moveInDate: string) =>
    row("Asha", "UNPAID", { dueAmount: 4200, paidAmount: 0 }, { moveInDate });

  it("marks the month a resident moved in, and no other", () => {
    // The point of the note: 4,200 next to everyone else's 8,500 is arithmetic,
    // not a billing fault, and an owner with no way to tell will go looking.
    expect(isFirstMonth(moved("2026-08-17T00:00:00.000Z"), "2026-08")).toBe(true);
    expect(isFirstMonth(moved("2026-08-17T00:00:00.000Z"), "2026-09")).toBe(false);
    expect(isFirstMonth(moved("2026-07-31T00:00:00.000Z"), "2026-08")).toBe(false);
  });

  it("does not claim a pro-rated amount for somebody admitted on the 1st", () => {
    // Their first month is billed in full. Explaining a discount they did not
    // get is worse than saying nothing — the figure is right and the note would
    // say it is not.
    const first = moved("2026-08-01T00:00:00.000Z");

    expect(isFirstMonth(first, "2026-08")).toBe(true);
    expect(isProRated(first, "2026-08")).toBe(false);
    expect(isProRated(moved("2026-08-17T00:00:00.000Z"), "2026-08")).toBe(true);
  });

  it("says nothing at all when the move-in date is missing", () => {
    // An unknown start is a data gap, not a first month. Guessing either way
    // puts a claim about money on a row the server could not support.
    expect(isFirstMonth(moved(""), "2026-08")).toBe(false);
    expect(isProRated(moved(""), "2026-08")).toBe(false);
  });
});

describe("billRows", () => {
  it("orders rent, discount, fine, khata and sums back to the bill", () => {
    const lines = [
      { amount: 8_000, basis: "SCHEDULE", description: "Monthly rent — Kartik 2083" },
      { amount: 300, basis: "KHATA", description: "Khata — 3 noodles" },
      { amount: 150, basis: "FINE", description: "Late fine — 3 days" },
      { amount: -4_000, basis: "CREDIT", description: "Dashain · 50% off — Kartik 2083" },
    ];
    const rows = billRows(lines);

    expect(rows.map((r) => r.label)).toEqual([
      "Month rent",
      "Dashain · 50% off — Kartik 2083",
      "Late fine",
      "Khata",
    ]);
    expect(rows[2]?.detail).toBe("3 days");
    expect(rows.reduce((sum, r) => sum + r.amount, 0)).toBe(4_450);
  });

  it("has no discount row when nothing was taken off", () => {
    expect(billRows([{ amount: 8_000, basis: "SCHEDULE", description: "Monthly rent" }]).map((r) => r.kind)).toEqual(["rent"]);
    expect(billRows(undefined)).toEqual([]);
  });
});
