/**
 * A notification that arrived over the socket, drawn in the phone's own
 * notification shade — the same banner its push would have been.
 *
 * `useRealtime` used to show every live row as an in-app toast: gone in four
 * seconds, never in the shade, and on a phone whose push had not landed yet (or
 * never would) the only trace the notification left. This posts it as a real
 * system notification instead, exactly like the download notices in
 * `upload-notifier.ts`, and keeps the toast only for a phone that has not
 * granted notification permission.
 *
 * The push for the same row still arrives. Whichever of the two reaches the app
 * first claims the banner (`claimNotificationDisplay`); the handler in
 * `push-notifications.ts` hides the second, so one notification is one banner.
 */

import * as Notifications from "expo-notifications";

import { claimNotificationDisplay } from "@/lib/notification-sound";
import { notificationRoute, PUSH_FALLBACK_PATH } from "@/lib/push-link";
import { PUSH_CHANNEL } from "@/lib/push-notifications";
import type { RealtimeNotification } from "@/lib/realtime";

/** Marks our own echo, so the handler neither hides it nor sounds it twice. */
export const LIVE_ECHO = "liveEcho";

/** The banner key for a socket payload: the row id, or the broadcast's campaign. */
export function liveDisplayKey(payload: { campaignId?: unknown; id?: unknown }): string | null {
  if (typeof payload.id === "string" && payload.id) return payload.id;
  if (typeof payload.campaignId === "string" && payload.campaignId) return `campaign:${payload.campaignId}`;
  return null;
}

/**
 * Post one live notification to the shade. Resolves `false` when it could not —
 * no permission — so the caller can fall back to a toast; `true` when it was
 * shown here or its push had already shown it.
 */
export async function presentLiveNotification(
  payload: RealtimeNotification & { campaignId?: string; data?: unknown },
): Promise<boolean> {
  const permission = await Notifications.getPermissionsAsync().catch(() => null);

  if (!permission?.granted) {
    return false;
  }

  if (!claimNotificationDisplay(liveDisplayKey(payload))) {
    return true;
  }

  const urgent = payload.priority === "URGENT" || payload.priority === "HIGH";

  await Notifications.scheduleNotificationAsync({
    content: {
      body: payload.body,
      data: {
        [LIVE_ECHO]: true,
        category: payload.category,
        notificationId: payload.id,
        path: notificationRoute(payload) ?? PUSH_FALLBACK_PATH,
        urgent,
      },
      title: payload.title,
    },
    // The channel rides on the trigger — in `content` Android ignores it.
    trigger: { channelId: urgent ? PUSH_CHANNEL.URGENT : PUSH_CHANNEL.DEFAULT },
  }).catch(() => undefined);

  return true;
}
