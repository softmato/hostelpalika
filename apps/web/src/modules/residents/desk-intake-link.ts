import { Types } from "mongoose";

import { Role } from "@/lib/roles";
import { promoteAccountToResident } from "@/modules/users/resident-promotion.service";
import { AuditLogModel } from "@hostel/db/models/AuditLog";
import { ResidentModel } from "@hostel/db/models/Resident";
import { UserModel } from "@hostel/db/models/User";

/**
 * Signing in for the first time with the email a hostel typed **at the desk**
 * with the person standing there (`Resident.deskIntake`, the "no card" intake):
 * the account is linked at once and opens on the resident portal, the same as
 * a scanned card — no "is this you?" (docs/FIELD_FIXES_2026_10.md §6.2).
 *
 * Only a verified, active PUBLIC address: typing someone's email on a password
 * sign-up proves nothing. Lists and join links still ask. Kept to the account
 * helpers on purpose — this runs on every sign-in, and the full resident
 * service would pull billing and PDFs into the login route.
 *
 * Never fails a sign-in; answers whether it linked.
 */
export async function linkDeskIntakeOnSignIn(userId: string): Promise<boolean> {
  try {
    const user = await UserModel.findOne({ _id: new Types.ObjectId(userId), isDeleted: { $ne: true } })
      .select("email emailVerified emailVerifiedAt role status")
      .lean<{
        _id: Types.ObjectId;
        email?: string;
        emailVerified?: boolean;
        emailVerifiedAt?: Date | null;
        role?: string;
        status?: string;
      } | null>();
    const email = user?.email?.trim().toLowerCase();

    if (
      !user ||
      !email ||
      !(user.emailVerified || user.emailVerifiedAt) ||
      user.role !== Role.PUBLIC ||
      user.status !== "ACTIVE"
    ) {
      return false;
    }

    const resident = await ResidentModel.findOne({
      $or: [{ userId: null }, { userId: { $exists: false } }],
      accountLinkDeclinedAt: null,
      deskIntake: true,
      email,
      isDeleted: { $ne: true },
      status: { $in: ["ACTIVE", "PENDING"] },
    })
      .sort({ createdAt: -1 })
      .select("firstName lastName hostelId phone")
      .lean<{ _id: Types.ObjectId; firstName: string; hostelId: Types.ObjectId; lastName: string; phone: string } | null>();

    if (!resident) return false;

    // One live residency per account.
    const elsewhere = await ResidentModel.exists({
      isDeleted: false,
      status: { $in: ["ACTIVE", "PENDING"] },
      userId: user._id,
    });

    if (elsewhere) return false;

    const claimed = await ResidentModel.updateOne(
      { _id: resident._id, $or: [{ userId: null }, { userId: { $exists: false } }] },
      { $set: { userId: user._id } },
    );

    if (claimed.modifiedCount === 0) return false;

    try {
      await promoteAccountToResident({
        hostelId: resident.hostelId,
        name: `${resident.firstName} ${resident.lastName}`.trim(),
        performedBy: user._id.toString(),
        phone: resident.phone,
        userId: user._id,
      });
    } catch {
      await ResidentModel.updateOne({ _id: resident._id, userId: user._id }, { $unset: { userId: "" } });
      return false;
    }

    await AuditLogModel.create({
      action: "RESIDENT_ACCOUNT_LINKED",
      actorId: user._id,
      entityId: resident._id.toString(),
      entityType: "Resident",
      hostelId: resident.hostelId,
      metadata: { email, via: "DESK_INTAKE_SIGN_IN" },
    }).catch(() => null);

    return true;
  } catch {
    return false;
  }
}
