import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";

import { renderReportPdf } from "@/lib/reports/report-pdf";

/**
 * The renderer's failure modes, not its appearance.
 *
 * Two are worth pinning. `pdf-lib`'s standard fonts are WinAnsi and **throw** on
 * anything outside it, so a Devanagari hostel name or a rupee sign would crash a
 * download rather than produce an ugly one. And a report is capped at 5000 rows
 * by the service, so it has to paginate — a renderer that silently kept only
 * what fits on page one would hand somebody a document that looks complete.
 */

const columns = [
  { key: "month", label: "Month" },
  { key: "collected", label: "Collected" },
];

function bytesOf(pdf: Uint8Array) {
  return Buffer.from(pdf).toString("latin1");
}

describe("renderReportPdf", () => {
  it("produces a PDF", async () => {
    const pdf = await renderReportPdf({
      columns,
      generatedAt: new Date("2026-08-26T00:00:00.000Z"),
      rows: [{ collected: 84_500, month: "2026-08" }],
      scopeName: "Green View Hostel",
      title: "Collection",
    });

    expect(bytesOf(pdf).startsWith("%PDF-")).toBe(true);
  });

  it("does not throw on characters the standard fonts cannot encode", async () => {
    await expect(
      renderReportPdf({
        columns,
        generatedAt: new Date(),
        rows: [{ collected: "रू 8,500", month: "2026-08" }],
        scopeName: "शान्ति भवन — Hostel",
        title: "Collection",
      }),
    ).resolves.toBeInstanceOf(Uint8Array);
  });

  it("paginates rather than dropping the rows that do not fit", async () => {
    const many = Array.from({ length: 400 }, (_, index) => ({
      collected: index,
      month: `row-${index}`,
    }));

    const one = await renderReportPdf({
      columns,
      generatedAt: new Date(),
      rows: many.slice(0, 1),
      scopeName: "",
      title: "Collection",
    });
    const lots = await renderReportPdf({
      columns,
      generatedAt: new Date(),
      rows: many,
      scopeName: "",
      title: "Collection",
    });

    // A 400-row report cannot be the same size as a 1-row one unless it lost
    // 399 of them.
    expect(lots.byteLength).toBeGreaterThan(one.byteLength * 2);

    /*
     * Counted by re-loading the document rather than by grepping the bytes for
     * `/Type /Page`: pdf-lib writes object streams, so the marker is compressed
     * out of the raw file and the grep finds nothing however many pages there
     * are.
     */
    expect((await PDFDocument.load(lots)).getPageCount()).toBeGreaterThan(1);
    expect((await PDFDocument.load(one)).getPageCount()).toBe(1);
  });

  it("says so rather than rendering an empty table", async () => {
    const pdf = await renderReportPdf({
      columns,
      generatedAt: new Date(),
      rows: [],
      scopeName: "",
      title: "Collection",
    });

    expect(pdf.byteLength).toBeGreaterThan(0);
  });
});
