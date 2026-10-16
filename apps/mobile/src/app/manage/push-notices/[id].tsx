import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { Image, Pressable, View } from "react-native";

import { AppBar } from "@/components/ui/app-bar";
import { Button } from "@/components/ui/button";
import { Card, SectionHeader } from "@/components/ui/card";
import { ChoiceChips } from "@/components/ui/choice-chips";
import { Glyph } from "@/components/ui/glyph";
import { Input } from "@/components/ui/input";
import { Screen } from "@/components/ui/screen";
import { SkeletonCard } from "@/components/ui/skeleton";
import { EmptyCard, ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { Toggle } from "@/components/ui/toggle";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useDates } from "@/hooks/use-dates";
import { useResource } from "@/hooks/use-resource";
import {
  createNoticePush,
  deleteNoticePush,
  type NoticePush,
  type NoticePushInput,
  type NoticePushRepeat,
  sendNoticePushNow,
  updateNoticePush,
} from "@/lib/admin-manage-api";
import { adminQuery } from "@/lib/admin-queries";
import { readApiError } from "@/lib/api-contract";
import { openConfirm } from "@/lib/confirm";
import { dayInputFromNow } from "@/lib/manage-dates";
import {
  DELAY_OPTIONS,
  PUSH_MODES,
  TIME_PRESETS,
  WEEKDAY_OPTIONS,
} from "@/lib/notice-push";
import { toastError, toastSuccess } from "@/lib/toast";

/**
 * One push notice: what it says and when it goes out. `new` in the URL writes
 * one. The card straddling the header is the push as a phone will show it,
 * redrawn as it is typed.
 */

const STRADDLE = 40;

const LIFT = {
  elevation: 8,
  shadowColor: "#000000",
  shadowOffset: { height: 6, width: 0 },
  shadowOpacity: 0.13,
  shadowRadius: 16,
} as const;

const LOGO = require("../../../../assets/images/logo-mark.png");
const LOGO_LIGHT = require("../../../../assets/images/logo-mark-light.png");

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

type Draft = {
  active: boolean;
  body: string;
  date: string;
  /** Minutes from now, as a string, or `custom` for a date and time. */
  delay: string;
  isUrgent: boolean;
  repeat: NoticePushRepeat;
  time: string;
  title: string;
  weekdays: number[];
};

function blankDraft(): Draft {
  return {
    active: true,
    body: "",
    date: dayInputFromNow(0),
    delay: "60",
    isUrgent: false,
    repeat: "NOW",
    time: "18:00",
    title: "",
    weekdays: [],
  };
}

function draftFrom(push: NoticePush): Draft {
  return {
    active: push.status !== "PAUSED",
    body: push.body,
    date: push.startsOn ?? dayInputFromNow(0),
    delay: push.repeat === "LATER" ? "custom" : "60",
    isUrgent: push.isUrgent,
    repeat: push.repeat,
    time: push.time ?? "18:00",
    title: push.title,
    weekdays: push.weekdays,
  };
}

function timingKey(draft: Draft) {
  return JSON.stringify([
    draft.repeat,
    draft.delay,
    draft.date,
    draft.time,
    [...draft.weekdays].sort(),
  ]);
}

function ModeTiles({
  onChange,
  value,
}: {
  onChange: (value: NoticePushRepeat) => void;
  value: NoticePushRepeat;
}) {
  const { colors } = useAppTheme();

  return (
    <View className="flex-row gap-2">
      {PUSH_MODES.map((mode) => {
        const on = mode.value === value;

        return (
          <Pressable
            accessibilityLabel={mode.label}
            accessibilityRole="radio"
            accessibilityState={{ checked: on }}
            className={`flex-1 items-center gap-1.5 rounded-2xl border py-3 active:opacity-70 ${
              on ? "border-primary" : "border-border bg-card"
            }`}
            key={mode.value}
            onPress={() => onChange(mode.value)}
            style={on ? { backgroundColor: `${colors.primary}14` } : undefined}
          >
            <View
              className="h-9 w-9 items-center justify-center rounded-full"
              style={{ backgroundColor: on ? colors.primary : colors.muted }}
            >
              <Glyph
                color={on ? colors.primaryForeground : colors.mutedForeground}
                name={mode.icon}
                size={18}
              />
            </View>
            <Text className={on ? "font-semibold text-foreground" : ""} variant="caption">
              {mode.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function TimeField({ onChange, value }: { onChange: (value: string) => void; value: string }) {
  return (
    <View className="gap-3">
      <ChoiceChips label="Time" onToggle={onChange} options={TIME_PRESETS} value={value} />
      <Input
        hint="24-hour, like 18:30"
        keyboardType="numbers-and-punctuation"
        label="Exact time"
        onChangeText={onChange}
        placeholder="HH:mm"
        value={value}
      />
    </View>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <View className="flex-row items-center justify-between gap-3">
      <Text variant="muted">{label}</Text>
      <Text variant="label">{value}</Text>
    </View>
  );
}

export default function PushNoticeScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const isNew = id === "new";
  const { isDark } = useAppTheme();
  const dates = useDates();
  const query = adminQuery.noticePushes();
  const pushes = useResource<NoticePush[]>(query.load, {
    cacheKey: query.key,
    topics: query.topics,
  });
  const existing = isNew ? null : (pushes.data?.find((push) => push.id === id) ?? null);
  const [blank] = useState(blankDraft);
  // What the push is on the server; edits sit on top until saved.
  const initial = useMemo(
    () => (isNew ? blank : existing ? draftFrom(existing) : null),
    [blank, existing, isNew],
  );
  const [edited, setEdited] = useState<Draft | null>(null);
  const draft = edited ?? initial;
  const [saving, setSaving] = useState(false);
  const { refresh } = pushes;

  const patch = useCallback(
    (next: Partial<Draft>) => {
      setEdited((prev) => {
        const base = prev ?? initial;

        return base ? { ...base, ...next } : prev;
      });
    },
    [initial],
  );

  const save = useCallback(async () => {
    if (!draft) {
      return;
    }

    const title = draft.title.trim();
    const body = draft.body.trim();
    const custom = draft.repeat === "LATER" && draft.delay === "custom";

    if (title.length < 2) {
      toastError("Give it a title", "Two characters at least.");
      return;
    }

    if (body.length < 2) {
      toastError("Write the message", "It cannot be empty.");
      return;
    }

    if ((custom || draft.repeat === "DAILY" || draft.repeat === "WEEKLY") && !TIME_RE.test(draft.time)) {
      toastError("Check the time", "Write it as HH:mm, like 18:30.");
      return;
    }

    if (custom && !DATE_RE.test(draft.date)) {
      toastError("Check the date", "Write it as YYYY-MM-DD.");
      return;
    }

    if (draft.repeat === "WEEKLY" && draft.weekdays.length === 0) {
      toastError("Pick the days", "At least one day of the week.");
      return;
    }

    const input: NoticePushInput = { body, isUrgent: draft.isUrgent, title };

    // Unchanged timing is left out, so editing the words of a finished push
    // does not re-ask the server to schedule it.
    if (!existing || !initial || timingKey(draft) !== timingKey(initial)) {
      input.repeat = draft.repeat;

      if (draft.repeat === "LATER") {
        Object.assign(
          input,
          custom ? { date: draft.date, time: draft.time } : { delayMinutes: Number(draft.delay) },
        );
      } else if (draft.repeat === "DAILY") {
        input.time = draft.time;
      } else if (draft.repeat === "WEEKLY") {
        Object.assign(input, { time: draft.time, weekdays: draft.weekdays });
      }
    }

    if (existing && draft.repeat !== "NOW") {
      input.active = draft.active;
    }

    setSaving(true);

    try {
      if (existing) {
        await updateNoticePush(existing.id, input);
        toastSuccess("Saved");
      } else {
        await createNoticePush(input);
        toastSuccess(
          draft.repeat === "NOW" ? "Sent" : "Scheduled",
          draft.repeat === "NOW" ? "Residents have been notified." : undefined,
        );
      }

      await refresh();
      router.back();
    } catch (error) {
      toastError("Could not save", readApiError(error, "The push notice did not save."));
    } finally {
      setSaving(false);
    }
  }, [draft, existing, initial, refresh]);

  const sendNow = useCallback(() => {
    if (!existing) {
      return;
    }

    openConfirm({
      confirmLabel: "Send now",
      message: "Residents get it on their phones and the notice board.",
      onConfirm: async () => {
        try {
          await sendNoticePushNow(existing.id);
          toastSuccess("Sent", "Residents have been notified.");
          await refresh();
        } catch (error) {
          toastError("Could not send", readApiError(error));
        }
      },
      title: "Send it now?",
    });
  }, [existing, refresh]);

  const remove = useCallback(() => {
    if (!existing) {
      return;
    }

    openConfirm({
      confirmLabel: "Delete",
      destructive: true,
      message: "It stops going out. Notices it already sent stay on the board.",
      onConfirm: async () => {
        try {
          await deleteNoticePush(existing.id);
          toastSuccess("Deleted");
          await refresh();
          router.back();
        } catch (error) {
          toastError("Could not delete", readApiError(error));
        }
      },
      title: "Delete this push notice?",
    });
  }, [existing, refresh]);

  const header = (
    <View className="bg-background">
      <AppBar
        accent
        centerTitle
        showBack
        straddle={STRADDLE}
        title={isNew ? "New push notice" : "Push notice"}
      />
      <View className="px-4" style={{ marginTop: -STRADDLE }}>
        <View
          className="flex-row gap-3 rounded-2xl border border-border bg-card p-3.5"
          style={LIFT}
        >
          <Image
            accessibilityIgnoresInvertColors
            source={isDark ? LOGO_LIGHT : LOGO}
            style={{ borderRadius: 10, height: 38, width: 38 }}
          />
          <View className="flex-1 gap-0.5">
            <View className="flex-row items-center gap-2">
              <Text className="flex-1" numberOfLines={1} variant="label">
                {draft?.title.trim() || "Title"}
              </Text>
              <Text variant="caption">now</Text>
            </View>
            <Text numberOfLines={2} variant="muted">
              {draft?.body.trim() || "Your message shows here."}
            </Text>
          </View>
        </View>
      </View>
    </View>
  );

  if (!draft) {
    return (
      <Screen header={header}>
        <View className="pt-3">
          {pushes.error ? (
            <ErrorState message={pushes.error} onRetry={pushes.reload} />
          ) : pushes.loading || !pushes.data ? (
            <SkeletonCard rows={4} />
          ) : (
            <EmptyCard description="It may have been deleted." title="Push notice not found" />
          )}
        </View>
      </Screen>
    );
  }

  const repeating = draft.repeat !== "NOW";

  return (
    <Screen header={header} scroll>
      <View className="gap-5 pb-6 pt-3">
        <View>
          <SectionHeader title="Message" />
          <Card className="gap-3">
            <Input
              label="Title"
              onChangeText={(title) => patch({ title })}
              placeholder="Clothes Washing Notice"
              value={draft.title}
            />
            <Input
              label="Message"
              multiline
              onChangeText={(body) => patch({ body })}
              placeholder="What residents should know or do."
              style={{ height: 110 }}
              value={draft.body}
            />
            <View className="flex-row items-center gap-3">
              <View className="flex-1">
                <Text variant="label">Urgent</Text>
                <Text variant="caption">Pinned to the top of the notice board</Text>
              </View>
              <Toggle
                accessibilityLabel="Urgent"
                onChange={(isUrgent) => patch({ isUrgent })}
                value={draft.isUrgent}
              />
            </View>
          </Card>
        </View>

        <View>
          <SectionHeader title="When" />
          <ModeTiles onChange={(repeat) => patch({ repeat })} value={draft.repeat} />

          {repeating ? (
            <Card className="mt-3 gap-4">
              {draft.repeat === "LATER" ? (
                <>
                  <ChoiceChips
                    label="Goes out"
                    onToggle={(delay) => patch({ delay })}
                    options={DELAY_OPTIONS}
                    value={draft.delay}
                  />
                  {draft.delay === "custom" ? (
                    <>
                      <Input
                        keyboardType="numbers-and-punctuation"
                        label="Date"
                        onChangeText={(date) => patch({ date })}
                        placeholder="YYYY-MM-DD"
                        value={draft.date}
                      />
                      <TimeField onChange={(time) => patch({ time })} value={draft.time} />
                    </>
                  ) : null}
                </>
              ) : null}

              {draft.repeat === "WEEKLY" ? (
                <ChoiceChips
                  label="Days"
                  onToggle={(day) =>
                    patch({
                      weekdays: draft.weekdays.includes(Number(day))
                        ? draft.weekdays.filter((value) => value !== Number(day))
                        : [...draft.weekdays, Number(day)],
                    })
                  }
                  options={WEEKDAY_OPTIONS}
                  value={draft.weekdays.map(String)}
                />
              ) : null}

              {draft.repeat === "DAILY" || draft.repeat === "WEEKLY" ? (
                <TimeField onChange={(time) => patch({ time })} value={draft.time} />
              ) : null}
            </Card>
          ) : null}
        </View>

        {existing ? (
          <View>
            <SectionHeader title="Status" />
            <Card className="gap-3">
              {repeating ? (
                <View className="flex-row items-center gap-3">
                  <View className="flex-1">
                    <Text variant="label">Running</Text>
                    <Text variant="caption">
                      {!draft.active
                        ? "Paused"
                        : existing.nextRunAt
                          ? `Next ${dates.dateTime(existing.nextRunAt)}`
                          : "Nothing left to send"}
                    </Text>
                  </View>
                  <Toggle
                    accessibilityLabel="Running"
                    onChange={(active) => patch({ active })}
                    value={draft.active}
                  />
                </View>
              ) : null}
              <Fact
                label="Sent"
                value={
                  existing.runCount === 0
                    ? "Not yet"
                    : `${existing.runCount} ${existing.runCount === 1 ? "time" : "times"}`
                }
              />
              {existing.lastRunAt ? (
                <Fact label="Last sent" value={dates.dateTime(existing.lastRunAt)} />
              ) : null}
            </Card>
          </View>
        ) : null}

        <Button
          label={isNew && draft.repeat === "NOW" ? "Send now" : "Save"}
          loading={saving}
          onPress={() => void save()}
        />

        {existing ? (
          <View className="flex-row gap-2">
            <Button className="flex-1" label="Send now" onPress={sendNow} variant="outline" />
            <Button className="flex-1" label="Delete" onPress={remove} variant="danger" />
          </View>
        ) : null}
      </View>
    </Screen>
  );
}
