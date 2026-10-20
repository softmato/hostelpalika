import type { NextRequest } from "next/server";

import { assertApiRoles, requireApiPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { Role } from "@/lib/roles";
import { listCookFoodPhotos, uploadCookFoodPhoto } from "@/modules/food/cook.service";
import { foodPhotoUploadSchema } from "@/modules/food/food.validation";

export const runtime = "nodejs";

/**
 * A photo of the meal, posted from the kitchen.
 *
 * The same `foodPhotoUploadSchema` the admin and resident routes use, so an
 * asset uploaded through the shared `/files` pipeline lands in the same feed —
 * the only difference is who is allowed to post and how their hostel is
 * resolved. `hostel-admin/food/photos` stays where it is; this is the cook's
 * door to the same place, because `manageFood` excludes them by definition.
 */
const ALLOWED_ROLES = [Role.COOK, Role.HOSTEL_ADMIN, Role.WARDEN];

/**
 * What this kitchen has posted, newest day first.
 *
 * The read half of the same door. It answers the question a cook actually has —
 * *did we get today's meals up* — which is why the response is grouped by day
 * with a `mealsCovered` count per day rather than being a flat list they have to
 * count themselves.
 *
 * Same role list as the POST: a cook sees their own kitchen's feed, and a
 * hostel admin or warden looking at it sees the hostel they are scoped to.
 * `hostelId` is honoured for the admin case, where a principal can hold several
 * — `resolveCookHostelId` asserts access either way, so it is not a way to read
 * somebody else's kitchen.
 */
export async function GET(request: NextRequest) {
  try {
    const principal = await requireApiPrincipal(request);
    assertApiRoles(principal, ALLOWED_ROLES);

    const hostelId = request.nextUrl.searchParams.get("hostelId") ?? undefined;
    // Opaque, and handed straight back to the service — see `encodePhotoCursor`.
    const cursor = request.nextUrl.searchParams.get("cursor") ?? undefined;
    const result = await listCookFoodPhotos(principal, hostelId, cursor);

    return withEtag(request, successResponse(result, "Food photos loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requireApiPrincipal(request);
    assertApiRoles(principal, ALLOWED_ROLES);

    const input = foodPhotoUploadSchema.parse(await request.json());
    const result = await uploadCookFoodPhoto(input, principal);

    return successResponse(result, "Food photo uploaded", { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
