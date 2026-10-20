import type { NextRequest } from "next/server";

import { requireHostelCapability } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { listStatementImports } from "@/modules/finance/statements/reconcile.service";
import { importStatement } from "@/modules/finance/statements/statement-import.service";
import {
  statementImportSchema,
  statementListQuerySchema,
} from "@/modules/finance/statements/statement.validation";
import { resolveAdminHostelId } from "@/modules/hostels/hostel.service";

export const runtime = "nodejs";

/** Past statement uploads, newest first (target §11.5). */
export async function GET(request: NextRequest) {
  try {
    const principal = await requireHostelCapability(request, "approvePayments");
    const query = statementListQuerySchema.parse(
      Object.fromEntries(new URL(request.url).searchParams),
    );
    const hostelId = resolveAdminHostelId(principal, query.hostelId);

    return withEtag(request, successResponse(
      { imports: await listStatementImports(hostelId, query.limit) },
      "Statement imports",
    ));
  } catch (error) {
    return handleRouteError(error);
  }
}

/**
 * Read an uploaded statement and run every credit through the ladder.
 *
 * `approvePayments`, not `viewPayments`: an import auto-settles the rows whose
 * reference codes verify, so it moves money and belongs with the capability that
 * governs moving it (item 0.5).
 */
export async function POST(request: NextRequest) {
  try {
    const principal = await requireHostelCapability(request, "approvePayments");
    const body = statementImportSchema.parse(await request.json());
    const hostelId = resolveAdminHostelId(principal, body.hostelId);

    return successResponse(
      await importStatement({
        assetId: body.assetId,
        hostelId,
        principal,
        provider: body.provider,
      }),
      "Statement read",
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
