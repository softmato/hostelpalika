import Pusher from "pusher";

import { logger } from "@/lib/logger";
import {
  GLOBAL_CHANNEL,
  PLATFORM_CHANNEL,
  REALTIME_EVENT,
  TRACK_SHEET_CHANNEL,
  hostelChannel,
  userChannel,
  type RealtimeTopic,
} from "@/lib/realtime/channels";
import { bumpHostelCache } from "@/lib/redis-cache";

/**
 * Server side of the real-time layer.
 *
 * Every export here is best-effort and never throws. Publishing happens *after*
 * the row that triggered it is committed, so a Pusher outage must not turn a
 * successful approval or payment into a failed request — the same rule the
 * email fan-outs follow (RULES.md §8). When the credentials are absent the
 * whole module degrades to a no-op and the portals fall back to TanStack
 * Query's polling, which is why local development needs no Pusher account.
 */

let client: Pusher | null = null;
let resolved = false;

function pusherClient() {
  if (resolved) {
    return client;
  }

  resolved = true;

  const appId = process.env.PUSHER_APP_ID;
  const key = process.env.PUSHER_KEY;
  const secret = process.env.PUSHER_SECRET;
  const cluster = process.env.PUSHER_CLUSTER;

  if (!appId || !key || !secret || !cluster) {
    logger.debug("realtime disabled: PUSHER_* credentials are not configured");
    return null;
  }

  client = new Pusher({ appId, cluster, key, secret, useTLS: true });

  return client;
}

export function isRealtimeConfigured() {
  return pusherClient() !== null;
}

/**
 * Sign a subscription for an already-authorised subscriber. A presence channel
 * also carries who they are, which every other member is shown.
 */
export function authorizeRealtimeChannel(
  socketId: string,
  channel: string,
  member?: { user_id: string; user_info: Record<string, unknown> },
) {
  const pusher = pusherClient();

  if (!pusher) {
    return null;
  }

  return pusher.authorizeChannel(socketId, channel, member);
}

type BatchEvent = { channel: string; data: unknown; name: string };

/**
 * Pusher accepts at most 10 events per batch call, so long fan-outs (a notice
 * to every resident in a hostel) are chunked rather than sent one at a time.
 */
async function publish(events: BatchEvent[]) {
  const pusher = pusherClient();

  if (!pusher || events.length === 0) {
    return;
  }

  try {
    for (let index = 0; index < events.length; index += 10) {
      await pusher.triggerBatch(events.slice(index, index + 10));
    }
  } catch (error) {
    logger.warn("realtime publish failed", { error: String(error) });
  }
}

/** Push one person's new notification straight into their open bell. */
export async function publishNotification(
  userId: string,
  notification: Record<string, unknown>,
) {
  await publish([
    {
      channel: userChannel(userId),
      data: notification,
      name: REALTIME_EVENT.NOTIFICATION_NEW,
    },
  ]);
}

/** Tell a user's other open tabs that a notification changed state. */
export async function publishNotificationUpdated(userId: string, notificationId: string) {
  await publish([
    {
      channel: userChannel(userId),
      data: { id: notificationId },
      name: REALTIME_EVENT.NOTIFICATION_UPDATED,
    },
  ]);
}

/**
 * Broadcast to every signed-in account at once, on `private-global`.
 *
 * For platform-wide announcements only — a maintenance window, a policy change,
 * a campaign going live. One socket message reaches everyone, which is the only
 * way a broadcast to the whole user base is affordable; durable per-recipient
 * rows still come from the campaign dispatch cron for anyone offline.
 *
 * `campaignId` lets a client that gets both the broadcast and the row show one
 * item rather than two.
 */
export async function publishGlobalAnnouncement(input: {
  body: string;
  campaignId?: string;
  category?: string;
  priority?: "LOW" | "NORMAL" | "HIGH" | "URGENT";
  title: string;
  url?: string;
}) {
  await publish([
    {
      channel: GLOBAL_CHANNEL,
      data: {
        body: input.body,
        campaignId: input.campaignId,
        category: input.category ?? "ANNOUNCEMENT",
        priority: input.priority ?? "NORMAL",
        sentAt: new Date().toISOString(),
        title: input.title,
        url: input.url,
      },
      name: REALTIME_EVENT.GLOBAL_ANNOUNCEMENT,
    },
  ]);
}

/**
 * Announce that server-side data moved, so every portal panel watching one of
 * these topics refetches instead of waiting for its next poll.
 *
 * Scope it as narrowly as the change allows: `hostelIds` for tenant data,
 * `platform` for the staff queues, `userIds` for one person's own screens.
 */
export async function publishResourceChange(input: {
  /**
   * Everyone signed in. For genuinely cross-tenant surfaces only — the
   * community is one platform-wide room, so a post there is not a hostel's
   * business to scope.
   */
  global?: boolean;
  hostelIds?: (string | undefined | null)[];
  platform?: boolean;
  topics: RealtimeTopic[];
  userIds?: (string | undefined | null)[];
}) {
  if (input.topics.length === 0) {
    return;
  }

  await bumpHostelCache(input.hostelIds ?? []);

  const data = { topics: input.topics };
  const channels = new Set<string>();

  for (const hostelId of input.hostelIds ?? []) {
    if (hostelId) {
      channels.add(hostelChannel(hostelId));
    }
  }

  for (const userId of input.userIds ?? []) {
    if (userId) {
      channels.add(userChannel(userId));
    }
  }

  if (input.platform) {
    channels.add(PLATFORM_CHANNEL);
  }

  if (input.global) {
    channels.add(GLOBAL_CHANNEL);
  }

  await publish(
    [...channels].map((channel) => ({
      channel,
      data,
      name: REALTIME_EVENT.RESOURCE_CHANGED,
    })),
  );
}

/** Tell everyone on the registration track sheet where a viewer is, or that lines were saved. */
export async function publishTrackSheet(name: string, data: Record<string, unknown>) {
  await publish([{ channel: TRACK_SHEET_CHANNEL, data, name }]);
}
