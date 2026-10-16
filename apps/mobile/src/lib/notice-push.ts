import type { GlyphName } from "@hostel/constants/glyphs";

import type { NoticePush, NoticePushRepeat } from "@/lib/admin-manage-api";

export const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export const WEEKDAY_OPTIONS = WEEKDAY_SHORT.map((label, day) => ({ label, value: String(day) }));

export const PUSH_MODES: {
  icon: GlyphName;
  label: string;
  value: NoticePushRepeat;
}[] = [
  { icon: "flash", label: "Now", value: "NOW" },
  { icon: "hourglass", label: "Later", value: "LATER" },
  { icon: "repeat", label: "Daily", value: "DAILY" },
  { icon: "calendar", label: "Weekly", value: "WEEKLY" },
];

export const DELAY_OPTIONS = [
  { label: "In 15 min", value: "15" },
  { label: "In 30 min", value: "30" },
  { label: "In 1 hour", value: "60" },
  { label: "In 3 hours", value: "180" },
  { label: "Pick date", value: "custom" },
];

/** `18:00` → `6:00 PM`. */
export function clockLabel(time: string | null | undefined) {
  if (!time || !/^\d{2}:\d{2}$/.test(time)) {
    return "";
  }

  const [hour, minute] = time.split(":").map(Number);

  return `${hour % 12 || 12}:${String(minute).padStart(2, "0")} ${hour >= 12 ? "PM" : "AM"}`;
}

export const TIME_PRESETS = ["07:00", "09:00", "12:00", "18:00", "20:00"].map((value) => ({
  label: clockLabel(value),
  value,
}));

/** One line: when it goes out. */
export function pushSchedule(push: Pick<NoticePush, "repeat" | "startsOn" | "time" | "weekdays">) {
  switch (push.repeat) {
    case "NOW":
      return "Sent once";
    case "LATER":
      return `Once · ${push.startsOn ?? ""} ${clockLabel(push.time)}`;
    case "DAILY":
      return `Every day · ${clockLabel(push.time)}`;
    default:
      return `${
        push.weekdays.length === 7
          ? "Every day"
          : push.weekdays.map((day) => WEEKDAY_SHORT[day]).join(", ")
      } · ${clockLabel(push.time)}`;
  }
}

const ORDER = { ACTIVE: 0, DONE: 2, PAUSED: 1 } as const;

/** Running first by next send, then paused, then finished, latest first. */
export function sortPushes(pushes: NoticePush[]) {
  return [...pushes].sort(
    (a, b) =>
      ORDER[a.status] - ORDER[b.status] ||
      (a.status === "ACTIVE"
        ? (a.nextRunAt ?? "").localeCompare(b.nextRunAt ?? "")
        : (b.lastRunAt ?? "").localeCompare(a.lastRunAt ?? "")),
  );
}
