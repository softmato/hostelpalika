/**
 * What a resident may say about their own night, and whether they have said it.
 *
 * Its own module so it can be tested — Vitest here is node-side with no React
 * Native shim. Same split as `lib/sos.ts` and `lib/complaints.ts`.
 */

import { isCurrentNight } from "@hostel/night/night-window";

import type { NightStatus, NightStatusValue } from "@/lib/resident-api";
import { sosIsOpen, type SosStanding } from "@/lib/sos";

/* -------------------------------------------------------------------------- */
/* What a resident is allowed to report                                       */
/* -------------------------------------------------------------------------- */

/**
 * The three a resident may set — a deliberate subset of the five
 * `nightStatusSchema` accepts.
 *
 * **`SOS_TRIGGERED` is excluded even though the server takes it.**
 * `POST /resident/night-status` validates against the full enum, so a client
 * could set it — and nothing would happen: no `SOSAlert` row, no fan-out, no
 * notification. It would show as an active emergency on the warden's roster with
 * nobody having been told, which is precisely the failure `lib/sos.ts` exists to
 * make unwriteable. The SOS button is the only way to raise one.
 *
 * **`NOT_VERIFIED` is excluded** because it is the *absence* of an answer —
 * `serializeNightStatus` returns it for a resident with no row at all. Offering
 * it as a choice would let someone "set" the state that means they set nothing.
 */
export const NIGHT_STATUS_OPTIONS: {
  description: string;
  icon: "home" | "moon" | "shield-checkmark";
  label: string;
  value: Extract<NightStatusValue, "INSIDE_HOSTEL" | "MARKED_SAFE" | "OUTSIDE_HOSTEL">;
}[] = [
  {
    description: "In for the night.",
    icon: "home",
    label: "Inside the hostel",
    value: "INSIDE_HOSTEL",
  },
  {
    description: "Staying elsewhere tonight — your hostel will not chase you.",
    icon: "moon",
    label: "Out for the night",
    value: "OUTSIDE_HOSTEL",
  },
  {
    description: "Somewhere else, and fine. Use this after an incident.",
    icon: "shield-checkmark",
    label: "I am safe",
    value: "MARKED_SAFE",
  },
];

export type SelfReportableStatus = (typeof NIGHT_STATUS_OPTIONS)[number]["value"];

export function isSelfReportable(status: string): status is SelfReportableStatus {
  return NIGHT_STATUS_OPTIONS.some((option) => option.value === status);
}

/* -------------------------------------------------------------------------- */
/* Which night an answer belongs to                                           */
/* -------------------------------------------------------------------------- */

/**
 * Re-exported, not reimplemented.
 *
 * The 17:00 night boundary used to live here as a private constant, and the
 * comment beside it admitted the problem: *"a client-side product choice with
 * no server counterpart."* That was fine while this screen was the only thing
 * that ever asked. It stopped being fine when a cron job started asking who has
 * not answered tonight and a warden board started rendering the answer — three
 * opinions about when a night starts, two of them across a network boundary
 * from this one.
 *
 * So it lives in `@hostel/night/night-window` now and both ends import it, the
 * same arrangement `@hostel/calendar` has for the Bikram Sambat month. The
 * re-export keeps every existing caller in this app importing from here.
 */
export { isCurrentNight };

/* -------------------------------------------------------------------------- */
/* The wording                                                                */
/* -------------------------------------------------------------------------- */

export type NightStanding = {
  /** True once tonight's answer is on record — drives the tick, not the colour. */
  answered: boolean;
  /** One sentence: what the hostel currently believes. */
  headline: string;
  /**
   * Set only when an SOS is on this resident's record. The screen renders it as a
   * warning, because changing a night status does **not** retract an alert.
   */
  sosNotice?: string;
  /** The status to preselect, or null when there is nothing worth preselecting. */
  suggested: SelfReportableStatus | null;
};

export function nightStanding(
  status: NightStatus,
  now: Date = new Date(),
  /**
   * The resident's most recent `SOSAlert`, when the caller has it.
   *
   * `null` means *no information*, not *no alert*: with nothing passed the
   * status row decides, which is what every caller did before the alert was on
   * the payload. Passed and settled, the SOS notice goes — see below.
   */
  sos: SosStanding | null = null,
): NightStanding {
  const current = isCurrentNight(status.checkedAt, now);

  /*
   * An SOS outranks everything. It is written by `triggerSOS`, not by a resident,
   * and only staff can move an alert off `ACTIVE` — so the screen must not imply
   * that picking "I am safe" cancels it.
   *
   * Which is exactly why it has to stop once they have. The notice below says
   * "only hostel staff can close it"; leaving it up after they did makes the
   * screen lie in the other direction, and the status row alone can never say —
   * it is a single upserted row that nothing clears. So: the row says an SOS was
   * written, and the alert (when the caller has one) says whether it is still
   * open.
   */
  if (status.status === "SOS_TRIGGERED" && (sos === null || sosIsOpen(sos))) {
    return {
      /*
        Never answered, even when the alert was raised tonight. `checkedAt` on an
        SOS row is the moment the alert fired, not the moment the resident said
        where they were — and `answered` is what puts "Checked in" on the home
        card and "Update my status" on this screen's button. Somebody in the
        middle of an emergency has told the hostel nothing about their night.
      */
      answered: false,
      headline: "Your hostel has an SOS alert on your record.",
      sosNotice:
        "Telling them you are safe updates your night status. It does not close the alert — only hostel staff can do that.",
      suggested: "MARKED_SAFE",
    };
  }

  if (!current || !isSelfReportable(status.status)) {
    return {
      answered: false,
      headline: "Your hostel does not know where you are tonight.",
      suggested: null,
    };
  }

  const option = NIGHT_STATUS_OPTIONS.find(
    (candidate) => candidate.value === status.status,
  );

  return {
    answered: true,
    headline: `Your hostel has you as ${option?.label.toLowerCase() ?? "checked in"} tonight.`,
    suggested: status.status,
  };
}

/**
 * `nightStatusUpdateSchema` has `note` as **optional with no minimum** and a
 * 1000-character cap, so unlike a complaint confirmation a one-character note is
 * fine — only an empty one has to be omitted rather than sent as `""`.
 */
export function nightNote(raw: string): { error?: string; note?: string } {
  const note = raw.trim();

  if (note.length === 0) {
    return {};
  }

  return note.length > 1000 ? { error: "That note is too long." } : { note };
}
