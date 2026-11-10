import { useMemo, useState } from "react";
import { View } from "react-native";

import { AppBar } from "@/components/ui/app-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, SectionHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Chip } from "@/components/ui/layout";
import { ListRow, RowDivider } from "@/components/ui/list-row";
import { Screen } from "@/components/ui/screen";
import { Segmented } from "@/components/ui/segmented";
import { SkeletonRows } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { Toggle } from "@/components/ui/toggle";
import { useDates } from "@/hooks/use-dates";
import { useResource } from "@/hooks/use-resource";
import { readApiError } from "@/lib/api-contract";
import { openConfirm } from "@/lib/confirm";
import {
  listPlatformPushes,
  PUSH_AUDIENCES,
  type PushAudience,
  type PushSchedule,
  sendPlatformPush,
  statusLabel,
  updatePushSchedule,
} from "@/lib/platform-admin-api";
import { toastError, toastSuccess } from "@/lib/toast";

/**
 * Push (web `platform-push-page`): write a notification to every phone of an
 * audience — now, once at a time, or daily / weekly — then the schedules
 * (pause, resume, cancel) and what was sent. Dates and times are Nepal's
 * (UTC+5:45, no daylight saving), as the server reads them.
 */

const AUDIENCE_LABELS: Record<PushAudience, string> = {
  EVERYONE: "Everyone",
  GUARDIANS: "Guardians",
  HOSTEL_STAFF: "Hostel staff",
  RESIDENTS: "Residents",
};
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
type Repeat = "NOW" | "ONCE" | "DAILY" | "WEEKLY";

/** Nepal is a fixed +5:45. `days` ahead, as YYYY-MM-DD, with its weekday. */
function nepalDay(days: number) {
  const at = new Date(Date.now() + (5 * 60 + 45) * 60_000 + days * 86_400_000);
  return { date: at.toISOString().slice(0, 10), weekday: at.getUTCDay() };
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export default function PlatformPushScreen() {
  const dates = useDates();
  const pushes = useResource(listPlatformPushes, { cacheKey: "platform:push" });
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [audience, setAudience] = useState<PushAudience>("EVERYONE");
  const [urgent, setUrgent] = useState(false);
  const [repeat, setRepeat] = useState<Repeat>("NOW");
  const [day, setDay] = useState(0);
  const [time, setTime] = useState("08:00");
  const [weekdays, setWeekdays] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);

  const days = useMemo(() => Array.from({ length: 7 }, (_, index) => ({ index, ...nepalDay(index) })), []);
  const valid =
    title.trim().length >= 2 &&
    body.trim().length >= 2 &&
    (repeat === "NOW" || TIME.test(time)) &&
    (repeat !== "WEEKLY" || weekdays.length > 0);

  function send() {
    const when =
      repeat === "NOW"
        ? "now"
        : repeat === "ONCE"
          ? `on ${days[day]!.date} at ${time}`
          : repeat === "DAILY"
            ? `every day at ${time}`
            : `every ${weekdays.map((d) => WEEKDAYS[d]).join(", ")} at ${time}`;
    openConfirm({
      confirmLabel: repeat === "NOW" ? "Send" : "Schedule",
      message: `"${title.trim()}" goes to ${AUDIENCE_LABELS[audience].toLowerCase()} ${when}.`,
      onConfirm: async () => {
        setBusy(true);
        try {
          await sendPlatformPush({
            audience,
            body: body.trim(),
            date: repeat === "NOW" ? undefined : repeat === "ONCE" ? days[day]!.date : days[0]!.date,
            repeat,
            time: repeat === "NOW" ? undefined : time,
            title: title.trim(),
            urgency: urgent ? "URGENT" : "NORMAL",
            weekdays: repeat === "WEEKLY" ? weekdays : undefined,
          });
          toastSuccess(repeat === "NOW" ? "Sent" : "Scheduled");
          setTitle("");
          setBody("");
          pushes.refresh();
        } catch (error) {
          toastError("Not sent", readApiError(error));
        } finally {
          setBusy(false);
        }
      },
      title: repeat === "NOW" ? "Send this push?" : "Schedule this push?",
    });
  }

  async function act(schedule: PushSchedule, action: "CANCEL" | "PAUSE" | "RESUME") {
    try {
      await updatePushSchedule(schedule.id, action);
      toastSuccess(`${schedule.title} · ${statusLabel(action === "CANCEL" ? "cancelled" : action === "PAUSE" ? "paused" : "resumed")}`);
      pushes.refresh();
    } catch (error) {
      toastError("Not changed", readApiError(error));
    }
  }

  const scheduleRows = [...(pushes.data?.automatic ?? []), ...(pushes.data?.schedules ?? [])];

  return (
    <Screen header={<AppBar showBack title="Push notifications" />} onRefresh={pushes.refresh} refreshing={pushes.refreshing} scroll>
      <View className="gap-5">
        <Card className="gap-4">
          <Input label="Title" maxLength={120} onChangeText={setTitle} placeholder="e.g. App update is out" value={title} />
          <Input label="Message" maxLength={500} multiline onChangeText={setBody} placeholder="What should they read?" value={body} />

          <View className="gap-2">
            <Text className="text-sm font-semibold">Who</Text>
            <View className="flex-row flex-wrap gap-2">
              {PUSH_AUDIENCES.map((key) => (
                <Chip key={key} label={AUDIENCE_LABELS[key]} onPress={() => setAudience(key)} tone={audience === key ? "brand" : "neutral"} />
              ))}
            </View>
          </View>

          <View className="gap-2">
            <Text className="text-sm font-semibold">When</Text>
            <Segmented
              onChange={setRepeat}
              options={[
                { label: "Now", value: "NOW" },
                { label: "Once", value: "ONCE" },
                { label: "Daily", value: "DAILY" },
                { label: "Weekly", value: "WEEKLY" },
              ]}
              value={repeat}
            />
            {repeat === "ONCE" ? (
              <View className="flex-row flex-wrap gap-2">
                {days.map((entry) => (
                  <Chip
                    key={entry.date}
                    label={entry.index === 0 ? "Today" : entry.index === 1 ? "Tomorrow" : WEEKDAYS[entry.weekday]!}
                    onPress={() => setDay(entry.index)}
                    tone={day === entry.index ? "brand" : "neutral"}
                  />
                ))}
              </View>
            ) : null}
            {repeat === "WEEKLY" ? (
              <View className="flex-row flex-wrap gap-2">
                {WEEKDAYS.map((label, index) => (
                  <Chip
                    key={label}
                    label={label}
                    onPress={() => setWeekdays((current) => (current.includes(index) ? current.filter((d) => d !== index) : [...current, index].sort()))}
                    tone={weekdays.includes(index) ? "brand" : "neutral"}
                  />
                ))}
              </View>
            ) : null}
            {repeat !== "NOW" ? (
              <Input
                error={time && !TIME.test(time) ? "24-hour time, like 08:00 or 18:30" : undefined}
                keyboardType="numbers-and-punctuation"
                label="Time (Nepal)"
                maxLength={5}
                onChangeText={setTime}
                placeholder="08:00"
                value={time}
              />
            ) : null}
          </View>

          <View className="flex-row items-center justify-between">
            <View className="flex-1 pr-3">
              <Text className="font-semibold">Urgent</Text>
              <Text className="text-xs" variant="muted">
                Rings even on silent where the phone allows it.
              </Text>
            </View>
            <Toggle accessibilityLabel="Urgent" onChange={setUrgent} value={urgent} />
          </View>

          <Button disabled={!valid || busy} label={repeat === "NOW" ? "Send now" : "Schedule"} loading={busy} onPress={send} />
        </Card>

        {pushes.loading ? (
          <SkeletonRows rows={4} />
        ) : pushes.error || !pushes.data ? (
          <ErrorState message={pushes.error ?? "Pushes could not be loaded."} onRetry={pushes.reload} />
        ) : (
          <>
            {scheduleRows.length ? (
              <View>
                <SectionHeader title="Scheduled" />
                <Card padding="px-4 py-1">
                  {scheduleRows.map((schedule, index) => (
                    <View key={schedule.id}>
                      {index > 0 ? <RowDivider /> : null}
                      <View className="gap-2 py-3">
                      <View className="flex-row items-center gap-2">
                        <Text className="flex-1 font-semibold" numberOfLines={1}>
                          {schedule.title}
                        </Text>
                        {schedule.automatic ? <Badge label="Automatic" tone="info" /> : null}
                        <Badge label={statusLabel(schedule.status)} tone={schedule.status === "ACTIVE" ? "success" : "neutral"} />
                      </View>
                      <Text className="text-xs" variant="muted">
                        {[
                          `${statusLabel(schedule.repeat)} ${schedule.time}`,
                          AUDIENCE_LABELS[schedule.audience as PushAudience] ?? schedule.audience,
                          schedule.nextRunAt ? `next ${dates.dateTime(schedule.nextRunAt)}` : null,
                          `${schedule.runCount} sent`,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </Text>
                      {schedule.status !== "CANCELLED" && schedule.status !== "COMPLETED" ? (
                        <View className="flex-row gap-2">
                          <Chip
                            label={schedule.status === "PAUSED" ? "Resume" : "Pause"}
                            onPress={() => void act(schedule, schedule.status === "PAUSED" ? "RESUME" : "PAUSE")}
                          />
                          {!schedule.automatic ? <Chip label="Cancel" onPress={() => void act(schedule, "CANCEL")} /> : null}
                        </View>
                      ) : null}
                      </View>
                    </View>
                  ))}
                </Card>
              </View>
            ) : null}

            <View>
              <SectionHeader title="Sent" />
              {pushes.data.pushes.length === 0 ? (
                <Card>
                  <Text variant="muted">Nothing sent yet.</Text>
                </Card>
              ) : (
                <Card padding="px-4 py-1">
                  {pushes.data.pushes.slice(0, 30).map((push, index) => (
                    <View key={push.id}>
                      {index > 0 ? <RowDivider /> : null}
                      <ListRow
                        icon={push.urgency === "URGENT" ? "siren" : "notifications"}
                        subtitle={`${AUDIENCE_LABELS[push.audience as PushAudience] ?? push.audience} · ${push.recipients} people · ${dates.ago(push.sentAt)}`}
                        title={push.title}
                      />
                    </View>
                  ))}
                </Card>
              )}
            </View>
          </>
        )}
      </View>
    </Screen>
  );
}
