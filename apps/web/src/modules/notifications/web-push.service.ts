import webpush, { type PushSubscription as WebPushSubscription } from "web-push";

/**
 * Web Push delivery — the browser half of `push.service.ts`.
 *
 * Until this file existed the platform had one push transport, Expo, and it
 * reached one surface: a phone with the app installed. Everyone who runs the
 * hostel from a laptop — which is most wardens, every platform moderator, and
 * every admin during office hours — got the bell badge and nothing else, so a
 * payment claim raised at 11am waited for somebody to look at the tab.
 *
 * This is the same contract as the Expo sender, deliberately:
 *
 *   - **Never throws into a caller.** The `Notification` row is committed long
 *     before delivery is attempted, so an unreachable push service costs a
 *     buzz, not the message.
 *   - **Prunes what it is told is dead.** A push service answering `404` or
 *     `410 Gone` is saying the subscription no longer exists — the browser was
 *     uninstalled, the profile was wiped, permission was revoked. Those rows are
 *     marked REVOKED rather than deleted, matching `DeviceNotRegistered`
 *     handling on the Expo side.
 *
 * The one structural difference is encryption. Expo takes a token and does the
 * rest; Web Push seals the payload for one subscription using keys the browser
 * generated, which is why `DeviceToken.keys` exists and why a row missing
 * either half is skipped instead of attempted.
 */

/** Seconds a push service should hold an undelivered message. */
const TTL_SECONDS = 60 * 60 * 24;

/**
 * How many endpoints are in flight at once.
 *
 * Web Push has no batch endpoint — each subscription is a separate encrypted
 * HTTPS request to whichever service that browser uses. A platform-wide
 * announcement can therefore mean thousands of them, and `Promise.allSettled`
 * over the whole array would open thousands of sockets in one tick: a
 * self-inflicted outage on the exact notification that matters most, and the
 * kind that only appears once the platform is big enough for it to hurt.
 *
 * Expo's own sender has this ceiling for free — 100 messages per request — so
 * this is the equivalent limit on the side that has to make its own.
 */
const MAX_CONCURRENT_SENDS = 50;

let configured = false;

type VapidConfig = {
  privateKey: string;
  publicKey: string;
  subject: string;
};

function vapidConfig(): VapidConfig {
  return {
    privateKey: process.env.VAPID_PRIVATE_KEY?.trim() ?? "",
    publicKey:
      process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY?.trim() ||
      process.env.VAPID_PUBLIC_KEY?.trim() ||
      "",
    subject: process.env.VAPID_SUBJECT?.trim() ?? "",
  };
}

/**
 * True when all three VAPID values are present.
 *
 * Checked rather than assumed because the failure without it is silent by
 * nature: `webpush.sendNotification` throws on every call, each one is caught,
 * and the only symptom is that browsers stop buzzing. The subscribe route
 * refuses outright when this is false, so a browser cannot register against a
 * key that will never be able to send to it.
 */
export function isWebPushConfigured() {
  const { privateKey, publicKey, subject } = vapidConfig();

  return Boolean(privateKey && publicKey && subject);
}

export function webPushPublicKey() {
  return vapidConfig().publicKey;
}

function ensureConfigured() {
  if (configured) {
    return true;
  }

  if (!isWebPushConfigured()) {
    return false;
  }

  const { privateKey, publicKey, subject } = vapidConfig();

  webpush.setVapidDetails(subject, publicKey, privateKey);
  configured = true;

  return true;
}

/** One stored `DeviceToken` row with `platform: "WEB"`. */
export type WebPushTarget = {
  expirationTime?: number | null;
  keys?: { auth?: string; p256dh?: string } | null;
  /** The push service endpoint — stored in `DeviceToken.token`. */
  token: string;
};

/**
 * What the service worker receives and renders.
 *
 * Kept flat and small on purpose. Push services cap the encrypted payload
 * (4 KB is the safe ceiling everywhere), and anything the worker cannot use is
 * weight paid on every single delivery.
 */
export type WebPushPayload = {
  badge?: string;
  body: string;
  category: string;
  icon?: string;
  image?: string;
  notificationId?: string;
  /** Collapses repeats about the same thing into one tray entry. */
  tag?: string;
  title: string;
  /** Where a click goes — see `web-routing.ts`. */
  url: string;
  /**
   * Keeps the notification on screen until it is dismissed. Reserved for SOS
   * and URGENT: a safety alert that auto-hides after four seconds because the
   * laptop was unattended is the one case where "best effort" is not enough.
   */
  urgent?: boolean;
};

export type WebPushResult = {
  revoked: string[];
  sent: number;
};

const EMPTY: WebPushResult = { revoked: [], sent: 0 };

function statusCodeOf(error: unknown): number | undefined {
  if (typeof error === "object" && error && "statusCode" in error) {
    const raw = Number((error as { statusCode?: unknown }).statusCode);

    return Number.isFinite(raw) ? raw : undefined;
  }

  return undefined;
}

/**
 * Deliver one payload to a set of browser subscriptions.
 *
 * Returns the endpoints the push services rejected as gone, for the caller to
 * revoke — this module does not touch the database, so it stays a pure
 * transport and the one place that marks rows REVOKED remains `push.service.ts`.
 */
export async function sendWebPush(
  targets: WebPushTarget[],
  payload: WebPushPayload,
): Promise<WebPushResult> {
  if (targets.length === 0 || !ensureConfigured()) {
    return EMPTY;
  }

  const body = JSON.stringify(payload);
  const dead: string[] = [];
  let sent = 0;

  const deliver = async (target: WebPushTarget) => {
    {
      const auth = target.keys?.auth;
      const p256dh = target.keys?.p256dh;

      if (!auth || !p256dh) {
        /*
         * A WEB row written before the keys existed, or a subscribe request
         * that lost them. Unsendable and will stay unsendable, but not proof
         * the browser is gone — the next page load re-subscribes and fills it
         * in — so it is skipped rather than revoked.
         */
        return "skipped" as const;
      }

      // The endpoint is whatever the browser (or a forged request) sent: post
      // only to the real push services, never anywhere else (SSRF).
      if (!isPushService(target.token)) return "skipped" as const;

      const subscription: WebPushSubscription = {
        endpoint: target.token,
        expirationTime: target.expirationTime ?? null,
        keys: { auth, p256dh },
      };

      try {
        await webpush.sendNotification(subscription, body, {
          TTL: TTL_SECONDS,
          urgency: payload.urgent ? "high" : "normal",
        });

        return "ok" as const;
      } catch (error) {
        const status = statusCodeOf(error);

        // 404 and 410 both mean "this subscription does not exist any more".
        // Anything else — a 429, a 502, a timeout — is about right now, and the
        // row is left alone so the next notification tries again.
        if (status === 404 || status === 410) {
          dead.push(target.token);

          return "gone" as const;
        }

        return "error" as const;
      }
    }
  };

  for (let index = 0; index < targets.length; index += MAX_CONCURRENT_SENDS) {
    const results = await Promise.allSettled(
      targets.slice(index, index + MAX_CONCURRENT_SENDS).map(deliver),
    );

    for (const result of results) {
      if (result.status === "fulfilled" && result.value === "ok") {
        sent += 1;
      }
    }
  }

  return { revoked: dead, sent };
}

const PUSH_HOSTS = ["fcm.googleapis.com", "push.services.mozilla.com", "notify.windows.com", "push.apple.com"];

/** Whether `endpoint` is an https URL on a browser push service (Go: push.IsPushService). */
export function isPushService(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.port !== "") return false;
  const host = url.hostname.toLowerCase();
  return PUSH_HOSTS.some((d) => host === d || host.endsWith(`.${d}`));
}
