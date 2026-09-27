import type { NextRequest } from "next/server";

import { errorResponse } from "@/lib/api-response";

type RateLimitBucket = {
  count: number;
  resetAt: number;
};

type PublicFormRateLimitOptions = {
  limit?: number;
  namespace: string;
  windowMs?: number;
};

const buckets = new Map<string, RateLimitBucket>();
const MAX_BUCKETS = 10_000;

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function publicFormLimit() {
  return positiveInteger(
    process.env.PUBLIC_FORM_RATE_LIMIT_MAX,
    process.env.NODE_ENV === "test" ? 1000 : 10,
  );
}

function publicFormWindowMs() {
  return positiveInteger(process.env.PUBLIC_FORM_RATE_LIMIT_WINDOW_SECONDS, 60) * 1000;
}

function clientKey(request: NextRequest) {
  const forwardedFor = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const realIp = request.headers.get("x-real-ip")?.trim();
  const userAgent = request.headers.get("user-agent")?.trim() ?? "unknown-agent";

  return `${forwardedFor || realIp || "unknown-ip"}:${userAgent}`;
}

export function rateLimitPublicForm(
  request: NextRequest,
  {
    limit = publicFormLimit(),
    namespace,
    windowMs = publicFormWindowMs(),
  }: PublicFormRateLimitOptions,
) {
  const now = Date.now();
  const key = `${namespace}:${clientKey(request)}`;
  const existing = buckets.get(key);

  if (!existing || existing.resetAt <= now) {
    // A warm instance sees every visitor it ever served, so the map is capped:
    // a Map iterates oldest first, and the oldest bucket goes. O(1) even under
    // a flood of new keys, where a sweep would rescan every entry each time.
    if (buckets.size >= MAX_BUCKETS) {
      buckets.delete(buckets.keys().next().value!);
    }

    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return null;
  }

  existing.count += 1;

  if (existing.count <= limit) {
    return null;
  }

  const retryAfterSeconds = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));

  return errorResponse(
    "Too many requests. Please wait before submitting again.",
    "RATE_LIMITED",
    429,
    { retryAfterSeconds },
  );
}

/** PHASES.md §1.1/§5.1: 5 attempts per 15 minutes per client, per endpoint. */
export const AUTH_ATTEMPT_LIMIT = 5;
export const AUTH_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

/**
 * The auth-endpoint limit, in one place so every credential- or token-guessing
 * surface gets the same budget.
 *
 * Each endpoint passes its own namespace, so exhausting password resets does
 * not also lock someone out of verifying their email — but a token guesser gets
 * five tries per quarter hour at whichever door they picked.
 */
export function rateLimitAuthAttempts(request: NextRequest, namespace: string) {
  return rateLimitPublicForm(request, {
    limit: AUTH_ATTEMPT_LIMIT,
    namespace,
    windowMs: AUTH_ATTEMPT_WINDOW_MS,
  });
}

export function resetPublicFormRateLimitForTests() {
  buckets.clear();
}
