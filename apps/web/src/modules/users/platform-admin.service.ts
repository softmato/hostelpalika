import { randomBytes } from "node:crypto";
import { Types } from "mongoose";

import type { ApiPrincipal } from "@/lib/api-auth";
import { connectToDatabase } from "@/lib/db";
import { hashPassword } from "@/lib/password";
import { Role } from "@/lib/roles";
import { AuditLogModel } from "@hostel/db/models/AuditLog";
import { SessionModel } from "@hostel/db/models/Session";
import { UserModel } from "@hostel/db/models/User";
import { sendEmail } from "@hostel/shared/email/sender";
import { credentialsIssuedEmail } from "@hostel/shared/email/templates/auth/credentials-issued";

/**
 * Platform-admin management, reachable only by a full SUPERADMIN.
 *
 * Two grades exist:
 * - SUPERADMIN          — identical access, including managing other admins.
 * - PLATFORM_MODERATOR  — "acting superadmin": the whole platform portal, but
 *                         cannot create, promote, demote, or revoke admins.
 */

export const PLATFORM_ADMIN_ROLES = [Role.SUPERADMIN, Role.PLATFORM_MODERATOR] as const;

export type PlatformAdminRole = (typeof PLATFORM_ADMIN_ROLES)[number];

type UserRecord = {
  _id: Types.ObjectId;
  createdAt?: Date;
  email?: string;
  lastLoginAt?: Date;
  mustChangePassword?: boolean;
  name?: string;
  phone?: string;
  role?: string;
  status?: string;
};

export class PlatformAdminServiceError extends Error {
  constructor(
    message: string,
    public errorCode = "PLATFORM_ADMIN_ERROR",
    public status = 400,
  ) {
    super(message);
  }
}

function generateTemporaryPassword() {
  return randomBytes(9).toString("base64url");
}

function loginUrl() {
  const base =
    process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  return `${base}/login`;
}

function roleLabel(role: string) {
  return role === Role.SUPERADMIN ? "Superadmin" : "Acting Superadmin";
}

function serialize(user: UserRecord) {
  return {
    createdAt: user.createdAt?.toISOString() ?? null,
    email: user.email ?? "",
    id: user._id.toString(),
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
    mustChangePassword: Boolean(user.mustChangePassword),
    name: user.name ?? "Unnamed admin",
    phone: user.phone ?? "",
    role: user.role ?? Role.PLATFORM_MODERATOR,
    status: user.status ?? "ACTIVE",
  };
}

export async function listPlatformAdmins() {
  await connectToDatabase();

  const admins = await UserModel.find({
    isDeleted: { $ne: true },
    role: { $in: PLATFORM_ADMIN_ROLES },
  })
    .sort({ role: 1, createdAt: -1 })
    .lean<UserRecord[]>();

  return { admins: admins.map(serialize) };
}

/**
 * Counts admins who can still manage privileges. Used to stop the last full
 * superadmin from demoting or revoking themselves into a locked-out platform.
 */
async function activeSuperadminCount(excludeId?: string) {
  const filter: Record<string, unknown> = {
    isDeleted: { $ne: true },
    role: Role.SUPERADMIN,
    status: { $ne: "ARCHIVED" },
  };

  if (excludeId) {
    filter._id = { $ne: new Types.ObjectId(excludeId) };
  }

  return UserModel.countDocuments(filter);
}

export type CreatePlatformAdminInput = {
  email: string;
  name?: string;
  phone?: string;
  role: PlatformAdminRole;
  sendEmailNotification?: boolean;
};

export async function createPlatformAdmin(
  input: CreatePlatformAdminInput,
  principal: ApiPrincipal,
) {
  await connectToDatabase();

  const email = input.email.trim().toLowerCase();

  if (!email) {
    throw new PlatformAdminServiceError("Email is required.", "EMAIL_REQUIRED", 422);
  }

  const existing = await UserModel.findOne({
    email,
    isDeleted: { $ne: true },
  }).lean<UserRecord | null>();

  // Only a PUBLIC account may be raised to a platform role. Promoting a hostel
  // admin or resident in place would silently strip their tenant scope, so that
  // is refused rather than guessed at.
  if (existing && existing.role !== Role.PUBLIC) {
    if (existing.role === Role.SUPERADMIN || existing.role === Role.PLATFORM_MODERATOR) {
      throw new PlatformAdminServiceError(
        "This email is already a platform admin.",
        "ALREADY_PLATFORM_ADMIN",
        409,
      );
    }

    throw new PlatformAdminServiceError(
      "This email already belongs to a hostel or resident account. Use a separate address for platform access.",
      "EMAIL_ALREADY_HAS_ROLE",
      409,
    );
  }

  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);
  let userId: string;

  if (existing) {
    await UserModel.updateOne(
      { _id: existing._id },
      {
        $set: {
          mustChangePassword: true,
          passwordHash,
          role: input.role,
          status: "INVITED",
          ...(input.name ? { name: input.name.trim() } : {}),
          ...(input.phone ? { phone: input.phone.trim() } : {}),
        },
      },
    );
    userId = existing._id.toString();
  } else {
    const created = await UserModel.create({
      authProvider: "LOCAL",
      email,
      emailVerified: true,
      emailVerifiedAt: new Date(),
      mustChangePassword: true,
      name: input.name?.trim() || email,
      passwordHash,
      phone: input.phone?.trim() || undefined,
      role: input.role,
      status: "INVITED",
    });
    userId = String(created._id);
  }

  await AuditLogModel.create({
    action: "PLATFORM_ADMIN_CREATED",
    actorId: principal.userId,
    entityId: userId,
    entityType: "User",
    metadata: { email, role: input.role, upgradedExisting: Boolean(existing) },
  });

  if (input.sendEmailNotification ?? true) {
    await sendEmail({
      to: email,
      ...credentialsIssuedEmail({
        email,
        loginUrl: loginUrl(),
        roleLabel: roleLabel(input.role),
        temporaryPassword,
      }),
    });
  }

  return {
    admin: { email, id: userId, role: input.role },
    // Returned so the superadmin can hand it over if email delivery is not set
    // up locally; the account is forced to change it on first login.
    temporaryPassword,
  };
}

export async function updatePlatformAdminRole(
  adminId: string,
  role: PlatformAdminRole,
  principal: ApiPrincipal,
) {
  await connectToDatabase();

  if (!Types.ObjectId.isValid(adminId)) {
    throw new PlatformAdminServiceError("Invalid admin id.", "INVALID_OBJECT_ID", 422);
  }

  const admin = await UserModel.findOne({
    _id: adminId,
    isDeleted: { $ne: true },
    role: { $in: PLATFORM_ADMIN_ROLES },
  }).lean<UserRecord | null>();

  if (!admin) {
    throw new PlatformAdminServiceError("Platform admin not found.", "NOT_FOUND", 404);
  }

  if (admin.role === role) {
    return { admin: serialize({ ...admin, role }) };
  }

  if (
    admin.role === Role.SUPERADMIN &&
    role !== Role.SUPERADMIN &&
    (await activeSuperadminCount(adminId)) === 0
  ) {
    throw new PlatformAdminServiceError(
      "At least one full superadmin must remain.",
      "LAST_SUPERADMIN",
      409,
    );
  }

  await UserModel.updateOne({ _id: adminId }, { $set: { role } });

  await AuditLogModel.create({
    action: "PLATFORM_ADMIN_ROLE_CHANGED",
    actorId: principal.userId,
    entityId: adminId,
    entityType: "User",
    metadata: { from: admin.role, to: role },
  });

  return { admin: serialize({ ...admin, role }) };
}

export async function revokePlatformAdmin(adminId: string, principal: ApiPrincipal) {
  await connectToDatabase();

  if (!Types.ObjectId.isValid(adminId)) {
    throw new PlatformAdminServiceError("Invalid admin id.", "INVALID_OBJECT_ID", 422);
  }

  if (adminId === principal.userId) {
    throw new PlatformAdminServiceError(
      "You cannot revoke your own platform access.",
      "CANNOT_REVOKE_SELF",
      409,
    );
  }

  const admin = await UserModel.findOne({
    _id: adminId,
    isDeleted: { $ne: true },
    role: { $in: PLATFORM_ADMIN_ROLES },
  }).lean<UserRecord | null>();

  if (!admin) {
    throw new PlatformAdminServiceError("Platform admin not found.", "NOT_FOUND", 404);
  }

  if (admin.role === Role.SUPERADMIN && (await activeSuperadminCount(adminId)) === 0) {
    throw new PlatformAdminServiceError(
      "At least one full superadmin must remain.",
      "LAST_SUPERADMIN",
      409,
    );
  }

  // Soft revoke: drop to PUBLIC and suspend rather than deleting, so the audit
  // trail keeps pointing at a real account.
  await UserModel.updateOne(
    { _id: adminId },
    { $inc: { tokenVersion: 1 }, $set: { role: Role.PUBLIC, status: "SUSPENDED" } },
  );
  // Signed out with it: the revoked admin kept access until the token ran out (P7-29).
  await SessionModel.deleteMany({ userId: new Types.ObjectId(adminId) });

  await AuditLogModel.create({
    action: "PLATFORM_ADMIN_REVOKED",
    actorId: principal.userId,
    entityId: adminId,
    entityType: "User",
    metadata: { previousRole: admin.role },
  });

  return { revoked: true };
}

/**
 * Blocks or unblocks any account that is not a platform admin (owner,
 * 2026-11-09: a superadmin must be able to act on users, not only read them).
 *
 * Blocking is `status: "SUSPENDED"` — the status every sign-in path already
 * refuses — plus a `tokenVersion` bump and the sessions deleted, so the person
 * is out now rather than when their access token runs out. Platform admins are
 * left to Admins' own revoke, which also takes the role away.
 */
export async function setUserBlocked(
  userId: string,
  blocked: boolean,
  principal: ApiPrincipal,
) {
  await connectToDatabase();

  if (!Types.ObjectId.isValid(userId)) {
    throw new PlatformAdminServiceError("Invalid user id.", "INVALID_OBJECT_ID", 422);
  }

  if (userId === principal.userId) {
    throw new PlatformAdminServiceError(
      "You cannot block your own account.",
      "CANNOT_BLOCK_SELF",
      409,
    );
  }

  const user = await UserModel.findOne({ _id: userId, isDeleted: { $ne: true } })
    .select("role status")
    .lean<{ role: string; status: string } | null>();

  if (!user) {
    throw new PlatformAdminServiceError("User not found.", "NOT_FOUND", 404);
  }

  if ((PLATFORM_ADMIN_ROLES as readonly string[]).includes(user.role)) {
    throw new PlatformAdminServiceError(
      "Platform admins are removed from Admins, not blocked.",
      "PLATFORM_ADMIN",
      409,
    );
  }

  const changes = blocked
    ? user.status === "ACTIVE" || user.status === "INVITED"
    : user.status === "SUSPENDED";

  if (changes) {
    const status = blocked ? "SUSPENDED" : "ACTIVE";

    await UserModel.updateOne(
      { _id: userId },
      blocked ? { $inc: { tokenVersion: 1 }, $set: { status } } : { $set: { status } },
    );

    if (blocked) {
      await SessionModel.deleteMany({ userId: new Types.ObjectId(userId) });
    }

    await AuditLogModel.create({
      action: blocked ? "USER_BLOCKED" : "USER_UNBLOCKED",
      actorId: principal.userId,
      entityId: userId,
      entityType: "User",
      metadata: { previousStatus: user.status },
    });

    return { user: { id: userId, status } };
  }

  return { user: { id: userId, status: user.status } };
}
