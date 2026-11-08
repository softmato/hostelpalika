import { safeEqual } from "@/lib/cron-auth";
import { revalidatePublicPages } from "@/lib/revalidate-public";

/**
 * The Go API calls this after a write a listing shows (`cache.PublicChanged`),
 * so the public pages drop their 6 h copy now. Outside `/api/v1` on purpose:
 * that prefix is rewritten to the API. Bearer `REVALIDATE_SECRET`, same value
 * on both sides.
 */
export async function POST(request: Request) {
  const secret = process.env.REVALIDATE_SECRET?.trim() ?? "";
  const sent = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim() ?? "";

  if (!safeEqual(sent, secret)) {
    return Response.json({ ok: false }, { status: 401 });
  }

  revalidatePublicPages();
  return Response.json({ ok: true });
}
