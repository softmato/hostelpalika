/**
 * Conditional GETs for signed-in reads: the same data never travels twice.
 *
 * Both clients revalidate behind what they already show (TanStack Query on the
 * web, `query-cache` in the app), and most of those revalidations come back
 * unchanged — a resident list, a ledger, a dashboard — re-sent in full every
 * time. So every JSON GET carries a weak ETag of its body, and a client that
 * sends it back in `If-None-Match` gets a bodiless 304 and reuses the copy it
 * holds in memory (`browser-api.ts`, the app's `api.ts`).
 *
 * The body is still built — this saves the transfer, which is what a phone on
 * mobile data pays for, not the query. The cached copy lives in the client's
 * memory, never in the browser's disk cache: `private, no-store` stays, for the
 * shared hostel-office PC reason `query-provider.tsx` gives.
 */

/** FNV-1a, 32-bit — fast and plenty for telling two bodies apart. */
function fnv1a(text: string) {
  let hash = 0x811c9dc5;

  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return (hash >>> 0).toString(36);
}

export async function withEtag(request: Request, response: Response): Promise<Response> {
  if (request.method !== "GET" || response.status !== 200) return response;
  if (!response.headers.get("content-type")?.includes("application/json")) return response;

  const body = await response.clone().text();
  const etag = `W/"${fnv1a(body)}-${body.length.toString(36)}"`;

  response.headers.set("etag", etag);

  if (request.headers.get("if-none-match") !== etag) return response;

  const headers = new Headers(response.headers);

  headers.delete("content-length");
  headers.delete("content-type");

  return new Response(null, { headers, status: 304 });
}
