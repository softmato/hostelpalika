import type { Types } from "mongoose";

import { demoteToPublicAccount } from "@/modules/auth/auth.service";
import { HostelModel } from "@hostel/db/models/Hostel";
import { ResidentModel } from "@hostel/db/models/Resident";
import { UserModel } from "@hostel/db/models/User";

/**
 * The one address any hostel may register while it lives somewhere else, so a
 * warden can be shown the intake end to end at any time. Registering it moves
 * it: `createResident` removes it from wherever it was first.
 */
export const DEMO_RESIDENT_EMAIL = "demo.resident@softmato.com";

export function isDemoResidentEmail(email: string | null | undefined) {
  return email?.trim().toLowerCase() === DEMO_RESIDENT_EMAIL;
}

/**
 * Where somebody lives right now, if anywhere on the platform.
 *
 * ## Why this exists
 *
 * One person lives in one hostel. The only place that rule used to be held was
 * `linkResidentAccount`, which runs **after** the intake has written the
 * resident, spent the bed and raised the invoices — and which answers a
 * conflict with `linked: false` rather than an error. So a student already on
 * Education Light's roll could be scanned and registered at a second hostel:
 * the second row, the second bed and the second bill all went through, and the
 * only symptom was a login that quietly did not link.
 *
 * This is the same question asked *before* anything is written, by both the
 * card lookup (so the screen can say so while the warden is still looking at
 * the details) and `createResident` (so no screen, old build or direct API call
 * can get past it).
 *
 * ## What counts as living somewhere
 *
 * Any row that is not deleted and not `MOVED_OUT`. `SUSPENDED` counts: a
 * suspended resident is still on that hostel's roll and still holds a bed there.
 *
 * ## How a person is matched
 *
 * By their account (`userId`) and by email, and either is enough. The email half
 * is not optional: a hostel that registered somebody by hand, who never signed
 * in, has a row with their address on it and no `userId` at all — and that row
 * is exactly the one a second hostel scanning their card would otherwise miss.
 */
export type LiveResidency = {
  hostelId: string;
  hostelName: string;
  /**
   * The row's id, **only** when it is the asking hostel's own. Another
   * hostel's record id is not this hostel's to hold.
   */
  residentId: string | null;
  sameHostel: boolean;
  status: "ACTIVE" | "PENDING" | "SUSPENDED";
};

const LIVE_STATUSES = ["ACTIVE", "PENDING", "SUSPENDED"] as const;

type LiveRow = {
  _id: Types.ObjectId;
  hostelId: Types.ObjectId;
  status: LiveResidency["status"];
};

export async function findLiveResidency(
  handles: {
    emails: (string | null | undefined)[];
    userIds: (Types.ObjectId | null | undefined)[];
  },
  askingHostelId?: Types.ObjectId | null,
): Promise<LiveResidency | null> {
  const emails = [
    ...new Set(
      handles.emails
        .map((email) => email?.trim().toLowerCase())
        .filter((email): email is string => Boolean(email)),
    ),
  ];
  const userIds = handles.userIds.filter((id): id is Types.ObjectId => Boolean(id));

  // Nothing to match on — a hand-typed intake with no email. The same-hostel
  // phone check is the only guard that case has. The demo resident never
  // "lives elsewhere": registering it moves it.
  if ((emails.length === 0 && userIds.length === 0) || emails.some(isDemoResidentEmail)) {
    return null;
  }

  const rows = await ResidentModel.find({
    $or: [
      ...(userIds.length ? [{ userId: { $in: userIds } }] : []),
      ...(emails.length ? [{ email: { $in: emails } }] : []),
    ],
    isDeleted: { $ne: true },
    status: { $in: LIVE_STATUSES },
  })
    .select("_id hostelId status")
    .limit(5)
    .lean<LiveRow[]>();

  if (!rows?.length) {
    return null;
  }

  /*
   * The asking hostel's own row wins when there is one. "They already live
   * here — open their record" is the more useful sentence, and it is the only
   * one that comes with somewhere to go.
   */
  const own = askingHostelId
    ? rows.find((row) => row.hostelId?.equals(askingHostelId))
    : undefined;
  const row = own ?? rows[0];

  const hostel = await HostelModel.findById(row.hostelId)
    .select("name")
    .lean<{ name?: string } | null>();

  return {
    hostelId: row.hostelId.toString(),
    hostelName: hostel?.name?.trim() || "another hostel",
    residentId: own ? own._id.toString() : null,
    sameHostel: Boolean(own),
    status: row.status,
  };
}

/**
 * A resident who left `hostelId` — moved out or removed — keeps their login but
 * loses that hostel, and once they live nowhere they are a plain public account
 * again. Left as RESIDENT, the app asks every sign-in for an activation code,
 * because a moved-out row is not an activated residency.
 *
 * Call after the row's own write, so it no longer counts as live.
 */
export async function releaseResidentAccount(
  userId: Types.ObjectId | null | undefined,
  hostelId: Types.ObjectId,
) {
  if (!userId) {
    return;
  }

  const [stillLives] = await Promise.all([
    ResidentModel.exists({
      isDeleted: { $ne: true },
      status: { $in: LIVE_STATUSES },
      userId,
    }),
    UserModel.updateOne({ _id: userId }, { $pull: { hostelIds: hostelId } }),
  ]);

  if (!stillLives) {
    await demoteToPublicAccount(userId);
  }
}

/** The refusal, in the words a warden reads it in. */
export function liveResidencyMessage(name: string, residency: LiveResidency) {
  const who = name.trim() || "This person";

  return residency.sameHostel
    ? `${who} already lives in your hostel. Open their record instead of adding them again.`
    : `${who} already lives at ${residency.hostelName}. They can't be added here until ${residency.hostelName} moves them out.`;
}
