/**
 * The bell.
 *
 * Typed from `apps/web/src/modules/notifications/notification.service.ts` —
 * `serializeNotification` and `listNotifications` — not from the route names.
 *
 * ## One list for every role
 *
 * `GET /notifications` runs `requireApiPrincipal` and filters on
 * `userId: principal.userId`, with no role branch and no hostel scope. So a
 * resident, a cook, a warden and a `PUBLIC_USER` all read their own rows through
 * this one call, and the bell is the same component everywhere.
 *
 * ## The fields left out on purpose
 *
 * `actions[]` and `actionState` drive the web's inline Approve/Reject buttons.
 * Each action is an `{ endpoint, method, payload }` the client is expected to
 * fire blind — building that on mobile means a button whose failure mode is a
 * silent POST to a route this app has never called. `needsAction` is kept,
 * because "this is waiting on you" is worth showing even when the only place to
 * act is the web portal, and the screen says as much.
 *
 * The one exception is the night question (`NIGHT_STATUS`): the app answers it
 * through its own `setResidentNightStatus`, not the row's blind action, and the
 * server settles the row from every surface — so `actionState` and
 * `data.answer` are read for it.
 */

import { api } from "@/lib/api";
import { type ApiEnvelope, unwrap } from "@/lib/api-contract";

export type NotificationFilter = "action" | "all" | "unread";

export type AppNotification = {
  /** `COMPLETED` once acted on. Read only for the night question. */
  actionState?: "COMPLETED" | "DISMISSED" | "PENDING";
  /** Which action was taken — the night status, for the night question. */
  actionTakenKey?: string;
  /** A **web** path, not an app route — `notificationRoute` maps it onto one. */
  actionUrl?: string;
  body: string;
  /** `FINANCE`, `COMPLAINT`, `SAFETY`, … — free text server-side. */
  category: string;
  createdAt?: string;
  /** Written by many call sites and not a stable schema — read it defensively. */
  data?: Record<string, unknown>;
  id: string;
  isRead: boolean;
  /** An ACTION row still sitting at `PENDING`. Not the same as unread. */
  needsAction: boolean;
  priority: "HIGH" | "LOW" | "NORMAL" | "URGENT";
  title: string;
};

export type NotificationFeed = {
  actionCount: number;
  notifications: AppNotification[];
  unreadCount: number;
};

export async function listNotifications(filter: NotificationFilter = "all") {
  const response = await api.get<ApiEnvelope<NotificationFeed>>("/notifications", {
    params: { filter },
  });

  return unwrap(response);
}

/** PATCH, not POST — the row already exists and only `readAt` moves. */
export async function markNotificationRead(id: string) {
  await api.patch(`/notifications/${encodeURIComponent(id)}/read`);
}

export async function markAllNotificationsRead() {
  await api.patch("/notifications/read-all");
}
