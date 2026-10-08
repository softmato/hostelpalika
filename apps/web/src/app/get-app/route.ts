import { NextResponse, type NextRequest } from "next/server";

import { loadSiteConfig } from "@/lib/site-config-server";

export const dynamic = "force-dynamic";

/**
 * The one link the team's QR codes and the install banner point at.
 *
 * - Android: the Play listing, or the uploaded APK when the Play link is
 *   blank (the browser starts the download straight away).
 * - iPhone/iPad: there is no App Store build yet, so the installable web app
 *   at `/app`, whose `?install` sheet walks through Add to Home Screen.
 * - Anything else (a laptop that opened the link): the Play listing.
 *
 * A redirect rather than a page, so the stored URLs can change without any
 * printed QR going stale.
 */
export async function GET(request: NextRequest) {
  const agent = request.headers.get("user-agent") ?? "";
  const { apps } = await loadSiteConfig();

  if (/iPhone|iPad|iPod/i.test(agent)) {
    return NextResponse.redirect(new URL("/app?install", request.url));
  }

  const target =
    apps.androidPlayUrl || (/Android/i.test(agent) && apps.androidApkUrl) || "/";

  return NextResponse.redirect(new URL(target, request.url));
}
