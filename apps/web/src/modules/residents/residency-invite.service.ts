import { Types } from "mongoose";

import type { ApiPrincipal } from "@/lib/api-auth";
import { connectToDatabase } from "@/lib/db";
import { formatBsPeriod } from "@/lib/hostel-day";
import { Role } from "@/lib/roles";
import { issueSessionForUser } from "@/modules/auth/auth.service";
import { createInAppNotification } from "@/modules/notifications/notification.service";
import { linkResidentAccount, type ResidentRecord } from "@/modules/residents/resident.service";
import { resolveHostelStaffUserIds } from "@/modules/residents/resident-notify";
import { HostelModel } from "@hostel/db/models/Hostel";
import { InvoiceModel } from "@hostel/db/models/Invoice";
import { ResidentModel } from "@hostel/db/models/Resident";
import { UserModel } from "@hostel/db/models/User";

/**
 * "Your hostel added you as a resident — is this you?" (docs/EXISTING_RESIDENTS.md).
 *
 * ## Why this asks instead of linking
 *
 * The email on a resident record was typed by the hostel. One typo and a
 * stranger who signs in with that address would find their app turned into a
 * resident app for a hostel they have never been to, showing somebody else's
 * rent. So an account is never attached to a hostel on the hostel's word alone:
 * the person signs in, sees which hostel and what it has for them, and presses
 * Continue — or "This is not me", which stops the question for good and tells the
 * hostel its email is wrong.
 *
 * ## Who is asked
 *
 * A signed-in `PUBLIC` account whose email is **verified** (Google, or a code
 * sent to it) and matches a live resident record nobody is linked to yet. An
 * unverified address proves nothing about who owns it, and a staff or already-
 * resident account is not the person a hostel's spreadsheet is looking for.
 *
 * The desk intake still links at once when the person is standing there with
 * their card; this is for everybody else.
 */

export class ResidencyInviteError extends Error {
  constructor(
    message: string,
    public errorCode = "RESIDENCY_INVITE_ERROR",
    public status = 400,
  ) {
    super(message);
  }
}

export type ResidencyInvite = {
  firstName: string;
  hostelName: string;
  /** Rupees due right now across open bills. Zero means all clear. */
  dueAmount: number;
  /** `Aswin 2083` when the hostel recorded one, for "all clear till". */
  paidTill: string | null;
  residentId: string;
  roomType: string;
};

type AccountRow = {
  _id: Types.ObjectId;
  email?: string;
  emailVerified?: boolean;
  emailVerifiedAt?: Date | null;
  role?: string;
  status?: string;
};

const LIVE = ["ACTIVE", "PENDING"];
const OPEN_INVOICES = ["OPEN", "PARTIAL", "OVERDUE"];

async function askingAccount(principal: ApiPrincipal) {
  const user = await UserModel.findOne({
    _id: new Types.ObjectId(principal.userId),
    isDeleted: { $ne: true },
  })
    .select("email emailVerified emailVerifiedAt role status")
    .lean<AccountRow | null>();

  const email = user?.email?.trim().toLowerCase();
  const verified = Boolean(user?.emailVerified || user?.emailVerifiedAt);

  if (!user || !email || !verified || user.role !== Role.PUBLIC || user.status !== "ACTIVE") {
    return null;
  }

  return { email, user };
}

function unlinkedResidentFilter(email: string) {
  return {
    $or: [{ userId: null }, { userId: { $exists: false } }],
    accountLinkDeclinedAt: null,
    email,
    isDeleted: { $ne: true },
    status: { $in: LIVE },
  };
}

export async function findResidencyInvite(
  principal: ApiPrincipal,
): Promise<ResidencyInvite | null> {
  await connectToDatabase();

  const asking = await askingAccount(principal);

  if (!asking) {
    return null;
  }

  const resident = await ResidentModel.findOne(unlinkedResidentFilter(asking.email))
    .sort({ createdAt: -1 })
    .select("firstName hostelId paidTill roomType")
    .lean<{
      _id: Types.ObjectId;
      firstName: string;
      hostelId: Types.ObjectId;
      paidTill?: string | null;
      roomType: string;
    } | null>();

  if (!resident) {
    return null;
  }

  const [hostel, dues] = await Promise.all([
    HostelModel.findOne({ _id: resident.hostelId, isDeleted: { $ne: true } })
      .select("name")
      .lean<{ name?: string } | null>(),
    InvoiceModel.aggregate<{ total: number }>([
      {
        $match: {
          hostelId: resident.hostelId,
          residentId: resident._id,
          status: { $in: OPEN_INVOICES },
        },
      },
      { $group: { _id: null, total: { $sum: "$totalAmount" } } },
    ]),
  ]);

  if (!hostel) {
    return null;
  }

  return {
    dueAmount: dues[0]?.total ?? 0,
    firstName: resident.firstName,
    hostelName: hostel.name?.trim() || "Your hostel",
    paidTill: resident.paidTill
      ? (formatBsPeriod(resident.paidTill) || resident.paidTill).replace(/\s*BS$/, "")
      : null,
    residentId: resident._id.toString(),
    roomType: resident.roomType,
  };
}

async function residentForAnswer(principal: ApiPrincipal, residentId: string) {
  await connectToDatabase();

  if (!Types.ObjectId.isValid(residentId)) {
    throw new ResidencyInviteError("This invite was not found.", "RESIDENCY_INVITE_NOT_FOUND", 404);
  }

  const asking = await askingAccount(principal);

  if (!asking) {
    throw new ResidencyInviteError(
      "Sign in with the email your hostel has for you.",
      "RESIDENCY_INVITE_NOT_FOR_YOU",
      403,
    );
  }

  const resident = await ResidentModel.findOne({
    _id: new Types.ObjectId(residentId),
    ...unlinkedResidentFilter(asking.email),
  }).lean<ResidentRecord | null>();

  if (!resident) {
    throw new ResidencyInviteError(
      "This invite is no longer open. Ask your hostel if this is a mistake.",
      "RESIDENCY_INVITE_NOT_FOUND",
      404,
    );
  }

  return { asking, resident };
}

/**
 * "Continue" — links the account and hands back a session whose token already
 * says RESIDENT, the same way redeeming an activation code does, so the next
 * screen is the resident dashboard and not a round of refused requests.
 */
export async function acceptResidencyInvite(principal: ApiPrincipal, residentId: string) {
  const { asking, resident } = await residentForAnswer(principal, residentId);

  const link = await linkResidentAccount(
    resident,
    resident.hostelId,
    principal,
    undefined,
    // The "your hostel is on the platform" email already went out; a second
    // "you can sign in now" mail to somebody who just signed in is noise.
    false,
    { email: asking.email, userId: asking.user._id },
  );

  if (!link.linked) {
    throw new ResidencyInviteError(
      link.reason === "ACCOUNT_ALREADY_LINKED"
        ? "This account is already a resident somewhere else. Ask your old hostel to move you out first."
        : "We could not connect your account. Ask your hostel for an activation code.",
      link.reason ?? "RESIDENCY_INVITE_LINK_FAILED",
      409,
    );
  }

  const user = await UserModel.findById(asking.user._id).lean<Parameters<typeof issueSessionForUser>[0] | null>();

  if (!user) {
    throw new ResidencyInviteError("Your account was not found.", "USER_NOT_FOUND", 404);
  }

  return { residentId: resident._id.toString(), session: await issueSessionForUser(user) };
}

/**
 * "This is not me" — the question stops for this email, and the hostel is told
 * the address on the record is probably wrong. Nothing about the resident's
 * bills changes; only the link that was never made stays unmade.
 */
export async function declineResidencyInvite(principal: ApiPrincipal, residentId: string) {
  const { resident } = await residentForAnswer(principal, residentId);

  await ResidentModel.updateOne(
    { _id: resident._id },
    {
      $set: {
        accountLinkDeclinedAt: new Date(),
        accountLinkDeclinedBy: new Types.ObjectId(principal.userId),
      },
    },
  );

  try {
    const staff = await resolveHostelStaffUserIds(resident.hostelId);
    const name = `${resident.firstName} ${resident.lastName}`.trim();

    await Promise.all(
      staff.map((userId) =>
        createInAppNotification({
          actionUrl: "/hostel-admin/residents",
          body: `Someone signed in with ${resident.email} and said they are not ${name}. Check the email on their record.`,
          category: "RESIDENT",
          data: { residentId: resident._id.toString() },
          hostelId: resident.hostelId.toString(),
          title: `Check ${name}'s email`,
          userId,
        }),
      ),
    );
  } catch {
    // The answer is recorded; a missed notice must not ask them again.
  }

  return { declined: true };
}

