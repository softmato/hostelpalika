import { assertPlanRoom } from "@/modules/billing/plan-limits";
import { Types } from "mongoose";
import type { z } from "zod";

import type { ApiPrincipal } from "@/lib/api-auth";
import { connectToDatabase } from "@/lib/db";
import { paginationMeta, paginationRange } from "@/lib/pagination";
import { Role } from "@/lib/roles";
import { AuditLogModel } from "@hostel/db/models/AuditLog";
import { HostelMemberModel } from "@hostel/db/models/HostelMember";
import {
  notifyWardenAdded,
  notifyWardenUpdated,
} from "@/modules/wardens/warden-notify";
import { UserModel } from "@hostel/db/models/User";
import {
  HostelServiceError,
  resolveAdminHostelId,
  scopedHostelFilter,
} from "@/modules/hostels/hostel.service";
import { registerOrUpgradeUserByEmail } from "@/modules/users/user.service";
import {
  DEFAULT_WARDEN_PERMISSIONS,
  type wardenCreateSchema,
  type wardenListQuerySchema,
  type wardenUpdateSchema,
} from "@/lib/wardens/warden.validation";

type WardenCreateInput = z.infer<typeof wardenCreateSchema>;
type WardenUpdateInput = z.infer<typeof wardenUpdateSchema>;
type WardenListQuery = z.infer<typeof wardenListQuerySchema>;

type MemberStatus = "ACTIVE" | "INVITED" | "SUSPENDED" | "REMOVED";

type HostelMemberRecord = {
  _id: Types.ObjectId;
  createdAt?: Date;
  hostelId: Types.ObjectId;
  permissions?: string[];
  role: string;
  status: MemberStatus;
  updatedAt?: Date;
  userId: Types.ObjectId;
};

type WardenUserRecord = {
  _id: Types.ObjectId;
  email?: string;
  name?: string;
  phone?: string;
  status?: string;
};

function toObjectId(value: string, label: string) {
  if (!Types.ObjectId.isValid(value)) {
    throw new HostelServiceError(`Invalid ${label}.`, "INVALID_OBJECT_ID", 422);
  }

  return new Types.ObjectId(value);
}

function serializeWarden(member: HostelMemberRecord, user?: WardenUserRecord | null) {
  return {
    createdAt: member.createdAt?.toISOString(),
    email: user?.email ?? "",
    hostelId: member.hostelId.toString(),
    id: member._id.toString(),
    name: user?.name ?? "Unnamed warden",
    permissions: member.permissions ?? [],
    phone: user?.phone ?? "",
    role: member.role,
    status: member.status,
    updatedAt: member.updatedAt?.toISOString(),
    userId: member.userId.toString(),
  };
}

async function hydrateUser(userId: Types.ObjectId) {
  return UserModel.findById(userId)
    .select("name email phone status")
    .lean<WardenUserRecord | null>();
}

async function findScopedWarden(
  memberId: string,
  principal: ApiPrincipal,
  requestedHostelId?: string,
) {
  const member = await HostelMemberModel.findOne({
    _id: toObjectId(memberId, "warden id"),
    isDeleted: false,
    role: Role.WARDEN,
    ...scopedHostelFilter(principal, requestedHostelId),
  }).lean<HostelMemberRecord | null>();

  if (!member) {
    throw new HostelServiceError("Warden was not found.", "WARDEN_NOT_FOUND", 404);
  }

  return member;
}

async function auditWardenAction(
  principal: ApiPrincipal,
  member: Pick<HostelMemberRecord, "_id" | "hostelId">,
  action: string,
  metadata: Record<string, unknown> = {},
) {
  await AuditLogModel.create({
    action,
    actorId: principal.userId,
    entityId: member._id.toString(),
    entityType: "HostelMember",
    hostelId: member.hostelId,
    metadata,
  });
}

export async function listHostelWardens(query: WardenListQuery, principal: ApiPrincipal) {
  await connectToDatabase();

  const filter: Record<string, unknown> = {
    isDeleted: false,
    role: Role.WARDEN,
    ...scopedHostelFilter(principal, query.hostelId),
  };

  if (query.status) {
    filter.status = query.status;
  }

  const { limit, skip } = paginationRange(query);

  const [members, total] = await Promise.all([
    HostelMemberModel.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean<HostelMemberRecord[]>(),
    HostelMemberModel.countDocuments(filter),
  ]);

  const userIds = members.map((member) => member.userId);
  const users = userIds.length
    ? await UserModel.find({ _id: { $in: userIds } })
        .select("name email phone status")
        .lean<WardenUserRecord[]>()
    : [];

  const userById = new Map(users.map((user) => [user._id.toString(), user]));

  return {
    pagination: paginationMeta(query, total),
    wardens: members.map((member) =>
      serializeWarden(member, userById.get(member.userId.toString())),
    ),
  };
}

export async function createHostelWarden(
  input: WardenCreateInput,
  principal: ApiPrincipal,
) {
  await connectToDatabase();

  const hostelId = resolveAdminHostelId(principal, input.hostelId);
  const permissions = input.permissions ?? DEFAULT_WARDEN_PERMISSIONS;

  await assertPlanRoom(hostelId, "wardens");

  // Account create/upgrade per ARCHITECTURE.md §3.2 (never duplicates a User).
  // Throws EMAIL_ALREADY_HAS_ROLE (409) if the email belongs to a non-PUBLIC,
  // non-WARDEN role.
  const account = await registerOrUpgradeUserByEmail({
    email: input.email,
    hostelId: hostelId.toString(),
    name: input.name,
    performedBy: principal.userId,
    phone: input.phone,
    role: Role.WARDEN,
    sendEmailNotification: true,
  });

  const userId = toObjectId(account.user.id, "user id");

  // HostelMember has a unique (hostelId, userId) index. Reactivate an existing
  // membership (e.g. a previously suspended warden) instead of failing.
  const existing = await HostelMemberModel.findOne({
    hostelId,
    userId,
  }).lean<HostelMemberRecord | null>();

  let member: HostelMemberRecord;

  if (existing) {
    const updated = await HostelMemberModel.findOneAndUpdate(
      { _id: existing._id },
      {
        $set: {
          isDeleted: false,
          permissions,
          role: Role.WARDEN,
          status: "ACTIVE",
          updatedBy: principal.userId,
        },
        $unset: { deletedAt: "", deletedBy: "" },
      },
      { new: true },
    ).lean<HostelMemberRecord | null>();

    if (!updated) {
      throw new HostelServiceError("Warden was not found.", "WARDEN_NOT_FOUND", 404);
    }

    member = updated;
  } else {
    const created = await HostelMemberModel.create({
      createdBy: principal.userId,
      hostelId,
      permissions,
      role: Role.WARDEN,
      status: "ACTIVE",
      userId,
    });

    member = created.toObject() as HostelMemberRecord;
  }

  await auditWardenAction(principal, member, "WARDEN_CREATED", {
    accountCreated: account.created,
    accountUpgraded: account.upgraded,
    email: input.email,
    permissions,
    userId: userId.toString(),
  });

  /*
   * An *upgraded* PUBLIC account gets no email — it keeps its own password, so
   * `registerOrUpgradeUserByEmail` has nothing to send — which meant somebody
   * could be made staff of a hostel and told nothing at all.
   */
  await notifyWardenAdded({
    actorUserId: principal.userId,
    hostelId,
    reactivated: Boolean(existing),
    userId: userId.toString(),
  });

  const user = await hydrateUser(userId);

  return {
    accountCreated: account.created,
    accountUpgraded: account.upgraded,
    // Surfaced only when a brand-new account was minted, so the admin can hand
    // over credentials if transactional email is not yet configured. Null for
    // upgraded PUBLIC accounts (they keep their existing password).
    temporaryPassword: account.temporaryPassword,
    warden: serializeWarden(member, user),
  };
}

export async function updateHostelWarden(
  memberId: string,
  input: WardenUpdateInput,
  principal: ApiPrincipal,
) {
  await connectToDatabase();

  const member = await findScopedWarden(memberId, principal, input.hostelId);

  const update: Record<string, unknown> = { updatedBy: principal.userId };

  if (input.permissions !== undefined) {
    update.permissions = input.permissions;
  }

  if (input.status !== undefined) {
    update.status = input.status;
  }

  const updated = await HostelMemberModel.findOneAndUpdate(
    { _id: member._id, isDeleted: false },
    { $set: update },
    { new: true },
  ).lean<HostelMemberRecord | null>();

  if (!updated) {
    throw new HostelServiceError("Warden was not found.", "WARDEN_NOT_FOUND", 404);
  }

  await auditWardenAction(principal, updated, "WARDEN_UPDATED", {
    permissions: input.permissions,
    status: input.status,
  });

  // Suspension is the one that has to arrive: it does not sign anybody out, it
  // just makes the next thing they try fail.
  await notifyWardenUpdated({
    actorUserId: principal.userId,
    hostelId: updated.hostelId,
    permissionsChanged: input.permissions !== undefined,
    status: input.status,
    userId: updated.userId.toString(),
  });

  const user = await hydrateUser(updated.userId);

  return {
    warden: serializeWarden(updated, user),
  };
}

export async function deactivateHostelWarden(
  memberId: string,
  principal: ApiPrincipal,
  requestedHostelId?: string,
) {
  await connectToDatabase();

  const member = await findScopedWarden(memberId, principal, requestedHostelId);

  const updated = await HostelMemberModel.findOneAndUpdate(
    { _id: member._id, isDeleted: false },
    { $set: { status: "SUSPENDED", updatedBy: principal.userId } },
    { new: true },
  ).lean<HostelMemberRecord | null>();

  if (!updated) {
    throw new HostelServiceError("Warden was not found.", "WARDEN_NOT_FOUND", 404);
  }

  await auditWardenAction(principal, updated, "WARDEN_DEACTIVATED", {});

  await notifyWardenUpdated({
    actorUserId: principal.userId,
    hostelId: updated.hostelId,
    permissionsChanged: false,
    status: "SUSPENDED",
    userId: updated.userId.toString(),
  });

  const user = await hydrateUser(updated.userId);

  return {
    warden: serializeWarden(updated, user),
  };
}
