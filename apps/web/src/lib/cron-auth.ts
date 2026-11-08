import crypto from "node:crypto";

/**
 * Cron request authentication (adapted from the QuestionCall project).
 *
 * Cron endpoints authorize with a shared secret in a HEADER only — never a
 * `?key=` query param, which would leak the secret into access logs, CDN/proxy
 * logs, browser history, and the `Referer` header of outbound navigations.
 * Send it as `x-cron-secret: <secret>` or `Authorization: Bearer <secret>`.
 *
 * The secret is env-only (`CRON_SECRET`); there is intentionally no hardcoded
 * fallback. Comparison is timing-safe.
 */
export const CRON_SECRET_ENV_KEY = "CRON_SECRET";
export const CRON_SECRET_HEADER = "x-cron-secret";

export type CronAuthResult = { ok: true } | { ok: false; status: number; error: string };

function normalizeSecret(value: string | null | undefined) {
  return value?.trim() || "";
}

export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  // timingSafeEqual throws on length mismatch, so compare lengths first.
  if (bufA.length === 0 || bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

export function validateCronRequest(request: Request): CronAuthResult {
  const configuredSecret = normalizeSecret(process.env[CRON_SECRET_ENV_KEY]);

  if (!configuredSecret) {
    return {
      ok: false,
      status: 500,
      error: `${CRON_SECRET_ENV_KEY} is not configured.`,
    };
  }

  const headerSecret = normalizeSecret(request.headers.get(CRON_SECRET_HEADER));
  const authHeader = normalizeSecret(request.headers.get("authorization"));

  const isAuthorized =
    safeEqual(headerSecret, configuredSecret) ||
    safeEqual(authHeader, configuredSecret) ||
    safeEqual(authHeader, `Bearer ${configuredSecret}`);

  if (!isAuthorized) {
    return { ok: false, status: 401, error: "Unauthorized" };
  }

  return { ok: true };
}
