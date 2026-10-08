import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
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
    findOne: () => ({ lean: async () => null }),
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
      bytes: new Uint8Array([2]),
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

  it("still answers not-found when there is no copy of ours to fall back to", async () => {
    mocks.invoice.mockResolvedValue({ ...ROW, localInvoiceNo: null });
    mocks.download.mockResolvedValue(null);

    expect(await resolveInvoiceDocument("SUB-0001-2431", null)).toBeNull();
  });
});
