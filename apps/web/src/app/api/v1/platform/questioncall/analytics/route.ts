import type { NextRequest } from "next/server";

import { requirePlatformPrincipal, requireSuperadminPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { csvFilename, csvResponse, toCsv } from "@/lib/csv";
import { getQuestionCallAnalytics } from "@/modules/questioncall/questioncall.service";
import { questionCallAnalyticsQuerySchema } from "@/modules/questioncall/questioncall.validation";

export const runtime = "nodejs";

const CSV_COLUMNS = [
  { key: "hostelName", label: "Hostel" },
  { key: "clicks", label: "Clicks" },
  { key: "conversions", label: "Conversions" },
  { key: "conversionRatePercent", label: "Conversion rate (%)" },
];

export async function GET(request: NextRequest) {
  try {
    const query = questionCallAnalyticsQuerySchema.parse(
      Object.fromEntries(request.nextUrl.searchParams),
    );

    // A moderator reads reports; exporting them is a superadmin action
    // (PHASES.md §5.1 — "Can view reports (read-only, no export)").
    if (query.format === "csv") {
      await requireSuperadminPrincipal(request);
    } else {
      await requirePlatformPrincipal(request);
    }

    const result = await getQuestionCallAnalytics(query);

    if (query.format === "csv") {
      return csvResponse(
        toCsv(
          CSV_COLUMNS,
          result.byHostel.map((row) => ({
            ...row,
            conversionRatePercent: (row.conversionRate * 100).toFixed(1),
          })),
        ),
        csvFilename("questioncall-analytics"),
      );
    }

    return withEtag(request, successResponse(result, "QuestionCall analytics loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}
