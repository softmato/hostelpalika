"use client";

import { Bell, CalendarClock, Pause, Play, Repeat as Repeat2, Send, Siren, Smartphone, X } from "@/components/icons";
import { memo, useCallback, useState, type FormEvent } from "react";

import { useConfirm } from "@/app/_components/confirm-dialog";
import { Message } from "@/app/_components/core-portal-shared";
import { FactChip } from "@/app/_components/platform-page-ui";
import {
  MetricCard,
  PortalPageHeader,
  RoleButton,
} from "@/app/_components/portal-dashboard-ui";
import { EmptyState, Input, LoadingRows, Panel, Select, TextArea } from "@/app/_components/shared-ui";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { browserApi } from "@/lib/browser-api";
import { usePortalResource } from "@/lib/portal-query";
import { cn } from "@/lib/utils";

type Urgency = "NORMAL" | "URGENT";
type Repeat = "NOW" | "ONCE" | "DAILY" | "WEEKLY";

type PushRecord = {
  audience: string;
  body: string;
  devices: number;
  id: string;
  recipients: number;
  scheduled: boolean;
  sentAt: string;
  title: string;
  urgency: Urgency;
};

type ScheduleRecord = {
  audience: string;
  /** Set on the platform's own reminders, which can be paused but not cancelled. */
  automatic: string | null;
  body: string;
  endsOn: string | null;
  id: string;
  lastDevices: number;
  lastRecipients: number;
  lastRunAt: string | null;
  nextRunAt: string | null;
  repeat: Exclude<Repeat, "NOW">;
  runCount: number;
  startsOn: string;
  status: "ACTIVE" | "PAUSED";
  time: string;
  title: string;
  urgency: Urgency;
  weekdays: number[];
};

const ENDPOINT = "/api/v1/platform/push";

const AUDIENCE_LABEL: Record<string, string> = {
  EVERYONE: "Everyone",
  GUARDIANS: "Guardians",
  HOSTEL_STAFF: "Hostel owners & staff",
  RESIDENTS: "Residents",
};

const REPEAT_LABEL: Record<Repeat, string> = {
  DAILY: "Daily",
  NOW: "Now",
  ONCE: "Once",
  WEEKLY: "Weekly",
};

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Nepal is a fixed +5:45 with no daylight saving. */
function nepalNow() {
  const local = new Date(Date.now() + (5 * 60 + 45) * 60_000).toISOString();

  return { date: local.slice(0, 10), time: local.slice(11, 16) };
}

function nepalDateTime(value: string) {
  return new Date(value).toLocaleString("en", {
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
    timeZone: "Asia/Kathmandu",
  });
}

function describeSchedule(schedule: ScheduleRecord) {
  const until = schedule.endsOn ? ` until ${schedule.endsOn}` : "";

  if (schedule.repeat === "ONCE") {
    return `Once on ${schedule.startsOn} at ${schedule.time}`;
  }

  if (schedule.repeat === "DAILY") {
    return `Daily at ${schedule.time}${until}`;
  }

  return `${schedule.weekdays.map((day) => WEEKDAYS[day]).join(", ")} at ${schedule.time}${until}`;
}

function Segmented<T extends string>({
  onChange,
  options,
  value,
}: {
  onChange: (value: T) => void;
  options: Array<{ icon?: React.ReactNode; label: string; tone?: "destructive"; value: T }>;
  value: T;
}) {
  return (
    <div
      className="grid gap-1 rounded-lg border border-border bg-muted p-1"
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
    >
      {options.map((option) => (
        <button
          aria-pressed={value === option.value}
          className={cn(
            "inline-flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-[13px] font-semibold transition-colors",
            value === option.value
              ? option.tone === "destructive"
                ? "bg-destructive text-white shadow-sm"
                : "bg-card text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
          key={option.value}
          onClick={() => onChange(option.value)}
          type="button"
        >
          {option.icon}
          {option.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Superadmin push: a heading, a message and an urgency, to every phone and
 * browser of the chosen audience — now, once later, or on a daily or weekly
 * repeat. Times are Nepal time; the `platform-push` cron sends them.
 */
export const PlatformPushPageContent = memo(function PlatformPushPageContent() {
  const { confirm, confirmDialog } = useConfirm();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [urgency, setUrgency] = useState<Urgency>("NORMAL");
  const [audience, setAudience] = useState("EVERYONE");
  const [repeat, setRepeat] = useState<Repeat>("NOW");
  const [date, setDate] = useState(() => nepalNow().date);
  const [time, setTime] = useState(() => nepalNow().time);
  const [weekdays, setWeekdays] = useState<number[]>([]);
  const [endsOn, setEndsOn] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [composing, setComposing] = useState(false);

  const resource = usePortalResource<{
    automatic: ScheduleRecord[];
    pushes: PushRecord[];
    schedules: ScheduleRecord[];
  }>(ENDPOINT, { errorMessage: "Could not load push notifications." });
  const automatic = resource.data?.automatic ?? [];
  const pushes = resource.data?.pushes ?? [];
  const schedules = resource.data?.schedules ?? [];

  const scheduling = repeat !== "NOW";

  // Opening the schedule picker starts from this moment in Nepal, not from
  // whenever the page happened to load.
  const pickRepeat = useCallback((next: Repeat) => {
    if (next !== "NOW") {
      const now = nepalNow();

      setDate(now.date);
      setTime(now.time);
    }

    setRepeat(next);
  }, []);
  const incomplete =
    title.trim().length < 2 ||
    body.trim().length < 2 ||
    (scheduling && !time) ||
    (repeat === "WEEKLY" && weekdays.length === 0);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setBusy(true);
      setMessage("");

      try {
        const result = await browserApi<{ push?: PushRecord; schedule?: ScheduleRecord }>(
          ENDPOINT,
          {
            body: JSON.stringify({
              audience,
              body,
              title,
              urgency,
              ...(scheduling
                ? {
                    date,
                    endsOn: repeat !== "ONCE" && endsOn ? endsOn : undefined,
                    repeat,
                    time,
                    weekdays: repeat === "WEEKLY" ? weekdays : [],
                  }
                : { repeat: "NOW" }),
            }),
            method: "POST",
          },
        );

        setMessage(
          result.push
            ? `Sent to ${result.push.recipients} account(s) · ${result.push.devices} device(s) took it.`
            : result.schedule?.nextRunAt
              ? `Scheduled · first send ${nepalDateTime(result.schedule.nextRunAt)}.`
              : "Scheduled.",
        );
        setTitle("");
        setBody("");
        setUrgency("NORMAL");
        setComposing(false);
        await resource.refreshAsync();
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Could not send the push.");
      } finally {
        setBusy(false);
      }
    },
    [audience, body, date, endsOn, repeat, resource, scheduling, time, title, urgency, weekdays],
  );

  const changeSchedule = useCallback(
    async (schedule: ScheduleRecord, action: "PAUSE" | "RESUME" | "CANCEL") => {
      if (
        action === "CANCEL" &&
        !(await confirm({
          actionLabel: "Cancel schedule",
          description: `"${schedule.title}" will not be sent again.`,
          title: "Cancel this scheduled push?",
          tone: "destructive",
        }))
      ) {
        return;
      }

      try {
        await browserApi(`${ENDPOINT}/schedules/${schedule.id}`, {
          body: JSON.stringify({ action }),
          method: "PATCH",
        });
        await resource.refreshAsync();
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Could not update the schedule.");
      }
    },
    [confirm, resource],
  );

  const reached = pushes.reduce((sum, push) => sum + push.devices, 0);
  const pausedAutomatic = automatic.filter((schedule) => schedule.status === "PAUSED").length;

  return (
    <div className="mx-auto max-w-[1448px] space-y-5">
      {confirmDialog}
      <PortalPageHeader
        actions={
          <RoleButton
            onClick={() => {
              setMessage("");
              setComposing(true);
            }}
            type="button"
          >
            <Send className="size-3.5" />
            New push
          </RoleButton>
        }
        description="To phones with the app and browsers with notifications on, in Nepal time."
        title="Push Notification"
      />
      <Message value={composing ? "" : message} />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          icon={Repeat2}
          label="Automatic"
          note={pausedAutomatic > 0 ? `${pausedAutomatic} paused` : undefined}
          noteTone="amber"
          value={automatic.length}
        />
        <MetricCard icon={CalendarClock} label="Scheduled" value={schedules.length} />
        <MetricCard icon={Send} label="Sent" value={pushes.length} />
        <MetricCard icon={Smartphone} label="Devices reached" value={reached.toLocaleString()} />
      </div>

      <Dialog onOpenChange={setComposing} open={composing}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>New push</DialogTitle>
            <DialogDescription>Times are Nepal time.</DialogDescription>
          </DialogHeader>
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_280px]">
        <div>
          <form className="grid gap-4" onSubmit={handleSubmit}>
            <Input
              label="Heading"
              name="title"
              onChange={(event) => setTitle(event.target.value)}
              required
              value={title}
            />
            <TextArea
              label="Content"
              name="body"
              onChange={(event) => setBody(event.target.value)}
              value={body}
            />

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-2 text-sm font-semibold text-foreground">
                Urgency
                <Segmented
                  onChange={setUrgency}
                  options={[
                    { icon: <Bell aria-hidden="true" className="size-3.5" />, label: "Normal", value: "NORMAL" },
                    {
                      icon: <Siren aria-hidden="true" className="size-3.5" />,
                      label: "Urgent",
                      tone: "destructive",
                      value: "URGENT",
                    },
                  ]}
                  value={urgency}
                />
              </div>

              <Select
                label="Send to"
                name="audience"
                onChange={(event) => setAudience(event.target.value)}
                value={audience}
              >
                {Object.entries(AUDIENCE_LABEL).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </Select>
            </div>

            <div className="grid gap-3 rounded-xl border border-border p-3">
              <div className="grid gap-2 text-sm font-semibold text-foreground">
                When
                <Segmented
                  onChange={pickRepeat}
                  options={(["NOW", "ONCE", "DAILY", "WEEKLY"] as const).map((value) => ({
                    label: REPEAT_LABEL[value],
                    value,
                  }))}
                  value={repeat}
                />
              </div>

              {scheduling ? (
                <div className="grid items-start gap-3 sm:grid-cols-3">
                  <Input
                    label={repeat === "ONCE" ? "Date" : "Starts on"}
                    min={nepalNow().date}
                    name="date"
                    onChange={(event) => setDate(event.target.value)}
                    type="date"
                    value={date}
                  />
                  <Input
                    label="Time (Nepal)"
                    name="time"
                    onChange={(event) => setTime(event.target.value)}
                    type="time"
                    value={time}
                  />
                  {repeat === "ONCE" ? null : (
                    <Input
                      hint="Leave empty to keep repeating."
                      label="Ends on"
                      min={date}
                      name="endsOn"
                      onChange={(event) => setEndsOn(event.target.value)}
                      type="date"
                      value={endsOn}
                    />
                  )}
                </div>
              ) : null}

              {repeat === "WEEKLY" ? (
                <div className="flex flex-wrap gap-1.5">
                  {WEEKDAYS.map((label, day) => {
                    const on = weekdays.includes(day);

                    return (
                      <button
                        aria-pressed={on}
                        className={cn(
                          "rounded-full border px-3 py-1 text-[12.5px] font-semibold transition-colors",
                          on
                            ? "border-foreground bg-foreground text-background"
                            : "border-border text-muted-foreground hover:text-foreground",
                        )}
                        key={label}
                        onClick={() =>
                          setWeekdays((current) =>
                            on ? current.filter((value) => value !== day) : [...current, day],
                          )
                        }
                        type="button"
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3">
              <p aria-live="polite" className="text-sm text-muted-foreground">
                {message}
              </p>
              <RoleButton className="h-9 px-4" disabled={busy || incomplete} type="submit">
                {scheduling ? (
                  <CalendarClock aria-hidden="true" className="size-4" />
                ) : (
                  <Send aria-hidden="true" className="size-4" />
                )}
                {busy ? "Saving…" : scheduling ? "Schedule push" : "Send push"}
              </RoleButton>
            </div>
          </form>
        </div>

        <div className="space-y-2">
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Preview</p>
          <div className="rounded-2xl border border-border bg-card p-3 shadow-sm">
            <div className="flex items-start gap-3">
              <span
                className={cn(
                  "grid size-9 shrink-0 place-items-center rounded-xl text-white",
                  urgency === "URGENT" ? "bg-destructive" : "bg-brand-teal",
                )}
              >
                {urgency === "URGENT" ? (
                  <Siren aria-hidden="true" className="size-4" />
                ) : (
                  <Bell aria-hidden="true" className="size-4" />
                )}
              </span>
              <div className="min-w-0">
                <p className="truncate text-[13px] font-semibold text-foreground">
                  {title || "Heading"}
                </p>
                <p className="mt-0.5 line-clamp-3 text-[12.5px] text-muted-foreground">
                  {body || "Content"}
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
        </DialogContent>
      </Dialog>

      <Panel title="Automatic">
        {resource.state === "loading" ? <LoadingRows /> : null}
        <div className="divide-y divide-border">
          {automatic.map((schedule) => (
            <div
              className="flex flex-wrap items-start justify-between gap-3 py-3"
              key={schedule.id}
            >
              <div className="min-w-0 max-w-3xl space-y-1.5">
                <p className="text-[13.5px] font-semibold text-foreground">{schedule.title}</p>
                <p className="line-clamp-1 text-[13px] text-muted-foreground">{schedule.body}</p>
                <div className="flex flex-wrap gap-1.5">
                  <FactChip glyph="repeat">{describeSchedule(schedule)}</FactChip>
                  {schedule.status === "PAUSED" ? (
                    <FactChip glyph="pause" tone="amber">Paused</FactChip>
                  ) : schedule.nextRunAt ? (
                    <FactChip glyph="time" tone="brand">{`Next ${nepalDateTime(schedule.nextRunAt)}`}</FactChip>
                  ) : null}
                  {schedule.lastRunAt ? (
                    <FactChip glyph="phone-portrait">
                      {`Last ${nepalDateTime(schedule.lastRunAt)} · ${schedule.lastRecipients} accounts · ${schedule.lastDevices} devices`}
                    </FactChip>
                  ) : null}
                </div>
              </div>
              <RoleButton
                onClick={() =>
                  changeSchedule(schedule, schedule.status === "PAUSED" ? "RESUME" : "PAUSE")
                }
                type="button"
                variant="outline"
              >
                {schedule.status === "PAUSED" ? (
                  <Play aria-hidden="true" className="size-3.5" />
                ) : (
                  <Pause aria-hidden="true" className="size-3.5" />
                )}
                {schedule.status === "PAUSED" ? "Resume" : "Pause"}
              </RoleButton>
            </div>
          ))}
        </div>
      </Panel>

      <Panel title="Scheduled">
        {resource.state === "loading" ? <LoadingRows /> : null}
        {resource.state !== "loading" && schedules.length === 0 ? (
          <EmptyState label="Nothing scheduled." />
        ) : null}
        <div className="divide-y divide-border">
          {schedules.map((schedule) => (
            <div
              className="flex flex-wrap items-start justify-between gap-3 py-3"
              key={schedule.id}
            >
              <div className="min-w-0 space-y-1.5">
                <p className="text-[13.5px] font-semibold text-foreground">
                  {schedule.title}
                  {schedule.urgency === "URGENT" ? (
                    <span className="ml-2 rounded-full bg-destructive/10 px-2 py-0.5 text-[11px] font-semibold text-destructive">
                      Urgent
                    </span>
                  ) : null}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  <FactChip glyph="repeat">{describeSchedule(schedule)}</FactChip>
                  <FactChip glyph="people">{AUDIENCE_LABEL[schedule.audience] ?? schedule.audience}</FactChip>
                  {schedule.status === "PAUSED" ? (
                    <FactChip glyph="pause" tone="amber">Paused</FactChip>
                  ) : schedule.nextRunAt ? (
                    <FactChip glyph="time" tone="brand">{`Next ${nepalDateTime(schedule.nextRunAt)}`}</FactChip>
                  ) : null}
                  {schedule.runCount > 0 ? <FactChip glyph="send">{`Sent ${schedule.runCount}×`}</FactChip> : null}
                </div>
              </div>
              <div className="flex gap-1.5">
                {schedule.repeat === "ONCE" ? null : (
                  <RoleButton
                    onClick={() =>
                      changeSchedule(schedule, schedule.status === "PAUSED" ? "RESUME" : "PAUSE")
                    }
                    type="button"
                    variant="outline"
                  >
                    {schedule.status === "PAUSED" ? (
                      <Play aria-hidden="true" className="size-3.5" />
                    ) : (
                      <Pause aria-hidden="true" className="size-3.5" />
                    )}
                    {schedule.status === "PAUSED" ? "Resume" : "Pause"}
                  </RoleButton>
                )}
                <RoleButton
                  onClick={() => changeSchedule(schedule, "CANCEL")}
                  type="button"
                  variant="outline"
                >
                  <X aria-hidden="true" className="size-3.5" />
                  Cancel
                </RoleButton>
              </div>
            </div>
          ))}
        </div>
      </Panel>

      <Panel title="Sent">
        {resource.state !== "loading" && pushes.length === 0 ? (
          <EmptyState label="No push notifications sent yet." />
        ) : null}
        <div className="divide-y divide-border">
          {pushes.map((push) => (
            <div className="flex flex-wrap items-start justify-between gap-3 py-3" key={push.id}>
              <div className="min-w-0 space-y-1.5">
                <p className="text-[13.5px] font-semibold text-foreground">{push.title}</p>
                <p className="line-clamp-1 text-[13px] text-muted-foreground">{push.body}</p>
                <div className="flex flex-wrap gap-1.5">
                  <FactChip glyph="time">{nepalDateTime(push.sentAt)}</FactChip>
                  <FactChip glyph="people">{AUDIENCE_LABEL[push.audience] ?? push.audience}</FactChip>
                  <FactChip glyph="phone-portrait">{`${push.recipients} accounts · ${push.devices} devices`}</FactChip>
                  {push.scheduled ? <FactChip glyph="calendar-clock">Scheduled</FactChip> : null}
                </div>
              </div>
              {push.urgency === "URGENT" ? (
                <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-[11px] font-semibold text-destructive">
                  Urgent
                </span>
              ) : null}
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
});
