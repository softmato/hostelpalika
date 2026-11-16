/*
 * The service worker that receives browser push notifications.
 *
 * API responses and website pages are never cached. The one exception is the
 * installed app's shell under `/app` (its HTML, hashed bundles, fonts, icons),
 * so the PWA opens offline the way the Android app does; its data already
 * lives in IndexedDB (`apps/mobile/web/local-db.ts`). The share-target handler
 * below stages private receipt files locally for handoff to the app, with expiry.
 *
 * ## The payload
 *
 * Written by `web-push.service.ts` and read here. Flat and small, because push
 * services cap the encrypted body around 4 KB:
 *
 *   { title, body, url, category, tag, icon, badge, image, notificationId, urgent }
 *
 * `url` is decided on the server by `web-routing.ts` — the recipient's portal
 * is known there and not here — and is always a same-origin path. It is
 * re-checked below anyway: a client that trusts a field because the server
 * promised to sanitise it is one server bug away from opening whatever an
 * attacker likes.
 */

const FALLBACK_TITLE = "New notification";
const FALLBACK_URL = "/";

/** Must match `NOTIFICATION_SOUND_MESSAGE` in `src/lib/notification-sound.ts`. */
const SOUND_MESSAGE = "hostelhub:play-notification-sound";

/**
 * How long open tabs get to say they played the tone. A frozen background tab
 * never answers, and a notification is not held back longer than this for it.
 */
const SOUND_HANDOFF_MS = 1000;

self.addEventListener("install", () => {
  // No precache to wait for, so take over immediately rather than sitting in
  // "waiting" until every tab is closed — which for a portal somebody keeps
  // open all day is functionally never.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  event.waitUntil(showNotification(event));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  event.waitUntil(openTarget(event.notification.data && event.notification.data.url));
});

/**
 * Re-subscribe when the browser rotates the subscription behind our back.
 *
 * Fires rarely and entirely without a page — a key rotation at the push
 * service, a browser update. Without this the old endpoint keeps being sent to
 * until it 410s and gets pruned, and the person simply stops receiving
 * notifications with nothing anywhere to explain why.
 */
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(resubscribe(event));
});

function readPayload(event) {
  if (!event.data) {
    return {};
  }

  try {
    return event.data.json();
  } catch {
    // A push with a body we did not write. Still worth showing rather than
    // dropping — a silent push is a spent wake-up with nothing to show for it.
    return { body: event.data.text() };
  }
}

/** Same-origin paths only. `//evil.example` reads local and resolves off-origin. */
function safePath(value) {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) {
    return FALLBACK_URL;
  }

  return value;
}

/**
 * Ask every open tab to play our tone, and report whether one did.
 *
 * A notification cannot carry a custom sound — see `lib/notification-sound.ts`
 * — so the tone has to come from a page. Each tab answers on its own port with
 * "played", "already" (the socket, or another tab, got there first) or
 * "failed" (autoplay refused it); the first yes settles it. No tabs, no yes, or
 * no answer in time all mean the system sound is still wanted.
 */
async function askTabsToSound(notificationId) {
  let clients = [];

  try {
    clients = await self.clients.matchAll({ includeUncontrolled: true, type: "window" });
  } catch {
    return false;
  }

  if (clients.length === 0) {
    return false;
  }

  return new Promise((resolve) => {
    let waiting = clients.length;
    const timer = setTimeout(() => resolve(false), SOUND_HANDOFF_MS);

    const answer = (sounded) => {
      waiting -= 1;

      if (sounded || waiting === 0) {
        clearTimeout(timer);
        resolve(sounded);
      }
    };

    for (const client of clients) {
      const channel = new MessageChannel();

      channel.port1.onmessage = (message) =>
        answer(message.data === "played" || message.data === "already");

      try {
        client.postMessage({ notificationId, type: SOUND_MESSAGE }, [channel.port2]);
      } catch {
        answer(false);
      }
    }
  });
}

async function showNotification(event) {
  const payload = readPayload(event);
  const url = safePath(payload.url);

  // Urgent pushes are never handed off: an SOS keeps the system sound and its
  // vibration however many tabs say they chimed.
  const soundedByTab = payload.urgent ? false : await askTabsToSound(payload.notificationId);

  await self.registration.showNotification(payload.title || FALLBACK_TITLE, {
    badge: payload.badge || "/notification-badge.png",
    body: payload.body || "",
    data: { category: payload.category, notificationId: payload.notificationId, url },
    icon: payload.icon || "/notification-icon.png",
    // Large preview — the product photo on a store order, the meal photo on a
    // food announcement. Ignored where unsupported, so no feature detection.
    image: payload.image || undefined,
    // Replaces the previous notification with the same tag instead of stacking
    // beside it, which is what makes a batched row ("5 people reacted") read
    // correctly on the desktop as well as in the bell.
    renotify: Boolean(payload.tag),
    requireInteraction: Boolean(payload.urgent),
    // Our tone already played in an open tab; the system's would be a second.
    // Never true alongside `vibrate` — that pairing throws — which holds
    // because only urgent pushes vibrate and those are never handed off.
    silent: soundedByTab,
    tag: payload.tag || undefined,
    // An SOS should be felt, not just seen, on a phone browser.
    vibrate: payload.urgent ? [300, 120, 300, 120, 300] : undefined,
  });
}

/**
 * Focus the tab that is already on the target, otherwise reuse any open tab of
 * ours, otherwise open a new one.
 *
 * The middle case is the one that matters: somebody working in the portal all
 * day should not accumulate a window per notification.
 */
async function openTarget(rawUrl) {
  const target = new URL(safePath(rawUrl), self.location.origin);
  const clients = await self.clients.matchAll({
    includeUncontrolled: true,
    type: "window",
  });

  for (const client of clients) {
    if (client.url === target.href && "focus" in client) {
      await client.focus();
      return;
    }
  }

  for (const client of clients) {
    if ("navigate" in client && "focus" in client) {
      try {
        await client.navigate(target.href);
        await client.focus();
        return;
      } catch {
        // A cross-origin or otherwise un-navigable client. Fall through and
        // open a window instead of giving up on the click.
      }
    }
  }

  if (self.clients.openWindow) {
    await self.clients.openWindow(target.href);
  }
}

function urlBase64ToUint8Array(base64) {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(normalized);

  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}

async function resubscribe(event) {
  try {
    const keyResponse = await fetch("/api/v1/push/public-key", { cache: "no-store" });

    if (!keyResponse.ok) {
      return;
    }

    const key = (await keyResponse.json())?.data?.publicKey;

    if (!key) {
      return;
    }

    const subscription = await self.registration.pushManager.subscribe({
      applicationServerKey: urlBase64ToUint8Array(key),
      userVisibleOnly: true,
    });

    await fetch("/api/v1/push/subscribe", {
      body: JSON.stringify({ subscription: subscription.toJSON() }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });

    const previous = event.oldSubscription && event.oldSubscription.endpoint;

    if (previous) {
      await fetch("/api/v1/push/unsubscribe", {
        body: JSON.stringify({ endpoint: previous }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }).catch(() => null);
    }
  } catch {
    // Nothing to report to and nobody to report it to. The next page load
    // re-subscribes through `web-push-client.ts`.
  }
}

// A share POST is handled locally: financial files never enter a public URL.
const SHARE_CACHE = "hostelpalika-shared-payments-v1";
// The installed app's shell, so it opens offline (owner, 2026-11-16).
const SHELL_CACHE = "hostelpalika-app-shell-v1";
const SHELL_PAGE = "/app";
const SHELL_KEEP = 300;
const SHELL_FILES = ["/manifest.webmanifest", "/icon.png", "/apple-icon.png"];
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname === "/app/share-payment" && event.request.method === "POST") {
    event.respondWith(receivePaymentShare(event.request));
    return;
  }
  if (event.request.method !== "GET") return;
  const inApp = url.pathname === SHELL_PAGE || url.pathname.startsWith(SHELL_PAGE + "/");
  if (event.request.mode === "navigate" && inApp) {
    event.respondWith(shellPage(event.request));
  } else if (url.pathname.startsWith("/app/_expo/") || url.pathname.startsWith("/app/assets/") || SHELL_FILES.includes(url.pathname)) {
    event.respondWith(shellFile(event.request));
  }
});
// Network first, so a deploy shows at once; the saved page only when offline or stalled.
async function shellPage(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await Promise.race([
      fetch(request),
      new Promise((_, reject) => setTimeout(() => reject(new Error("slow")), 4000)),
    ]);
    if (response.ok) await cache.put(SHELL_PAGE, response.clone());
    return response;
  } catch (error) {
    const saved = await cache.match(SHELL_PAGE);
    if (saved) return saved;
    throw error;
  }
}
// Hashed and immutable: the saved copy is always right. Oldest dropped past SHELL_KEEP.
async function shellFile(request) {
  const cache = await caches.open(SHELL_CACHE);
  const saved = await cache.match(request);
  // Icons and the manifest are not hashed: serve the saved one, refresh it behind.
  if (saved && SHELL_FILES.includes(new URL(request.url).pathname)) {
    fetch(request).then((fresh) => fresh.ok && cache.put(request, fresh)).catch(() => {});
  }
  if (saved) return saved;
  const response = await fetch(request);
  if (response.ok) {
    await cache.put(request, response.clone());
    const keys = await cache.keys();
    for (const key of keys.slice(0, Math.max(0, keys.length - SHELL_KEEP))) {
      if (new URL(key.url).pathname !== SHELL_PAGE) await cache.delete(key);
    }
  }
  return response;
}
async function sniffType(file) {
  const b = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const ascii = (from, to) => String.fromCharCode(...b.slice(from, to));
  if (ascii(0, 4) === "%PDF") return "application/pdf";
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (b[0] === 0x89 && ascii(1, 4) === "PNG") return "image/png";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (ascii(4, 8) === "ftyp") return "image/heic";
  return "";
}
async function receivePaymentShare(request) {
  try {
    const form = await request.formData();
    // Older installed manifests may use a different field name. Inspect file
    // parts, never text/URLs, and still require exactly one attachment.
    const files = [...form.values()].filter(value => value instanceof File);
    const file = files[0];
    const reject = reason => Response.redirect(new URL("/app/receipt-sheet.html?error=" + reason, self.location.origin), 303);
    if (!files.length) return reject("missing");
    if (files.length > 1) return reject("multiple");
    if (!file.size) return reject("empty");
    if (file.size > 20 * 1024 * 1024) return reject("oversized");
    const extension = file.name.split(".").pop().toLowerCase();
    const aliases = { pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", heic: "image/heic", heif: "image/heif" };
    const suppliedType = file.type.toLowerCase().split(";")[0].trim();
    const generic = !suppliedType || ["application/octet-stream", "binary/octet-stream", "*/*"].includes(suppliedType);
    // eSewa/bank apps share statements as generic binary, sometimes with no
    // extension at all — fall back to the file's own magic bytes.
    const mimeType = suppliedType === "application/x-pdf" ? "application/pdf" : generic ? aliases[extension] || await sniffType(file) : suppliedType;
    if (!(mimeType.startsWith("image/") || mimeType === "application/pdf")) return reject("unsupported");
    const cache = await caches.open(SHARE_CACHE);
    for (const key of await cache.keys()) {
      const stored = await cache.match(key);
      if (Number(stored.headers.get("x-shared-at")) < Date.now() - 3600000) await cache.delete(key);
    }
    const outstanding = await cache.keys();
    for (const key of outstanding.slice(0, Math.max(0, outstanding.length - 4))) await cache.delete(key);
    const id = crypto.randomUUID();
    await cache.put(new URL("/app/_shared-payment/" + id, self.location.origin), new Response(file, {
      headers: { "content-type": mimeType, "x-shared-at": String(Date.now()), "x-file-name": encodeURIComponent(file.name) },
    }));
    return Response.redirect(new URL("/app/receipt-sheet.html?share=" + id, self.location.origin), 303);
  } catch {
    return Response.redirect(new URL("/app/receipt-sheet.html?error=unavailable", self.location.origin), 303);
  }
}
