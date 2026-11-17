/**
 * The Pusher socket.
 *
 * Mirrors `apps/web/src/components/realtime-provider.tsx` — same channels, same
 * events, same degradation — with two differences that are forced by the
 * platform rather than chosen.
 *
 * ## 1. `require`, and pull `.Pusher` off the namespace
 *
 * The default browser build references DOM globals that do not exist in Hermes.
 * The React Native build does not, but its v8 webpack bundle ends with
 * `module.exports.Pusher = r` — so `import Pusher from "pusher-js/react-native"`
 * resolves to `undefined` and `new undefined()` throws "constructor is not
 * callable". The class has to be read off the required namespace explicitly.
 *
 * It also imports `@react-native-community/netinfo` at load time; Metro
 * redirects that to `src/shims/netinfo.js`. See `metro.config.js`.
 *
 * ## 2. A custom authorizer, because there is no cookie
 *
 * The web sets `authEndpoint: "/api/v1/realtime/auth"` and lets the browser
 * attach the session cookie. A phone has no cookie — it has a bearer token that
 * rotates. Pusher's `auth.headers` option is read **once, at construction**, so
 * a token captured there goes stale at the first refresh and every subsequent
 * subscribe 401s; the socket stays up and simply stops receiving, which is the
 * hardest possible version of this bug to notice.
 *
 * So authorisation goes through `api` — the axios instance that already
 * attaches the current token and handles 401 → refresh → retry. One
 * implementation of session handling, not two.
 *
 * ## Everything here is optional
 *
 * No credentials on the server, a blocked socket, a failed config fetch: all
 * end at "no socket", and the app keeps working on `use-resource`'s
 * refetch-on-focus. Nothing in this file is load-bearing for correctness — it
 * only shortens the delay.
 */

import { api } from "@/lib/api";
import { publishTopics } from "@/lib/resource-bus";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const PusherModule = require("pusher-js/react-native");
const Pusher = PusherModule?.Pusher ?? PusherModule?.default ?? PusherModule;

/** Mirrors `REALTIME_EVENT` in `apps/web/src/lib/realtime/channels.ts`. */
export const REALTIME_EVENT = {
  GLOBAL_ANNOUNCEMENT: "global:announcement",
  NOTIFICATION_NEW: "notification:new",
  NOTIFICATION_UPDATED: "notification:updated",
  RESOURCE_CHANGED: "resource:changed",
} as const;

export type RealtimeConfig = {
  channels: string[];
  cluster: string;
  enabled: boolean;
  key: string;
};

/** `serializeNotification`'s shape, as broadcast on `notification:new`. */
export type RealtimeNotification = {
  actionUrl?: string;
  /** The branch the row belongs to; absent = account-wide. */
  hostelId?: string | null;
  body: string;
  category: string;
  createdAt?: string;
  id: string;
  isRead: boolean;
  kind?: string;
  priority?: string;
  title: string;
};

export type RealtimeHandlers = {
  /** A platform-wide broadcast with no durable row behind it yet. */
  onAnnouncement?: (payload: RealtimeNotification) => void;
  onConnectionChange?: (connected: boolean) => void;
  onNotification?: (payload: RealtimeNotification) => void;
  /** A notification was read or actioned on another device. */
  onNotificationUpdated?: () => void;
};

export type RealtimeConnection = {
  disconnect: () => void;
  /** Nudges the socket after the app returns to the foreground. */
  reconnect: () => void;
};

async function fetchConfig(): Promise<RealtimeConfig | null> {
  try {
    const response = await api.get<{ data: RealtimeConfig }>("/realtime/config");

    return response.data?.data ?? null;
  } catch {
    // Signed out, offline, or realtime not deployed. Polling covers it.
    return null;
  }
}

/**
 * Pusher's authorizer contract: it hands us the socket id and expects the
 * `{ auth, channel_data? }` body back through the callback.
 *
 * The endpoint reads `socket_id` and `channel_name` as **form fields**
 * (`request.formData()`), not JSON — posting JSON here returns a 400 that says
 * nothing about the encoding. It also answers with the bare `{ auth }` object
 * rather than the usual success envelope, which is why this reads
 * `response.data` directly instead of going through `unwrap`.
 */
function authorizer(channel: { name: string }) {
  return {
    authorize(socketId: string, callback: (error: Error | null, data?: unknown) => void) {
      const body = new URLSearchParams();
      body.append("socket_id", socketId);
      body.append("channel_name", channel.name);

      api
        .post("/realtime/auth", body.toString(), {
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
        })
        .then((response) => callback(null, response.data))
        .catch((error: Error) => callback(error));
    },
  };
}

/**
 * Opens the socket and binds every channel the server says this account may
 * join. Returns null when realtime is unavailable, which callers treat as
 * "carry on".
 */
export async function connectRealtime(
  handlers: RealtimeHandlers,
): Promise<RealtimeConnection | null> {
  const config = await fetchConfig();

  if (!config?.enabled || !config.key || config.channels.length === 0) {
    return null;
  }

  const client = new Pusher(config.key, {
    authorizer,
    cluster: config.cluster,
  });

  client.connection.bind("connected", () => handlers.onConnectionChange?.(true));
  client.connection.bind("disconnected", () => handlers.onConnectionChange?.(false));
  client.connection.bind("error", () => handlers.onConnectionChange?.(false));

  const names = [...config.channels];

  for (const name of names) {
    const channel = client.subscribe(name);

    channel.bind(REALTIME_EVENT.NOTIFICATION_NEW, (payload: RealtimeNotification) => {
      handlers.onNotification?.(payload);
      // The bell's own list is a resource like any other, so it refreshes
      // through the same bus rather than through a second mechanism.
      publishTopics(["notifications"]);
    });

    channel.bind(REALTIME_EVENT.NOTIFICATION_UPDATED, () => {
      handlers.onNotificationUpdated?.();
      publishTopics(["notifications"]);
    });

    channel.bind(REALTIME_EVENT.GLOBAL_ANNOUNCEMENT, (payload: RealtimeNotification) => {
      if (!payload?.title) {
        return;
      }

      handlers.onAnnouncement?.(payload);
      publishTopics(["notifications"]);
    });

    channel.bind(REALTIME_EVENT.RESOURCE_CHANGED, (payload: { topics?: string[] }) => {
      publishTopics(payload?.topics ?? []);
    });
  }

  return {
    disconnect() {
      for (const name of names) {
        client.unsubscribe(name);
      }

      client.disconnect();
      handlers.onConnectionChange?.(false);
    },
    /*
     * Android suspends the socket when the app goes to the background and
     * Pusher does not always notice on the way back — it sits in `connecting`
     * with a backoff that can be tens of seconds, which is exactly when the
     * user is looking at a stale screen. `connect()` on an already-connected
     * client is a no-op, so this is safe to call on every foreground.
     */
    reconnect() {
      if (client.connection.state !== "connected") {
        client.connect();
      }
    },
  };
}
