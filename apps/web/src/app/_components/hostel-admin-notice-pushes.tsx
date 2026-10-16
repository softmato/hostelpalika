"use client";

import { BellRing, CalendarDays, Clock3, Repeat, Send, Trash2, Zap } from "@/components/icons";
import { memo, useCallback, useMemo, useState } from "react";

import { useConfirm } from "@/app/_components/confirm-dialog";
import {
  EmptyInline,
  RoleButton,
  SectionCard,
  ToggleSwitch,
} from "@/app/_components/portal-dashboard-ui";
import { Input } from "@/app/_components/shared-ui";
import { browserApi } from "@/lib/browser-api";
import { hostelAdminEndpoints } from "@/lib/hostel-admin-endpoints";
import { useInvalidateResources, usePortalResource } from "@/lib/portal-query";

type PushRepeat = "NOW" | "LATER" | "DAILY" | "WEEKLY";

type NoticePush = {
  body: string;
  id: string;
  isUrgent: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  repeat: PushRepeat;
  runCount: number;
  startsOn: string | null;
  status: "ACTIVE" | "PAUSED" | "DONE";
  time: string | null;
  title: string;
  weekdays: number[];
};

type Draft = {
  active: boolean;
  body: string;
  date: string;
  delay: string;
  isUrgent: boolean;
  repeat: PushRepeat;
  time: string;
  title: string;
  weekdays: number[];
};

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const MODES = [
  { icon: Zap, label: "Now", value: "NOW" },
  { icon: Clock3, label: "Later", value: "LATER" },
  { icon: Repeat, label: "Daily", value: "DAILY" },
  { icon: CalendarDays, label: "Weekly", value: "WEEKLY" },
] as const;

const DELAYS = [
  { label: "In 15 min", value: "15" },
  { label: "In 30 min", value: "30" },
  { label: "In 1 hour", value: "60" },
  { label: "In 3 hours", value: "180" },
  { label: "Pick date", value: "custom" },
];

const ORDER = { ACTIVE: 0, DONE: 2, PAUSED: 1 } as const;

const pill = (on: boolean) =>
  `rounded-full border px-3 py-1 text-[12.5px] font-semibold transition-colors ${
    on
      ? "border-foreground bg-foreground text-background"
      : "border-border text-muted-foreground hover:text-foreground"
  }`;

function clock(time: string | null) {
  if (!time) {
    return "";
  }

  const [hour, minute] = time.split(":").map(Number);

  return `${hour % 12 || 12}:${String(minute).padStart(2, "0")} ${hour >= 12 ? "PM" : "AM"}`;
}

function nepalToday() {
  return new Date(Date.now() + (5 * 60 + 45) * 60_000).toISOString().slice(0, 10);
}

function when(iso: string) {
  return new Date(iso).toLocaleString("en-GB", {
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    month: "short",
    timeZone: "Asia/Kathmandu",
    weekday: "short",
  });
}

function schedule(push: NoticePush) {
  switch (push.repeat) {
    case "NOW":
      return "Sent once";
    case "LATER":
      return `Once · ${push.startsOn ?? ""} ${clock(push.time)}`;
    case "DAILY":
      return `Every day · ${clock(push.time)}`;
    default:
      return `${push.weekdays.map((day) => WEEKDAYS[day]).join(", ")} · ${clock(push.time)}`;
  }
}

function blankDraft(): Draft {
  return {
    active: true,
    body: "",
    date: nepalToday(),
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
    date: push.startsOn ?? nepalToday(),
    delay: push.repeat === "LATER" ? "custom" : "60",
    isUrgent: push.isUrgent,
    repeat: push.repeat,
    time: push.time ?? "18:00",
    title: push.title,
    weekdays: push.weekdays,
  };
}

function timingKey(draft: Draft) {
  return JSON.stringify([draft.repeat, draft.delay, draft.date, draft.time, [...draft.weekdays].sort()]);
}

/** Timing goes only when it changed, so rewording a finished push is not a reschedule. */
function payloadOf(draft: Draft, existing: NoticePush | null) {
  const input: Record<string, unknown> = {
    body: draft.body.trim(),
    isUrgent: draft.isUrgent,
    title: draft.title.trim(),
  };

  if (!existing || timingKey(draft) !== timingKey(draftFrom(existing))) {
    input.repeat = draft.repeat;

    if (draft.repeat === "LATER") {
      Object.assign(
        input,
        draft.delay === "custom"
          ? { date: draft.date, time: draft.time }
          : { delayMinutes: Number(draft.delay) },
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

  return input;
}

const STATUS_LABEL = { ACTIVE: "Running", DONE: "Finished", PAUSED: "Paused" } as const;

export const HostelAdminNoticePushes = memo(function HostelAdminNoticePushes() {
  const invalidate = useInvalidateResources();
  const { confirm, confirmDialog } = useConfirm();
  const resource = usePortalResource<{ pushes: NoticePush[] }>(hostelAdminEndpoints.noticePushes, {
    errorMessage: "Could not load push notices.",
  });
  const pushes = useMemo(
    () =>
      [...(resource.data?.pushes ?? [])].sort(
        (a, b) =>
          ORDER[a.status] - ORDER[b.status] ||
          (a.nextRunAt ?? "").localeCompare(b.nextRunAt ?? ""),
      ),
    [resource.data],
  );
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(blankDraft);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const existing = pushes.find((push) => push.id === selected) ?? null;

  const open = (push: NoticePush | null) => {
    setSelected(push ? push.id : "new");
    setDraft(push ? draftFrom(push) : blankDraft());
    setMessage("");
  };

  const patch = (next: Partial<Draft>) => setDraft((prev) => ({ ...prev, ...next }));

  const run = useCallback(
    async (work: () => Promise<unknown>, done: string, close: boolean) => {
      setBusy(true);

      try {
        await work();
        setMessage(done);
        invalidate(hostelAdminEndpoints.noticePushes);
        invalidate(hostelAdminEndpoints.notices);

        if (close) {
          setSelected(null);
        }
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Something went wrong.");
      } finally {
        setBusy(false);
      }
    },
    [invalidate],
  );

  const save = () => {
    const body = JSON.stringify(payloadOf(draft, existing));

    if (existing) {
      void run(
        () => browserApi(hostelAdminEndpoints.noticePush(existing.id), { body, method: "PATCH" }),
        "Push notice saved.",
        true,
      );
    } else {
      void run(
        () => browserApi(hostelAdminEndpoints.noticePushes, { body, method: "POST" }),
        draft.repeat === "NOW" ? "Sent — residents notified." : "Push notice scheduled.",
        true,
      );
    }
  };

  const sendNow = async () => {
    if (
      existing &&
      (await confirm({
        actionLabel: "Send now",
        description: "Residents get it on their phones and the notice board.",
        title: "Send it now?",
      }))
    ) {
      void run(
        () => browserApi(`${hostelAdminEndpoints.noticePush(existing.id)}/send`, { method: "POST" }),
        "Sent — residents notified.",
        false,
      );
    }
  };

  const remove = async () => {
    if (
      existing &&
      (await confirm({
        actionLabel: "Delete push notice",
        description: "It stops going out. Notices it already sent stay on the board.",
        title: "Delete this push notice?",
        tone: "destructive",
      }))
    ) {
      void run(
        () => browserApi(hostelAdminEndpoints.noticePush(existing.id), { method: "DELETE" }),
        "Push notice deleted.",
        true,
      );
    }
  };

  const needsTime =
    draft.repeat === "DAILY" ||
    draft.repeat === "WEEKLY" ||
    (draft.repeat === "LATER" && draft.delay === "custom");

  return (
    <SectionCard
      actions={
        <RoleButton onClick={() => open(null)} size="sm" tone="admin" type="button">
          <BellRing className="size-3.5" />
          New push notice
        </RoleButton>
      }
      title="Push notices"
    >
      {confirmDialog}
      {message ? (
        <div className="mb-3 rounded-lg border border-border bg-muted/40 px-3 py-2 text-[12.5px] text-foreground">
          {message}
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-2">
          {resource.state === "loading" ? (
            Array.from({ length: 2 }).map((_, index) => (
              <div
                className="h-14 animate-pulse rounded-xl border border-border/60 bg-muted/30"
                key={index}
              />
            ))
          ) : pushes.length === 0 ? (
            <EmptyInline label="No push notices yet." />
          ) : (
            pushes.map((push) => {
              const Icon = MODES.find((mode) => mode.value === push.repeat)?.icon ?? Zap;

              return (
                <button
                  className={`flex w-full items-center gap-3 rounded-xl border p-3 text-left transition-colors ${
                    selected === push.id
                      ? "border-role-admin bg-role-admin-soft/50"
                      : "border-border/70 hover:bg-muted/30"
                  }`}
                  key={push.id}
                  onClick={() => open(push)}
                  type="button"
                >
                  <span
                    className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${
                      push.status === "ACTIVE"
                        ? "bg-role-admin-soft text-role-admin"
                        : "bg-muted text-muted-foreground"
                    }`}
                  >
                    <Icon className="size-[17px]" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-bold text-foreground">
                      {push.title}
                    </span>
                    <span className="block truncate text-[12px] text-muted-foreground">
                      {schedule(push)}
                    </span>
                  </span>
                  <span className="shrink-0 text-right text-[11.5px] text-muted-foreground">
                    <span className="block font-semibold text-foreground">
                      {STATUS_LABEL[push.status]}
                    </span>
                    {push.status === "ACTIVE" && push.nextRunAt ? when(push.nextRunAt) : null}
                  </span>
                </button>
              );
            })
          )}
        </div>

        {selected ? (
          <div className="space-y-3 rounded-xl border border-border/70 p-4">
            <Input
              label="Title"
              name="push-title"
              onChange={(event) => patch({ title: event.target.value })}
              value={draft.title}
            />
            <label className="grid gap-1.5 text-[12.5px] font-medium text-foreground">
              Message
              <textarea
                className="min-h-24 rounded-lg border border-border bg-background px-3 py-2 text-[13px] font-normal outline-none focus:border-role-admin"
                maxLength={500}
                onChange={(event) => patch({ body: event.target.value })}
                value={draft.body}
              />
            </label>

            <div className="grid grid-cols-4 gap-2">
              {MODES.map((mode) => {
                const on = draft.repeat === mode.value;

                return (
                  <button
                    aria-pressed={on}
                    className={`flex flex-col items-center gap-1 rounded-xl border py-2.5 text-[12px] font-semibold transition-colors ${
                      on
                        ? "border-role-admin bg-role-admin-soft text-role-admin"
                        : "border-border text-muted-foreground hover:text-foreground"
                    }`}
                    key={mode.value}
                    onClick={() => patch({ repeat: mode.value })}
                    type="button"
                  >
                    <mode.icon className="size-4" />
                    {mode.label}
                  </button>
                );
              })}
            </div>

            {draft.repeat === "LATER" ? (
              <div className="flex flex-wrap gap-1.5">
                {DELAYS.map((option) => (
                  <button
                    aria-pressed={draft.delay === option.value}
                    className={pill(draft.delay === option.value)}
                    key={option.value}
                    onClick={() => patch({ delay: option.value })}
                    type="button"
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            ) : null}

            {draft.repeat === "WEEKLY" ? (
              <div className="flex flex-wrap gap-1.5">
                {WEEKDAYS.map((label, day) => {
                  const on = draft.weekdays.includes(day);

                  return (
                    <button
                      aria-pressed={on}
                      className={pill(on)}
                      key={label}
                      onClick={() =>
                        patch({
                          weekdays: on
                            ? draft.weekdays.filter((value) => value !== day)
                            : [...draft.weekdays, day],
                        })
                      }
                      type="button"
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            ) : null}

            {needsTime ? (
              <div className="grid gap-3 sm:grid-cols-2">
                {draft.repeat === "LATER" ? (
                  <Input
                    label="Date"
                    name="push-date"
                    onChange={(event) => patch({ date: event.target.value })}
                    type="date"
                    value={draft.date}
                  />
                ) : null}
                <Input
                  label="Time (Nepal)"
                  name="push-time"
                  onChange={(event) => patch({ time: event.target.value })}
                  type="time"
                  value={draft.time}
                />
              </div>
            ) : null}

            <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">
              <input
                checked={draft.isUrgent}
                className="accent-role-admin"
                onChange={(event) => patch({ isUrgent: event.target.checked })}
                type="checkbox"
              />
              Mark as urgent
            </label>

            {existing && draft.repeat !== "NOW" ? (
              <ToggleSwitch
                checked={draft.active}
                description={
                  existing.nextRunAt ? `Next: ${when(existing.nextRunAt)}` : undefined
                }
                label="Running"
                onChange={(active) => patch({ active })}
                tone="admin"
              />
            ) : null}

            {existing ? (
              <p className="text-[12px] text-muted-foreground">
                Sent {existing.runCount} {existing.runCount === 1 ? "time" : "times"}
                {existing.lastRunAt ? ` · last ${when(existing.lastRunAt)}` : ""}
              </p>
            ) : null}

            <div className="flex flex-wrap gap-2">
              <RoleButton disabled={busy} onClick={save} tone="admin" type="button">
                <Send className="size-3.5" />
                {!existing && draft.repeat === "NOW" ? "Send now" : "Save"}
              </RoleButton>
              {existing ? (
                <>
                  <RoleButton
                    disabled={busy}
                    onClick={() => void sendNow()}
                    tone="admin"
                    type="button"
                    variant="outline"
                  >
                    Send now
                  </RoleButton>
                  <RoleButton
                    disabled={busy}
                    onClick={() => void remove()}
                    tone="admin"
                    type="button"
                    variant="soft"
                  >
                    <Trash2 className="size-3.5" />
                    Delete
                  </RoleButton>
                </>
              ) : null}
              <RoleButton
                onClick={() => setSelected(null)}
                tone="admin"
                type="button"
                variant="outline"
              >
                Cancel
              </RoleButton>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-center rounded-xl border border-dashed border-border/70 p-6 text-[12.5px] text-muted-foreground">
            Pick a push notice to change its day and time.
          </div>
        )}
      </div>
    </SectionCard>
  );
});
