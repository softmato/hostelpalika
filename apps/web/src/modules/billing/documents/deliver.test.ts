import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cached: vi.fn(),
  dropCached: vi.fn(),
  download: vi.fn(),
  invoice: vi.fn(),
  render: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ connectToDatabase: async () => undefined }));
vi.mock("@hostel/db/models/SubscriptionInvoice", () => ({
  SubscriptionInvoiceModel: { findOne: () => ({ lean: mocks.invoice }) },
}));
vi.mock("@hostel/db/models/SubscriptionPayment", () => ({
  SubscriptionPaymentModel: { aggregate: async () => [{ total: 2000 }] },
}));
vi.mock("@hostel/db/models/SoftmatoDocument", () => ({
  SoftmatoDocumentModel: {
    deleteOne: (filter: unknown) => ({ catch: async () => mocks.dropCached(filter) }),
    findOne: () => ({ lean: mocks.cached }),
    updateOne: () => ({ catch: async () => undefined }),
  },
}));
vi.mock("@/modules/billing/softmato/config", () => ({ isSoftmatoConfigured: () => true }));
vi.mock("@/modules/billing/softmato/client", () => ({ isSoftmatoDown: () => false }));
vi.mock("@/modules/billing/softmato/documents", () => ({
  documentFilename: (number: string) => `${number}.pdf`,
  downloadInvoiceFile: mocks.download,
  downloadReceiptFile: vi.fn(),
  isPdf: (file: { contentType: string }) => file.contentType === "application/pdf",
}));
vi.mock("./issue", () => ({
  documentFileName: (number: string) => `${number}.pdf`,
  ensureLocalReceiptNumber: vi.fn(),
  renderInvoiceForRow: mocks.render,
  renderReceiptForRow: vi.fn(),
}));

import { resolveInvoiceDocument } from "./deliver";

/** "%PDF-1" — the header the app checks before it saves anything. */
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);

const ROW = {
  _id: "6aa7abf84bc62299c2cf243c",
  invoiceNumber: "SUB-0001-2431",
  localInvoiceNo: "HH-INV-2083/84-000004",
  softmatoInvoiceNo: "INV-2083/84-000012",
  status: "PARTIAL",
};

describe("resolveInvoiceDocument", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.cached.mockResolvedValue(null);
    mocks.render.mockResolvedValue(new Uint8Array([1]));
  });

  it("prints ours when Softmato no longer holds the number it gave us", async () => {
    mocks.invoice.mockResolvedValue(ROW);
    mocks.download.mockResolvedValue(null);

    const document = await resolveInvoiceDocument("SUB-0001-2431", null);

    expect(document?.issuedBy).toBe("platform");
    expect(mocks.render).toHaveBeenCalledWith(
      expect.objectContaining({ localInvoiceNo: "HH-INV-2083/84-000004" }),
      { amountPaid: 2000, documentNumber: "HH-INV-2083/84-000004" },
    );
  });

  it("serves Softmato's copy when they have it", async () => {
    mocks.invoice.mockResolvedValue(ROW);
    mocks.download.mockResolvedValue({
      bytes: PDF,
      contentType: "application/pdf",
      pdfFallbackReason: null,
    });

    const document = await resolveInvoiceDocument("SUB-0001-2431", null);

    expect(document?.issuedBy).toBe("softmato");
    expect(mocks.render).not.toHaveBeenCalled();
  });

  it("prints the same number itself when Softmato answers HTML instead of a PDF", async () => {
    mocks.invoice.mockResolvedValue(ROW);
    mocks.download.mockResolvedValue({
      bytes: new Uint8Array([60]),
      contentType: "text/html",
      pdfFallbackReason: "no engine",
    });

    const document = await resolveInvoiceDocument("SUB-0001-2431", null);

    expect(document?.contentType).toBe("application/pdf");
    expect(document?.filename).toBe("INV-2083/84-000012.pdf");
    expect(mocks.render).toHaveBeenCalledWith(
      expect.objectContaining({ localInvoiceNo: "INV-2083/84-000012" }),
      { amountPaid: 2000, documentNumber: "INV-2083/84-000012" },
    );
  });

  it("serves a cached copy whole when the driver hands it back as a BSON Binary", async () => {
    mocks.invoice.mockResolvedValue(ROW);
    // `.lean()` shape: a capacity buffer plus `position`, and `length` is a method.
    const padded = new Uint8Array(16);
    padded.set(PDF);
    mocks.cached.mockResolvedValue({
      bytes: { buffer: padded, length: () => PDF.length, position: PDF.length },
      contentType: "application/pdf",
    });

    const document = await resolveInvoiceDocument("SUB-0001-2431", null);

    expect(Array.from(document?.bytes ?? [])).toEqual(Array.from(PDF));
    expect(mocks.download).not.toHaveBeenCalled();
  });

  it("drops a cached copy that is not a PDF and fetches it again", async () => {
    mocks.invoice.mockResolvedValue(ROW);
    mocks.cached.mockResolvedValue({ bytes: new Uint8Array([60]), contentType: "application/pdf" });
    mocks.download.mockResolvedValue({ bytes: PDF, contentType: "application/pdf", pdfFallbackReason: null });

    const document = await resolveInvoiceDocument("SUB-0001-2431", null);

    expect(mocks.dropCached).toHaveBeenCalled();
    expect(document?.issuedBy).toBe("softmato");
    expect(Array.from(document?.bytes ?? [])).toEqual(Array.from(PDF));
  });

  it("prints its own when Softmato labels something a PDF that is not one", async () => {
    mocks.invoice.mockResolvedValue(ROW);
    mocks.download.mockResolvedValue({
      bytes: new Uint8Array([123, 34]),
      contentType: "application/pdf",
      pdfFallbackReason: null,
    });

    const document = await resolveInvoiceDocument("SUB-0001-2431", null);

    expect(document?.issuedBy).toBe("platform");
    expect(mocks.render).toHaveBeenCalled();
  });

  it("still answers not-found when there is no copy of ours to fall back to", async () => {
    mocks.invoice.mockResolvedValue({ ...ROW, localInvoiceNo: null });
    mocks.download.mockResolvedValue(null);

    expect(await resolveInvoiceDocument("SUB-0001-2431", null)).toBeNull();
  });
});
