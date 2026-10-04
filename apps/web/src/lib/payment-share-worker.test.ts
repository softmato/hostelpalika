import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
function worker() {
 const saved = new Map<string, Response>();
 const cache = { keys: async () => [...saved.keys()], match: async (key: string) => saved.get(String(key)),
   delete: async (key: string) => saved.delete(String(key)), put: async (key: string, value: Response) => { saved.set(String(key), value); } };
 const scope = { self: { location: { origin: "https://example.com" }, addEventListener() {} },
   caches: { open: async () => cache }, URL, Response, File, Date, crypto };
 const receive = runInNewContext(readFileSync("public/sw.js", "utf8") + "\nreceivePaymentShare", scope);
 return { receive, saved };
}
function request(files: File[], field = "receipt") {
 const form = new FormData(); files.forEach((file) => form.append(field, file));
 return { formData: async () => form };
}
it("stages a private receipt and redirects to an opaque share id", async () => {
 const { receive, saved } = worker();
 const response = await receive(request([new File(["receipt"], "bank.png", { type: "image/png" })]));
 expect(response.status).toBe(303);
 expect(response.headers.get("location")).toMatch(/receipt-sheet\.html\?share=[a-f0-9-]+$/);
 expect(saved.size).toBe(1);
 expect(await [...saved.values()][0].text()).toBe("receipt");
});
it("rejects unsupported files and multiple receipts", async () => {
 const { receive, saved } = worker();
 for (const files of [[new File(["code"], "file.html", { type: "text/html" })], [new File(["a"], "a.png", { type: "image/png" }), new File(["b"], "b.png", { type: "image/png" })]]) {
   expect((await receive(request(files))).headers.get("location")).toMatch(/error=(unsupported|multiple)/);
 }
 expect(saved.size).toBe(0);
});

it("accepts bank PDFs with generic MIME metadata", async () => {
 for (const type of ["", "application/octet-stream", "binary/octet-stream", "application/x-pdf", "application/pdf; charset=binary"]) {
  const { receive, saved } = worker();
  const response = await receive(request([new File(["%PDF-receipt"], "Send_Money.pdf", { type })]));
  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toContain("receipt-sheet.html?share=");
  expect([...saved.values()][0].headers.get("content-type")).toBe("application/pdf");
 }
});

it("receives an older manifest file field", async () => {
 const { receive, saved } = worker();
 const response = await receive(request([new File(["%PDF-test"], "Send_Money.pdf", {type:"application/x-pdf"})], "files"));
 expect(response.headers.get("location")).toContain("?share=");
 expect(saved.size).toBe(1);
});
it("distinguishes a missing attachment from an empty file", async () => {
 const { receive } = worker();
 expect((await receive(request([]))).headers.get("location")).toContain("error=missing");
 expect((await receive(request([new File([], "receipt.pdf")]))).headers.get("location")).toContain("error=empty");
});
