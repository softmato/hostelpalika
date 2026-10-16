/**
 * Ordering and labelling a provider's job list.
 *
 * Pure, and separate from `lib/provider-api.ts` because that file imports the
 * axios client and therefore React Native — which Vitest here cannot load.
 *
 * ## Open work first, then the schedule, then urgency
 *
 * The server returns newest-created first, which is the wrong order for
 * somebody standing outside a building deciding what to do next. A closed job
 * is not work; a job scheduled for today outranks one scheduled for Friday
 * however urgent Friday's is, because urgency within a day is a tiebreak and a
 * date is a commitment.
 */

import type { ProviderJob } from "@/lib/provider-api";

export const OPEN_JOB_STATUSES = ["PENDING", "CONTACTED", "SCHEDULED"] as const;

export function isOpenJob(job: ProviderJob): boolean {
  return (OPEN_JOB_STATUSES as readonly string[]).includes(job.status);
}

/** Lower sorts first. */
const PRIORITY_RANK: Record<string, number> = {
  URGENT: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
};

function scheduleKey(job: ProviderJob): number {
  const raw = job.scheduledFor ?? job.createdAt;

  if (!raw) {
    return Number.MAX_SAFE_INTEGER;
  }

  const parsed = Date.parse(raw);

  return Number.isNaN(parsed) ? Number.MAX_SAFE_INTEGER : parsed;
}

/**
 * Open jobs first, each block sorted by when it is due, urgency breaking ties.
 *
 * Closed jobs keep their newest-first order: they are a record, not a queue,
 * and the one a provider wants to see after finishing a job is the one they
 * just closed.
 */
export function sortProviderJobs(jobs: ProviderJob[]): ProviderJob[] {
  const open: ProviderJob[] = [];
  const closed: ProviderJob[] = [];

  for (const job of jobs) {
    (isOpenJob(job) ? open : closed).push(job);
  }

  open.sort(
    (left, right) =>
      scheduleKey(left) - scheduleKey(right) ||
      (PRIORITY_RANK[left.priority] ?? 9) - (PRIORITY_RANK[right.priority] ?? 9),
  );

  return [...open, ...closed];
}

/**
 * What the provider can do with this job, as the screen should offer it.
 *
 * `CONTACTED` is offered only from `PENDING`: once contact is made, saying so
 * again is not a state change, and a button that no-ops teaches people to
 * distrust the others. `COMPLETED` is offered from every open status.
 */
export function jobActions(job: ProviderJob): {
  canComplete: boolean;
  canContact: boolean;
} {
  return {
    canComplete: isOpenJob(job),
    canContact: job.status === "PENDING",
  };
}

/** The site address a provider actually navigates to. */
export function jobAddress(job: ProviderJob): string {
  return [job.location, job.hostelName, job.hostelArea, job.hostelCity]
    .map((part) => part.trim())
    .filter(Boolean)
    .join(", ");
}

export function openJobCount(jobs: ProviderJob[]): number {
  return jobs.filter(isOpenJob).length;
}

/**
 * The icon for a job's trade.
 *
 * Providers work one or two categories and scan a list for theirs; a column of
 * identical rows makes them read every title. The keys are
 * `maintenanceCategorySchema`'s eleven values exactly — a category the server
 * adds later falls back to the generic tool rather than rendering blank, which
 * is the failure mode that looks like a broken build.
 */
const CATEGORY_ICONS: Record<string, string> = {
  APPLIANCE: "hardware-chip",
  CARPENTRY: "hammer",
  CLEANING: "sparkles",
  ELECTRICAL: "flash",
  HEALTH: "medkit",
  INTERNET: "wifi",
  OTHER: "construct",
  PAINTING: "color-palette",
  PLUMBING: "water",
  ROOM_REPAIR: "bed",
  WATER: "water",
};

export function jobCategoryIcon(category: string): string {
  return CATEGORY_ICONS[category] ?? "construct";
}

/** Open jobs whose priority is one somebody should look at today. */
export function urgentJobCount(jobs: ProviderJob[]): number {
  return jobs.filter((job) => isOpenJob(job) && ["HIGH", "URGENT"].includes(job.priority))
    .length;
}

/** Jobs this provider has finished. The number worth showing them. */
export function completedJobCount(jobs: ProviderJob[]): number {
  return jobs.filter((job) => job.status === "COMPLETED").length;
}

/* -------------------------------------------------------------------------- */
/* Row anatomy                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The tint of a row's leading glyph tile.
 *
 * Urgency, not trade: the category is already carried by the *glyph*, and a
 * tile that is both the trade and the priority is one object saying two things
 * — which is exactly what the row is for. Closed work goes grey whatever it was,
 * because a finished emergency is not an emergency.
 *
 * Never the only cue. `jobUrgencyLabel` prints the same fact in words on the
 * line below, because a column of coloured squares is unreadable in greyscale
 * and to a colour-blind provider.
 */
export type JobTone = "brand" | "danger" | "neutral" | "warning";

export function jobTone(job: ProviderJob): JobTone {
  if (!isOpenJob(job)) {
    return "neutral";
  }

  if (job.priority === "URGENT") {
    return "danger";
  }

  return job.priority === "HIGH" ? "warning" : "brand";
}

/**
 * The word for a priority worth printing, or `null` for the ordinary ones.
 *
 * `MEDIUM` and `LOW` are the default and the absence of a claim; printing them
 * on every row is what teaches people to stop reading the one that says
 * `Urgent`. Closed work prints nothing at all — see `jobTone`.
 */
export function jobUrgencyLabel(job: ProviderJob): string | null {
  if (!isOpenJob(job)) {
    return null;
  }

  if (job.priority === "URGENT") {
    return "Urgent";
  }

  return job.priority === "HIGH" ? "High" : null;
}

/**
 * Where the job is, in the space a row has for it.
 *
 * The short form of `jobAddress` — the free-text spot the admin typed and the
 * building, without the area and the city. A row is answering "which job is
 * this"; the detail screen answers "how do I get there", and that is where the
 * full address and the phone belong.
 */
export function jobPlace(job: ProviderJob): string {
  return [job.location, job.hostelName]
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" · ");
}

/**
 * An open job whose scheduled day has already passed.
 *
 * Compared against the start of the local day, not against the instant: a job
 * scheduled for today at 9am is not overdue at 10am — the hostel wrote a *date*,
 * and treating it as a deadline to the minute would paint half the list red
 * every afternoon.
 */
export function isOverdueJob(job: ProviderJob, now: Date = new Date()): boolean {
  if (!isOpenJob(job) || !job.scheduledFor) {
    return false;
  }

  const parsed = Date.parse(job.scheduledFor);

  if (Number.isNaN(parsed)) {
    return false;
  }

  const dayStart = new Date(now);

  dayStart.setHours(0, 0, 0, 0);

  return parsed < dayStart.getTime();
}

/** Open jobs whose scheduled day has already gone by. The count worth a tone. */
export function overdueJobCount(jobs: ProviderJob[], now: Date = new Date()): number {
  return jobs.filter((job) => isOverdueJob(job, now)).length;
}
