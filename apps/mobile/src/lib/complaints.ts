/**
 * The wording and the rules behind the complaints screens.
 *
 * Its own module so it can be tested: Vitest here is node-side with no React
 * Native shim, so anything importing a component — or importing a module that
 * does — cannot be. Same split as `lib/sos.ts` and `lib/claim-form.ts`.
 *
 * The validation mirrors `complaint.validation.ts` rather than inventing softer
 * rules, so a resident is told what is wrong next to the field instead of by a
 * 422 after their photos have already uploaded.
 */

import type { GlyphName } from "@hostel/constants/glyphs";

import type {
  Complaint,
  ComplaintCategory,
  ComplaintUpdate,
} from "@/lib/complaints-api";
import { humanizeEnum } from "@/lib/format";

/* -------------------------------------------------------------------------- */
/* Categories                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * `complaintCategorySchema`'s enum, in the server's order, with the label, the
 * glyph and the one-line explanation.
 *
 * The descriptions exist because the categories are not self-evident: a broken
 * tap is `MAINTENANCE`, not `ROOM`, and a resident who picks the wrong one lands
 * in the wrong admin's filter and waits out an SLA nobody is watching.
 *
 * The **icons** exist because the raise screen draws these as a tile grid rather
 * than as a list of sentences — the one thing every reference app in
 * `app_recordings` agrees on. Eight glyphs are read in about the time one column
 * of text is, and the grid is two taps shallower than a picker that opens a
 * sheet. The descriptions still carry: they are the caption under each tile.
 */
export const COMPLAINT_CATEGORY_OPTIONS: {
  description: string;
  icon: GlyphName;
  label: string;
  value: ComplaintCategory;
}[] = [
  {
    description: "Meals, quality, timing",
    icon: "restaurant",
    label: "Food",
    value: "FOOD",
  },
  {
    description: "Your room, bed or roommates",
    icon: "bed",
    label: "Room",
    value: "ROOM",
  },
  {
    description: "Something broken — water, power, furniture",
    icon: "construct",
    label: "Maintenance",
    value: "MAINTENANCE",
  },
  {
    description: "Anything that feels unsafe",
    icon: "shield-checkmark",
    label: "Safety",
    value: "SAFETY",
  },
  {
    description: "Rent, dues, receipts",
    icon: "card",
    label: "Payment",
    value: "PAYMENT",
  },
  {
    description: "Conduct of hostel staff",
    icon: "people",
    label: "Staff",
    value: "STAFF",
  },
  {
    description: "Disturbance, late-night noise",
    icon: "volume-high",
    label: "Noise",
    value: "NOISE",
  },
  {
    description: "Anything else",
    icon: "ellipsis-horizontal-circle",
    label: "Other",
    value: "OTHER",
  },
];

export function complaintCategoryLabel(category: string): string {
  return (
    COMPLAINT_CATEGORY_OPTIONS.find((option) => option.value === category)?.label ??
    humanizeEnum(category)
  );
}

/* -------------------------------------------------------------------------- */
/* The create form                                                            */
/* -------------------------------------------------------------------------- */

/**
 * What the raise screen holds.
 *
 * **There is no title.** The screen asks one question — what is this about —
 * then shows the camera and a record button, and the server derives the title
 * from the first line of whatever was written (or from the category when
 * nothing was). A resident standing in front of a blocked drain does not have a
 * headline for it, and asking for one was the field everybody stalled on.
 */
export type ComplaintDraft = {
  attachmentCount: number;
  /** Typed, or empty when they spoke instead. */
  description: string;
  hasVoiceNote: boolean;
};

export type ComplaintErrors = Partial<Record<keyof ComplaintDraft, string>>;

/** `complaintCreateSchema`'s bounds. Trimmed lengths, as the server trims first. */
const DESCRIPTION_MIN = 2;
const DESCRIPTION_MAX = 4000;
export const MAX_COMPLAINT_ATTACHMENTS = 5;

/**
 * The one thing the screen can actually refuse.
 *
 * `description` and `voiceNoteAssetId` are optional individually and required
 * together — `complaintCreateSchema` refuses a complaint carrying neither,
 * because a category and a photograph do not tell an admin what they are
 * looking at. Everything else on the screen is genuinely optional, so this
 * returns at most one error and the submit button is the only thing that can be
 * blocked.
 */
export function validateComplaint(draft: ComplaintDraft): ComplaintErrors {
  const errors: ComplaintErrors = {};
  const description = draft.description.trim();

  if (!draft.hasVoiceNote && description.length < DESCRIPTION_MIN) {
    errors.description = "Say what happened, or record it.";
  } else if (description.length > DESCRIPTION_MAX) {
    errors.description = `That is longer than the ${DESCRIPTION_MAX} characters the form takes.`;
  }

  if (draft.attachmentCount > MAX_COMPLAINT_ATTACHMENTS) {
    errors.attachmentCount = `Up to ${MAX_COMPLAINT_ATTACHMENTS} photos.`;
  }

  return errors;
}

export function hasComplaintErrors(errors: ComplaintErrors): boolean {
  return Object.keys(errors).length > 0;
}

/**
 * `description` as the API should receive it: **absent, not empty**.
 *
 * The schema is `min(2).optional()`, so `""` is a 422 while a missing field is
 * fine — and a voice-only complaint has nothing to send. One-character text is
 * treated the same way rather than being padded into validity; the recording is
 * the description in that case, and `validateComplaint` has already refused it
 * if there is no recording either.
 */
export function complaintDescription(raw: string): string | undefined {
  const description = raw.trim();

  return description.length >= DESCRIPTION_MIN ? description : undefined;
}

/* -------------------------------------------------------------------------- */
/* Confirming a resolution                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The server **409s with `COMPLAINT_NOT_RESOLVED`** on anything else, so this is
 * what decides whether the button is drawn at all.
 *
 * `confirmedAt` is part of it because the service does not guard against a
 * second confirmation — it would re-stamp the date and append another line to
 * the thread. Note that any later status change clears `confirmedAt`, so a
 * complaint the hostel re-opens and resolves again is confirmable again, which
 * is correct.
 */
export function canConfirmResolution(
  complaint: Pick<Complaint, "confirmedAt" | "status">,
): boolean {
  return complaint.status === "RESOLVED" && !complaint.confirmedAt;
}

/**
 * `complaintResolutionConfirmSchema` has `note` as **optional, min 2** — so a
 * blank box must be sent as an absent field rather than as `""`, and a
 * one-character note is a 422. Confirming with no note is the common case and
 * must not be blocked by a field nobody filled in.
 */
export function confirmNote(raw: string): { error?: string; note?: string } {
  const note = raw.trim();

  if (note.length === 0) {
    return {};
  }

  if (note.length < 2) {
    return { error: "Either leave a note or leave the box empty." };
  }

  if (note.length > 1000) {
    return { error: "That note is too long." };
  }

  return { note };
}

/* -------------------------------------------------------------------------- */
/* What state a complaint is in                                               */
/* -------------------------------------------------------------------------- */

export type ComplaintStanding = {
  /** Non-null when there is something for the resident to do. */
  action: "confirm" | null;
  /** One sentence, in the resident's terms rather than the enum's. */
  headline: string;
};

/**
 * The line under the title, and whether a button belongs with it.
 *
 * `isOverdue` is taken from the payload, never recomputed: the server derives it
 * from `slaDueAt` at serialize time, and a client that compares the same date
 * against its own clock will disagree with the hostel's admin panel on a phone
 * whose time is off.
 */
export function complaintStanding(
  complaint: Pick<Complaint, "confirmedAt" | "isOverdue" | "status">,
): ComplaintStanding {
  if (complaint.status === "REJECTED") {
    return { action: null, headline: "The hostel rejected this." };
  }

  if (complaint.status === "RESOLVED") {
    return canConfirmResolution(complaint)
      ? {
          action: "confirm",
          headline: "The hostel marked this resolved. Confirm it is actually fixed.",
        }
      : { action: null, headline: "Resolved, and you confirmed it." };
  }

  if (complaint.status === "IN_PROGRESS") {
    return {
      action: null,
      headline: complaint.isOverdue
        ? "Being worked on, but past the time your hostel allows for it."
        : "Your hostel is working on this.",
    };
  }

  return {
    action: null,
    headline: complaint.isOverdue
      ? "Nobody has picked this up, and it is past the time your hostel allows."
      : "Waiting for your hostel to pick this up.",
  };
}

/* -------------------------------------------------------------------------- */
/* The thread                                                                 */
/* -------------------------------------------------------------------------- */

export type ThreadEntry = {
  /** "You", or who at the hostel acted. */
  actor: string;
  at?: string;
  /** Always says something — see `updateBody`. */
  body: string;
  id: string;
  /** The resident's own line. Drives the bubble's side and tone. */
  mine: boolean;
  /** What the actor typed, when `body` is the event rather than their words. */
  note?: string;
};

/**
 * Staff roles the resident should see a name for.
 *
 * `humanizeEnum` alone would render `HOSTEL_ADMIN` as "Hostel admin", which is
 * fine, and `SUPERADMIN` as "Superadmin", which tells a resident nothing about
 * who touched their complaint.
 */
const ACTOR_LABELS: Record<string, string> = {
  HOSTEL_ADMIN: "Hostel admin",
  RESIDENT: "You",
  SUPERADMIN: "Platform support",
  WARDEN: "Warden",
};

/**
 * **Role, not id.** `actorId` is a `User` id while `complaint.residentId` is a
 * `Resident` id — different collections, so comparing them is always false and
 * every one of the resident's own lines would be attributed to the hostel.
 */
function actorLabel(update: Pick<ComplaintUpdate, "actorRole">): string {
  return ACTOR_LABELS[update.actorRole] ?? humanizeEnum(update.actorRole);
}

/**
 * An update with no message still has to read as something.
 *
 * A `STATUS_CHANGE` usually carries no words at all — `message` is the admin's
 * optional `response` — so the status move *is* the content. Without this, the
 * most important line in the thread ("marked resolved") renders as an empty
 * bubble with a timestamp.
 */
function updateBody(update: ComplaintUpdate): { body: string; note?: string } {
  const message = update.message.trim();

  if (update.type === "STATUS_CHANGE") {
    const next = update.nextStatus;

    return {
      body: next ? `Marked ${humanizeEnum(next).toLowerCase()}.` : "Status updated.",
      note: message || undefined,
    };
  }

  if (update.type === "CREATED") {
    return { body: "Complaint submitted." };
  }

  if (update.type === "RESIDENT_CONFIRMATION") {
    return { body: "Confirmed the fix.", note: message || undefined };
  }

  return { body: message || "The hostel replied." };
}

/**
 * The thread, oldest first — the order the server already sorts in, kept rather
 * than reversed so a long history reads as a history.
 */
export function threadEntries(
  complaint: Pick<Complaint, "updates">,
): ThreadEntry[] {
  return complaint.updates.map((update) => {
    const { body, note } = updateBody(update);

    return {
      actor: actorLabel(update),
      at: update.createdAt,
      body,
      id: update.id,
      mine: update.actorRole === "RESIDENT",
      note,
    };
  });
}
