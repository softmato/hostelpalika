import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";

import type { HostelLedger } from "@/modules/finance/invoice-list.service";
import { buildStatement, renderStatementPdf, statementPdfFilename } from "@/modules/reports/statement-pdf";

function ledger(): HostelLedger {
  return {
    entries: [
      // 2083-04 (Shrawan) — before the range: carried in the opening balance.
      { dueAmount: 5000, id: "a", month: "2083-04", paidAmount: 5000, paidDate: new Date("2026-08-01T05:00:00Z"), residentId: "r1", residentName: "Kartik Adhikari", status: "PAID" },
      // 2083-05 (Bhadra)
      { dueAmount: 6000, id: "b", month: "2083-05", paidAmount: 6000, paidDate: new Date("2026-08-24T05:00:00Z"), residentId: "r2", residentName: "Sita Rai", status: "PAID" },
      // Raised, never paid — not a movement.
      { dueAmount: 6000, id: "c", month: "2083-05", paidAmount: 0, residentId: "r3", residentName: "Ram", status: "UNPAID" },
    ] as HostelLedger["entries"],
    expenses: [
      { amount: 1200, category: "GROCERIES", categoryLabel: "Groceries", createdAt: null, customCategoryId: null, id: "e1", mine: true, paidBy: "CASH", payer: "HOSTEL", photoAssetId: null, recordedBy: { id: "o", name: "Owner", role: "HOSTEL_ADMIN" }, salaryFor: null, spentOn: "2026-08-25", status: "RECORDED", voidReason: null, what: "Vegetables" },
      { amount: 999, category: "OTHER", categoryLabel: "Other", createdAt: null, customCategoryId: null, id: "e2", mine: true, paidBy: "CASH", payer: "HOSTEL", photoAssetId: null, recordedBy: { id: "o", name: "Owner", role: "HOSTEL_ADMIN" }, salaryFor: null, spentOn: "2026-08-26", status: "VOID", voidReason: "typo", what: "" },
    ] as HostelLedger["expenses"],
    truncated: false,
  };
}

describe("buildStatement", () => {
  it("lists the range's credits and debits oldest first, with the balance brought forward", () => {
    const statement = buildStatement(ledger(), "2083-05", "2083-05");

    expect(statement.opening).toBe(5000);
    expect(statement.lines.map((line) => [line.kind, line.amount])).toEqual([
      ["credit", 6000],
      ["debit", 1200],
    ]);
    expect(statement.totals).toEqual({ credit: 6000, debit: 1200 });
    expect(statement.closing).toBe(9800);
    expect(statement.months).toEqual([{ credit: 6000, debit: 1200, month: "2083-05" }]);
  });

  it("prints cash handed to a warden as a transfer and tracks what they hold", () => {
    const base = ledger();
    const owner = { id: "o", name: "Owner", role: "HOSTEL_ADMIN" };
    const hari = { id: "hari", name: "Hari", role: "WARDEN" };
    const row = base.expenses![0]!;
    const withCash: HostelLedger = {
      ...base,
      expenses: [
        ...base.expenses!,
        { ...row, amount: 3000, cashStatus: "ACCEPTED", cashTo: { name: "Hari", userId: "hari" }, category: "STAFF_CASH", id: "give", recordedBy: owner, spentOn: "2026-08-25" },
        { ...row, amount: 500, cashStatus: "PENDING", cashTo: { name: "Hari", userId: "hari" }, category: "STAFF_CASH", id: "wait", recordedBy: owner, spentOn: "2026-08-26" },
        { ...row, amount: 900, cashStatus: "DECLINED", cashTo: { name: "Hari", userId: "hari" }, category: "STAFF_CASH", id: "lost", recordedBy: owner, spentOn: "2026-08-26" },
        { ...row, amount: 700, id: "rice", payer: "STAFF", recordedBy: hari, spentOn: "2026-08-27" },
      ] as HostelLedger["expenses"],
    };
    const statement = buildStatement(withCash, "2083-05", "2083-05");

    expect(statement.lines.filter((line) => line.kind === "transfer")).toHaveLength(2);
    expect(statement.totals).toEqual({ credit: 6000, debit: 1900 });
    expect(statement.closing).toBe(5000 + 6000 - 1900);
    expect(statement.lines.find((line) => line.amount === 700)?.particulars).toContain("by Hari");
    expect(statement.staff).toEqual([{ given: 3000, left: 2300, name: "Hari", pending: 500, spent: 700 }]);
  });

  it("covers a run of months and accepts the ends in either order", () => {
    const statement = buildStatement(ledger(), "2083-05", "2083-04");

    expect(statement.from).toBe("2083-04");
    expect(statement.opening).toBe(0);
    expect(statement.months.map((month) => month.month)).toEqual(["2083-04", "2083-05"]);
  });
});

describe("renderStatementPdf", () => {
  it("renders a PDF that opens, paginating a long ledger", async () => {
    const long = ledger();

    long.entries = Array.from({ length: 120 }, (_, index) => ({
      ...long.entries[1],
      id: `x${index}`,
      paidDate: new Date(Date.UTC(2026, 7, 18, 5, index)),
    }));

    const bytes = await renderStatementPdf(buildStatement(long, "2083-05", "2083-05"), "Green View Hostel");
    const pdf = await PDFDocument.load(bytes);

    expect(pdf.getPageCount()).toBeGreaterThan(1);
    expect(pdf.getTitle()).toContain("Green View Hostel");
  });

  it("names the file by its range", () => {
    expect(statementPdfFilename("2083-01", "2083-06")).toBe("statement-2083-01-to-2083-06.pdf");
    expect(statementPdfFilename("2083-05", "2083-05")).toBe("statement-2083-05.pdf");
  });
});
