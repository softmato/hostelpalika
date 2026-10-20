import type { NextRequest } from "next/server";

import { requireHostelCapability } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { rateLimitPublicForm } from "@/lib/rate-limit";
import { residentIdLookupSchema } from "@/modules/users/resident-identity.validation";
import { scanResidentForHostel } from "@/modules/users/resident-scan.service";

export const runtime = "nodejs";

/**
 * The whole record behind a scanned ID card.
 *
 * Sibling of `/hostel-admin/resident-lookup`, which answers "prefill this
 * registration form" and refuses everything that cannot. This one answers "who
 * is standing in front of me" and refuses almost nothing — see
 * `resident-scan.service.ts` for why that is the same endpoint twice rather
 * than one endpoint with a flag.
 *
 * ## Two capability checks, not one
 *
 * `registerResidents` is the gate: it is the grant that already governs reading
 * a resident's record, so a warden who may open the roster may scan a card.
 * `viewPayments` is asked for **separately and tolerantly**, because a warden
 * can legitimately hold the first without the second — and a door screen that
 * 403s in a corridor because the ledger was out of reach would be useless. A
 * refusal there returns the dossier with `ledger: null` and `ledgerDenied: true`,
 * which the phone prints as a line saying whose permission is missing.
 *
 * Rate limited for the same reason the lookup is: `HH-4K7M-9XQ2` is ten
 * characters out of a thirty-symbol alphabet, and an unthrottled endpoint that
 * returns somebody's blood group is a guessing game worth playing.
 */
export async function GET(request: NextRequest) {
  try {
    const rateLimited = rateLimitPublicForm(request, {
      limit: 20,
      namespace: "resident-scan",
    });

    if (rateLimited) {
      return rateLimited;
    }

    const principal = await requireHostelCapability(request, "registerResidents");
    const query = residentIdLookupSchema.parse(
      Object.fromEntries(request.nextUrl.searchParams.entries()),
    );

    const canViewPayments = await requireHostelCapability(request, "viewPayments")
      .then(() => true)
      .catch(() => false);

    const result = await scanResidentForHostel(query.residentId, principal, {
      canViewPayments,
      hostelId: query.hostelId,
    });

    return withEtag(request, successResponse(result, "Resident card read"));
  } catch (error) {
    return handleRouteError(error);
  }
}
