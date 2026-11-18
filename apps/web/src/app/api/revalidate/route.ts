import { safeEqual } from "@/lib/cron-auth";
import { revalidatePublicPages, revalidateWholeSite } from "@/lib/revalidate-public";

/**
 * The Go API calls this after a write a page shows: `cache.PublicChanged` for a
 * listing (only listing pages drop their copy), `cache.SiteChanged` with
 * `?scope=site` for the website config (every page does). Outside `/api/v1` on
 * purpose: that prefix is rewritten to the API. Bearer `REVALIDATE_SECRET`, same
 * value on both sides.
 */
export async function POST(request: Request) {
  const secret = process.env.REVALIDATE_SECRET?.trim() ?? "";
  const sent = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim() ?? "";

  if (!safeEqual(sent, secret)) {
    return Response.json({ ok: false }, { status: 401 });
  }

  if (new URL(request.url).searchParams.get("scope") === "site") {
    revalidateWholeSite();
  } else {
    revalidatePublicPages();
  }
  return Response.json({ ok: true });
}
