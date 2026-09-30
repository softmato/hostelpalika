import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { NotificationBell } from "@/components/notification-bell";
import { AppBar } from "@/components/ui/app-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Chip } from "@/components/ui/layout";
import { Screen } from "@/components/ui/screen";
import { Segmented } from "@/components/ui/segmented";
import { Skeleton, SkeletonRows } from "@/components/ui/skeleton";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useDates } from "@/hooks/use-dates";
import { useResource } from "@/hooks/use-resource";
import { residentQuery } from "@/lib/resident-queries";
import { humanizeEnum } from "@/lib/format";
import {
  filterNotices,
  groupNoticesByDay,
  noticeCategories,
  type NoticeStatus,
} from "@/lib/notice-list";
import {
  getResidentNotices,
  markNoticeRead,
  type ResidentNotice,
  type ResidentNoticeList,
} from "@/lib/resident-api";

/**
 * Notices from the hostel.
 *
 * ## Two controls, because there were two questions in one
 *
 * The filter used to be a single horizontal scroller carrying `All`, `Unread`,
 * `Urgent` and then every category the hostel posts under. Two different kinds
 * of question sharing one row, which meant they clobbered each other: tapping
 * `Maintenance` cleared `Unread`, so *unread maintenance notices* — the query
 * somebody opening this screen on a Monday actually has — could not be asked at
 * all.
 *
 * So the status is a `<Segmented>` (three exclusive views of one list, with the
 * counts on the labels, which is exactly what that component is for) and the
 * category is a chip row **under** it that composes with the view instead of
 * replacing it. The chips appear only when the hostel uses more than one
 * category; a lone chip is a control that does nothing.
 *
 * The rules that survived the split, both in `lib/notice-list.ts`: the
 * categories come from the rows in hand rather than from an enum, so a hostel
 * that never posts a maintenance notice has no maintenance chip; and `urgent`
 * does not imply unread, so an urgent notice already read still appears under
 * `Urgent`, which is the one somebody is most likely to be looking for again.
 *
 * ## The list is grouped by day
 *
 * `NOTES.md` §5 — the heading on the page background, the day's cards under it.
 * Every notice used to print its own `3 days ago` on its own bottom row, which
 * is the flat-list shape that rule exists to replace: eleven timestamps down a
 * column, none of them adjacent to each other, and no way to see that four of
 * them are the same day. The date moved up to the heading and off the rows.
 *
 * The heading is drawn through `useDates()` rather than by the pure module, so
 * it follows the resident's **calendar preference** — a heading in AD above
 * rows a BS reader is counting from is worse than no heading.
 *
 * ## Read is marked on expand, not on scroll-past
 *
 * A notice counts as read when the resident opens it, because that is the only
 * moment we know they saw the *content* rather than the headline. Marking on
 * render would clear the unread badge for a list somebody scrolled past on the
 * way to Payments, and the one notice that matters — a water cut tomorrow — is
 * exactly the one that gets scrolled past.
 *
 * The flip is **optimistic**: the row un-bolds immediately and the PATCH runs
 * behind it. The server upserts with `$setOnInsert`, so a replay is a no-op
 * rather than a second timestamp, and a failed call leaves a notice marked read
 * locally that the next fetch will correct. Both failure modes are cheaper than
 * a tap that appears to do nothing.
 *
 * ## Against `resident-notices-page.tsx` (§5.1)
 *
 * The web filters by **status** — All / Unread / Urgent, with counts — and this
 * screen filtered by **category**. Both are worth having and both are here now,
 * on the two controls above rather than fighting over one.
 *
 * Also fixed here rather than ported: the screen fetched page 1 and dropped
 * `pagination.hasMore` on the floor, so a hostel that posts often had older
 * notices that no resident could reach on the phone at all.
 */

const STATUS_ALL: NoticeStatus = "all";

export default function ResidentNoticesScreen() {
  const dates = useDates();

  // Published by `notice.service.ts` to the whole hostel the moment a notice
  // goes out — "everyone in the hostel gets the notice board refreshed" is its
  // own comment. This is the screen it meant.
  const query = residentQuery.notices();
  const notices = useResource<ResidentNoticeList>(query.load, {
    cacheKey: query.key,
    topics: query.topics,
  });
  const [status, setStatus] = useState<NoticeStatus>(STATUS_ALL);
  const [category, setCategory] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  // Memoised because the `?? []` on the next line would otherwise be a new
  // array identity every render, re-deriving the category list each time.
  const rows = useMemo(() => notices.data?.notices ?? [], [notices.data]);

  const categories = useMemo(() => noticeCategories(rows), [rows]);

  const unread = rows.filter((notice) => !notice.isRead).length;
  const urgent = rows.filter((notice) => notice.isUrgent).length;

  const days = useMemo(
    () => groupNoticesByDay(filterNotices(rows, status, category)),
    [category, rows, status],
  );

  const pagination = notices.data?.pagination;

  const loadMore = useCallback(async () => {
    if (!pagination?.hasMore || loadingMore) {
      return;
    }

    setLoadingMore(true);

    try {
      const next = await getResidentNotices(pagination.page + 1);

      // Appended, not replaced: the point of the button is to grow the list.
      notices.setData((current) =>
        current
          ? { ...next, notices: [...current.notices, ...next.notices] }
          : next,
      );
    } catch {
      // Silent. The button stays, and the list the resident already has is
      // untouched — a toast about page 2 is noise on a screen being read.
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, notices, pagination]);

  const markRead = useCallback(
    (notice: ResidentNotice) => {
      if (notice.isRead) {
        return;
      }

      notices.setData((current) =>
        current
          ? {
              ...current,
              notices: current.notices.map((row) =>
                row.id === notice.id ? { ...row, isRead: true } : row,
              ),
            }
          : current,
      );

      // Fire and forget. The next fetch is the correction, and a toast about a
      // read receipt would be noise on a screen someone is reading.
      void markNoticeRead(notice.id).catch(() => undefined);
    },
    [notices],
  );

  const header = (
    <AppBar
      /*
       * Reached by a push from Home now that Community holds the fifth tab slot,
       * so it needs a way back — and an explicit destination rather than
       * `router.back()`, because this is still a screen *inside* the tab
       * navigator and a bottom-tab navigator's default `backBehavior` is
       * `firstRoute`, not `history`.
       *
       * No `large`: that prop marks a tab, and this screen carries a back arrow.
       * See its own note in `components/ui/app-bar.tsx`.
       */
      actions={<NotificationBell />}
      onBack={() => router.navigate("/(resident)")}
      showBack
      subtitle={unread > 0 ? `${unread} unread` : undefined}
      title="Notices"
    />
  );

  if (notices.loading) {
    return (
      <Screen header={header} insideTabs>
        {/* The segmented track, the chip row, then a stack of notice cards. */}
        <View className="gap-4">
          <Skeleton height={38} radius={19} />

          <View className="flex-row gap-2">
            <Skeleton height={28} radius={8} width={76} />
            <Skeleton height={28} radius={8} width={68} />
            <Skeleton height={28} radius={8} width={84} />
          </View>

          <SkeletonRows rows={6} />
        </View>
      </Screen>
    );
  }

  if (notices.error || !notices.data) {
    return (
      <Screen header={header} insideTabs>
        <ErrorState
          message={notices.error ?? "Notices could not be loaded."}
          onRetry={notices.reload}
        />
      </Screen>
    );
  }

  return (
    <Screen
      header={header}
      insideTabs
      onRefresh={notices.refresh}
      refreshing={notices.refreshing}
      scroll
    >
      <View className="gap-4 pt-1">
        {/*
          The counts are the whole reason these are segments rather than three
          words: "is it worth tapping" gets answered before it is tapped. They
          are omitted when zero — `Unread 0` is a segment offering an empty list.
        */}
        <Segmented
          onChange={setStatus}
          options={[
            { label: "All", value: "all" },
            { count: unread > 0 ? unread : undefined, label: "Unread", value: "unread" },
            { count: urgent > 0 ? urgent : undefined, label: "Urgent", value: "urgent" },
          ]}
          value={status}
        />

        {categories.length > 1 ? (
          <ScrollView
            contentContainerClassName="gap-2"
            horizontal
            showsHorizontalScrollIndicator={false}
          >
            {/*
              `All` is a chip like the others rather than a cleared state with no
              control, because a chip row with nothing lit looks like a row
              nobody has touched yet — and a resident who has filtered to
              `Maintenance` needs an obvious way back that is not "tap the lit
              one again".
            */}
            <Chip
              label="All"
              onPress={() => setCategory(null)}
              tone={category === null ? "brand" : "neutral"}
            />
            {categories.map((option) => (
              <Chip
                key={option}
                label={humanizeEnum(option)}
                onPress={() => setCategory(option)}
                tone={category === option ? "brand" : "neutral"}
              />
            ))}
          </ScrollView>
        ) : null}

        {days.length === 0 ? (
          <EmptyState
            description={
              category !== null
                ? "Nothing in this category yet."
                : status === "all"
                  ? "Your hostel has not posted anything yet."
                  : status === "unread"
                    ? "You have read everything."
                    : "Nothing urgent right now."
            }
            title="No notices"
          />
        ) : (
          <View className="gap-5">
            {days.map((day) => (
              <View className="gap-2" key={day.key || "undated"}>
                {/*
                  Outside the cards, on the page background — `NOTES.md` §5. The
                  rows underneath no longer carry a timestamp of their own, so
                  this heading is the only place the date is stated and it has to
                  be here.
                */}
                <Text className="px-1" variant="label">
                  {day.iso ? dates.relativeDay(day.iso) : "Date not recorded"}
                </Text>

                <View className="gap-3">
                  {day.notices.map((notice) => (
                    <NoticeCard key={notice.id} notice={notice} onOpen={markRead} />
                  ))}
                </View>
              </View>
            ))}
          </View>
        )}

        {/*
          Older notices were unreachable before this: the screen asked for page
          one and never looked at `hasMore`. Hidden while anything is filtered —
          the filters run over what has been fetched, so "load more" under an
          empty filtered view would look like it had failed.
        */}
        {pagination?.hasMore && status === STATUS_ALL && category === null ? (
          <Button
            label={loadingMore ? "Loading…" : "Load older notices"}
            loading={loadingMore}
            onPress={() => void loadMore()}
            variant="outline"
          />
        ) : null}
      </View>
    </Screen>
  );
}

/** A tile colour and glyph per category — the same set the office's board uses. */
const CATEGORY_LOOK: Record<string, { bg: string; icon: keyof typeof Ionicons.glyphMap }> = {
  EVENT: { bg: "#AF52DE", icon: "calendar-outline" },
  FOOD: { bg: "#FF9500", icon: "restaurant-outline" },
  GENERAL: { bg: "#007AFF", icon: "megaphone-outline" },
  MAINTENANCE: { bg: "#30B0C7", icon: "construct-outline" },
  PAYMENT: { bg: "#34C759", icon: "cash-outline" },
  RULE: { bg: "#5E5CE6", icon: "document-text-outline" },
  URGENT: { bg: "#FF3B30", icon: "alert-circle-outline" },
};

/**
 * One notice, collapsed to two lines until it is opened.
 *
 * The published date is **not** on it. It is on the day heading above the group
 * this card is in, which is the whole of what the grouping bought — see the
 * screen's note. What stays on the row is what varies *within* a day: whether it
 * is urgent, what it is about, and whether this resident has read it.
 */
function NoticeCard({
  notice,
  onOpen,
}: {
  notice: ResidentNotice;
  onOpen: (notice: ResidentNotice) => void;
}) {
  const { colors } = useAppTheme();
  const [expanded, setExpanded] = useState(false);
  const look = notice.isUrgent
    ? CATEGORY_LOOK.URGENT!
    : (CATEGORY_LOOK[notice.category ?? ""] ?? CATEGORY_LOOK.GENERAL!);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded }}
      onPress={() => {
        setExpanded((value) => !value);
        onOpen(notice);
      }}
    >
      {/*
        Urgent gets a left border rather than a red card. A whole notice in
        alarm colours is unreadable, and once two of them are on screen neither
        reads as urgent any more.
      */}
      <Card
        className={`gap-2 active:opacity-80 ${
          notice.isUrgent ? "border-l-4 border-l-destructive" : ""
        }`}
      >
        <View className="flex-row items-start gap-3">
          {/*
            The web's icon square, ported. It carries the urgency — red for an
            alert, brand for an announcement — which is what makes a list of ten
            notices scannable without reading any of them.
          */}
          <View
            className="h-9 w-9 items-center justify-center rounded-[10px]"
            style={{ backgroundColor: look.bg }}
          >
            <Ionicons color="#FFFFFF" name={look.icon} size={18} />
          </View>

          <View className="flex-1 gap-2">
            <View className="flex-row items-start gap-2">
              {!notice.isRead ? (
                <View
                  accessibilityLabel="Unread"
                  className="mt-1.5 h-2 w-2 rounded-full"
                  style={{ backgroundColor: colors.primary }}
                />
              ) : null}

              <Text
                className={`flex-1 ${notice.isRead ? "" : "font-semibold"}`}
                variant="subtitle"
              >
                {notice.title}
              </Text>

              <Ionicons
                color={colors.mutedForeground}
                name={expanded ? "chevron-up" : "chevron-down"}
                size={18}
              />
            </View>

            <Text numberOfLines={expanded ? undefined : 2} variant="muted">
              {notice.content}
            </Text>

            {notice.isUrgent || notice.category ? (
              <View className="flex-row flex-wrap items-center gap-2">
                {notice.isUrgent ? <Badge label="Urgent" tone="danger" /> : null}
                {notice.category ? <Badge label={humanizeEnum(notice.category)} /> : null}
              </View>
            ) : null}
          </View>
        </View>
      </Card>
    </Pressable>
  );
}
