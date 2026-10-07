import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { AppBar } from "@/components/ui/app-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Screen } from "@/components/ui/screen";
import { SkeletonRows } from "@/components/ui/skeleton";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useAppDispatch, useAppSelector } from "@/hooks/redux";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useDates } from "@/hooks/use-dates";
import { useResource } from "@/hooks/use-resource";
import {
  type NotificationTone,
  type NotificationVisual,
  notificationVisual,
} from "@/lib/notification-categories";
import { readApiError } from "@/lib/api-contract";
import { humanizeEnum } from "@/lib/format";
import { type NightStatusReasonCode, reasonLabel } from "@/lib/night-status-actions";
import { collapseNightPrompts } from "@/lib/night-status-notification";
import { groupNotifications } from "@/lib/notification-groups";
import { notificationQuery } from "@/lib/notification-queries";
import {
  type AppNotification,
  type NotificationFeed,
  type NotificationFilter,
  markAllNotificationsRead,
  markNotificationRead,
} from "@/lib/notifications-api";
import { notificationRoute } from "@/lib/push-link";
import { setBadgeCount } from "@/lib/push-notifications";
import { invalidateQuery, readQuery, writeQuery } from "@/lib/query-cache";
import { setResidentNightStatus } from "@/lib/resident-api";
import { toastError } from "@/lib/toast";
import { nightKey } from "@hostel/night/night-window";
import {
  acknowledgeAllNotifications,
  acknowledgeNotification,
  holdUnacknowledged,
} from "@/store/slices/notificationsSlice";

/**
 * What the bell opens.
 *
 * ## One screen for every role
 *
 * `GET /notifications` is scoped to `principal.userId` with no role branch, so
 * this lives at the root of the stack rather than inside a role's tab group —
 * the same file serves a resident's payment reminder and an admin's approval
 * queue, and a folder nested under a `<Tabs>` layout would become another tab.
 *
 * ## It opens already drawn
 *
 * The list reads `notificationQuery.feed(filter)`, which is the same key
 * `<NotificationBell>` reads for its badge and the one `role-tabs.tsx` warms on
 * the way into every portal. So the usual path into this screen — tap the bell
 * whose count came from this entry — paints the rows on the first frame and
 * revalidates behind them. `lib/notification-queries.ts` has the reasoning.
 *
 * The skeleton below is therefore for the cold cases only: a deep link from a
 * push, a hard relaunch, or a filter nobody has asked for yet.
 *
 * ## Three shapes of feed, and the grouping is what makes it a list
 *
 * Rows come from everywhere — rent, complaints, the kitchen, an SOS, a store
 * delivery — and arrive as one column sorted by time. Two things from
 * `ui_inspiration_folder/app_recordings/NOTES.md` turn that into something
 * scannable, and both are load-bearing rather than decorative:
 *
 * - **§5, headings outside the cards.** The day is written once on the page
 *   background instead of once per row, which is what lets "what happened since
 *   I last looked" be answered by the shape of the screen. `lib/notification-groups.ts`.
 * - **§5 and §11, a tinted glyph leading the row.** The category *and* what
 *   happened to it, before a word is read. `lib/notification-categories.ts`.
 *
 * ## Opening clears the badge; tapping clears the tint
 *
 * Two different things, and they used to be one. Opening this screen marks the
 * whole mailbox read on the server, so the bell's badge and the app-icon count
 * drop the moment somebody looks. The rows that were unread at that moment are
 * held in `store/slices/notificationsSlice.ts` and keep their tint until the
 * row is tapped or "Mark all read" is pressed — so the one notification that
 * mattered is still visibly new even though the badge has gone.
 *
 * Both are optimistic. The cache entries the bell reads are rewritten before the
 * request leaves (`writeFeedRead`), so the bell underneath loses its badge on
 * the same frame, and "Mark all read" un-tints every row on the press itself
 * rather than after a round trip. A failed request marks the entries stale and
 * the next fetch corrects them — the held tint means nothing looks wrong
 * meanwhile.
 *
 * The "Unread" chip is filtered here from the `all` feed rather than asked of
 * the server: once opening has marked everything read, the server's unread
 * filter is always empty, while what the reader means by unread is the tint.
 *
 * ## A tap opens what the push would
 *
 * `actionUrl` holds a **web** path, so it is never pushed as-is: it goes through
 * `notificationRoute`, the same mapping a tapped push uses, onto the app's own
 * screen for it. A row it cannot place (a platform page, a tenant URL) expands
 * in place instead of opening a browser or `+not-found`.
 */

const FILTERS: { label: string; value: NotificationFilter }[] = [
  { label: "All", value: "all" },
  { label: "Unread", value: "unread" },
  { label: "Needs you", value: "action" },
];

/**
 * The tinted square behind the glyph.
 *
 * `bg-destructive-soft` rather than `bg-destructive/10`: NativeWind does not
 * compose an opacity modifier from a CSS variable, so the `/10` form renders no
 * square at all. `global.css` carries that as a comment beside the token, and
 * `<CardRow>` still has the broken form.
 */
const TILE_TONES: Record<NotificationTone, string> = {
  brand: "bg-brand-soft",
  danger: "bg-destructive-soft",
  neutral: "bg-muted",
  success: "bg-success-soft",
  warning: "bg-warning-soft",
};

const TILE_GLYPH: Record<
  NotificationTone,
  "destructive" | "mutedForeground" | "primary" | "success" | "warning"
> = {
  brand: "primary",
  danger: "destructive",
  neutral: "mutedForeground",
  success: "success",
  warning: "warning",
};

/**
 * Every cached feed entry, rewritten as if the server had already answered the
 * read-all. `all` is the one the bell's badge reads; `action` is patched too so
 * switching chips does not paint a stale unread count back in.
 *
 * Skips entries with nothing unread, so it does not re-stamp an answer as fresh
 * for no reason.
 */
function writeFeedRead() {
  for (const filter of ["all", "action"] as const) {
    const { key, topics } = notificationQuery.feed(filter);
    const cached = readQuery<NotificationFeed>(key);

    if (
      cached &&
      (cached.data.unreadCount > 0 || cached.data.notifications.some((row) => !row.isRead))
    ) {
      writeQuery(
        key,
        {
          ...cached.data,
          notifications: cached.data.notifications.map((row) =>
            row.isRead ? row : { ...row, isRead: true },
          ),
          unreadCount: 0,
        },
        topics,
      );
    }
  }
}

function invalidateFeeds() {
  for (const filter of ["all", "action"] as const) {
    invalidateQuery(notificationQuery.feed(filter).key);
  }
}

export default function NotificationsScreen() {
  const account = useAppSelector((state) => state.auth.account);
  const held = useAppSelector((state) => state.notifications.unacknowledged);
  const dispatch = useAppDispatch();
  const [filter, setFilter] = useState<NotificationFilter>("all");

  /*
   * The descriptor, not an inline loader. `defineQuery` hands back the same
   * object for a key for the life of the process, so `query.load` is a stable
   * identity `useResource` can key its fetch effect off — and changing the chip
   * changes the key, which paints the other filter from cache if it has been
   * looked at and re-asks if it has not.
   *
   * `topics` is what makes the bell live: the socket publishes `notifications`
   * on every `notification:new` and `notification:updated`, so a notice
   * published on the web updates this list with no push involved and no polling.
   * The refetch is silent — the list stays on screen while it runs.
   */
  const query = notificationQuery.feed(filter === "unread" ? "all" : filter);

  const feed = useResource<NotificationFeed>(query.load, {
    cacheKey: query.key,
    topics: query.topics,
  });
  const { data } = feed;

  /*
   * `isRead` as the reader sees it: the server's receipt, unless the row is held
   * as not yet acknowledged. The row component only ever sees this value, so the
   * tint follows the hold and not the receipt.
   */
  const rows = useMemo(() => {
    const heldIds = new Set(held);
    const shown = (data?.notifications ?? []).map((row) =>
      row.isRead && heldIds.has(row.id) ? { ...row, isRead: false } : row,
    );

    return filter === "unread" ? shown.filter((row) => !row.isRead) : shown;
  }, [data, filter, held]);

  /*
   * The kinds of thing on this page — Khata, Stock, Payment… — keyed by the
   * word on the chip, most rows first. A khata request and a rent reminder are
   * different jobs, and one long mixed list made the reader sort them by eye.
   */
  const [category, setCategory] = useState<string | null>(null);
  const categories = useMemo(() => {
    const byLabel = new Map<string, CategoryChip>();
    for (const row of rows) {
      const { icon, label } = notificationVisual({ category: row.category });
      const chip = byLabel.get(label);
      if (chip) chip.count += 1;
      else byLabel.set(label, { count: 1, icon, label });
    }
    return [...byLabel.values()].sort((left, right) => right.count - left.count);
  }, [rows]);
  // A pick that is not on this page (another chip above was chosen) means "every kind".
  const picked = categories.some((chip) => chip.label === category) ? category : null;
  const shownRows = useMemo(
    () =>
      picked
        ? rows.filter((row) => notificationVisual({ category: row.category }).label === picked)
        : rows,
    [picked, rows],
  );

  /** What the server still counts, which is what the badges show. */
  const serverUnread = data?.unreadCount ?? 0;
  /** What is still tinted, which is what the header and its button speak to. */
  const unread = Math.max(held.length, serverUnread);

  /*
   * Opening marks everything read, and holds what was unread.
   *
   * Keyed on the payload, so a notification arriving while the screen is open
   * is held and receipted the same way as the ones that were here on entry.
   *
   * `receipt` keeps a revalidate that lands mid-request from firing a second
   * read-all for the same rows, and a failure from being retried on every
   * refetch — it is tried again the next time the screen opens.
   */
  const receipt = useRef<"busy" | "failed" | "idle">("idle");

  useEffect(() => {
    if (!account || !data) {
      return;
    }

    // Read from the cache rather than from `data`: for a frame after a chip
    // change `data` can still be the other filter's page, and pruning against
    // the `action` page would drop every held row not waiting on a decision.
    const allPage = readQuery<NotificationFeed>(notificationQuery.feed("all").key);

    dispatch(
      holdUnacknowledged({
        present: allPage?.data.notifications.map((row) => row.id),
        unread: data.notifications.filter((row) => !row.isRead).map((row) => row.id),
      }),
    );

    if (data.unreadCount === 0 || receipt.current !== "idle") {
      return;
    }

    receipt.current = "busy";
    writeFeedRead();

    void markAllNotificationsRead().then(
      () => {
        receipt.current = "idle";
        writeFeedRead();
      },
      () => {
        receipt.current = "failed";
        invalidateFeeds();
      },
    );
  }, [account, data, dispatch]);

  /*
   * Grouped here rather than in the render body so the buckets are recomputed
   * when the rows move and not when the screen re-renders for a chip.
   *
   * `new Date()` is read once per grouping rather than per row: a list crossing
   * midnight Kathmandu time mid-loop would otherwise file its first rows under
   * one heading and its last under another.
   */
  const groups = useMemo(() => groupNotifications(shownRows), [shownRows]);

  /*
   * The app-icon badge, written from the server's count.
   *
   * This screen is the only place that sets it authoritatively, and that is
   * what "cleared on read" means in practice: marking a row read moves
   * `unreadCount` locally, marking all read refetches it, and either way the
   * icon follows the same number the bell is showing. `use-push.ts` only
   * increments between visits, to keep the icon from lying while the app is
   * open — a second counter would drift from this one within a day.
   */
  useEffect(() => {
    if (data) {
      void setBadgeCount(serverUnread);
    }
  }, [data, serverUnread]);

  const { setData } = feed;

  const markRead = useCallback(
    (notification: AppNotification) => {
      if (notification.isRead) {
        return;
      }

      dispatch(acknowledgeNotification(notification.id));

      // Held rows were already receipted on open; only a row the server still
      // counts needs the PATCH, and the badge has to move with it.
      const receipted = data?.notifications.find((row) => row.id === notification.id)?.isRead;

      if (receipted) {
        return;
      }

      setData((current) =>
        current
          ? {
              ...current,
              notifications: current.notifications.map((row) =>
                row.id === notification.id ? { ...row, isRead: true } : row,
              ),
              unreadCount: Math.max(0, current.unreadCount - 1),
            }
          : current,
      );

      void markNotificationRead(notification.id).catch(() => undefined);
    },
    [data, dispatch, setData],
  );

  /*
   * No spinner and no await: the tint goes on the press, and the request — only
   * needed if something arrived that the open has not receipted yet — runs
   * behind it.
   */
  const markAll = useCallback(() => {
    dispatch(acknowledgeAllNotifications());

    if (serverUnread === 0) {
      return;
    }

    writeFeedRead();

    void markAllNotificationsRead()
      .then(writeFeedRead)
      .catch(() => {
        invalidateFeeds();
        toastError("Couldn't mark them read", "Check your connection and try again.");
      });
  }, [dispatch, serverUnread]);

  const header = (
    <AppBar
      actions={
        unread > 0 ? (
          <Pressable
            accessibilityLabel="Mark all as read"
            accessibilityRole="button"
            className="active:opacity-50"
            hitSlop={8}
            onPress={markAll}
          >
            <Text className="text-primary" variant="label">
              Mark all read
            </Text>
          </Pressable>
        ) : undefined
      }
      onBack={() => router.back()}
      showBack
      subtitle={unread > 0 ? `${unread} unread` : "You're up to date"}
      title="Notifications"
    />
  );

  /*
   * The bell is only drawn for a signed-in account, so this is a deep link or a
   * session that ended while the screen was open — not a state reachable by
   * tapping. It still has to say something other than a failed request.
   */
  if (!account) {
    return (
      <Screen header={header}>
        <EmptyState
          description="Notifications belong to an account. Sign in to see yours."
          title="Not signed in"
        />
      </Screen>
    );
  }

  if (feed.error || (!feed.data && !feed.loading)) {
    return (
      <Screen header={header}>
        <ErrorState
          message={feed.error ?? "Notifications could not be loaded."}
          onRetry={feed.reload}
        />
      </Screen>
    );
  }

  return (
    <Screen header={header} onRefresh={feed.refresh} refreshing={feed.refreshing} scroll>
      <View className="gap-4 pt-1">
        <ScrollView
          contentContainerClassName="gap-2"
          horizontal
          showsHorizontalScrollIndicator={false}
        >
          {FILTERS.map((option) => {
            const active = option.value === filter;

            return (
              <Pressable
                accessibilityRole="tab"
                accessibilityState={{ selected: active }}
                className={`rounded-full border px-3.5 py-2 active:opacity-70 ${
                  active ? "border-primary bg-primary" : "border-border"
                }`}
                key={option.value}
                onPress={() => setFilter(option.value)}
              >
                <Text
                  className={`text-sm font-medium ${
                    active ? "text-primary-foreground" : "text-foreground"
                  }`}
                >
                  {option.value === "action" && feed.data
                    ? `${option.label}${feed.data.actionCount > 0 ? ` (${feed.data.actionCount})` : ""}`
                    : option.label}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>

        {categories.length > 1 ? (
          <ScrollView
            contentContainerClassName="gap-2"
            horizontal
            showsHorizontalScrollIndicator={false}
          >
            {categories.map((chip) => (
              <CategoryChipButton
                active={chip.label === picked}
                chip={chip}
                key={chip.label}
                onPress={() => setCategory(chip.label === picked ? null : chip.label)}
              />
            ))}
          </ScrollView>
        ) : null}

        {/*
          Skeleton rows rather than a centred spinner, per NOTES §9: the shape of
          this list is known before its contents are, and matching it is what
          keeps the page from jumping when the rows land. Six because that is
          roughly a screenful at this row height.
        */}
        {feed.loading ? (
          <SkeletonRows rows={6} />
        ) : rows.length === 0 ? (
          <EmptyState
            description={
              filter === "unread"
                ? "Everything here has been read."
                : filter === "action"
                  ? "Nothing is waiting on a decision from you."
                  : "Rent reminders, notices and alerts will show up here."
            }
            title="Nothing to read"
          />
        ) : (
          <View className="gap-5">
            {groups.map((group) => (
              <View className="gap-2.5" key={group.bucket}>
                {/*
                  On the page, not in a card — NOTES §5. The day is stated once
                  for the rows under it instead of once on every row.
                */}
                <Text
                  className="px-0.5 font-semibold uppercase tracking-wider"
                  variant="caption"
                >
                  {group.label}
                </Text>

                {group.rows.map((notification) => (
                  <NotificationRow
                    key={notification.id}
                    notification={notification}
                    onOpen={markRead}
                  />
                ))}
              </View>
            ))}
          </View>
        )}
      </View>
    </Screen>
  );
}

type CategoryChip = { count: number; icon: NotificationVisual["icon"]; label: string };

/** One kind of notification: its glyph, its word, how many. Tap again to show every kind. */
function CategoryChipButton({
  active,
  chip,
  onPress,
}: {
  active: boolean;
  chip: CategoryChip;
  onPress: () => void;
}) {
  const { colors } = useAppTheme();

  return (
    <Pressable
      accessibilityLabel={`${chip.label}, ${chip.count}`}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      className={`flex-row items-center gap-1.5 rounded-xl px-3 py-2 active:opacity-70 ${
        active ? "bg-primary" : "bg-muted"
      }`}
      onPress={onPress}
    >
      <Ionicons
        color={active ? colors.primaryForeground : colors.foreground}
        name={chip.icon}
        size={15}
      />
      <Text
        className={`text-sm font-medium ${active ? "text-primary-foreground" : "text-foreground"}`}
      >
        {`${chip.label} ${chip.count}`}
      </Text>
    </Pressable>
  );
}

/**
 * One row: a tinted glyph, the title with its age opposite, two lines of body.
 *
 * ## Not a `<Card>`, and not `<CardRow>`
 *
 * The accent edge has to be flush with the rounded corner, which a component
 * whose padding is a single slot cannot do — `<Card>`'s own doc explains why
 * that slot is not additive. `<CardRow>` is the other near-miss: its value sits
 * vertically centred in the right slot rather than on the title's baseline, and
 * its subtitle is fixed at two lines with nothing to expand. Both differences
 * are the row's whole anatomy, so this is a screen-level composition rather than
 * a fifth variant of a kit primitive.
 *
 * ## Unread inverts the row rather than adding a dot to it
 *
 * Unread rows take a tinted ground and their glyph tile goes white; read rows
 * are a white card with a tinted tile. Two states, one pair of surfaces swapped,
 * and the tone still shows in both because it is the *glyph* that carries the
 * colour — a tinted tile on a tinted ground would simply disappear.
 *
 * The dot that used to say "unread" is gone with it: ground, weight and edge all
 * say it already, and it was the fourth. Screen readers get the word itself.
 */
function NotificationRow({
  notification,
  onOpen,
}: {
  notification: AppNotification;
  onOpen: (notification: AppNotification) => void;
}) {
  const dates = useDates();

  const { colors } = useAppTheme();
  const [expanded, setExpanded] = useState(false);

  const urgent = notification.priority === "URGENT" || notification.priority === "HIGH";
  // Its buttons say it is waiting, and an old night's row is waiting on nothing.
  const isNight = notification.category === "NIGHT_STATUS";
  const unread = !notification.isRead;
  const visual = notificationVisual(notification);

  /*
   * One edge, two meanings, and urgency wins.
   *
   * A left border for urgency, never a red card — the same rule the notices list
   * follows, and two red cards on one screen means neither reads as urgent. An
   * unread row that is *also* urgent keeps the red: it is the more important of
   * the two things to know, and the tinted ground still says unread.
   */
  const edge = urgent ? colors.destructive : unread ? colors.primary : "transparent";

  return (
    <Pressable
      accessibilityLabel={`${unread ? "Unread. " : ""}${visual.label}. ${notification.title}. ${notification.body}`}
      accessibilityRole="button"
      accessibilityState={{ expanded }}
      className="active:opacity-80"
      onPress={() => {
        onOpen(notification);

        const route = notificationRoute(notification);

        if (route) {
          router.push(route as never);
          return;
        }

        setExpanded((value) => !value);
      }}
    >
      <View
        className={`flex-row overflow-hidden rounded-2xl border ${
          unread ? "border-transparent bg-brand-soft" : "border-border bg-card"
        }`}
      >
        {/*
          Always drawn, transparent when there is nothing to say — so a read row
          and an unread one align on the same left edge and the list does not
          shift by four points as rows are opened.
        */}
        <View style={{ backgroundColor: edge, width: 4 }} />

        <View className="flex-1 flex-row gap-3 p-3">
          <View
            className={`h-10 w-10 items-center justify-center rounded-xl ${
              unread ? "bg-card" : TILE_TONES[visual.tone]
            }`}
          >
            <Ionicons
              color={colors[TILE_GLYPH[visual.tone]]}
              name={visual.icon}
              size={19}
            />
          </View>

          <View className="flex-1 gap-1">
            <View className="flex-row items-start gap-2">
              <Text
                className={`flex-1 ${unread ? "font-semibold" : ""}`}
                numberOfLines={2}
                variant="subtitle"
              >
                {notification.title}
              </Text>

              {/*
                The age, on the title's line and hard right — the reference's own
                row anatomy. `dates.ago` falls back to a date past a week, which
                is the point at which "23 days ago" stops being an answer.
              */}
              <Text variant="caption">{dates.ago(notification.createdAt)}</Text>
            </View>

            <Text numberOfLines={expanded ? undefined : 2} variant="muted">
              {notification.body}
            </Text>

            <View className="flex-row flex-wrap items-center gap-2 pt-0.5">
              {notification.needsAction && !isNight ? (
                <Badge label="Needs you" tone="warning" />
              ) : null}
              <Badge label={visual.label} />
            </View>

            {/*
              Only once the row is open, and only as a sentence. The action itself
              is a web endpoint this app deliberately does not fire — saying where
              it can be done beats a button that posts blind.
            */}
            {isNight ? <NightPromptAnswer notification={notification} /> : null}

            {expanded && notification.needsAction && !isNight ? (
              <Text variant="caption">
                This one is waiting on a decision. It can be actioned from the web portal.
              </Text>
            ) : null}
          </View>
        </View>
      </View>
    </Pressable>
  );
}

const NIGHT_ANSWER_LABELS: Record<string, string> = {
  INSIDE_HOSTEL: "Inside",
  MARKED_SAFE: "Safe",
  OUTSIDE_HOSTEL: "Outside",
};

/** "Inside", "Outside · At home", "Outside · at Ram's" — `null` while unanswered. */
function nightAnswerText(notification: AppNotification): string | null {
  if (notification.actionState !== "COMPLETED") {
    return null;
  }

  const answer = (notification.data?.answer ?? {}) as {
    note?: string;
    reasonCode?: NightStatusReasonCode;
    status?: string;
  };
  const status = answer.status ?? notification.actionTakenKey ?? "";

  return [
    NIGHT_ANSWER_LABELS[status] ?? humanizeEnum(status),
    answer.note || reasonLabel(answer.reasonCode),
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * The night question, answerable from the bell — the fallback for a prompt
 * swiped away in the shade, or a phone with notifications off.
 *
 * The server settles this row from every surface — the shade, this row, the
 * night-status screen, the web, a warden's override — so once answered it shows
 * the answer however it was given. Only tonight's row takes an answer; an older
 * one says it went unanswered.
 */
function NightPromptAnswer({ notification }: { notification: AppNotification }) {
  const [given, setGiven] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const answered = given ?? nightAnswerText(notification);

  if (answered) {
    return (
      <Text className="text-primary" variant="caption">
        Answered: {answered}
      </Text>
    );
  }

  if (!notification.needsAction || notification.data?.night !== nightKey()) {
    return <Text variant="caption">Not answered</Text>;
  }

  const answer = async (
    label: string,
    input: { reasonCode?: NightStatusReasonCode; status: "INSIDE_HOSTEL" | "OUTSIDE_HOSTEL" },
  ) => {
    setSaving(label);

    try {
      await setResidentNightStatus({ ...input, source: "APP" });
      setGiven(label === "At home" ? "Outside · At home" : label);
      // Answered here, so the prompts waiting in the shade are done with.
      void collapseNightPrompts({ keepLatest: false });
    } catch (caught) {
      toastError("Could not send your answer", readApiError(caught));
    } finally {
      setSaving(null);
    }
  };

  return (
    <View className="flex-row flex-wrap gap-2 pt-1">
      <Button
        disabled={saving !== null}
        label="Inside"
        loading={saving === "Inside"}
        onPress={() => void answer("Inside", { status: "INSIDE_HOSTEL" })}
        size="sm"
      />
      <Button
        disabled={saving !== null}
        label="At home"
        loading={saving === "At home"}
        onPress={() =>
          void answer("At home", { reasonCode: "HOME", status: "OUTSIDE_HOSTEL" })
        }
        size="sm"
        variant="outline"
      />
      {/* A reason or a note needs the screen with a real text field. */}
      <Button
        disabled={saving !== null}
        label="Other…"
        onPress={() => router.push("/night-status")}
        size="sm"
        variant="outline"
      />
    </View>
  );
}
