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
function request(files: File[]) {
 const form = new FormData(); files.forEach((file) => form.append("receipt", file));
 return { formData: async () => form };
}
it("stages a private receipt and redirects to an opaque share id", async () => {
 const { receive, saved } = worker();
 const response = await receive(request([new File(["receipt"], "bank.png", { type: "image/png" })]));
 expect(response.status).toBe(303);
 expect(response.headers.get("location")).toMatch(/share-payment\?share=[a-f0-9-]+$/);
 expect(saved.size).toBe(1);
 expect(await [...saved.values()][0].text()).toBe("receipt");
});
it("rejects unsupported files and multiple receipts", async () => {
 const { receive, saved } = worker();
 for (const files of [[new File(["code"], "file.html", { type: "text/html" })], [new File(["a"], "a.png", { type: "image/png" }), new File(["b"], "b.png", { type: "image/png" })]]) {
   expect((await receive(request(files))).headers.get("location")).toContain("error=unsupported");
 }
 expect(saved.size).toBe(0);
});
