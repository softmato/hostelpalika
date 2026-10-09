/**
 * The socket's lifecycle, tied to the signed-in account.
 *
 * Connects when there is one, disconnects when there is not, and reconnects
 * when the app comes back to the foreground. Everything it receives is routed
 * through `lib/resource-bus`, so no screen subscribes to Pusher directly — a
 * screen names its topics on `useResource` and that is the whole contract.
 */

import { useEffect, useRef } from "react";
import { AppState } from "react-native";

import { useAppSelector } from "@/hooks/redux";
import { presentLiveNotification } from "@/lib/live-notifier";
import { claimNotificationSound } from "@/lib/notification-sound";
import {
  connectRealtime,
  type RealtimeConnection,
  type RealtimeNotification,
} from "@/lib/realtime";
import { playNotificationDrop } from "@/lib/sound-effects";
import { toastInfo, toastUrgent } from "@/lib/toast";

/**
 * The socket can deliver in the moment after the app is backgrounded, before
 * Android suspends it. The push arriving then sounds through its channel with
 * no handler to see a claim, so a chime here as well would be a second one.
 */
function isOnScreen() {
  return AppState.currentState === "active";
}

/**
 * A live row goes to the phone's notification shade, like its push — see
 * `lib/live-notifier.ts`. The toast is only for a phone without notification
 * permission, where the shade is not ours to write to.
 */
function showLive(payload: RealtimeNotification) {
  void presentLiveNotification(payload).then((shown) => {
    if (shown) return;
    const urgent =
      payload.priority === "URGENT" || payload.priority === "HIGH" || payload.kind === "ACTION";
    (urgent ? toastUrgent : toastInfo)(payload.title, payload.body);
  });
}

export function useRealtime() {
  const userId = useAppSelector((state) => state.auth.account?.id ?? null);
  const connection = useRef<RealtimeConnection | null>(null);

  useEffect(() => {
    if (!userId) {
      return;
    }

    let cancelled = false;

    async function open() {
      const client = await connectRealtime({
        /*
         * A platform-wide broadcast arrives with no durable row behind it —
         * the dispatch cron writes those later, for people who were offline.
         * So this is shown immediately and left to be de-duplicated by the
         * bell, which reads the row when it eventually exists.
         */
        onAnnouncement: (payload) => {
          if (!isOnScreen()) {
            return;
          }

          playNotificationDrop();
          showLive(payload);
        },
        /*
         * Surfaced rather than only badging the bell: the entire reason for
         * the socket is that some of these cannot wait for someone to go
         * looking. Drawn in the shade as a system notification, and the push
         * for the same row is hidden when it lands — one banner per row.
         */
        onNotification: (payload) => {
          // In the background the push is what the shade shows; drawing it
          // here as well would be a second banner for one row.
          if (!isOnScreen()) {
            return;
          }

          // Keyed on the row id, which the push for the same row carries as
          // `notificationId` — the push handler then shows it silently.
          if (claimNotificationSound(payload.id)) {
            playNotificationDrop();
          }

          showLive(payload);
        },
      });

      if (cancelled) {
        // Signed out while the config request was in flight. Without this the
        // socket outlives the session it was opened for.
        client?.disconnect();
        return;
      }

      connection.current = client;
    }

    void open();

    return () => {
      cancelled = true;
      connection.current?.disconnect();
      connection.current = null;
    };
  }, [userId]);

  useEffect(() => {
    if (!userId) {
      return;
    }

    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        connection.current?.reconnect();
      }
    });

    return () => subscription.remove();
  }, [userId]);
}
