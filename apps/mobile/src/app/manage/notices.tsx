import { NoticeReader } from "@/components/notice-reader";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { NoticeArt } from "@/components/notice-art";
import { AppBar } from "@/components/ui/app-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { FloatingButton } from "@/components/ui/floating-button";
import { Input } from "@/components/ui/input";
import { Chip } from "@/components/ui/layout";
import { ListRow, RowDivider } from "@/components/ui/list-row";
import { Screen } from "@/components/ui/screen";
import { Segmented } from "@/components/ui/segmented";
import { Select } from "@/components/ui/select";
import { Sheet } from "@/components/ui/sheet";
import { SkeletonCard } from "@/components/ui/skeleton";
import { EmptyCard, ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useDates } from "@/hooks/use-dates";
import { useResource } from "@/hooks/use-resource";
import {
  createManagedNotice,
  type ManagedNotice,
  NOTICE_CATEGORIES,
  type NoticePush,
  type NoticeAudience,
  type NoticeCategory,
  updateManagedNotice,
} from "@/lib/admin-manage-api";
import { adminQuery } from "@/lib/admin-queries";
import { readApiError } from "@/lib/api-contract";
import { humanizeEnum } from "@/lib/format";
import {
  dayInputFromNow,
  endOfDayIso,
  isFuture,
  isPast,
  startOfDayIso,
  toDayInput,
} from "@/lib/manage-dates";
import { groupNotifications } from "@/lib/notification-groups";
import { toastError, toastSuccess } from "@/lib/toast";

/**
 * Notices, in full.
 *
 * ## What Today already does, and why this is not that
 *
 * `(admin)/today.tsx` has a compose sheet with two fields and an urgent switch,
 * and its own comment explains the omission: scheduling, expiry and audience are
 * "decisions someone makes at a desk with the calendar open". Half of that was
 * right — they are not what you reach for to say *water is off until 4pm* — and
 * half of it was the browser-handoff argument in disguise. Both screens now
 * exist and they are for different jobs: Today writes one, this manages all of
 * them.
 *
 * ## Live, scheduled and expired are computed, not stored
 *
 * There is no status field on a notice. `publishedAt` in the future means it has
 * not gone out yet; `expiresAt` in the past means it no longer applies. The
 * segments below are those two comparisons and nothing else, which is why a
 * notice can move between them without anybody editing it.
 *
 * ## The compose sheet is three fields and a drawer
 *
 * A notice is a title, a body and how loud it is. Everything else — category,
 * audience, when it goes out, when it stops applying — has a working default
 * that is right for almost every notice anybody writes, and putting all seven
 * on one sheet turned *water is off until 4pm* into a form. The people using
 * this run hostels; they are not filling in a ticket.
 *
 * So four of the seven moved behind `More options`, shut by default, with a
 * summary line on the closed row saying what those four currently are. Hidden
 * and *silent* are different things: somebody who scheduled a notice for
 * Tuesday last time must be able to see that from the outside of the drawer.
 *
 * ## There is no delete, on purpose
 *
 * The server offers `POST` and `PATCH` and no `DELETE`. A notice residents have
 * already read should stop *applying*, not stop having existed — so "Expire now"
 * writes `expiresAt`, and the record and its read receipts stay put.
 */

type NoticeState = "all" | "live" | "scheduled" | "expired";

function stateOf(notice: ManagedNotice, now: Date): NoticeState {
  if (isFuture(notice.publishedAt, now)) {
    return "scheduled";
  }

  return isPast(notice.expiresAt, now) ? "expired" : "live";
}

const CATEGORY_OPTIONS = NOTICE_CATEGORIES.map((value) => ({
  label: humanizeEnum(value),
  value,
}));

const AUDIENCE_OPTIONS: {
  description: string;
  label: string;
  value: NoticeAudience;
}[] = [
  {
    description: "Residents and their guardians.",
    label: "Everyone",
    value: "ALL",
  },
  {
    description: "Only the people living here.",
    label: "Residents",
    value: "RESIDENTS",
  },
  {
    /*
     * Worth saying out loud: `deliverNoticeBroadcast` skips the fan-out entirely
     * for this audience. Guardians read notices by opening their dashboard, so a
     * guardians-only notice sends no push and no email — it appears, silently.
     */
    description:
      "Guardians only. Sends no push — they see it on their dashboard.",
    label: "Guardians",
    value: "GUARDIANS",
  },
];

type Draft = {
  category: NoticeCategory;
  content: string;
  expiresOn: string;
  isUrgent: boolean;
  publishOn: string;
  targetAudience: NoticeAudience;
  title: string;
};

const BLANK_DRAFT: Draft = {
  category: "GENERAL",
  content: "",
  expiresOn: "",
  isUrgent: false,
  publishOn: "",
  targetAudience: "ALL",
  title: "",
};

function draftFrom(notice: ManagedNotice): Draft {
  return {
    category: (notice.category as NoticeCategory) ?? "GENERAL",
    content: notice.content,
    expiresOn: toDayInput(notice.expiresAt),
    isUrgent: notice.isUrgent,
    // A notice already live is not re-scheduled by opening it, so the field
    // shows the date it went out and only a deliberate change moves it.
    publishOn: toDayInput(notice.publishedAt),
    targetAudience: (notice.targetAudience as NoticeAudience) ?? "ALL",
    title: notice.title,
  };
}

/**
 * The line on the closed `More options` row.
 *
 * Four values in the order they are asked about, and each one says its
 * *default* in plain words rather than being left out — `Now` and `No expiry`
 * are facts about the notice, and a summary that listed only the non-default
 * ones would change length as it was edited and read as a list of problems.
 */
function draftSummary(draft: Draft): string {
  return [
    humanizeEnum(draft.category),
    AUDIENCE_OPTIONS.find((option) => option.value === draft.targetAudience)
      ?.label ?? "Everyone",
    draft.publishOn ? `From ${draft.publishOn}` : "Now",
    draft.expiresOn ? `Until ${draft.expiresOn}` : "No expiry",
  ].join(" · ");
}

/** Whether any of the four differs from what a blank notice would carry. */
function hasExtraOptions(draft: Draft): boolean {
  return (
    draft.category !== BLANK_DRAFT.category ||
    draft.targetAudience !== BLANK_DRAFT.targetAudience ||
    draft.publishOn !== "" ||
    draft.expiresOn !== ""
  );
}

/** A tile colour and glyph per category, so the board reads before its titles do. */
const CATEGORY_LOOK: Record<
  string,
  { bg: string; icon: keyof typeof Ionicons.glyphMap }
> = {
  EVENT: { bg: "#AF52DE", icon: "calendar-outline" },
  FOOD: { bg: "#FF9500", icon: "restaurant-outline" },
  GENERAL: { bg: "#007AFF", icon: "megaphone-outline" },
  MAINTENANCE: { bg: "#30B0C7", icon: "construct-outline" },
  PAYMENT: { bg: "#34C759", icon: "cash-outline" },
  RULE: { bg: "#5E5CE6", icon: "document-text-outline" },
  URGENT: { bg: "#FF3B30", icon: "alert-circle-outline" },
};

/** The way into push notices, with how many are still going out. */
function PushNoticesEntry() {
  const { colors } = useAppTheme();
  const query = adminQuery.noticePushes();
  const pushes = useResource<NoticePush[]>(query.load, {
    cacheKey: query.key,
    topics: query.topics,
  });
  const running = (pushes.data ?? []).filter(
    (push) => push.status === "ACTIVE",
  ).length;

  return (
    <Pressable
      accessibilityLabel="Push notices"
      accessibilityRole="button"
      className="flex-row items-center gap-3 rounded-2xl border border-border bg-card px-3 py-2.5 active:opacity-70"
      onPress={() => router.push("/manage/push-notices")}
    >
      <NoticeArt size={56} />
      <View className="flex-1 gap-0.5">
        <Text variant="subtitle">Push notices</Text>
        <Text variant="caption">
          {pushes.data ? `${running} running` : "Now, later, daily or weekly"}
        </Text>
      </View>
      <Ionicons
        color={colors.mutedForeground}
        name="chevron-forward"
        size={18}
      />
    </Pressable>
  );
}

export default function ManageNoticesScreen() {
  const { colors } = useAppTheme();
  const dates = useDates();
  const [category, setCategory] = useState<string>("");
  const [state, setState] = useState<NoticeState>("all");
  const [editing, setEditing] = useState<ManagedNotice | null>(null);
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState<Draft>(BLANK_DRAFT);
  const [saving, setSaving] = useState(false);
  /*
   * Expiring is per notice, not per screen: "Expire now" is drawn once for every
   * live notice on the board, so a shared boolean spins all of them at whichever
   * one was tapped.
   */
  const [expiring, setExpiring] = useState<string | null>(null);
  const [showMore, setShowMore] = useState(false);

  /*
   * The category is in the key, so switching filters re-asks — and switching
   * back to one already looked at does not.
   */
  const query = adminQuery.notices(category);
  const notices = useResource<ManagedNotice[]>(query.load, {
    cacheKey: query.key,
    topics: query.topics,
  });

  const now = new Date();
  const rows = useMemo(() => notices.data ?? [], [notices.data]);

  const counts = useMemo(() => {
    const tally = { all: rows.length, expired: 0, live: 0, scheduled: 0 };

    for (const notice of rows) {
      tally[stateOf(notice, now)] += 1;
    }

    return tally;
    // `now` is a fresh Date each render by design — the tally is a snapshot, and
    // pinning it in a dep array would make an expiry that passes while the
    // screen is open invisible until a refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

  const visible = useMemo(
    () =>
      state === "all"
        ? rows
        : rows.filter((notice) => stateOf(notice, now) === state),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, state],
  );
  const groups = useMemo(() => groupNotifications(visible), [visible]);

  const { refresh } = notices;

  const submit = useCallback(async () => {
    const title = draft.title.trim();
    const content = draft.content.trim();

    if (title.length < 2) {
      toastError(
        "Give it a title",
        "Two characters at least — residents scan these.",
      );
      return;
    }

    if (content.length < 2) {
      toastError("Say what it is", "The body cannot be empty.");
      return;
    }

    if (draft.publishOn && !startOfDayIso(draft.publishOn)) {
      toastError("Check the publish date", "Write it as YYYY-MM-DD.");
      return;
    }

    if (draft.expiresOn && !endOfDayIso(draft.expiresOn)) {
      toastError("Check the expiry date", "Write it as YYYY-MM-DD.");
      return;
    }

    setSaving(true);

    try {
      const payload = {
        category: draft.category,
        content,
        expiresAt: draft.expiresOn
          ? (endOfDayIso(draft.expiresOn) ?? undefined)
          : undefined,
        isUrgent: draft.isUrgent,
        publishedAt: draft.publishOn
          ? (startOfDayIso(draft.publishOn) ?? undefined)
          : undefined,
        targetAudience: draft.targetAudience,
        title,
      };

      if (editing) {
        await updateManagedNotice(editing.id, payload);
        toastSuccess("Notice updated");
      } else {
        await createManagedNotice(payload);
        toastSuccess(
          isFuture(payload.publishedAt, new Date())
            ? "Notice scheduled"
            : "Notice published",
          draft.targetAudience === "GUARDIANS"
            ? "Guardians will see it on their dashboard."
            : "Residents have been notified.",
        );
      }

      setComposing(false);
      setEditing(null);
      await refresh();
    } catch (error) {
      toastError(
        "Could not save",
        readApiError(error, "The notice did not save."),
      );
    } finally {
      setSaving(false);
    }
  }, [draft, editing, refresh]);

  const expireNow = useCallback(
    async (notice: ManagedNotice) => {
      setExpiring(notice.id);

      try {
        // Yesterday rather than this instant: `expiresAt` is compared against
        // "now" on every read, and a value a second old is indistinguishable
        // from one that has not landed yet on a phone with a drifting clock.
        await updateManagedNotice(notice.id, {
          expiresAt: endOfDayIso(dayInputFromNow(-1)) ?? undefined,
        });
        toastSuccess("Expired", "It no longer shows on anyone's notice board.");
        setEditing(null);
        await refresh();
      } catch (error) {
        toastError("Could not expire", readApiError(error));
      } finally {
        setExpiring(null);
      }
    },
    [refresh],
  );

  /*
   * The drawer opens with the notice when one of the four is not at its
   * default. Editing a notice scheduled for Tuesday and being shown a shut
   * `More options` row would be the sheet hiding the thing the person opened it
   * to change; a plain new notice still starts shut, which is the whole point.
   */
  const [reading, setReading] = useState<ManagedNotice | null>(null);

  const open = useCallback((notice: ManagedNotice) => {
    const next = draftFrom(notice);

    setDraft(next);
    setShowMore(hasExtraOptions(next));
    setEditing(notice);
  }, []);

  const compose = useCallback(() => {
    setDraft(BLANK_DRAFT);
    setShowMore(false);
    setEditing(null);
    setComposing(true);
  }, []);

  return (
    <Screen
      floating={
        <FloatingButton
          icon="create-outline"
          label="Write a notice"
          onPress={compose}
        />
      }
      header={<AppBar accent centerTitle showBack title="Notices" />}
      onRefresh={notices.refresh}
      refreshing={notices.refreshing}
      scroll
    >
      <View className="gap-4 pt-1">
        <PushNoticesEntry />

        <Segmented
          onChange={setState}
          options={[
            { count: counts.all, label: "All", value: "all" },
            { count: counts.live, label: "Live", value: "live" },
            { count: counts.scheduled, label: "Scheduled", value: "scheduled" },
            { count: counts.expired, label: "Expired", value: "expired" },
          ]}
          value={state}
        />

        {/*
          Category filters the *request*, unlike the segments above it, because
          the server takes `?category=` and the list is capped at fifty rows —
          filtering client-side would quietly hide older notices in a busy
          category.
        */}
        <ScrollView
          contentContainerClassName="gap-2 pr-4"
          horizontal
          showsHorizontalScrollIndicator={false}
        >
          <Chip
            label="Every category"
            onPress={() => setCategory("")}
            tone={category === "" ? "brand" : "neutral"}
          />
          {NOTICE_CATEGORIES.map((value) => (
            <Chip
              key={value}
              label={humanizeEnum(value)}
              onPress={() => setCategory(value)}
              tone={category === value ? "brand" : "neutral"}
            />
          ))}
        </ScrollView>

        {notices.loading ? <SkeletonCard rows={3} /> : null}

        {notices.error ? (
          <ErrorState message={notices.error} onRetry={notices.reload} />
        ) : null}

        {!notices.loading && !notices.error && visible.length === 0 ? (
          <EmptyCard
            description={
              state === "all"
                ? "Nothing has been posted here yet."
                : `No ${state} notices${category ? ` in ${humanizeEnum(category)}` : ""}.`
            }
            title="Nothing to show"
          />
        ) : null}

        {groups.map((group) => (
          <View className="gap-2" key={group.bucket}>
            <Text
              className="px-0.5 font-semibold uppercase tracking-wider"
              variant="caption"
            >
              {group.label}
            </Text>
            <Card padding="px-4 py-1">
              {group.rows.map((notice, index) => {
                const current = stateOf(notice, now);
                const look = notice.isUrgent
                  ? CATEGORY_LOOK.URGENT!
                  : (CATEGORY_LOOK[notice.category] ?? CATEGORY_LOOK.GENERAL!);

                return (
                  <View key={notice.id}>
                    {index > 0 ? <RowDivider inset /> : null}
                    <ListRow
                      icon={look.icon}
                      iconBgColor={current === "expired" ? "#8E8E93" : look.bg}
                      onPress={() => setReading(notice)}
                      right={
                        <Badge
                          label={
                            current === "live"
                              ? "Live"
                              : current === "scheduled"
                                ? "Scheduled"
                                : "Expired"
                          }
                          tone={
                            current === "live"
                              ? "success"
                              : current === "scheduled"
                                ? "info"
                                : "neutral"
                          }
                        />
                      }
                      subtitle={`${
                        notice.targetAudience === "ALL"
                          ? "Everyone"
                          : humanizeEnum(notice.targetAudience)
                      } · ${
                        current === "scheduled"
                          ? `goes out ${dates.dateTime(notice.publishedAt)}`
                          : dates.ago(notice.publishedAt ?? notice.createdAt)
                      }`}
                      title={notice.title}
                    />
                  </View>
                );
              })}
            </Card>
          </View>
        ))}
      </View>

      <Sheet
        open={reading !== null}
        onClose={() => setReading(null)}
        title="Notice"
        footer={
          <Button
            label="Edit notice"
            variant="outline"
            onPress={() => {
              if (reading) {
                open(reading);
                setReading(null);
              }
            }}
          />
        }
      >
        {reading ? (
          <NoticeReader
            title={reading.title}
            content={reading.content}
            category={humanizeEnum(reading.category)}
            urgent={reading.isUrgent}
            date={dates.date(reading.publishedAt ?? reading.createdAt)}
          />
        ) : null}
      </Sheet>

      <Sheet
        footer={
          <Button
            label={editing ? "Save changes" : "Publish"}
            loading={saving}
            onPress={() => void submit()}
          />
        }
        onClose={() => {
          setComposing(false);
          setEditing(null);
          setShowMore(false);
        }}
        open={composing || editing !== null}
        title={editing ? "Edit notice" : "New notice"}
      >
        <View className="gap-4 pb-2">
          {editing && stateOf(editing, new Date()) !== "expired" ? (
            <Button
              label="Expire now"
              loading={expiring === editing.id}
              onPress={() => void expireNow(editing)}
              size="sm"
              variant="outline"
            />
          ) : null}

          <Input
            label="Title"
            onChangeText={(title) => setDraft((prev) => ({ ...prev, title }))}
            placeholder="Water supply interrupted"
            value={draft.title}
          />

          <Input
            label="Notice"
            multiline
            onChangeText={(content) =>
              setDraft((prev) => ({ ...prev, content }))
            }
            placeholder="What is happening, and what should people do about it."
            style={{ height: 132 }}
            value={draft.content}
          />

          {/*
            Two words, not a switch with a paragraph under it.

            Urgency is the third thing a notice has, so it stays on the sheet
            rather than going in the drawer — but it was a label, a sentence of
            explanation and a toggle: three lines to answer a two-state
            question. The segments carry the answer on their faces, and what
            "urgent" does is said once underneath instead of once per state.
          */}
          <View className="gap-1.5">
            <Text variant="label">How loud</Text>
            <Segmented
              onChange={(value) =>
                setDraft((prev) => ({ ...prev, isUrgent: value === "urgent" }))
              }
              options={[
                { label: "Normal", value: "normal" },
                { label: "Urgent", value: "urgent" },
              ]}
              value={draft.isUrgent ? "urgent" : "normal"}
            />
            <Text variant="caption">
              {draft.isUrgent
                ? "Pinned to the top of the notice board and coloured red."
                : "Sits in date order on the notice board."}
            </Text>
          </View>

          {/*
            The other four, shut. See the note at the top of the file for why —
            and note the summary on the closed row, which is what keeps a notice
            scheduled for Tuesday from looking like one going out now.
          */}
          <View className="overflow-hidden rounded-xl border border-border">
            <Pressable
              accessibilityLabel="More notice options"
              accessibilityRole="button"
              accessibilityState={{ expanded: showMore }}
              className="flex-row items-center gap-3 px-3 py-2.5 active:opacity-70"
              onPress={() => setShowMore((value) => !value)}
            >
              <View className="flex-1">
                <Text variant="label">More options</Text>
                <Text numberOfLines={1} variant="caption">
                  {draftSummary(draft)}
                </Text>
              </View>
              <Ionicons
                color={colors.mutedForeground}
                name={showMore ? "chevron-up" : "chevron-down"}
                size={18}
              />
            </Pressable>

            {showMore ? (
              <View className="gap-3 border-t border-border px-3 py-3">
                <Select
                  label="Category"
                  onChange={(value) =>
                    setDraft((prev) => ({ ...prev, category: value }))
                  }
                  options={CATEGORY_OPTIONS}
                  value={draft.category}
                />

                <Select
                  label="Who sees it"
                  onChange={(value) =>
                    setDraft((prev) => ({ ...prev, targetAudience: value }))
                  }
                  options={AUDIENCE_OPTIONS}
                  value={draft.targetAudience}
                />

                <View className="gap-2">
                  <Input
                    hint="Leave blank to publish immediately."
                    keyboardType="numbers-and-punctuation"
                    label="Publish on"
                    onChangeText={(publishOn) =>
                      setDraft((prev) => ({ ...prev, publishOn }))
                    }
                    placeholder="YYYY-MM-DD"
                    value={draft.publishOn}
                  />
                  <View className="flex-row flex-wrap gap-2">
                    <Chip
                      label="Now"
                      onPress={() =>
                        setDraft((prev) => ({ ...prev, publishOn: "" }))
                      }
                    />
                    <Chip
                      label="Tomorrow"
                      onPress={() =>
                        setDraft((prev) => ({
                          ...prev,
                          publishOn: dayInputFromNow(1),
                        }))
                      }
                    />
                    <Chip
                      label="In a week"
                      onPress={() =>
                        setDraft((prev) => ({
                          ...prev,
                          publishOn: dayInputFromNow(7),
                        }))
                      }
                    />
                  </View>
                </View>

                <View className="gap-2">
                  <Input
                    hint="The last day it applies. Leave blank and it stays up until you expire it."
                    keyboardType="numbers-and-punctuation"
                    label="Expires on"
                    onChangeText={(expiresOn) =>
                      setDraft((prev) => ({ ...prev, expiresOn }))
                    }
                    placeholder="YYYY-MM-DD"
                    value={draft.expiresOn}
                  />
                  <View className="flex-row flex-wrap gap-2">
                    <Chip
                      label="Never"
                      onPress={() =>
                        setDraft((prev) => ({ ...prev, expiresOn: "" }))
                      }
                    />
                    <Chip
                      label="In 3 days"
                      onPress={() =>
                        setDraft((prev) => ({
                          ...prev,
                          expiresOn: dayInputFromNow(3),
                        }))
                      }
                    />
                    <Chip
                      label="In a week"
                      onPress={() =>
                        setDraft((prev) => ({
                          ...prev,
                          expiresOn: dayInputFromNow(7),
                        }))
                      }
                    />
                    <Chip
                      label="In a month"
                      onPress={() =>
                        setDraft((prev) => ({
                          ...prev,
                          expiresOn: dayInputFromNow(30),
                        }))
                      }
                    />
                  </View>
                </View>
              </View>
            ) : null}
          </View>
        </View>
      </Sheet>
    </Screen>
  );
}
