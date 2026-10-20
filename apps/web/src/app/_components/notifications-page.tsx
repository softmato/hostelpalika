"use client";

import { Bell, BellRing, CheckCheck, ChevronRight, Loader2 } from "@/components/icons";
import Link from "next/link";
import { memo, useMemo, useState } from "react";

import { FilterButton, FilterChoice } from "@/components/filter-panel";
import { Button } from "@/components/ui/button";
import {
  TONE_CHIP,
  notificationDisplay,
  relativeTime,
} from "@/lib/notification-display";
import { dayMonthYear } from "@/lib/format-month";
import {
  useNotifications,
  type NotificationFilter,
  type NotificationItem,
} from "@/lib/use-notifications";
import { cn } from "@/lib/utils";
import { Message, PageHeader } from "./daily-operations-shared";
import { EmptyState } from "@/app/_components/shared-ui";
import { CardSkeletons, SectionTitle } from "./daily-portal-ui";
import { MetricCard } from "./portal-dashboard-ui";

/**
 * The full notification archive, shared by every portal that has a bell.
 *
 * Same data, same hook and the same three filters as the header bell, so the
 * two never disagree about what is unread or what is still waiting on a
 * decision. This page is the roomier view: full body text, and the action
 * buttons laid out rather than squeezed under a dropdown row.
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
        "relative overflow-hidden rounded-2xl border bg-card p-4 transition duration-200",
        notification.needsAction ? "border-amber-300 dark:border-amber-500/40" : "border-border/70",
        notification.isRead ? "" : "cursor-pointer hover:-translate-y-0.5 hover:shadow-md",
      )}
      onClick={notification.isRead ? undefined : () => onMarkRead(notification.id)}
    >
      {/* Faded rather than swapped, so marking read visibly settles the card. */}
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-0 bg-linear-to-r from-primary/10 via-primary/[0.03] to-transparent transition-opacity duration-300",
          notification.isRead ? "opacity-0" : "opacity-100",
        )}
      />
      <div className="relative flex items-start gap-3">
        <span
          className={cn(
            "flex size-10 shrink-0 items-center justify-center rounded-xl",
            TONE_CHIP[display.tone],
          )}
        >
          <Icon className="size-[18px]" />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            <p className="min-w-0 flex-1 font-heading text-[15px] font-semibold text-foreground">
              {notification.title}
              {!notification.isRead ? (
                <span aria-label="Unread" className="ml-2 inline-block size-2 rounded-full bg-brand-teal align-middle" />
              ) : null}
            </p>
            <span className="shrink-0 text-[11.5px] text-muted-foreground">
              {relativeTime(notification.createdAt)}
            </span>
          </div>

          <p className="mt-0.5 text-[13.5px] text-muted-foreground">{notification.body}</p>

          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
              {display.label}
            </span>
            {notification.needsAction ? (
              <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
                Needs action
              </span>
            ) : null}
            {notification.actionState === "COMPLETED" ? (
              <span className="rounded-full bg-role-team-soft px-2 py-0.5 text-[11px] font-semibold text-role-team">
                Done
              </span>
            ) : null}
          </div>

          {notification.needsAction || notification.actionUrl || !notification.isRead ? (
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
          ) : null}
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

  // Grouped by day, the heading outside the cards.
  const groups = useMemo(() => {
    const byDay = new Map<string, NotificationItem[]>();

    for (const notification of notifications) {
      const key = dayMonthYear(notification.createdAt) || "Earlier";
      byDay.set(key, [...(byDay.get(key) ?? []), notification]);
    }

    return [...byDay];
  }, [notifications]);

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
    <div className="mx-auto max-w-[900px] space-y-5">
      <PageHeader
        description="Everything the bell has told you."
        icon={Bell}
        title="Notifications"
      />
      <Message value={message} />

      <div className="grid gap-3 sm:grid-cols-2">
        <MetricCard icon={Bell} label="Unread" value={unacknowledgedCount} />
        <MetricCard
          icon={BellRing}
          label="Needs action"
          tone={actionCount > 0 ? "amber" : "teal"}
          value={actionCount}
        />
      </div>

      <div className="flex items-center justify-between gap-3">
        <SectionTitle>{FILTERS.find((item) => item.value === filter)?.label ?? "All"}</SectionTitle>
        <div className="flex items-center gap-2">
          {unacknowledgedCount > 0 ? (
            <Button className="h-10 gap-2 rounded-xl" onClick={() => void markAllRead()} variant="outline">
              <CheckCheck className="size-4" />
              Mark all read
            </Button>
          ) : null}
          <FilterButton active={filter === "all" ? 0 : 1} onClear={() => setFilter("all")}>
            <FilterChoice
              label="Show"
              onChange={setFilter}
              options={FILTERS.map((item) => ({
                label:
                  item.value === "unread"
                    ? `Unread ${unacknowledgedCount}`
                    : item.value === "action"
                      ? `Needs action ${actionCount}`
                      : item.label,
                value: item.value,
              }))}
              value={filter}
            />
          </FilterButton>
        </div>
      </div>

      {notifications.length === 0 ? (
        state === "loading" ? (
          <CardSkeletons className="sm:grid-cols-1 xl:grid-cols-1" count={3} />
        ) : (
          <EmptyState
            label={
              filter === "action"
                ? "Nothing needs your attention."
                : filter === "unread"
                  ? "You're all caught up."
                  : "No notifications."
            }
          />
        )
      ) : null}

      {groups.map(([label, rows]) => (
        <section className="space-y-2" key={label}>
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{label}</h3>
          <div className="grid gap-3">
            {rows.map((notification) => (
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
        </section>
      ))}
    </div>
  );
});
