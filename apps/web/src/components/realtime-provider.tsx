"use client";

import { pusherChannelAuth } from "@/lib/api-url";
import type { Channel } from "pusher-js";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { browserApi } from "@/lib/browser-api";
import { useInvalidateResources } from "@/lib/portal-query";
import {
  REALTIME_EVENT,
  TOPIC_ENDPOINTS,
  endpointsForTopics,
} from "@/lib/realtime/channels";
import { playNotificationSound, primeNotificationSound } from "@/lib/notification-sound";
import { toast } from "@/stores/toast-store";

/**
 * Browser side of the real-time layer.
 *
 * Mounted once per authenticated portal (inside `PortalShell`), it opens a
 * single Pusher socket for the whole tab and turns server events into cache
 * invalidations. That is what makes every panel and tab live without each one
 * subscribing for itself: a `resource:changed` event names the domain topics
 * that moved, and this provider drops the matching query cache entries, so any
 * mounted panel reading one of those endpoints refetches immediately while the
 * rest stay untouched.
 *
 * Degradation is deliberate and total. No credentials, a blocked socket, or a
 * failed config fetch all end in the same place: `connected: false` and the
 * portals keep running on TanStack Query's ordinary polling. Nothing here is
 * load-bearing for correctness — it only shortens the delay.
 */

type RealtimeConfig = {
  channels: string[];
  cluster: string;
  enabled: boolean;
  key: string;
};

export type RealtimeNotification = {
  actionUrl?: string;
  body: string;
  category: string;
  createdAt?: string;
  id: string;
  isRead: boolean;
  kind?: string;
  title: string;
};

type RealtimeContextValue = {
  connected: boolean;
  /** Notifications that arrived over the socket this session, newest first. */
  liveNotifications: RealtimeNotification[];
  /** Drop the live queue, e.g. once the bell has been opened. */
  clearLive: () => void;
};

const RealtimeContext = createContext<RealtimeContextValue>({
  clearLive: () => {},
  connected: false,
  liveNotifications: [],
});

export function useRealtime() {
  return useContext(RealtimeContext);
}

const NOTIFICATION_ENDPOINTS = TOPIC_ENDPOINTS.notifications;

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const invalidate = useInvalidateResources();
  const [connected, setConnected] = useState(false);
  const [liveNotifications, setLiveNotifications] = useState<RealtimeNotification[]>([]);

  // The socket handlers are created once but must always call the *current*
  // invalidator, so it goes through a ref rather than into the effect's deps —
  // otherwise every render would tear the connection down and rebuild it.
  const invalidateRef = useRef(invalidate);

  useEffect(() => {
    invalidateRef.current = invalidate;
  }, [invalidate]);

  const clearLive = useCallback(() => setLiveNotifications([]), []);

  // The socket chimes whether or not browser push is on, so a portal tab always
  // gets the tone ready — see `primeNotificationSound`.
  useEffect(() => primeNotificationSound(), []);

  useEffect(() => {
    let cancelled = false;
    let cleanup: (() => void) | undefined;

    async function connect() {
      let config: RealtimeConfig;

      try {
        config = await browserApi<RealtimeConfig>("/api/v1/realtime/config");
      } catch {
        // Unauthenticated, offline, or realtime not deployed — stay on polling.
        return;
      }

      if (cancelled || !config.enabled || !config.key || config.channels.length === 0) {
        return;
      }

      // Loaded lazily so the ~40kB client never lands in the first paint of a
      // deployment that has no Pusher credentials at all.
      const { default: Pusher } = await import("pusher-js");

      if (cancelled) {
        return;
      }

      const client = new Pusher(config.key, {
        channelAuthorization: pusherChannelAuth,
        cluster: config.cluster,
      });

      client.connection.bind("connected", () => setConnected(true));
      client.connection.bind("disconnected", () => setConnected(false));
      client.connection.bind("error", () => setConnected(false));

      const channels: Channel[] = config.channels.map((name) => {
        const channel = client.subscribe(name);

        channel.bind(REALTIME_EVENT.NOTIFICATION_NEW, (payload: RealtimeNotification) => {
          setLiveNotifications((current) => {
            if (current.some((item) => item.id === payload.id)) {
              return current;
            }

            return [payload, ...current].slice(0, 20);
          });
          invalidateRef.current(...NOTIFICATION_ENDPOINTS);

          // Surface it immediately rather than only badging the bell — the
          // whole reason for the socket is that some of these are urgent.
          const needsAction = payload.kind === "ACTION";

          toast[needsAction ? "warning" : "info"]({
            description: payload.body,
            title: payload.title,
          });

          // Keyed on the row id, which the push for the same row carries as
          // `notificationId` — so whichever lands first sounds, once.
          void playNotificationSound(payload.id);
        });

        channel.bind(REALTIME_EVENT.NOTIFICATION_UPDATED, () => {
          invalidateRef.current(...NOTIFICATION_ENDPOINTS);
        });

        channel.bind(
          REALTIME_EVENT.GLOBAL_ANNOUNCEMENT,
          (payload: {
            body?: string;
            campaignId?: string;
            priority?: string;
            title?: string;
          }) => {
            if (!payload?.title) {
              return;
            }

            // One broadcast reaches every tab's socket; the campaign id is what
            // lets them agree to chime once between them.
            void playNotificationSound(
              payload.campaignId ? `campaign:${payload.campaignId}` : undefined,
            );

            // Platform-wide, so it is deliberately loud: pinned for URGENT,
            // auto-dismissing otherwise.
            const urgent = payload.priority === "URGENT" || payload.priority === "HIGH";

            toast[urgent ? "warning" : "info"]({
              description: payload.body,
              duration: urgent ? 0 : 8000,
              title: payload.title,
            });

            invalidateRef.current(...NOTIFICATION_ENDPOINTS);
          },
        );

        channel.bind(
          REALTIME_EVENT.RESOURCE_CHANGED,
          (payload: { topics?: string[] }) => {
            const endpoints = endpointsForTopics(payload?.topics ?? []);

            if (endpoints.length > 0) {
              invalidateRef.current(...endpoints);
            }
          },
        );

        return channel;
      });

      cleanup = () => {
        for (const channel of channels) {
          channel.unbind_all();
          client.unsubscribe(channel.name);
        }

        client.disconnect();
        setConnected(false);
      };
    }

    void connect();

    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, []);

  const value = useMemo(
    () => ({ clearLive, connected, liveNotifications }),
    [clearLive, connected, liveNotifications],
  );

  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}
