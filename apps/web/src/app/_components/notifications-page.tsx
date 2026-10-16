"use client";

import { Bell, CheckCheck, ChevronRight, Loader2 } from "@/components/icons";
import Link from "next/link";
import { memo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  TONE_CHIP,
  notificationDisplay,
  relativeTime,
} from "@/lib/notification-display";
import {
  useNotifications,
  type NotificationFilter,
  type NotificationItem,
} from "@/lib/use-notifications";
import { cn } from "@/lib/utils";
import { Message, PageHeader } from "./daily-operations-shared";
import { EmptyState, Panel } from "@/app/_components/shared-ui";

/**
 * The full notification archive, shared by the resident, guardian and hostel
 * admin portals.
 *
 * Same data, same hook and the same three tabs as the header bell, so the two
 * never disagree about what is unread or what is still waiting on a decision.
 * This page is the roomier view: full body text, and the action buttons laid
 * out rather than squeezed under a dropdown row.
 */

const FILTERS: { label: string; value: NotificationFilter }[] = [
  { label: "All", value: "all" },
  { label: "Unread", value: "unread" },
  { label: "Needs action", value: "action" },
];

const NotificationCard = memo(function NotificationCard({
  busy,
  notification,
  onDismiss,
  onMarkRead,
  onRun,
}: {
  busy: string | null;
  notification: NotificationItem;
  onDismiss: (id: string) => void;
  onMarkRead: (id: string) => void;
  onRun: (notification: NotificationItem, actionKey: string) => void;
}) {
  const display = notificationDisplay(notification.category);
  const Icon = display.icon;

  return (
    // Clicking anywhere on an unread card acknowledges it, the same as the bell.
    <div
      className={cn(
        "relative overflow-hidden rounded-xl border p-4 transition-colors",
        notification.needsAction
          ? "border-amber-300 bg-amber-50/40 dark:border-amber-500/40 dark:bg-amber-500/5"
          : "border-border",
        notification.isRead ? "" : "cursor-pointer",
      )}
      onClick={notification.isRead ? undefined : () => onMarkRead(notification.id)}
    >
      {/* Faded rather than swapped, so marking read visibly settles the card. */}
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-0 bg-linear-to-r from-primary/15 via-primary/5 to-transparent transition-opacity duration-300",
          notification.isRead ? "opacity-0" : "opacity-100",
        )}
      />
      <div className="relative flex items-start gap-3">
        <span
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-lg",
            TONE_CHIP[display.tone],
          )}
        >
          <Icon className="size-4.5" />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-semibold text-foreground">{notification.title}</p>

            <Badge className="h-5 rounded px-1.5 text-[10px] font-semibold" variant="outline">
              {display.label}
            </Badge>

            {notification.needsAction ? (
              <Badge className="h-5 rounded px-1.5 text-[10px] font-bold" variant="default">
                ACTION NEEDED
              </Badge>
            ) : null}

            {notification.actionState === "COMPLETED" ? (
              <Badge
                className="h-5 rounded border-emerald-300 px-1.5 text-[10px] font-semibold text-emerald-600 dark:border-emerald-500/40 dark:text-emerald-400"
                variant="outline"
              >
                RESOLVED
              </Badge>
            ) : null}

            {!notification.isRead ? (
              <span className="size-1.5 rounded-full bg-rose-500" />
            ) : null}

            <span className="ml-auto text-[11px] text-muted-foreground">
              {relativeTime(notification.createdAt)}
            </span>
          </div>

          <p className="mt-1 text-sm text-muted-foreground">{notification.body}</p>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {notification.needsAction
              ? notification.actions.map((action) => (
                  <Button
                    disabled={busy !== null}
                    key={action.key}
                    onClick={() => onRun(notification, action.key)}
                    size="sm"
                    variant={
                      action.tone === "danger"
                        ? "destructive"
                        : action.tone === "primary"
                          ? "default"
                          : "outline"
                    }
                  >
                    {busy === `${notification.id}:${action.key}` ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : null}
                    {action.label}
                  </Button>
                ))
              : null}

            {notification.actionUrl ? (
              <Button asChild size="sm" variant="ghost">
                <Link href={notification.actionUrl}>
                  Open
                  <ChevronRight className="size-3.5" />
                </Link>
              </Button>
            ) : null}

            {notification.needsAction ? (
              <Button
                className="text-muted-foreground"
                disabled={busy !== null}
                onClick={() => onDismiss(notification.id)}
                size="sm"
                variant="ghost"
              >
                Dismiss
              </Button>
            ) : null}

            {!notification.isRead ? (
              <Button
                className="ml-auto text-muted-foreground"
                onClick={(event) => {
                  event.stopPropagation();
                  onMarkRead(notification.id);
                }}
                size="sm"
                variant="ghost"
              >
                Mark read
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
});

export const NotificationsPageContent = memo(function NotificationsPageContent() {
  const [filter, setFilter] = useState<NotificationFilter>("all");
  const [busy, setBusy] = useState<string | null>(null);
  const {
    actionCount,
    dismissAction,
    markAllRead,
    markRead,
    message,
    notifications,
    runAction,
    state,
    unacknowledgedCount,
  } = useNotifications(filter, { autoMarkRead: true });

  async function handleRun(notification: NotificationItem, actionKey: string) {
    const action = notification.actions.find((item) => item.key === actionKey);

    if (!action) {
      return;
    }

    setBusy(`${notification.id}:${actionKey}`);
    await runAction(notification, action);
    setBusy(null);
  }

  async function handleDismiss(id: string) {
    setBusy(`${id}:dismiss`);
    await dismissAction(id);
    setBusy(null);
  }

  return (
    <div className="mx-auto max-w-[900px] space-y-6">
      <PageHeader
        description="In-app notification feed."
        icon={Bell}
        title="Notifications"
      />
      <Message value={message} />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs
          onValueChange={(value) => setFilter(value as NotificationFilter)}
          value={filter}
        >
          <TabsList>
            {FILTERS.map((item) => (
              <TabsTrigger key={item.value} value={item.value}>
                {item.label}
                {item.value === "action" && actionCount > 0 ? (
                  <span className="ml-1.5 rounded bg-amber-500 px-1 text-[10px] font-bold text-white">
                    {actionCount}
                  </span>
                ) : null}
                {item.value === "unread" && unacknowledgedCount > 0 ? (
                  <span className="ml-1.5 rounded bg-rose-500 px-1 text-[10px] font-bold text-white">
                    {unacknowledgedCount}
                  </span>
                ) : null}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        {unacknowledgedCount > 0 ? (
          <Button onClick={() => void markAllRead()} size="sm" variant="outline">
            <CheckCheck className="size-3.5" />
            Mark all read
          </Button>
        ) : null}
      </div>

      <Panel>
        {notifications.length === 0 ? (
          <EmptyState
            label={
              state === "loading"
                ? "Loading…"
                : filter === "action"
                  ? "Nothing needs your attention."
                  : filter === "unread"
                    ? "You're all caught up."
                    : "No notifications."
            }
          />
        ) : null}

        <div className="space-y-3">
          {notifications.map((notification) => (
            <NotificationCard
              busy={busy}
              key={notification.id}
              notification={notification}
              onDismiss={(id) => void handleDismiss(id)}
              onMarkRead={(id) => void markRead(id)}
              onRun={(item, key) => void handleRun(item, key)}
            />
          ))}
        </div>
      </Panel>
    </div>
  );
});
