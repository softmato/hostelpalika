/**
 * Receipt and statement PDFs — Block 2 item 2.6, current §7.12.
 *
 * Rendering has one failure mode that matters and it is not visual: standard PDF
 * fonts are WinAnsi-encoded, and this product is full of Devanagari names. An
 * unencodable character makes `pdf-lib` throw *mid-render*, which would turn
 * "download my statement" into a 500 for exactly the residents most likely to
 * have one.
 */
import { describe, expect, it } from "vitest";

import { PDFDocument } from "pdf-lib";

import {
  systemDocumentKind,
  systemDocumentKindFromText,
} from "@/modules/finance/evidence";
import {
  receiptVerifyUrl,
  renderReceiptPdf,
  renderStatementPdf,
} from "@/modules/finance/receipt-pdf";

/** The receipt's own text layer, which is what a screenshot of it would show. */
async function textOf(bytes: Uint8Array): Promise<string> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const { text } = await extractText(await getDocumentProxy(new Uint8Array(bytes)), {
    mergePages: true,
  });

  return Array.isArray(text) ? text.join("\n") : text;
}

const header = (bytes: Uint8Array) =>
  String.fromCharCode(...bytes.slice(0, 5));

describe("renderReceiptPdf", () => {
  it("produces a PDF", async () => {
    const bytes = await renderReceiptPdf({
      amount: 12000,
      hostelName: "Rupa Hostel",
      invoicePeriod: "2026-08",
      issuedAt: new Date("2026-08-07T00:00:00.000Z"),
      receiptNumber: "RCP-RUP-2026-08-00001",
      referenceCode: "RUP-4821-K",
      residentName: "Sita Sharma",
    });

    expect(header(bytes)).toBe("%PDF-");
    expect(bytes.length).toBeGreaterThan(500);
  });

  it("renders a Devanagari name instead of throwing", async () => {
    const bytes = await renderReceiptPdf({
      amount: 12000,
      hostelName: "रूपा होस्टेल",
      issuedAt: new Date("2026-08-07T00:00:00.000Z"),
      receiptNumber: "RCP-RUP-2026-08-00001",
      residentName: "सीता शर्मा",
    });

    expect(header(bytes)).toBe("%PDF-");
  });

  it("renders a voided receipt rather than refusing", async () => {
    // A resident holding a voided receipt is exactly who needs to be told it no
    // longer stands.
    const bytes = await renderReceiptPdf({
      amount: 12000,
      hostelName: "Rupa Hostel",
      issuedAt: new Date("2026-08-07T00:00:00.000Z"),
      receiptNumber: "RCP-RUP-2026-08-00001",
      residentName: "Sita Sharma",
      voidReason: "wrong amount",
      voidedAt: new Date("2026-08-08T00:00:00.000Z"),
    });

    expect(header(bytes)).toBe("%PDF-");
  });
});

describe("renderStatementPdf", () => {
  it("produces a PDF for an empty history", async () => {
    // A resident who has never been billed still gets a document, because the
    // absence is itself the answer they were asked to produce.
    const bytes = await renderStatementPdf({
      generatedAt: new Date("2026-08-07T00:00:00.000Z"),
      hostelName: "Rupa Hostel",
      residentName: "Sita Sharma",
      rows: [],
    });

    expect(header(bytes)).toBe("%PDF-");
  });

  it("does not run off the page for a long stay", async () => {
    const bytes = await renderStatementPdf({
      generatedAt: new Date("2026-08-07T00:00:00.000Z"),
      hostelName: "Rupa Hostel",
      residentName: "Sita Sharma",
      rows: Array.from({ length: 60 }, (_, index) => ({
        dueAmount: 12000,
        paidAmount: 12000,
        period: `20${20 + Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`,
        status: "PAID",
      })),
    });

    expect(header(bytes)).toBe("%PDF-");
  });
});

describe("the system-document stamp", () => {
  /**
   * The whole detection scheme rests on one assumption: that pdf-lib writes the
   * metadata we set as a *literal* string in the trailer rather than inside a
   * compressed object stream. If that ever stops being true the marker silently
   * disappears from the bytes, the scan finds nothing, and a resident can submit
   * our own receipt as proof again — with no test failing anywhere else.
   */
  it("survives into the saved bytes of a receipt", async () => {
    const bytes = await renderReceiptPdf({
      amount: 12000,
      hostelName: "Education Light Hostel",
      issuedAt: new Date("2026-08-10T00:00:00.000Z"),
      receiptNumber: "RCP-EDU-2026-08-00001",
      residentName: "Aadarsh Yadav",
    });

    await expect(systemDocumentKind(bytes)).resolves.toBe("RECEIPT");
  });

  it("survives into the saved bytes of a statement, and is told apart", async () => {
    const bytes = await renderStatementPdf({
      generatedAt: new Date("2026-08-10T00:00:00.000Z"),
      hostelName: "Education Light Hostel",
      residentName: "Aadarsh Yadav",
      rows: [
        {
          dueAmount: 12000,
          paidAmount: 12000,
          period: "2026-08",
          status: "PAID",
        },
      ],
    });

    await expect(systemDocumentKind(bytes)).resolves.toBe("STATEMENT");
  });

  it("does not match a PDF we did not produce", async () => {
    const foreign = await PDFDocument.create();

    foreign.addPage([595, 842]);
    foreign.setSubject("Everest Bank payment receipt");

    await expect(systemDocumentKind(await foreign.save())).resolves.toBeNull();
  });

  it("returns null for anything that is not a readable PDF", async () => {
    // A corrupt or non-PDF upload is `verifyUploadedObject`'s problem. This must
    // answer "not ours" rather than throw inside the claim path.
    await expect(systemDocumentKind(Buffer.from("not a pdf at all"))).resolves.toBeNull();
    await expect(
      systemDocumentKind(Buffer.from("%PDF-1.7 truncated garbage")),
    ).resolves.toBeNull();
    await expect(systemDocumentKind(new Uint8Array())).resolves.toBeNull();
    await expect(systemDocumentKind(null)).resolves.toBeNull();
  });

  it("still detects a receipt the resident re-exported through another tool", async () => {
    // Re-saving is the obvious way to try to launder the marker off. Metadata
    // survives a round trip, which is why three fields carry it.
    const original = await renderReceiptPdf({
      amount: 12000,
      hostelName: "Education Light Hostel",
      issuedAt: new Date("2026-08-10T00:00:00.000Z"),
      receiptNumber: "RCP-EDU-2026-08-00001",
      residentName: "Aadarsh Yadav",
    });
    const resaved = await (await PDFDocument.load(original)).save();

    await expect(systemDocumentKind(resaved)).resolves.toBe("RECEIPT");
  });
});

/**
 * The printed marker, which is the half a screenshot cannot strip.
 *
 * This is the regression test for the reported bug: a receipt issued for a 60
 * -rupee part payment was submitted back as proof against the 1,230 still
 * outstanding, and the reference check confirmed it — because the invoice's code
 * is the same code all month and we print it on the receipt ourselves. The
 * metadata stamp does not help there, since what gets uploaded is a screenshot.
 */
describe("the printed system-document marker", () => {
  it("is readable off a rendered receipt's own text", async () => {
    const bytes = await renderReceiptPdf({
      amount: 60,
      coversFrom: new Date(Date.UTC(2026, 6, 1)),
      coversTo: new Date(Date.UTC(2026, 6, 31)),
      hostelName: "Education Light Hostel",
      invoicePeriod: "2026-07",
      issuedAt: new Date("2026-07-14T00:00:00.000Z"),
      receiptNumber: "RCP-EDU-2026-07-00004",
      referenceCode: "EDU-0002-P",
      residentName: "Aadarsh Yadav",
    });

    expect(systemDocumentKindFromText(await textOf(bytes))).toBe("RECEIPT");
  });

  it("matches on the receipt number alone, as OCR would read it", () => {
    // A recogniser that loses the footer still sees the number, and vice versa.
    expect(systemDocumentKindFromText("Receipt number RCP-EDU-2026-07-00004")).toBe(
      "RECEIPT",
    );
    expect(
      systemDocumentKindFromText("Computer generated receipt. Not a proof of payment upload."),
    ).toBe("RECEIPT");
  });

  it("does not match a real wallet or bank receipt", () => {
    // The false-positive direction is the one that costs a resident their rent
    // submission, so the markers have to be things no provider prints.
    expect(
      systemDocumentKindFromText(
        "eSewa PAYMENT RECEIPT\nTransaction Code: 8823119471\nAmount : 1290.00\nStatus: Complete\n2026-07-14",
      ),
    ).toBeNull();
    expect(
      systemDocumentKindFromText(
        "Nabil Bank\nFund Transfer Successful\nRef No: RCP123\nNPR 1,290.00\nRemarks: EDU-0002-P",
      ),
    ).toBeNull();
    expect(systemDocumentKindFromText("")).toBeNull();
    expect(systemDocumentKindFromText(null)).toBeNull();
  });
});

describe("the receipt's coverage window and certification", () => {
  it("states the dates the payment covers, not just the month", async () => {
    const bytes = await renderReceiptPdf({
      amount: 1290,
      coversFrom: new Date(Date.UTC(2026, 7, 1)),
      coversTo: new Date(Date.UTC(2026, 7, 31)),
      hostelName: "Rupa Hostel",
      invoicePeriod: "2026-08",
      issuedAt: new Date("2026-08-07T00:00:00.000Z"),
      receiptNumber: "RCP-RUP-2026-08-00001",
      residentName: "Sita Sharma",
    });
    const text = await textOf(bytes);

    expect(text).toContain("Covers");
    expect(text).toContain("01 Aug 2026 to 31 Aug 2026");
  });

  it("omits the coverage lines when the invoice buys no period", async () => {
    // An admission fee or a deposit covers no span. Inventing one would be a
    // worse answer on a document a landlord may read than saying nothing.
    const text = await textOf(
      await renderReceiptPdf({
        amount: 5000,
        hostelName: "Rupa Hostel",
        issuedAt: new Date("2026-08-07T00:00:00.000Z"),
        receiptNumber: "RCP-RUP-2026-08-00002",
        residentName: "Sita Sharma",
      }),
    );

    expect(text).not.toContain("Covers");
  });

  it("does not certify a voided receipt", async () => {
    // A stamp on a withdrawn document is the most misleading thing this
    // renderer could produce — and the resident holding it is exactly who
    // would be misled.
    const text = await textOf(
      await renderReceiptPdf({
        amount: 1290,
        hostelName: "Rupa Hostel",
        issuedAt: new Date("2026-08-07T00:00:00.000Z"),
        receiptNumber: "RCP-RUP-2026-08-00003",
        residentName: "Sita Sharma",
        voidReason: "Issued against the wrong invoice",
        voidedAt: new Date("2026-08-09T00:00:00.000Z"),
      }),
    );

    expect(text).toContain("VOID");
    expect(text).not.toContain("CERTIFIED");
  });
});

/**
 * The Resident Offer Program stamp: reference quoted and verified → certified,
 * with a code anyone can check. Anything else is receipted, not certified.
 */
describe("Resident Offer Program certification", () => {
  const base = {
    amount: 12000,
    hostelName: "Rupa Hostel",
    issuedAt: new Date("2026-08-07T00:00:00.000Z"),
    receiptNumber: "RCP-RUP-2026-08-00007",
    residentName: "Sita Sharma",
  };

  it("certifies, prints the code, and says where to check it", async () => {
    const text = await textOf(
      await renderReceiptPdf({ ...base, certificationCode: "HP-7K2M-9QXD-4TRA" }),
    );

    expect(text).toContain("CERTIFIED");
    expect(text).toContain("RESIDENT OFFER PROGRAM");
    expect(text).toContain("HP-7K2M-9QXD-4TRA");
    expect(text).toContain("hostelpalika.com/verify-receipt");
    expect(text).toContain("Issued on behalf of Rupa Hostel");
    expect(text).not.toContain("PROVISIONAL");
  });

  it("receipts a payment with no reference, without the programme stamp", async () => {
    const text = await textOf(await renderReceiptPdf(base));

    expect(text).toContain("PAID");
    expect(text).not.toContain("CERTIFIED");
    expect(text).not.toContain("RESIDENT OFFER PROGRAM");
  });

  it("drops the code from a voided receipt", async () => {
    const text = await textOf(
      await renderReceiptPdf({
        ...base,
        certificationCode: "HP-7K2M-9QXD-4TRA",
        voidReason: "Issued against the wrong invoice",
        voidedAt: new Date("2026-08-09T00:00:00.000Z"),
      }),
    );

    expect(text).toContain("VOID");
    expect(text).not.toContain("HP-7K2M-9QXD-4TRA");
  });

  it("points the QR at the public verify page", () => {
    expect(receiptVerifyUrl("HP-7K2M-9QXD-4TRA")).toBe(
      "https://hostelpalika.com/verify-receipt?code=HP-7K2M-9QXD-4TRA",
    );
  });
});
