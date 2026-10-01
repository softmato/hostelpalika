import { z } from "zod";

export const serverEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_URL: z.string().url(),
  NEXT_PUBLIC_APP_URL: z.string().url(),
  MONGODB_URI: z.string().min(1),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  ACCESS_TOKEN_TTL: z.string().default("15m"),
  REFRESH_TOKEN_TTL: z.string().default("30d"),
  OTP_TTL_MINUTES: z.string().default("10"),
  OTP_RESEND_COOLDOWN_SECONDS: z.string().default("60"),
  OTP_RATE_LIMIT_WINDOW_MINUTES: z.string().default("15"),
  OTP_RATE_LIMIT_MAX: z.string().default("5"),
  OTP_HASH_SECRET: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  /**
   * The verified sending domain, e.g. `softmato.com`. The **only** part of the
   * email sender that stays in the environment.
   *
   * Everything else about the sender — display name, reply-to, and the
   * per-category mailboxes (`info@`, `alert@`, `billing@`, `security@`,
   * `support@`, `noreply@`) — is the platform owner's, editable under
   * Website Config → Site Content → Email Sending. This is not, because it is
   * not a branding choice: it must match a domain verified in Resend, and a
   * typo in a settings form would silently stop every email in the product.
   *
   * `RESEND_FROM_EMAIL` / `RESEND_FROM_NAME` / `EMAIL_FROM` are gone. They
   * pinned the sender to one address for every kind of message, and the name
   * half of them contradicted the site name the owner had configured.
   */
  EMAIL_DOMAIN: z.string().optional(),
  /** Overrides the reply address the admin configured. Rarely needed. */
  EMAIL_REPLY_TO: z.string().optional(),
  /**
   * No SMS group. `SMS_OTP_PROVIDER`, `EMAIL_OTP_PROVIDER` and the four
   * `TWILIO_*` variables were declared here and read by nothing — there is no
   * Twilio dependency in any package.json and no code path that sends an SMS.
   * OTP delivery is email-only, through Resend. Removed rather than left as a
   * promise the code does not keep; the `SMS` value on `Notification.channel`
   * is a channel enum, not evidence of a sender.
   */
  GOOGLE_CLIENT_ID: z.string().optional(),
  /**
   * 32-byte key (base64 or hex) that encrypts the resident identity profiles.
   * Optional here so existing deployments keep booting; the resident-profile
   * endpoints fail with a clear message when it is absent.
   */
  PERSONAL_DATA_ENCRYPTION_KEY: z.string().optional(),
  /**
   * QuestionCall's sign-up callback (ARCHITECTURE.md §12). Optional: without it
   * the conversion callback returns 503 instead of trusting an unauthenticated
   * caller. The link residents open is site config, not env.
   */
  QUESTIONCALL_WEBHOOK_SECRET: z.string().optional(),
  /**
   * Pusher Channels, for real-time notifications and live portal panels. All
   * four are optional together: with any of them missing the realtime layer
   * no-ops and the portals fall back to TanStack Query polling, so local
   * development and CI need no Pusher account.
   */
  PUSHER_APP_ID: z.string().optional(),
  PUSHER_KEY: z.string().optional(),
  PUSHER_SECRET: z.string().optional(),
  PUSHER_CLUSTER: z.string().optional(),
  /**
   * Cloudflare R2. Optional in the schema because a local `next dev` with no
   * bucket is a legitimate way to work on anything that is not an upload, but
   * listed in `PRODUCTION_REQUIRED` below — in production their absence is not
   * a degraded feature, it is every upload throwing.
   */
  R2_ENDPOINT: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  /** World-readable objects. This is the bucket `R2_PUBLIC_URL` serves. */
  R2_BUCKET_PUBLIC: z.string().optional(),
  /**
   * Everything reachable only through a presigned read. Must have **no** public
   * base URL: the split is what stops a payment proof being fetchable unsigned
   * by anyone who was once shown a signed link to it.
   */
  R2_BUCKET_PRIVATE: z.string().optional(),
  /** Folder this project owns inside the shared company buckets. */
  R2_KEY_PREFIX: z.string().optional(),
  R2_PUBLIC_URL: z.string().optional(),
  /** Protects `/api/v1/cron/*`. Absent, every scheduled job answers 500. */
  CRON_SECRET: z.string().optional(),
  /** Signs the resident QR activation codes. Falls back to `CRON_SECRET`. */
  ACTIVATION_CODE_SECRET: z.string().optional(),
  /** Wraps the per-hostel gateway secrets (ADR-6). 32 bytes, base64 or hex. */
  FINANCE_MASTER_KEY: z.string().optional(),
  /** Set only while rotating `FINANCE_MASTER_KEY`; both are accepted meanwhile. */
  FINANCE_MASTER_KEY_PREVIOUS: z.string().optional(),
  /** `off` disables the evidence OCR pass; anything else leaves it on. */
  EVIDENCE_OCR: z.string().optional(),
  /**
   * The iOS half of app links: `<Apple Team ID>.com.softmato.hostelpalika`.
   *
   * Read only by `/.well-known/apple-app-site-association`, which is Apple's
   * counterpart to the static `assetlinks.json` beside it. It lives in the
   * environment rather than in `public/` for one reason: the team id is issued
   * by Apple when the developer account is created, and there is no honest
   * value to commit before that happens. A placeholder would be worse than an
   * absence — iOS caches what it fetches, so a file naming the wrong app is a
   * mistake that outlives the deploy that fixes it.
   *
   * Unset, the route answers 404 and iOS simply never claims the domain, which
   * is exactly today's behaviour. Set it and universal links start working on
   * the next install with no code change and no app release.
   *
   * Team ID: Apple Developer → Membership. It is the same prefix shown in
   * App Store Connect and in the provisioning profile EAS generates.
   */
  APPLE_APP_ID_PREFIX: z.string().optional(),
  /**
   * `COOKIE_DOMAIN` and `COOKIE_SECURE` were declared here and read by nothing —
   * setting either had no effect at all, which is worse than not offering them.
   * `session-cookies.ts` derives `secure` from `NODE_ENV === "production"` and
   * sets no domain, so the cookies stay host-only. That is the right default:
   * a domain-wide cookie would be sent to every subdomain, including any the
   * platform does not control. Removed rather than wired up, because nothing
   * here needs cross-subdomain sessions.
   */
  LOG_LEVEL: z.string().default("info"),
  PUBLIC_FORM_RATE_LIMIT_MAX: z.string().default("10"),
  PUBLIC_FORM_RATE_LIMIT_WINDOW_SECONDS: z.string().default("60"),
  /**
   * Upload limits. Deliberately `.optional()` and **not** `.default()`: the real
   * defaults live in `DEFAULT_*` in `packages/shared/src/utils/file-assets.ts`,
   * which is what `fileAssetLimits()` actually falls back to. A second copy here
   * would only be a copy that drifts — and it already had. The previous default
   * for `ALLOWED_DOCUMENT_MIME_TYPES` listed four types while the shipped
   * allowlist carried eight, having gained `text/plain`, `text/csv` and the two
   * spreadsheet types when statement import landed. These entries exist so the
   * schema documents every variable the app reads, not to set values.
   */
  UPLOAD_MAX_IMAGE_BYTES: z.string().optional(),
  UPLOAD_MAX_DOCUMENT_BYTES: z.string().optional(),
  UPLOAD_MAX_VIDEO_BYTES: z.string().optional(),
  ALLOWED_IMAGE_MIME_TYPES: z.string().optional(),
  ALLOWED_DOCUMENT_MIME_TYPES: z.string().optional(),
  ALLOWED_VIDEO_MIME_TYPES: z.string().optional(),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

/**
 * Absent in production, the app is **broken** rather than degraded — uploads
 * throw, every cron job answers 500, or nothing boots at all. These fail the
 * boot check loudly, which is the whole point: the alternative is discovering a
 * mistyped key at a resident's first login.
 *
 * `MONGODB_URI`, the two JWT secrets and the two URLs are not listed because the
 * schema already makes them non-optional in every environment.
 */
const PRODUCTION_REQUIRED = [
  "R2_ENDPOINT",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET_PUBLIC",
  "R2_BUCKET_PRIVATE",
  "CRON_SECRET",
] as const;

/**
 * Absent in production, one feature silently degrades and nothing says so.
 * Warned about rather than rejected, because each of these is a legitimate
 * choice for a first deployment — and because a boot that refuses to start over
 * a missing Pusher key would be a worse failure than the one it prevents.
 */
const PRODUCTION_RECOMMENDED: Array<{ keys: readonly string[]; consequence: string }> = [
  {
    consequence:
      "realtime is off — portals fall back to polling and the notification bell updates late",
    keys: ["PUSHER_APP_ID", "PUSHER_KEY", "PUSHER_SECRET", "PUSHER_CLUSTER"],
  },
  {
    consequence:
      "no email is delivered — OTPs, invitations, receipts and every notification email are dropped",
    keys: ["RESEND_API_KEY"],
  },
  {
    consequence:
      "email falls back to the softmato.com sending domain — correct for a Softmato deployment, wrong for anyone else, and unverified domains bounce",
    keys: ["EMAIL_DOMAIN"],
  },
  {
    consequence:
      "resident identity profiles cannot be read or written — the endpoints fail with a clear message",
    keys: ["PERSONAL_DATA_ENCRYPTION_KEY"],
  },
  {
    consequence:
      "no hostel can enable a payment gateway — the per-hostel secrets have nothing to wrap them",
    keys: ["FINANCE_MASTER_KEY"],
  },
];

/**
 * Parses and returns the server environment, throwing on anything that makes
 * this deployment unusable.
 *
 * Called from `instrumentation.ts`, so it runs **once when the server starts**
 * rather than on the first request that happens to need a given key. That is
 * the entire value of it: a mistyped `JWT_ACCESS_SECRET` should stop the
 * deployment, not wait to surface as a confusing failure at someone's first
 * login.
 */
export function validateServerEnv() {
  const parsed = serverEnvSchema.parse(process.env);

  if (parsed.NODE_ENV === "production") {
    const missing = PRODUCTION_REQUIRED.filter((key) => !process.env[key]);

    if (missing.length > 0) {
      throw new Error(
        `Missing required production environment ${
          missing.length === 1 ? "variable" : "variables"
        }: ${missing.join(", ")}. See docs/ENVIRONMENT.md.`,
      );
    }
  }

  return parsed;
}

/**
 * The non-fatal half of the boot check: what is missing, and what breaks
 * because of it. Returned rather than logged so the caller owns the output and
 * a test can assert on it.
 */
export function serverEnvWarnings(): string[] {
  if (process.env.NODE_ENV !== "production") {
    return [];
  }

  return PRODUCTION_RECOMMENDED.filter(({ keys }) =>
    keys.every((key) => !process.env[key]),
  ).map(({ consequence, keys }) => `${keys.join(", ")} not set — ${consequence}.`);
}
