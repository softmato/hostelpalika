import type { NextRequest } from "next/server";

import { handleRouteError, successResponse } from "@/lib/api-response";
import { verifyReceiptByCode } from "@/modules/finance/receipt.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * What `/verify-receipt` shows for a certified receipt's code (PARITY §9: the
 * page reads the API). No session: whoever holds the paper may check it.
 */
export async function GET(request: NextRequest) {
  try {
    const code = request.nextUrl.searchParams.get("code") ?? "";

    return successResponse({ verification: await verifyReceiptByCode(code) }, "Receipt checked");
  } catch (error) {
    return handleRouteError(error);
  }
}
