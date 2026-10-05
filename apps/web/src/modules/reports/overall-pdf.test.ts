import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";

import { overallTable, renderOverallPdf } from "@/modules/reports/overall-pdf";

const branch = (name: string, isBranch: boolean, moneyIn: number, moneyOut: number, staffCash: number) => ({
  closing: moneyIn - moneyOut,
  collected: moneyIn,
  due: 500,
  isBranch,
  moneyIn,
  moneyOut,
  name,
  residents: 10,
  staffCash,
});

describe("overallTable", () => {
  it("puts each branch on its own row and sums every column underneath", () => {
    const table = overallTable("statement", [branch("Green View", false, 10000, 4000, 1500), branch("Lakeside", true, 6000, 1000, -200)]);

    expect(table.headers).toEqual(["Branch", "Money in", "Money out", "Net", "Staff cash", "Balance"]);
    expect(table.rows[0]).toEqual(["Green View (main)", "Rs 10,000", "Rs 4,000", "Rs 6,000", "Rs 1,500", "Rs 6,000"]);
    expect(table.rows[1]?.[4]).toBe("-Rs 200");
    expect(table.total).toEqual(["All 2 branches", "Rs 16,000", "Rs 5,000", "Rs 11,000", "Rs 1,300", "Rs 11,000"]);
  });
});

describe("renderOverallPdf", () => {
  it("puts the cover first and every branch's pages after it", async () => {
    const part = await PDFDocument.create();

    part.addPage();
    part.addPage();

    const bytes = await renderOverallPdf({
      kind: "report",
      parts: [await part.save(), await part.save()],
      period: "2083-06",
      table: overallTable("report", [branch("Green View", false, 1, 1, 0)]),
    });

    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(5);
  });
});
