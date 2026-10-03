import { randomUUID } from "node:crypto";

export const runtime = "nodejs";

/** Fallback when a share navigation has no controlling service worker yet.
 * No upload or database write here: return the file to this browser's private
 * cache, then use the usual authenticated upload/read flow. Never cache HTML.
 */
export async function POST(request: Request) {
  const fail = (reason: string) => new Response(null, {
    status: 303, headers: { Location: `/app/receipt-sheet.html?error=${reason}`, "Cache-Control": "no-store" },
  });
  try {
    // Keep the HTML/base64 response below the hosting platform's 4.5 MB limit.
    if (Number(request.headers.get("content-length")) > 3 * 1024 * 1024) return fail("large");
    const form = await request.formData();
    const files = form.getAll("receipt");
    const file = files[0];
    if (files.length !== 1 || !(file instanceof File) || !file.size) return fail("unsupported");
    if (file.size > 3 * 1024 * 1024) return fail("large");
    const aliases: Record<string, string> = { pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", heic: "image/heic", heif: "image/heif" };
    const supplied = file.type.toLowerCase().split(";")[0];
    const type = !supplied || ["application/octet-stream", "binary/octet-stream", "*/*"].includes(supplied)
      ? aliases[file.name.split(".").pop()!.toLowerCase()] || "" : supplied;
    if (!(type.startsWith("image/") || type === "application/pdf")) return fail("unsupported");
    const id = randomUUID(), nonce = randomUUID();
    const data = JSON.stringify({ id, type, name: encodeURIComponent(file.name), bytes: Buffer.from(await file.arrayBuffer()).toString("base64") }).replace(/</g, "\\u003c");
    return new Response(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>Reading receipt</title></head><body><p role="status">Reading receipt…</p><script nonce="${nonce}">
      (async () => {
        try {
          const data = ${data};
          const cache = await caches.open('hostelpalika-shared-payments-v1');
          for (const key of await cache.keys()) {
            const stored = await cache.match(key);
            if (Number(stored.headers.get('x-shared-at')) < Date.now() - 3600000) await cache.delete(key);
          }
          const keys = await cache.keys();
          for (const key of keys.slice(0, Math.max(0, keys.length - 4))) await cache.delete(key);
          await cache.put('/app/_shared-payment/' + data.id, new Response(Uint8Array.from(atob(data.bytes), c => c.charCodeAt(0)), {
            headers: {'content-type':data.type, 'x-file-name':data.name, 'x-shared-at':String(Date.now())}
          }));
          location.replace('/app/receipt-sheet.html?share=' + data.id);
        } catch { location.replace('/app/receipt-sheet.html?error=unavailable'); }
      })();
    </script></body></html>`, { headers: {
      "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store, private",
      "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
      "Referrer-Policy": "no-referrer",
    } });
  } catch { return fail("unavailable"); }
}
