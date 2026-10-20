import { describe, expect, it } from "vitest";

import type { ResidentInvoice } from "@/lib/finance-api";
import {
  filterInvoices,
  groupInvoicesByYear,
  invoiceLedger,
  invoiceRowCopy,
  oneOffLabel,
  outstanding,
  paymentStats,
  totalOutstanding,
} from "@/lib/invoice-ledger";

function line(
  overrides: Partial<ResidentInvoice["lines"][number]> = {},
): ResidentInvoice["lines"][number] {
  return {
    amount: 0,
    basis: "SCHEDULE",
    bedType: null,
    description: "",
    prorationBasis: null,
    ...overrides,
  };
}

function invoice(overrides: Partial<ResidentInvoice> = {}): ResidentInvoice {
  return {
    dueAmount: 8500,
    id: "inv-1",
    // The ledger is built from totals and receipts, never from the breakdown:
    // a paid invoice's lines still sum to the full charge, so adding them in
    // would double the opening balance.
    lines: [],
    month: "2083-05",
    paidAmount: 0,
    receipts: [],
    referenceCode: "HH-AUG-01",
    status: "UNPAID",
    ...overrides,
  };
}

describe("invoiceLedger", () => {
  it("opens with the charge and closes on what is owed", () => {
    const lines = invoiceLedger(invoice());

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ amount: 8500, balance: 8500, kind: "charge" });
  });

  it("walks receipts oldest-first, even though the server sends them newest-first", () => {
    const lines = invoiceLedger(
      invoice({
        paidAmount: 8500,
        receipts: [
          { amount: 6500, certificationCode: null, id: "r2", issuedAt: "2026-08-20T04:00:00.000Z", number: "R-02" },
          { amount: 2000, certificationCode: null, id: "r1", issuedAt: "2026-08-05T04:00:00.000Z", number: "R-01" },
        ],
        status: "PAID",
      }),
    );

    expect(lines.map((line) => line.label)).toEqual([
      "Amount billed",
      "Receipt R-01",
      "Receipt R-02",
    ]);
    expect(lines.map((line) => line.balance)).toEqual([8500, 6500, 0]);
  });

  it("names the gap when the ledger has settled more than the receipts show", () => {
    // A payment can settle before its receipt is issued, and a receipt voided
    // with a reversed payment is excluded by the server. Absorbing the
    // difference silently would end the statement on a balance that disagrees
    // with the headline on the same screen.
    const lines = invoiceLedger(
      invoice({
        paidAmount: 8500,
        receipts: [
          { amount: 2000, certificationCode: null, id: "r1", issuedAt: "2026-08-05T04:00:00.000Z", number: "R-01" },
        ],
        status: "PAID",
      }),
    );

    expect(lines.at(-1)).toMatchObject({
      amount: -6500,
      balance: 0,
      kind: "unreceipted",
    });
  });

  it("emits no gap line for a floating-point residue", () => {
    const lines = invoiceLedger(
      invoice({
        dueAmount: 1200.3,
        paidAmount: 0.1 + 0.2,
        receipts: [{ amount: 0.3, certificationCode: null, id: "r1", issuedAt: null, number: "R-01" }],
      }),
    );

    expect(lines.map((line) => line.kind)).toEqual(["charge", "receipt"]);
  });

  it("does not invent a payment line when receipts exceed the settled total", () => {
    // Shouldn't happen, but a positive-only guard means a data oddity shows up
    // as a balance that looks wrong rather than as a fabricated credit.
    const lines = invoiceLedger(
      invoice({
        paidAmount: 1000,
        receipts: [{ amount: 3000, certificationCode: null, id: "r1", issuedAt: null, number: "R-01" }],
      }),
    );

    expect(lines.map((line) => line.kind)).toEqual(["charge", "receipt"]);
  });
});

describe("outstanding totals", () => {
  it("treats an overpaid month as zero, not as a negative", () => {
    expect(outstanding(invoice({ dueAmount: 8500, paidAmount: 9000 }))).toBe(0);
  });

  it("counts only the statuses that are still an obligation", () => {
    const total = totalOutstanding([
      invoice({ dueAmount: 8500, id: "a", paidAmount: 0, status: "OVERDUE" }),
      invoice({ dueAmount: 8500, id: "b", paidAmount: 4000, status: "PARTIAL" }),
      invoice({ dueAmount: 8500, id: "c", paidAmount: 8500, status: "PAID" }),
      invoice({ dueAmount: 8500, id: "d", paidAmount: 0, status: "VOID" }),
    ]);

    expect(total).toBe(8500 + 4500);
  });

  it("does not let an overpaid month cancel out an unpaid one", () => {
    const total = totalOutstanding([
      invoice({ dueAmount: 8500, id: "a", paidAmount: 12000, status: "PARTIAL" }),
      invoice({ dueAmount: 8500, id: "b", paidAmount: 0, status: "UNPAID" }),
    ]);

    expect(total).toBe(8500);
  });
});

describe("paymentStats", () => {
  it("points at the oldest open month, not the newest", () => {
    // The list arrives newest-first. A resident two months behind must be sent
    // to July, or it ages into a default while they settle August.
    const stats = paymentStats([
      invoice({ dueDate: "2026-08-07T00:00:00.000Z", id: "aug", month: "2026-08" }),
      invoice({ dueDate: "2026-07-07T00:00:00.000Z", id: "jul", month: "2026-07" }),
    ]);

    expect(stats.nextDue?.id).toBe("jul");
  });

  it("sorts an undated invoice last rather than first", () => {
    const stats = paymentStats([
      invoice({ dueDate: undefined, id: "undated" }),
      invoice({ dueDate: "2026-08-07T00:00:00.000Z", id: "aug" }),
    ]);

    expect(stats.nextDue?.id).toBe("aug");
  });

  it("has no next due when everything is settled", () => {
    const stats = paymentStats([
      invoice({ paidAmount: 8500, status: "PAID" }),
      invoice({ id: "inv-2", paidAmount: 8500, status: "PAID" }),
    ]);

    expect(stats.nextDue).toBeNull();
    expect(stats.settledCount).toBe(2);
  });

  it("takes the most recently paid month as the last payment", () => {
    const stats = paymentStats([
      invoice({
        id: "jun",
        paidAmount: 8500,
        paidDate: "2026-06-04T00:00:00.000Z",
        status: "PAID",
      }),
      invoice({
        id: "jul",
        paidAmount: 8500,
        paidDate: "2026-07-02T00:00:00.000Z",
        status: "PAID",
      }),
    ]);

    expect(stats.lastPaid?.id).toBe("jul");
  });

  it("ignores an unpaid month when looking for the last payment", () => {
    const stats = paymentStats([invoice({ paidAmount: 0, status: "UNPAID" })]);

    expect(stats.lastPaid).toBeNull();
  });

  it("counts overdue months separately from open ones", () => {
    const stats = paymentStats([
      invoice({ id: "a", status: "OVERDUE" }),
      invoice({ id: "b", status: "UNPAID" }),
      invoice({ id: "c", paidAmount: 8500, status: "PAID" }),
    ]);

    expect(stats.overdueCount).toBe(1);
    expect(stats.settledCount).toBe(1);
  });

  it("survives an empty ledger", () => {
    expect(paymentStats([])).toEqual({
      lastPaid: null,
      nextDue: null,
      overdueCount: 0,
      settledCount: 0,
    });
  });
});

describe("filterInvoices", () => {
  const ledger = [
    invoice({ id: "open", status: "UNPAID" }),
    invoice({ id: "proof", status: "PENDING_PROOF" }),
    invoice({ id: "settled", paidAmount: 8500, status: "PAID" }),
  ];

  it("returns everything for all", () => {
    expect(filterInvoices(ledger, "all")).toHaveLength(3);
  });

  it("counts a claim awaiting verification as still open", () => {
    // The money may have moved, but the hostel has not confirmed it — so the
    // resident still has something to watch, and hiding it under "settled"
    // is how a rejected claim goes unnoticed.
    expect(filterInvoices(ledger, "open").map((row) => row.id)).toEqual(["open", "proof"]);
  });

  it("returns only closed months for settled", () => {
    expect(filterInvoices(ledger, "settled").map((row) => row.id)).toEqual(["settled"]);
  });
});

describe("groupInvoicesByYear", () => {
  it("keeps the server's order and does not re-sort the groups", () => {
    const groups = groupInvoicesByYear([
      invoice({ id: "a", month: "2026-01" }),
      invoice({ id: "b", month: "2025-12" }),
      invoice({ id: "c", month: "2026-02" }),
    ]);

    // Three rows, two years, and `2026` first because that is where the list
    // started — not because 2026 sorts above 2025.
    expect(groups.map((group) => group.year)).toEqual(["2026", "2025"]);
    expect(groups[0].invoices.map((row) => row.id)).toEqual(["a", "c"]);
  });

  it("files a one-off invoice by its due date", () => {
    // An admission fee has `period: null`, so a month-keyed grouping would drop
    // the first invoice of every tenancy out of the list it belongs in.
    const groups = groupInvoicesByYear([
      invoice({ dueDate: "2026-03-01T00:00:00.000Z", id: "admission", month: null }),
    ]);

    expect(groups).toEqual([
      { invoices: [expect.objectContaining({ id: "admission" })], year: "2026" },
    ]);
  });

  it("puts an invoice with no date at all in its own trailing group", () => {
    const groups = groupInvoicesByYear([
      invoice({ id: "dated", month: "2026-01" }),
      invoice({ dueDate: undefined, id: "undated", month: null }),
    ]);

    expect(groups.map((group) => group.year)).toEqual(["2026", null]);
  });

  it("does not merge an undated row into a real year", () => {
    // The bucket key for `null` is deliberately not a year string; if it were
    // `""` a future `slice` returning `""` would land two unrelated rows in one
    // section.
    const groups = groupInvoicesByYear([
      invoice({ dueDate: undefined, id: "undated", month: null }),
      invoice({ id: "dated", month: "2026-01" }),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0].year).toBeNull();
  });

  /*
   * The bug the `yearOf` parameter exists for. Grouping sliced `"2026"` off the
   * period key while every row under the heading was formatted in Bikram Sambat,
   * so the Payments screen drew `2026` over a card of `2083 BS` rows.
   *
   * Relabelling would not have been enough: one Gregorian year holds two BS
   * ones, which is what the second case here pins down.
   */
  it("groups by whatever year the caller resolves, not the period key", () => {
    const groups = groupInvoicesByYear(
      [
        invoice({ id: "bhadra", month: "2026-09" }),
        invoice({ id: "aswin", month: "2026-10" }),
      ],
      () => "2083 BS",
    );

    expect(groups.map((group) => group.year)).toEqual(["2083 BS"]);
    expect(groups[0].invoices.map((row) => row.id)).toEqual(["bhadra", "aswin"]);
  });

  it("splits one Gregorian year across the two Nepali years it spans", () => {
    const groups = groupInvoicesByYear(
      [
        invoice({ id: "magh", month: "2026-02" }),
        invoice({ id: "bhadra", month: "2026-09" }),
      ],
      (row) => (row.month === "2026-02" ? "2082 BS" : "2083 BS"),
    );

    expect(groups.map((group) => group.year)).toEqual(["2082 BS", "2083 BS"]);
  });

  it("files a row its resolver could not name with the undated ones", () => {
    // `formatPeriodYearIn` answers `""` for a date outside the converter's
    // table. An empty heading is not a heading, so the row goes where the other
    // rows nobody can date go.
    const groups = groupInvoicesByYear(
      [invoice({ id: "offTable", month: "2200-01" })],
      () => "",
    );

    expect(groups.map((group) => group.year)).toEqual([null]);
  });
});

/*
 * An admission fee carries `period: null`, and it is the first invoice every
 * resident in this product ever sees. `formatPeriod(null)` is a dash, so every
 * screen that titled a row by its month titled that one `—`.
 */
describe("oneOffLabel", () => {
  it("names a monthless invoice from its own first line", () => {
    expect(
      oneOffLabel(
        invoice({
          lines: [
            {
              amount: 3000,
              basis: "SCHEDULE",
              bedType: null,
              description: "Admission fee",
              prorationBasis: null,
            },
          ],
          month: null,
        }),
      ),
    ).toBe("Admission fee");
  });

  it("falls back to a noun for migrated history, which has no lines", () => {
    expect(oneOffLabel(invoice({ lines: [], month: null }))).toBe("One-off invoice");
  });

  it("returns null when there is a month, so the caller uses it", () => {
    expect(oneOffLabel(invoice({ month: "2083-05" }))).toBeNull();
  });

  /*
   * The deposit was never invoiced before this — it sat on the rate card, was
   * quoted at the door, and appeared on nobody's ledger. It is a line on the
   * joining invoice now, and a label reading only the first line would
   * understate what one reference code settles by the size of it.
   */
  it("names every charge on a joining invoice, not just the first", () => {
    expect(
      oneOffLabel(
        invoice({
          lines: [
            line({ amount: 2000, description: "Admission fee" }),
            line({ amount: 10000, description: "Security deposit" }),
          ],
          month: null,
        }),
      ),
    ).toBe("Admission fee + Security deposit");
  });

  it("leaves a credit out, because a discount is not a thing being paid for", () => {
    expect(
      oneOffLabel(
        invoice({
          lines: [
            line({ amount: 2000, description: "Admission fee" }),
            line({
              amount: -500,
              basis: "CREDIT",
              description: "Referral discount — code ASHA5",
            }),
            line({ amount: 10000, description: "Security deposit" }),
          ],
          month: null,
        }),
      ),
    ).toBe("Admission fee + Security deposit");
  });
});

/**
 * What a list row says.
 *
 * The row used to be the month as a title over the due date as a subtitle —
 * `Bhadra` over `Due Aswin 15` — which is two month names, nothing saying which
 * is which, and neither of them saying what the row is *for*.
 */
describe("invoiceRowCopy", () => {
  const monthLabel = (period: string | null) =>
    period === "2083-05" ? "Bhadra" : String(period);
  const dateLabel = (date: string | null | undefined) =>
    date ? "Bhadra · 2083-05-19" : "—";

  const copy = (value: ResidentInvoice) => invoiceRowCopy(value, monthLabel, dateLabel);

  it("leads with the charge and explains it with the month", () => {
    expect(copy(invoice())).toMatchObject({
      proration: null,
      subtitle: "Due Bhadra",
      title: "Monthly rent",
    });
  });

  /*
   * A part month replaces the due line rather than joining it — the smaller
   * figure on the right is the one thing somebody is most likely to query — but
   * only when the basis names its own month. `Due Bhadra · Bhadra 19–31 · 13 of
   * 31 days` would say Bhadra twice to fit less in.
   */
  it("says which days a mid-month move-in is charged for", () => {
    const row = copy(
      invoice({
        lines: [
          line({
            amount: 7548,
            description: "Monthly rent — Bhadra 2083 BS",
            prorationBasis: "Bhadra 19–31 · 13 of 31 days",
          }),
        ],
      }),
    );

    expect(row).toMatchObject({
      proration: "Bhadra 19–31 · 13 of 31 days",
      subtitle: "Bhadra 19–31 · 13 of 31 days",
      title: "Monthly rent",
    });
  });

  /*
   * The basis is snapshotted at issue time, and invoices raised under the older
   * format carry `28/30 days` with no month in it. Under a group heading that
   * is a year, that row named no month at all — so the month goes in front of
   * a basis that does not already hold one.
   */
  it("puts the month in front of a legacy basis that names no month", () => {
    const row = copy(
      invoice({
        lines: [
          line({
            amount: 16800,
            description: "Monthly rent",
            prorationBasis: "28/30 days",
          }),
        ],
      }),
    );

    expect(row).toMatchObject({
      proration: "28/30 days",
      subtitle: "Bhadra · 28/30 days",
      title: "Monthly rent",
    });
  });

  it("titles a joining invoice by both its charges", () => {
    expect(
      copy(
        invoice({
          dueDate: "2026-09-04T00:00:00.000Z",
          lines: [
            line({ amount: 2000, description: "Admission fee" }),
            line({ amount: 10000, description: "Security deposit" }),
          ],
          month: null,
        }),
      ),
    ).toMatchObject({
      subtitle: "Due Bhadra · 2083-05-19",
      title: "Admission fee + Security deposit",
    });
  });

  it("says a one-off with no due date is payable now, not that it has no date", () => {
    expect(copy(invoice({ dueDate: undefined, lines: [], month: null })).subtitle).toBe(
      "Payable now",
    );
  });
});
