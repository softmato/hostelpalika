"use client";

import { Bell, BellOff, BellRing, CheckCheck, ChevronRight, Loader2, Zap } from "@/components/icons";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { useRealtime } from "@/components/realtime-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
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
import {
  disableBrowserPush,
  enableBrowserPush,
  readPushStatus,
  readPushSupport,
  resyncBrowserPush,
} from "@/lib/web-push-client";
import { toast } from "@/stores/toast-store";

/**
 * Header bell for every authenticated portal (PHASES.md §4.1).
 *
 * Three tabs over the same feed: everything, unread, and "Needs action" — the
 * queue of requests waiting on this person. That third tab is the reason the
 * bell is more than a glance: a hostel awaiting approval or a service provider
 * application can be approved from here without opening the panel, because the
 * row carries its own endpoint (see `Notification.actions`).
 *
 * Rows arrive over the socket when Pusher is configured and by polling when it
 * is not, so nothing below depends on the connection being up — the lightning
 * badge is the only thing that changes.
 */

const FILTERS: { label: string; value: NotificationFilter }[] = [
  { label: "All", value: "all" },
  { label: "Unread", value: "unread" },
  { label: "Needs action", value: "action" },
];

function ActionButtons({
  busy,
  notification,
  onDismiss,
  onRun,
}: {
  busy: string | null;
  notification: NotificationItem;
  onDismiss: (id: string) => void;
  onRun: (notification: NotificationItem, actionKey: string) => void;
}) {
  if (!notification.needsAction) {
    return null;
  }

  return (
    // The row itself navigates now, so the buttons must swallow their clicks —
    // deciding inline should never also open the page behind the decision.
    <div
      className="mt-2 flex flex-wrap items-center gap-1.5 pl-9"
      onClick={(event) => event.stopPropagation()}
    >
      {notification.actions.map((action) => (
        <Button
          className="h-7 px-2.5 text-[11px] font-semibold"
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
            <Loader2 className="size-3 animate-spin" />
          ) : null}
          {action.label}
        </Button>
      ))}

      {notification.actionUrl ? (
        <Button asChild className="h-7 px-2.5 text-[11px] font-semibold" size="sm" variant="ghost">
          <Link href={notification.actionUrl}>
            Review
            <ChevronRight className="size-3" />
          </Link>
        </Button>
      ) : null}

      <Button
        className="h-7 px-2 text-[11px] text-muted-foreground"
        disabled={busy !== null}
        onClick={() => onDismiss(notification.id)}
        size="sm"
        variant="ghost"
      >
        Dismiss
      </Button>
    </div>
  );
}

function NotificationRow({
  busy,
  notification,
  onDismiss,
  onOpen,
  onRun,
}: {
  busy: string | null;
  notification: NotificationItem;
  onDismiss: (id: string) => void;
  onOpen: (notification: NotificationItem) => void;
  onRun: (notification: NotificationItem, actionKey: string) => void;
}) {
  const display = notificationDisplay(notification.category);
  const Icon = display.icon;
  // Every row with a destination opens it, including the ones carrying inline
  // actions — those buttons stop their own clicks, so the body stays a link to
  // the page where the request can be seen in full. A row with no destination
  // is still clickable while unread: clicking is how its tint is acknowledged.
  const navigable = Boolean(notification.actionUrl) || !notification.isRead;

  const body = (
    <>
      <div className="flex items-start gap-2.5">
        <span
          className={cn(
            "mt-0.5 flex size-6.5 shrink-0 items-center justify-center rounded-lg",
            TONE_CHIP[display.tone],
          )}
        >
          <Icon className="size-3.5" />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <p
              className={cn(
                "truncate text-[13px] leading-tight text-foreground",
                notification.isRead ? "font-medium" : "font-semibold",
              )}
            >
              {notification.title}
            </p>
            {notification.needsAction ? (
              <Badge
                className="h-4 shrink-0 rounded px-1 text-[9px] font-bold tracking-wide"
                variant="default"
              >
                ACTION
              </Badge>
            ) : null}
            {!notification.isRead ? (
              <span className="ml-auto size-1.5 shrink-0 rounded-full bg-rose-500" />
            ) : null}
          </div>

          <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
            {notification.body}
          </p>

          <p className="mt-1 flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <span className="font-medium">{display.label}</span>
            <span aria-hidden>·</span>
            <span>{relativeTime(notification.createdAt)}</span>
            {notification.actionState === "COMPLETED" ? (
              <>
                <span aria-hidden>·</span>
                <span className="font-medium text-emerald-600 dark:text-emerald-400">
                  Resolved
                </span>
              </>
            ) : null}
          </p>
        </div>
      </div>

      <ActionButtons
        busy={busy}
        notification={notification}
        onDismiss={onDismiss}
        onRun={onRun}
      />
    </>
  );

  return (
    <div
      className={cn(
        "relative rounded-lg px-2.5 py-2 transition-colors",
        navigable ? "cursor-pointer hover:bg-muted" : "",
      )}
      onClick={navigable ? () => onOpen(notification) : undefined}
      onKeyDown={
        navigable
          ? (event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onOpen(notification);
              }
            }
          : undefined
      }
      role={navigable ? "button" : undefined}
      tabIndex={navigable ? 0 : undefined}
    >
      {/* The unread tint, faded rather than swapped so a click or "Mark all
          read" visibly settles the row. Opacity is the only way to animate it:
          a gradient background does not transition. */}
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-0 rounded-lg bg-linear-to-r from-primary/15 via-primary/5 to-transparent transition-opacity duration-300",
          notification.isRead ? "opacity-0" : "opacity-100",
        )}
      />
      <div className="relative">{body}</div>
    </div>
  );
}

/**
 * Desktop notifications: the toggle, and the state it can be in.
 *
 * Six states rather than a boolean because five of them need different words.
 * "Off" invites a click; "denied" must not, since the browser will not re-ask
 * and the only fix is in site settings — a toggle that silently does nothing is
 * the worst of the six. `unconfigured` is this deployment having no VAPID pair,
 * which is an operator problem and not something to show a warden.
 */
type PushState =
  | "loading"
  | "unsupported"
  | "unconfigured"
  | "denied"
  | "off"
  | "on"
  | "working";

function BrowserPushRow({
  onChange,
  state,
}: {
  onChange: (next: boolean) => void;
  state: PushState;
}) {
  // Nothing to offer, and nothing the person reading it could act on.
  if (state === "loading" || state === "unsupported" || state === "unconfigured") {
    return null;
  }

  if (state === "denied") {
    return (
      <div className="flex items-center gap-2 px-2.5 py-2 text-[11px] text-muted-foreground">
        <BellOff className="size-3.5 shrink-0" />
        <span>
          This browser is blocking notifications. Allow them in your site settings to
          get them with the tab closed.
        </span>
      </div>
    );
  }

  const on = state === "on";
  const working = state === "working";

  return (
    <button
      className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[11px] transition-colors hover:bg-accent"
      disabled={working}
      onClick={() => onChange(!on)}
      type="button"
    >
      {working ? (
        <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
      ) : on ? (
        <BellRing className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
      ) : (
        <BellOff className="size-3.5 shrink-0 text-muted-foreground" />
      )}
      <span className="flex-1 text-foreground">
        {on ? "Desktop notifications are on" : "Get notifications on this device"}
      </span>
      <span
        className={cn(
          "rounded-full px-1.5 py-px text-[9px] font-bold uppercase",
          on
            ? "bg-emerald-50 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400"
            : "bg-slate-100 text-slate-500 dark:bg-slate-500/15 dark:text-slate-300",
        )}
      >
        {on ? "On" : "Off"}
      </span>
    </button>
  );
}

export function NotificationBell({ href }: { href: string }) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<NotificationFilter>("all");
  const [busy, setBusy] = useState<string | null>(null);
  const [pushState, setPushState] = useState<PushState>("loading");
  const router = useRouter();
  const { clearLive, connected, liveNotifications } = useRealtime();
  const {
    actionCount,
    dismissAction,
    markAllRead,
    markRead,
    notifications,
    runAction,
    state,
    unacknowledgedCount,
    unreadCount,
  } = useNotifications(filter, { autoMarkRead: open });

  // The live queue exists to badge notifications that arrived while the bell
  // was shut; once it has been opened they are ordinary rows in the list.
  useEffect(() => {
    if (open && liveNotifications.length > 0) {
      clearLive();
    }
  }, [clearLive, liveNotifications.length, open]);

  /*
   * Read the real state once on mount, and quietly repair it.
   *
   * Both halves matter. The server's row decides whether the toggle reads on —
   * the browser can hold a subscription this server has already pruned, and a
   * toggle driven by the browser alone would say "on" while delivering nothing.
   * `resyncBrowserPush` then re-posts the current subscription when permission
   * is already granted, which is what survives a new service worker, a pruned
   * endpoint, and a different account signing in on the same machine.
   *
   * Deliberately not re-run on focus or visibility: this is a repair, not a
   * poll, and a request on every tab switch buys nothing.
   */
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const { permission, supported } = readPushSupport();

      if (!supported) {
        if (!cancelled) setPushState("unsupported");
        return;
      }

      const status = await readPushStatus();

      if (cancelled) {
        return;
      }

      if (status && !status.configured) {
        setPushState("unconfigured");
        return;
      }

      if (permission === "denied") {
        setPushState("denied");
        return;
      }

      setPushState(status?.enabled && permission === "granted" ? "on" : "off");

      if (permission === "granted") {
        await resyncBrowserPush();
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  async function handlePushToggle(next: boolean) {
    setPushState("working");

    if (!next) {
      await disableBrowserPush();
      setPushState("off");
      toast.info("Desktop notifications are off for this browser.");
      return;
    }

    const result = await enableBrowserPush();

    if (result.ok) {
      setPushState("on");
      toast.success("Desktop notifications are on for this browser.");
      return;
    }

    if (result.reason === "denied") {
      setPushState("denied");
      return;
    }

    if (result.reason === "unconfigured") {
      setPushState("unconfigured");
      return;
    }

    setPushState("off");
    toast.error("Could not turn on desktop notifications. Try again.");
  }

  const badge = unreadCount;

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

  function handleOpen(notification: NotificationItem) {
    if (!notification.isRead) {
      void markRead(notification.id);
    }

    // No destination means the click was only an acknowledgement — the bell
    // stays open on the row that just settled.
    if (notification.actionUrl) {
      setOpen(false);
      router.push(notification.actionUrl);
    }
  }

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <Button
          aria-label={badge > 0 ? `Notifications, ${badge} unread` : "Notifications"}
          className="relative size-8 rounded-full border-slate-200 bg-white text-slate-600 shadow-sm dark:border-border dark:bg-card dark:text-foreground"
          size="icon"
          type="button"
          variant="outline"
        >
          <Bell className="size-4" />
          {badge > 0 ? (
            <span
              className={cn(
                "absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full px-1 text-[9px] font-bold text-white ring-2 ring-white dark:ring-card",
                // An outstanding request outranks a merely unread row, so the
                // badge turns amber the moment something needs a decision.
                actionCount > 0 ? "bg-amber-500" : "bg-rose-500",
              )}
            >
              {badge > 9 ? "9+" : badge}
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>

      <PopoverContent
        align="end"
        className="flex max-h-[min(32rem,var(--radix-popover-content-available-height))] w-[min(22rem,calc(100vw-1.5rem))] flex-col overflow-hidden p-0 sm:w-96"
      >
        <div className="flex shrink-0 items-center justify-between gap-2 px-3 pt-3">
          <div className="flex items-center gap-1.5">
            <p className="text-sm font-semibold text-foreground">Notifications</p>
            {connected ? (
              <span
                className="inline-flex items-center gap-0.5 rounded bg-emerald-50 px-1 py-px text-[9px] font-bold text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400"
                title="Live updates are connected"
              >
                <Zap className="size-2.5" />
                LIVE
              </span>
            ) : null}
          </div>

          {unacknowledgedCount > 0 ? (
            <Button
              className="h-6 gap-1 px-1.5 text-[11px] text-muted-foreground active:scale-95"
              onClick={() => void markAllRead()}
              size="sm"
              variant="ghost"
            >
              <CheckCheck className="size-3" />
              Mark all read
            </Button>
          ) : null}
        </div>

        <div className="shrink-0 px-3 pt-2">
          <Tabs
            onValueChange={(value) => setFilter(value as NotificationFilter)}
            value={filter}
          >
            <TabsList className="w-full">
              {FILTERS.map((item) => (
                <TabsTrigger className="flex-1 text-[11px]" key={item.value} value={item.value}>
                  {item.label}
                  {item.value === "action" && actionCount > 0 ? (
                    <span className="ml-1 rounded bg-amber-500 px-1 text-[9px] font-bold text-white">
                      {actionCount}
                    </span>
                  ) : null}
                  {item.value === "unread" && unacknowledgedCount > 0 ? (
                    <span className="ml-1 rounded bg-rose-500 px-1 text-[9px] font-bold text-white">
                      {unacknowledgedCount}
                    </span>
                  ) : null}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>

        {/* A plain scroller, not ScrollArea: its viewport is height:100% of a
            max-height parent, which resolves to auto — the list grew past the
            popover instead of scrolling inside it. */}
        <div className="mt-1 min-h-0 flex-1 overflow-y-auto overscroll-contain px-1.5 py-1">
          {notifications.length === 0 ? (
            <p className="px-2 py-8 text-center text-sm text-muted-foreground">
              {state === "loading"
                ? "Loading…"
                : filter === "action"
                  ? "Nothing needs your attention."
                  : filter === "unread"
                    ? "You're all caught up."
                    : "Nothing new."}
            </p>
          ) : (
            <div className="space-y-0.5">
              {notifications.slice(0, 12).map((notification) => (
                <NotificationRow
                  busy={busy}
                  key={notification.id}
                  notification={notification}
                  onDismiss={(id) => void handleDismiss(id)}
                  onOpen={handleOpen}
                  onRun={(item, key) => void handleRun(item, key)}
                />
              ))}
            </div>
          )}
        </div>

        <div className="shrink-0 border-t border-border p-1.5">
          <BrowserPushRow
            onChange={(next) => void handlePushToggle(next)}
            state={pushState}
          />
          <Button asChild className="w-full text-[13px] font-semibold" size="sm" variant="ghost">
            <Link href={href} onClick={() => setOpen(false)}>
              View all notifications
            </Link>
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
