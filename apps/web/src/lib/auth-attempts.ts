import type { NextRequest } from "next/server";

import { errorResponse } from "@/lib/api-response";
import { connectToDatabase } from "@/lib/db";
import { AuthAttemptModel } from "@hostel/db/models/AuthAttempt";

/**
 * Failed-attempt limits for the doors where a secret is guessed: a password, a
 * guardian access code, an OTP.
 *
 * These used the in-memory form limiter, which was wrong three ways here:
 *
 * - it counted every attempt, successful ones included, so residents signing in
 *   on one hostel's Wi-Fi — one IP, and the app sends the same user-agent from
 *   every Android phone — shared five sign-ins per quarter hour;
 * - its key included the user-agent, which a guesser changes per request;
 * - it lived in one instance's memory, and Vercel runs many.
 *
 * So only failures count, in Mongo, under two budgets per window: five for one
 * IP guessing one account (the PHASES.md §1.1 figure, now per account rather
 * than per building), and thirty for one IP across every account it tries.
 */
export const FAILED_ATTEMPT_LIMIT = 5;
export const FAILED_ATTEMPTS_PER_IP = 30;
export const FAILED_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

function clientIp(request: NextRequest) {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip")?.trim() ||
    "unknown-ip"
  );
}

/** Fixed windows, so each count is one document with one atomic `$inc`. */
function attemptKeys(request: NextRequest, namespace: string, subject: string) {
  const window = Math.floor(Date.now() / FAILED_ATTEMPT_WINDOW_MS);
  const ip = clientIp(request);

  return {
    expiresAt: new Date((window + 1) * FAILED_ATTEMPT_WINDOW_MS),
    ip: `${namespace}|${ip}|*|${window}`,
    subject: `${namespace}|${ip}|${subject.trim().toLowerCase()}|${window}`,
  };
}

/** A 429 when either budget is spent, otherwise null. Checked before the secret is. */
export async function refuseIfTooManyFailures(
  request: NextRequest,
  namespace: string,
  subject: string,
) {
  await connectToDatabase();

  const keys = attemptKeys(request, namespace, subject);
  const rows = await AuthAttemptModel.find({ key: { $in: [keys.ip, keys.subject] } })
    .select("key count")
    .lean<{ count: number; key: string }[]>();
  const count = (key: string) => rows.find((row) => row.key === key)?.count ?? 0;

  if (count(keys.subject) < FAILED_ATTEMPT_LIMIT && count(keys.ip) < FAILED_ATTEMPTS_PER_IP) {
    return null;
  }

  return errorResponse(
    "Too many failed attempts. Please wait before trying again.",
    "RATE_LIMITED",
    429,
    {
      retryAfterSeconds: Math.max(1, Math.ceil((keys.expiresAt.getTime() - Date.now()) / 1000)),
    },
  );
}

/**
 * Counts one wrong guess against both budgets. Never throws: the caller is
 * already answering with the real error, and a failed count must not replace it.
 */
export async function recordFailedAttempt(
  request: NextRequest,
  namespace: string,
  subject: string,
) {
  const keys = attemptKeys(request, namespace, subject);

  try {
    await Promise.all(
      [keys.ip, keys.subject].map((key) =>
        AuthAttemptModel.updateOne(
          { key },
          { $inc: { count: 1 }, $setOnInsert: { expiresAt: keys.expiresAt } },
          { upsert: true },
        ),
      ),
    );
  } catch (error) {
    console.warn(
      JSON.stringify({
        action: "auth_attempt_count_failed",
        level: "warn",
        message: error instanceof Error ? error.message : String(error),
        namespace,
      }),
    );
  }
}
