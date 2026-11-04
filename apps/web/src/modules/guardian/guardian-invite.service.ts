import { randomBytes } from "node:crypto";

import { Types } from "mongoose";
import type { z } from "zod";

import type { ApiPrincipal } from "@/lib/api-auth";
import { connectToDatabase } from "@/lib/db";
import { Role } from "@/lib/roles";
import {
  notifyGuardianOfPermissionChange,
  notifyGuardianOfRevocation,
  notifyResidentGuardianAccepted,
} from "@/modules/guardian/guardian-notify";
import { AuditLogModel } from "@hostel/db/models/AuditLog";
import { GuardianAccessModel } from "@hostel/db/models/GuardianAccess";
import { GuardianModel } from "@hostel/db/models/Guardian";
import { GuardianPermissionModel } from "@hostel/db/models/GuardianPermission";
import { GuardianServiceError } from "@/modules/guardian/guardian.service";
import { releaseGuardianAccounts } from "@/modules/guardian/guardian-account";
import { guardianInvitationEmail } from "@hostel/shared/email/templates/guardian/invitation";
import { registerOrUpgradeUserByEmail } from "@/modules/users/user.service";
import {
  appUrl,
  getHostelName,
  sendNotificationEmail,
} from "@/modules/residents/resident-notify";
import {
  findCurrentResident,
  normalizeObjectId,
} from "@/modules/residents/resident-access";
import type {
  guardianInvitationAcceptSchema,
  guardianInviteSchema,
  guardianPermissionsUpdateSchema,
} from "@/modules/guardian/guardian.validation";

type GuardianInviteInput = z.infer<typeof guardianInviteSchema>;
type GuardianPermissionsUpdateInput = z.infer<typeof guardianPermissionsUpdateSchema>;
type GuardianInvitationAcceptInput = z.infer<typeof guardianInvitationAcceptSchema>;

const INVITATION_EXPIRY_DAYS = 7;

export const PERMISSION_LABELS: Record<string, string> = {
  canViewComplaintStatus: "Complaint status (titles only, never the details)",
  canViewFood: "This week's food menu",
  canViewNotices: "Hostel notices",
  canViewPayments: "Fee status (paid / unpaid / due)",
  canViewReceipts: "Payment receipts",
  canViewSafety: "Night safety summary (day-level only)",
};

type GuardianPermissionFlags = {
  canViewComplaintStatus: boolean;
  canViewFood: boolean;
  canViewNotices: boolean;
  canViewPayments: boolean;
  canViewReceipts: boolean;
  canViewSafety: boolean;
};

type GuardianAccessRecord = {
  _id: Types.ObjectId;
  accessCode: string;
  email?: string;
  expiresAt: Date;
  guardianId: Types.ObjectId;
  hostelId: Types.ObjectId;
  invitationExpiresAt?: Date;
  invitationToken?: string;
  phone: string;
  residentId: Types.ObjectId;
  status: "ACTIVE" | "USED" | "REVOKED" | "EXPIRED";
  userId?: Types.ObjectId;
};

type GuardianRecord = {
  _id: Types.ObjectId;
  email?: string;
  firstName: string;
  hostelId: Types.ObjectId;
  lastName: string;
  phone: string;
  relation: string;
  residentId: Types.ObjectId;
};

function invitationToken() {
  return randomBytes(32).toString("hex");
}

function shortCode() {
  return randomBytes(4).toString("hex").toUpperCase().slice(0, 6);
}

function daysFromNow(days: number) {
  const date = new Date();

  date.setDate(date.getDate() + days);

  return date;
}

function enabledPermissionLabels(permissions: Partial<GuardianPermissionFlags>) {
  return Object.entries(permissions)
    .filter(([, enabled]) => enabled)
    .map(([key]) => PERMISSION_LABELS[key])
    .filter(Boolean);
}

function serializeGuardianLink(
  guardian: GuardianRecord,
  access: GuardianAccessRecord,
  permissions: GuardianPermissionFlags,
) {
  return {
    accessId: access._id.toString(),
    email: access.email ?? guardian.email ?? "",
    expiresAt: access.expiresAt.toISOString(),
    guardianId: guardian._id.toString(),
    invitationExpiresAt: access.invitationExpiresAt?.toISOString(),
    /** Never leaks the token itself — only whether one is still outstanding. */
    invitationPending: access.status === "ACTIVE" && Boolean(access.invitationToken),
    name: `${guardian.firstName} ${guardian.lastName}`.trim(),
    permissions,
    phone: guardian.phone,
    relation: guardian.relation,
    status: access.status,
  };
}

async function loadPermissions(
  accessId: Types.ObjectId,
): Promise<GuardianPermissionFlags> {
  const permission = await GuardianPermissionModel.findOne({
    guardianAccessId: accessId,
  }).lean<Partial<GuardianPermissionFlags> | null>();

  // Absence means "nothing shared". Defaulting open here would hand a guardian
  // the whole record the moment a permission document went missing.
  return {
    canViewComplaintStatus: permission?.canViewComplaintStatus ?? false,
    canViewFood: permission?.canViewFood ?? false,
    canViewNotices: permission?.canViewNotices ?? false,
    canViewPayments: permission?.canViewPayments ?? false,
    canViewReceipts: permission?.canViewReceipts ?? false,
    canViewSafety: permission?.canViewSafety ?? false,
  };
}

/**
 * Resident invites a guardian by email (PHASES.md §4.1). The resident — not an
 * admin — owns this link and the permissions attached to it.
 */
export async function inviteGuardian(
  input: GuardianInviteInput,
  principal: ApiPrincipal,
) {
  await connectToDatabase();

  const resident = await findCurrentResident(principal);
  const existingGuardian = await GuardianModel.findOne({
    email: input.email,
    hostelId: resident.hostelId,
    residentId: resident._id,
  }).lean<GuardianRecord | null>();

  const guardian =
    existingGuardian ??
    ((await GuardianModel.create({
      email: input.email,
      firstName: input.firstName,
      hostelId: resident.hostelId,
      lastName: input.lastName,
      phone: input.phone,
      relation: input.relation,
      residentId: resident._id,
    })) as GuardianRecord);

  // One live invitation per guardian: re-inviting replaces the previous link
  // rather than leaving two tokens valid.
  await GuardianAccessModel.updateMany(
    { guardianId: guardian._id, status: "ACTIVE" },
    { $set: { status: "REVOKED" } },
  );

  const token = invitationToken();
  const access = (await GuardianAccessModel.create({
    accessCode: shortCode(),
    allowComplaintStatus: input.permissions.canViewComplaintStatus,
    createdBy: principal.userId,
    email: input.email,
    expiresAt: daysFromNow(365),
    guardianId: guardian._id,
    hostelId: resident.hostelId,
    invitationExpiresAt: daysFromNow(INVITATION_EXPIRY_DAYS),
    invitationToken: token,
    invitedBy: principal.userId,
    phone: input.phone,
    residentId: resident._id,
    status: "ACTIVE",
  })) as GuardianAccessRecord;

  await GuardianPermissionModel.create({
    ...input.permissions,
    guardianAccessId: access._id,
    hostelId: resident.hostelId,
    residentId: resident._id,
  });
  await AuditLogModel.create({
    action: "GUARDIAN_INVITED",
    actorId: principal.userId,
    entityId: access._id.toString(),
    entityType: "GuardianAccess",
    hostelId: resident.hostelId,
    metadata: { guardianId: guardian._id.toString(), permissions: input.permissions },
  });

  const hostelName = await getHostelName(resident.hostelId);
  const email = guardianInvitationEmail({
    acceptUrl: appUrl(`/guardian-invite?token=${token}`),
    expiresInDays: INVITATION_EXPIRY_DAYS,
    hostelName,
    permissions: enabledPermissionLabels(input.permissions),
    residentName: `${resident.firstName} ${resident.lastName}`.trim(),
  });

  await sendNotificationEmail({
    action: "guardian_invitation",
    category: email.category, html: email.html,
    subject: email.subject,
    to: input.email,
  });

  return {
    guardian: serializeGuardianLink(guardian, access, {
      canViewComplaintStatus: input.permissions.canViewComplaintStatus,
      canViewFood: input.permissions.canViewFood,
      canViewNotices: input.permissions.canViewNotices,
      canViewPayments: input.permissions.canViewPayments,
      canViewReceipts: input.permissions.canViewReceipts,
      canViewSafety: input.permissions.canViewSafety,
    }),
  };
}

/** Every guardian the resident has linked, with what each one can see. */
export async function listResidentGuardians(principal: ApiPrincipal) {
  await connectToDatabase();

  const resident = await findCurrentResident(principal);
  const accesses = await GuardianAccessModel.find({
    hostelId: resident.hostelId,
    residentId: resident._id,
    status: { $in: ["ACTIVE", "USED"] },
  })
    .sort({ createdAt: -1 })
    .lean<GuardianAccessRecord[]>();

  if (accesses.length === 0) {
    return { guardians: [] };
  }

  const guardians = await GuardianModel.find({
    _id: { $in: accesses.map((access) => access.guardianId) },
  }).lean<GuardianRecord[]>();
  const guardianById = new Map(
    guardians.map((guardian) => [guardian._id.toString(), guardian]),
  );
  const permissions = await Promise.all(
    accesses.map((access) => loadPermissions(access._id)),
  );

  return {
    guardians: accesses
      .map((access, index) => {
        const guardian = guardianById.get(access.guardianId.toString());

        return guardian
          ? serializeGuardianLink(guardian, access, permissions[index])
          : null;
      })
      .filter(Boolean),
  };
}

async function findResidentOwnedAccess(accessId: string, principal: ApiPrincipal) {
  const resident = await findCurrentResident(principal);
  const access = await GuardianAccessModel.findOne({
    _id: normalizeObjectId(accessId, "guardian access id"),
    hostelId: resident.hostelId,
    residentId: resident._id,
  }).lean<GuardianAccessRecord | null>();

  if (!access) {
    throw new GuardianServiceError(
      "Guardian access was not found.",
      "GUARDIAN_ACCESS_NOT_FOUND",
      404,
    );
  }

  return { access, resident };
}

/** Residents can retune what a guardian sees at any time, field by field. */
export async function updateGuardianPermissions(
  accessId: string,
  input: GuardianPermissionsUpdateInput,
  principal: ApiPrincipal,
) {
  await connectToDatabase();

  const { access, resident } = await findResidentOwnedAccess(accessId, principal);

  await GuardianPermissionModel.updateOne(
    { guardianAccessId: access._id },
    {
      $set: { ...input, hostelId: resident.hostelId, residentId: resident._id },
      $setOnInsert: { guardianAccessId: access._id },
    },
    { upsert: true },
  );

  if (typeof input.canViewComplaintStatus === "boolean") {
    await GuardianAccessModel.updateOne(
      { _id: access._id },
      { $set: { allowComplaintStatus: input.canViewComplaintStatus } },
    );
  }

  await AuditLogModel.create({
    action: "GUARDIAN_PERMISSIONS_UPDATED",
    actorId: principal.userId,
    entityId: access._id.toString(),
    entityType: "GuardianAccess",
    hostelId: resident.hostelId,
    metadata: { permissions: input },
  });

  /*
   * The guardian is told, because they are the one this happened to. Without
   * it a screen quietly stops working on somebody else's device with nothing
   * anywhere to say why — which is reported as a fault, not as a change.
   */
  await notifyGuardianOfPermissionChange({
    guardianUserId: access.userId?.toString(),
    hostelId: resident.hostelId,
    residentName: `${resident.firstName} ${resident.lastName}`.trim(),
  });

  return { permissions: await loadPermissions(access._id) };
}

/** Withdraw a guardian entirely. Their next request fails the access lookup. */
export async function revokeGuardianAccess(accessId: string, principal: ApiPrincipal) {
  await connectToDatabase();

  const { access, resident } = await findResidentOwnedAccess(accessId, principal);

  await GuardianAccessModel.updateOne(
    { _id: access._id },
    { $set: { status: "REVOKED" }, $unset: { invitationToken: "" } },
  );
  await releaseGuardianAccounts([access.userId], resident.hostelId);
  await AuditLogModel.create({
    action: "GUARDIAN_ACCESS_REVOKED",
    actorId: principal.userId,
    entityId: access._id.toString(),
    entityType: "GuardianAccess",
    hostelId: resident.hostelId,
  });

  await notifyGuardianOfRevocation({
    guardianUserId: access.userId?.toString(),
    hostelId: resident.hostelId,
    residentName: `${resident.firstName} ${resident.lastName}`.trim(),
  });

  return { accessId: access._id.toString(), status: "REVOKED" as const };
}

/**
 * Guardian clicks the emailed link. Creates a GUARDIAN account or upgrades an
 * existing PUBLIC one through the single account-upgrade entry point, so an
 * email that already belongs to a resident or admin is refused (409) rather
 * than silently repurposed.
 */
export async function acceptGuardianInvitation(input: GuardianInvitationAcceptInput) {
  await connectToDatabase();

  const access = await GuardianAccessModel.findOne({
    invitationToken: input.token,
    status: "ACTIVE",
  }).lean<GuardianAccessRecord | null>();

  if (!access || !access.email) {
    throw new GuardianServiceError(
      "This invitation is not valid.",
      "GUARDIAN_INVITATION_INVALID",
      404,
    );
  }

  if (access.invitationExpiresAt && access.invitationExpiresAt.getTime() < Date.now()) {
    await GuardianAccessModel.updateOne(
      { _id: access._id },
      { $set: { status: "EXPIRED" }, $unset: { invitationToken: "" } },
    );

    throw new GuardianServiceError(
      "This invitation has expired. Ask the resident to send a new one.",
      "GUARDIAN_INVITATION_EXPIRED",
      410,
    );
  }

  const guardian = await GuardianModel.findById(
    access.guardianId,
  ).lean<GuardianRecord | null>();

  if (!guardian) {
    throw new GuardianServiceError("Guardian was not found.", "GUARDIAN_NOT_FOUND", 404);
  }

  const hostelName = await getHostelName(access.hostelId);
  const result = await registerOrUpgradeUserByEmail({
    email: access.email,
    hostelId: access.hostelId.toString(),
    hostelName,
    name: input.name ?? `${guardian.firstName} ${guardian.lastName}`.trim(),
    phone: guardian.phone,
    role: Role.GUARDIAN,
  });

  await GuardianAccessModel.updateOne(
    { _id: access._id },
    {
      $set: { status: "USED", usedAt: new Date(), userId: result.user.id },
      $unset: { invitationToken: "" },
    },
  );
  await AuditLogModel.create({
    action: "GUARDIAN_INVITATION_ACCEPTED",
    actorId: result.user.id,
    entityId: access._id.toString(),
    entityType: "GuardianAccess",
    hostelId: access.hostelId,
  });

  /*
   * The resident granted this access and is the one person with no way of
   * knowing it took effect — the guardian got an email, the hostel does not
   * care, and nothing reaches the account that authorised it.
   */
  await notifyResidentGuardianAccepted({
    guardianName: `${guardian.firstName} ${guardian.lastName}`.trim(),
    hostelId: access.hostelId,
    residentId: access.residentId,
  });

  return {
    accepted: true,
    accountCreated: result.created,
    email: result.user.email,
    hostelName,
    /** True when credentials were emailed and the guardian must sign in. */
    requiresLogin: result.created || result.upgraded,
  };
}
