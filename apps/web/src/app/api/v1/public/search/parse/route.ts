import type { NextRequest } from "next/server";
import { z } from "zod";

import { handleRouteError, successResponse } from "@/lib/api-response";
import { isLLMConfigured } from "@/lib/llm/providers";
import { rateLimitPublicForm } from "@/lib/rate-limit";
import { parseWithLLM } from "@/lib/search/llm-search";
import { parseSearchQuery, type ParsedSearch } from "@/lib/search/query-parser";
import {
  currentWindow,
  encodeQuota,
  QUOTA_COOKIE,
  QUOTA_LIMIT,
  quotaMaxAge,
  quotaRemaining,
} from "@/lib/search/search-quota";

export const runtime = "nodejs";

/**
 * Above this, the deterministic parser explained the query well enough that an
 * LLM call would only add latency and burn quota.
 */
const CONFIDENCE_FLOOR = 0.6;

const bodySchema = z.object({
  query: z.string().trim().min(1).max(200),
});

/**
 * Turns a hero-search sentence into listing filters.
 *
 * Keyword detection runs first and answers most queries outright. Only a query
 * it cannot explain reaches the LLM, and only while the visitor has quota left
 * in their 5-hour window — after that the keyword result stands on its own. The
 * response never fails over to an error for a spent quota; degrading quietly is
 * the point.
 */
export async function POST(request: NextRequest) {
  try {
    const { query } = bodySchema.parse(await request.json());

    const keyword = parseSearchQuery(query);
    const state = currentWindow(request.cookies.get(QUOTA_COOKIE)?.value);

    let result: ParsedSearch = keyword;
    // Tracks that an upstream call was made, not that it was useful — the
    // provider is billed either way, so an unusable answer still costs quota.
    let calledLLM = false;

    const worthEscalating =
      keyword.confidence < CONFIDENCE_FLOOR &&
      isLLMConfigured() &&
      quotaRemaining(state) > 0 &&
      // The quota a client cannot drop: the cookie one starts fresh the moment
      // a script stops sending it, and every call is billed.
      rateLimitPublicForm(request, {
        limit: QUOTA_LIMIT,
        namespace: "search-llm",
        windowMs: 5 * 60 * 60 * 1000,
      }) === null;

    if (worthEscalating) {
      calledLLM = true;
      const viaLLM = await parseWithLLM(query).catch(() => null);
      if (viaLLM) {
        // Keyword hits are literal matches on known place names, so they win
        // on any key the model also filled in — except the raw-sentence `q`
        // placeholder, which is not a real signal and would otherwise override
        // the model's answer with a text search that matches nothing.
        const keywordSignals = { ...keyword.filters };
        if (keyword.rawTextOnly) {
          delete keywordSignals.q;
        }

        result = {
          confidence: 0.9,
          filters: { ...viaLLM, ...keywordSignals },
          rawTextOnly: false,
          source: "llm",
        };
      }
    }

    const nextState = calledLLM ? { ...state, used: state.used + 1 } : state;

    const response = successResponse(
      {
        filters: result.filters,
        quota: {
          limit: QUOTA_LIMIT,
          remaining: quotaRemaining(nextState),
          resetsAt: new Date(nextState.windowEndsAt).toISOString(),
        },
        source: result.source,
      },
      "Search parsed",
    );

    response.cookies.set(QUOTA_COOKIE, encodeQuota(nextState), {
      httpOnly: true,
      maxAge: quotaMaxAge(nextState),
      path: "/",
      sameSite: "lax",
      secure: process.env.COOKIE_SECURE === "true",
    });

    return response;
  } catch (error) {
    return handleRouteError(error);
  }
}
