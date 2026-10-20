import type { NextRequest } from "next/server";

import { requireTeamPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { getOperationsConfig } from "@/modules/platform-config/operations-config";

export const runtime = "nodejs";

/**
 * The QR an agent shows an owner who wants to pay by wallet.
 *
 * Two fields out of the operations config and nothing else. It is behind the
 * team guard rather than public because the whole of the operations config is
 * staff-only and this endpoint should not become the crack in that — the image
 * itself is meant to be seen by payers, but *which* account the platform is
 * collecting into is not something an anonymous caller needs to be able to
 * enumerate.
 */
export async function GET(request: NextRequest) {
  try {
    await requireTeamPrincipal(request);

    const operations = await getOperationsConfig();

    return withEtag(request, successResponse(
      {
        qr: {
          label: operations.collectionQrLabel,
          url: operations.collectionQrUrl,
        },
      },
      "Collection QR loaded",
    ));
  } catch (error) {
    return handleRouteError(error);
  }
}
