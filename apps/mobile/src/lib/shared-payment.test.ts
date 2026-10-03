import { describe, expect, it } from "vitest";
import { acceptsSharedPayment, normalizeSharedPayment } from "./shared-payment";
describe("bank receipt metadata", () => {
  it.each([undefined, "application/octet-stream", "*/*", "application/x-pdf"])("accepts a PDF with %s metadata", (mimeType) => {
    const file = { uri: "file:///cache/receipt", fileName: "Send_Money.pdf", mimeType, fileSize: 500 };
    expect(normalizeSharedPayment(file).mimeType).toBe("application/pdf");
    expect(acceptsSharedPayment(file)).toBe(true);
  });
  it("rejects unsupported, empty and oversized files", () => {
    for (const patch of [{ mimeType: "text/html" }, { fileSize: 0 }, { fileSize: NaN }, { fileSize: 20 * 1024 * 1024 + 1 }, { uri: "" }]) {
      expect(acceptsSharedPayment({ uri: "file:///receipt.pdf", mimeType: "application/pdf", fileSize: 1, ...patch })).toBe(false);
    }
  });
});
