import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";
import { POST } from "@/app/api/receipt-share/route";

function request(files: File[], field = "receipt") {
  const body = new FormData();
  files.forEach(file => body.append(field, file));
  return new Request("https://example.com/app/share-payment", { method: "POST", body });
}

it.each(["application/octet-stream", "application/x-pdf", "binary/octet-stream"])("cold %s shares preserve the file and auto-fill without a picker", async (type) => {
  const response = await POST(request([new File(["%PDF-bank-receipt"], "Send_Money.pdf", { type })]));
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toContain("no-store");
  const html = await response.text();
  const saved = new Map<string, Response>();
  const cache = {
    keys: async () => [...saved.keys()],
    match: async (key: string) => saved.get(new URL(String(key), "https://example.com").href)?.clone(),
    put: async (key: string, value: Response) => { saved.set(new URL(String(key), "https://example.com").href, value); },
    delete: async (key: string) => saved.delete(String(key)),
  };
  const caches = { open: async () => cache };
  const replace = vi.fn();
  await runInNewContext(html.match(/<script[^>]*>([\s\S]*?)<\/script>/)![1], {
    caches, Response, Uint8Array, atob, Date, location: { replace },
  });
  expect(replace).toHaveBeenCalledWith(expect.stringMatching(/^\/app\/receipt-sheet.html\?share=/));
  expect(await [...saved.values()][0].clone().text()).toBe("%PDF-bank-receipt");

  const sheet = readFileSync("public/receipt-sheet.html", "utf8");
  const elements = new Map([...sheet.matchAll(/id="([^"]+)"/g)].map(m => [m[1], { value: "", hidden: true, checked: false, textContent: "" }]));
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "https://upload.example/receipt") {
      expect(await (init!.body as Blob).text()).toBe("%PDF-bank-receipt");
      return new Response(null);
    }
    const data = url.endsWith("/auth/me") ? { user: { id: "staff", role: "HOSTEL_ADMIN" } }
      : url.endsWith("/presign") ? { assetId: "asset1", presignedUrl: "https://upload.example/receipt" }
      : url.endsWith("/receipt/read") ? { fields: { amount: 250, method: "ESEWA" }, description: "Lunch", autoSaveEligible: false } : {};
    return Response.json({ success: true, data });
  });
  runInNewContext(sheet.match(/<script>([\s\S]*?)<\/script>/)![1], {
    window: {}, document: { getElementById: (id: string) => elements.get(id) },
    location: { origin: "https://example.com", search: new URL(replace.mock.calls[0][0], "https://example.com").search },
    caches, URL, URLSearchParams, crypto, AbortSignal, fetch, localStorage: { getItem: () => null },
  });
  await vi.waitFor(() => expect(elements.get("amount")!.value).toBe(250));
  expect(elements.get("pick")!.hidden).toBe(true);
  expect(elements.get("save")!.hidden).toBe(false);
  expect(fetch.mock.calls.some(([url]) => url.endsWith("/receipt/read"))).toBe(true);
});

it("rejects empty, multiple, unsupported and oversized fallback shares", async () => {
  for (const files of [[], [new File(["html"], "x.html", { type: "text/html" })],
    [new File(["a"], "a.pdf"), new File(["b"], "b.pdf")],
    [new File([new Uint8Array(3 * 1024 * 1024 + 1)], "large.pdf")]]) {
    const response = await POST(request(files));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toMatch(/error=(unsupported|large|missing|multiple|empty)/);
  }
});

it("cannot inject HTML through a receipt filename", async () => {
  const response = await POST(request([new File(["pdf"], '</script><script>alert(1)</script>.pdf', { type: "application/pdf" })]));
  const html = await response.text();
  expect(html).not.toContain("<script>alert(1)");
  expect(html.match(/<script/g)).toHaveLength(1);
  expect(response.headers.get("content-security-policy")).toContain("script-src 'nonce-");
});

it("accepts the file field used by an older installed manifest", async () => {
 const response = await POST(request([new File(["%PDF-test"], "bank.pdf", {type:"application/pdf"})], "files"));
 expect(response.status).toBe(200);
});
