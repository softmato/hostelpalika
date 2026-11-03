import { Types } from "mongoose";
import type { z } from "zod";

import type { ApiPrincipal } from "@/lib/api-auth";
import { signPurposeToken, verifyPurposeToken } from "@/lib/auth";
import { connectToDatabase } from "@/lib/db";
import {
  MAX_PAGE_SIZE,
  paginationMeta,
  paginationRange,
  type PaginationQuery,
} from "@/lib/pagination";
import { Role } from "@/lib/roles";
import { AccountDeletionRequestModel } from "@hostel/db/models/AccountDeletionRequest";
import { AuditLogModel } from "@hostel/db/models/AuditLog";
import { DeviceTokenModel } from "@hostel/db/models/DeviceToken";
import { GuardianAccessModel } from "@hostel/db/models/GuardianAccess";
import { HostelModel } from "@hostel/db/models/Hostel";
import { ResidentModel } from "@hostel/db/models/Resident";
import { SessionModel } from "@hostel/db/models/Session";
import { UserModel } from "@hostel/db/models/User";
import { createInAppNotification } from "@/modules/notifications/notification.service";
import { appUrl, sendNotificationEmail } from "@/modules/residents/resident-notify";
import { normalizeObjectId } from "@/modules/residents/resident-access";
import { accountDeletionCancelledEmail } from "@hostel/shared/email/templates/account/deletion-cancelled";
import { accountDeletionRequestedEmail } from "@hostel/shared/email/templates/account/deletion-requested";
import { accountDeletionReviewEmail } from "@hostel/shared/email/templates/platform/account-deletion-review";
import type {
  accountDeletionRequestSchema,
  accountDeletionReviewSchema,
} from "@/modules/users/account-deletion.validation";

type RequestInput = z.infer<typeof accountDeletionRequestSchema>;
type ReviewInput = z.infer<typeof accountDeletionReviewSchema>;

/** ARCHITECTURE.md §13.1 — the grace period, in days. */
export const DELETION_GRACE_PERIOD_DAYS = 60;

export class AccountDeletionError extends Error {
  constructor(
    message: string,
    public errorCode = "ACCOUNT_DELETION_ERROR",
    public status = 400,
  ) {
    super(message);
  }
}

type UserRecord = {
  _id: Types.ObjectId;
  email?: string;
  hostelIds?: Types.ObjectId[];
  name?: string;
  role: Role;
  status: string;
};

/**
 * What the "Delete account" button is allowed to do for this account.
 *
 * Deletion is not one action, because an account is not one thing. Four
 * outcomes, decided by what else depends on the account:
 *
 * - **`SELF_SERVICE`** — nothing depends on it. The 60-day clock starts.
 * - **`GUARDIAN_RELEASE`** — a guardian's account outlives their guardianship.
 *   Deleting "the guardian" means giving up the link to the resident they watch
 *   over, not erasing the person; they keep a normal public account and can
 *   then delete that outright if they still want to.
 * - **`BLOCKED`** — an active resident. Their residency is the hostel's record
 *   of who is living in a bed tonight; it is not theirs alone to erase. They
 *   can delete once they have moved out.
 * - **`PLATFORM_REVIEW`** — a hostel owner. Residents, payments and staff hang
 *   off this account, so it goes to the platform owner as a request instead.
 */
export type DeletionPathway =
  | "BLOCKED"
  | "GUARDIAN_RELEASE"
  | "PLATFORM_REVIEW"
  | "SELF_SERVICE";

async function loadUser(userId: string) {
  const user = await UserModel.findOne({
    _id: normalizeObjectId(userId, "user id"),
    isDeleted: { $ne: true },
  }).lean<UserRecord | null>();

  if (!user) {
    throw new AccountDeletionError("Account was not found.", "NOT_FOUND", 404);
  }

  return user;
}

async function resolvePathway(user: UserRecord): Promise<{
  blockedReason?: string;
  hostelNames: string[];
  pathway: DeletionPathway;
}> {
  if (user.role === Role.GUARDIAN) {
    return { hostelNames: [], pathway: "GUARDIAN_RELEASE" };
  }

  if (user.role === Role.HOSTEL_ADMIN) {
    const hostels = await HostelModel.find({
      _id: { $in: user.hostelIds ?? [] },
      isDeleted: { $ne: true },
    })
      .select("name")
      .lean<{ name: string }[]>();

    return { hostelNames: hostels.map((hostel) => hostel.name), pathway: "PLATFORM_REVIEW" };
  }

  // WARDEN and COOK accounts are issued by a hostel admin and belong to the
  // hostel's staffing, so retiring one is the admin's action, not a
  // self-service deletion.
  if (user.role === Role.WARDEN || user.role === Role.COOK) {
    return {
      blockedReason:
        "Staff accounts are created and closed by your hostel administrator. Ask them to remove your account.",
      hostelNames: [],
      pathway: "BLOCKED",
    };
  }

  if (user.role === Role.SUPERADMIN || user.role === Role.PLATFORM_MODERATOR) {
    return {
      blockedReason:
        "Platform accounts cannot be deleted from here. Another platform owner must remove the account.",
      hostelNames: [],
      pathway: "BLOCKED",
    };
  }

  const activeResidency = await ResidentModel.findOne({
    isDeleted: { $ne: true },
    status: { $in: ["ACTIVE", "PENDING"] },
    userId: user._id,
  })
    .select("_id")
    .lean<{ _id: Types.ObjectId } | null>();

  if (activeResidency) {
    return {
      blockedReason:
        "You are currently registered as a resident. Your hostel needs this record while you are living there — you can delete your account once you have moved out.",
      hostelNames: [],
      pathway: "BLOCKED",
    };
  }

  return { hostelNames: [], pathway: "SELF_SERVICE" };
}

type DeletionRequestRecord = {
  _id: Types.ObjectId;
  cancelled?: boolean;
  cancelledAt?: Date;
  executed?: boolean;
  executedAt?: Date;
  hostelIds?: Types.ObjectId[];
  kind: string;
  reason: string;
  requestedAt: Date;
  requestedEmail: string;
  requestedName?: string;
  requestedRole: string;
  reviewNote?: string;
  reviewStatus?: string;
  reviewedAt?: Date;
  scheduledDeletionAt?: Date;
  userId: Types.ObjectId;
};

function serializeRequest(request: DeletionRequestRecord) {
  return {
    cancelled: Boolean(request.cancelled),
    cancelledAt: request.cancelledAt?.toISOString(),
    executed: Boolean(request.executed),
    executedAt: request.executedAt?.toISOString(),
    hostelIds: (request.hostelIds ?? []).map(String),
    id: request._id.toString(),
    kind: request.kind,
    reason: request.reason,
    requestedAt: request.requestedAt.toISOString(),
    requestedEmail: request.requestedEmail,
    requestedName: request.requestedName,
    requestedRole: request.requestedRole,
    reviewNote: request.reviewNote,
    reviewStatus: request.reviewStatus,
    reviewedAt: request.reviewedAt?.toISOString(),
    scheduledDeletionAt: request.scheduledDeletionAt?.toISOString(),
    userId: request.userId.toString(),
  };
}

/**
 * Powers the settings screen: which of the four outcomes this account faces,
 * and whether a request is already open. The UI needs this *before* the user
 * clicks, so the button can say what it will actually do.
 */
export async function getAccountDeletionStatus(principal: ApiPrincipal) {
  await connectToDatabase();

  const user = await loadUser(principal.userId);
  const { blockedReason, hostelNames, pathway } = await resolvePathway(user);
  const existing = await AccountDeletionRequestModel.findOne({
    cancelled: false,
    executed: false,
    userId: user._id,
  }).lean<DeletionRequestRecord | null>();

  return {
    blockedReason,
    graceperiodDays: DELETION_GRACE_PERIOD_DAYS,
    hostelNames,
    pathway,
    request: existing ? serializeRequest(existing) : null,
  };
}

/** ARCHITECTURE.md §13.2 — the effects that land the moment a request is made. */
async function applyImmediateEffects(userId: Types.ObjectId) {
  await Promise.all([
    // Suspends the login. The User enum has no DISABLED member; SUSPENDED is
    // the shipped name for the same state and is already what the login check
    // refuses on.
    UserModel.updateOne(
      { _id: userId },
      // Bumping tokenVersion invalidates access tokens already in the wild —
      // revoking the session rows alone would leave an unexpired JWT working.
      { $inc: { tokenVersion: 1 }, $set: { status: "SUSPENDED" } },
    ),
    SessionModel.updateMany(
      { revokedAt: null, userId },
      { $set: { revokedAt: new Date() } },
    ),
    DeviceTokenModel.deleteMany({ userId }),
  ]);
}

async function cancelUrlFor(userId: Types.ObjectId) {
  const token = await signPurposeToken({
    purpose: "cancel-account-deletion",
    ttlSeconds: DELETION_GRACE_PERIOD_DAYS * 24 * 60 * 60,
    userId: userId.toString(),
  });

  return appUrl(`/cancel-deletion?token=${encodeURIComponent(token)}`);
}

/**
 * PRIVACY_POLICY.md §8.1. Branches on {@link resolvePathway} — the caller does
 * not get to pick which flow they land in.
 */
export async function requestAccountDeletion(
  input: RequestInput,
  principal: ApiPrincipal,
) {
  await connectToDatabase();

  const user = await loadUser(principal.userId);
  const { blockedReason, hostelNames, pathway } = await resolvePathway(user);

  if (pathway === "BLOCKED") {
    throw new AccountDeletionError(
      blockedReason ?? "This account cannot be deleted from here.",
      "DELETION_NOT_ALLOWED",
      409,
    );
  }

  if (pathway === "GUARDIAN_RELEASE") {
    return releaseGuardianRole(principal);
  }

  const open = await AccountDeletionRequestModel.findOne({
    cancelled: false,
    executed: false,
    userId: user._id,
  }).lean<{ _id: Types.ObjectId } | null>();

  if (open) {
    throw new AccountDeletionError(
      "A deletion request is already open on this account.",
      "DELETION_ALREADY_REQUESTED",
      409,
    );
  }

  const now = new Date();
  const platformReview = pathway === "PLATFORM_REVIEW";
  // A reviewed request has no clock: nothing may purge it until a superadmin
  // approves, and approval is what sets this.
  const scheduledDeletionAt = platformReview
    ? undefined
    : new Date(now.getTime() + DELETION_GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000);

  const request = await AccountDeletionRequestModel.findOneAndUpdate(
    { userId: user._id },
    {
      $set: {
        cancelled: false,
        executed: false,
        hostelIds: user.hostelIds ?? [],
        kind: platformReview ? "PLATFORM_REVIEW" : "SELF_SERVICE",
        reason: input.reason,
        requestedAt: now,
        requestedEmail: user.email ?? "",
        requestedName: user.name,
        requestedRole: user.role,
        ...(platformReview ? { reviewStatus: "PENDING" } : { scheduledDeletionAt }),
      },
      // Mongoose drops `undefined` from $set, so a reopened row (cancelled or
      // rejected before) kept its old review and cancellation; unset them.
      $unset: {
        cancelledAt: 1,
        executedAt: 1,
        reviewNote: 1,
        reviewedAt: 1,
        reviewedBy: 1,
        ...(platformReview ? { scheduledDeletionAt: 1 } : { reviewStatus: 1 }),
      },
    },
    { new: true, upsert: true },
  ).lean<DeletionRequestRecord | null>();

  if (!request) {
    throw new AccountDeletionError(
      "Could not record the deletion request. Please try again.",
      "DELETION_WRITE_FAILED",
      500,
    );
  }

  await AuditLogModel.create({
    action: platformReview ? "ACCOUNT_DELETION_SUBMITTED" : "ACCOUNT_DELETION_REQUESTED",
    actorId: user._id,
    entityType: "User",
    entityId: String(user._id),
  }).catch(() => {});

  if (platformReview) {
    await notifyPlatformOfDeletionRequest(user, input.reason, hostelNames);

    return {
      pathway,
      request: serializeRequest(request),
      // The account is untouched — saying otherwise would be a lie the UI
      // would then have to walk back.
      message:
        "Your request has been sent to the platform owner. Your account and hostel stay active until they review it.",
    };
  }

  await applyImmediateEffects(user._id);

  if (user.email && scheduledDeletionAt) {
    const email = accountDeletionRequestedEmail({
      cancelUrl: await cancelUrlFor(user._id),
      scheduledDeletionDate: scheduledDeletionAt.toISOString().slice(0, 10),
      userName: user.name,
    });

    await sendNotificationEmail({
      action: "account_deletion_requested",
      html: email.html,
      subject: email.subject,
      to: user.email,
    }).catch(() => {
      // The request is already committed and the account already closed; a
      // failed mail must not roll that back into a 500.
    });
  }

  return {
    pathway,
    request: serializeRequest(request),
    message:
      "Your account is closed. It will be permanently deleted in 60 days — use the link in your email if you change your mind.",
  };
}

/**
 * The guardian outcome. A guardian account is a normal account with a link to
 * a resident attached; removing the link is the meaningful thing "delete" can
 * do, and it leaves a working public account behind rather than destroying one.
 */
export async function releaseGuardianRole(principal: ApiPrincipal) {
  await connectToDatabase();

  const userId = normalizeObjectId(principal.userId, "user id");

  await GuardianAccessModel.updateMany(
    { status: "ACTIVE", userId },
    { $set: { status: "REVOKED" } },
  );
  await UserModel.updateOne(
    { _id: userId },
    // hostelIds is cleared with the role: a public account has no tenant, and
    // leaving them would keep granting hostel-scoped reads to a PUBLIC user.
    { $set: { hostelIds: [], role: Role.PUBLIC } },
  );
  await AuditLogModel.create({
    action: "GUARDIAN_ACCESS_RELEASED",
    actorId: userId,
    entityType: "User",
    entityId: String(userId),
  }).catch(() => {});

  return {
    pathway: "GUARDIAN_RELEASE" as const,
    request: null,
    message:
      "Your guardian access has been removed and you no longer see your resident's information. Your account itself is still here as a regular account — you can delete it from this page if you want it gone entirely.",
  };
}

async function notifyPlatformOfDeletionRequest(
  user: UserRecord,
  reason: string,
  hostelNames: string[],
) {
  try {
    const owners = await UserModel.find({
      isDeleted: { $ne: true },
      role: Role.SUPERADMIN,
      status: "ACTIVE",
    })
      .select("_id email")
      .lean<{ _id: Types.ObjectId; email?: string }[]>();

    const email = accountDeletionReviewEmail({
      hostelNames,
      queueUrl: appUrl("/platform/account-deletions"),
      reason,
      requesterEmail: user.email ?? "",
      requesterName: user.name,
      requesterRole: user.role,
    });

    await Promise.all(
      owners.map(async (owner) => {
        if (owner.email) {
          await sendNotificationEmail({
            action: "account_deletion_review",
            html: email.html,
            subject: email.subject,
            to: owner.email,
          });
        }

        await createInAppNotification({
          body: `${user.name ?? user.email} asked for their account to be deleted.`,
          category: "ACCOUNT_DELETION",
          data: { userId: user._id.toString() },
          title: "Account deletion request",
          userId: owner._id.toString(),
        }).catch(() => {});
      }),
    );
  } catch {
    // The request row is written; failing to tell the platform must not fail
    // the submission. It is still visible in the review queue.
  }
}

/**
 * Cancel during the grace period. Reached from the emailed link, because the
 * account is suspended and the user cannot log in to reach a settings page
 * (ARCHITECTURE.md §13.1 wants both to be true at once).
 */
export async function cancelAccountDeletionByToken(token: string) {
  await connectToDatabase();

  let userId: string;

  try {
    const payload = await verifyPurposeToken(token, "cancel-account-deletion");
    userId = payload.sub as string;
  } catch {
    throw new AccountDeletionError(
      "This cancellation link is invalid or has expired.",
      "INVALID_TOKEN",
      400,
    );
  }

  return cancelAccountDeletionForUser(userId);
}

export async function cancelAccountDeletionForUser(userId: string) {
  await connectToDatabase();

  const id = normalizeObjectId(userId, "user id");
  const request = await AccountDeletionRequestModel.findOneAndUpdate(
    // Keyed on the clock rather than on `kind`: an owner whose PLATFORM_REVIEW
    // request was approved is on the same 60-day countdown and gets the same
    // cancel link, so they must be able to use it. A request still awaiting
    // review has no `scheduledDeletionAt` and nothing to cancel.
    {
      cancelled: false,
      executed: false,
      scheduledDeletionAt: { $exists: true, $ne: null },
      userId: id,
    },
    { $set: { cancelled: true, cancelledAt: new Date() } },
    { new: true },
  ).lean<DeletionRequestRecord | null>();

  if (!request) {
    throw new AccountDeletionError(
      "There is no deletion request to cancel on this account.",
      "NOT_FOUND",
      404,
    );
  }

  const user = await UserModel.findOneAndUpdate(
    { _id: id },
    { $set: { status: "ACTIVE" } },
    { new: true },
  ).lean<UserRecord | null>();

  await AuditLogModel.create({
    action: "ACCOUNT_DELETION_CANCELLED",
    actorId: id,
    entityType: "User",
    entityId: String(id),
  }).catch(() => {});

  if (user?.email) {
    const email = accountDeletionCancelledEmail({
      loginUrl: appUrl("/login"),
      userName: user.name,
    });

    await sendNotificationEmail({
      action: "account_deletion_cancelled",
      html: email.html,
      subject: email.subject,
      to: user.email,
    }).catch(() => {});
  }

  return { request: serializeRequest(request) };
}

/** The SUPERADMIN queue (PLATFORM_REVIEW requests). */
export async function listAccountDeletionRequests(
  query: { reviewStatus?: string } & PaginationQuery = {
    page: 1,
    pageSize: MAX_PAGE_SIZE,
  },
) {
  await connectToDatabase();

  const filter: Record<string, unknown> = { kind: "PLATFORM_REVIEW" };

  if (query.reviewStatus) {
    filter.reviewStatus = query.reviewStatus;
  }

  const { limit, skip } = paginationRange(query);

  const [requests, total, pending] = await Promise.all([
    AccountDeletionRequestModel.find(filter)
      .sort({ requestedAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean<DeletionRequestRecord[]>(),
    AccountDeletionRequestModel.countDocuments(filter),
    // Counted over the whole queue, not the page — the tab badge would
    // otherwise stop at the page size (API.md §1.4).
    AccountDeletionRequestModel.countDocuments({
      kind: "PLATFORM_REVIEW",
      reviewStatus: "PENDING",
    }),
  ]);

  return {
    pagination: paginationMeta(query, total),
    pendingCount: pending,
    requests: requests.map(serializeRequest),
  };
}

/**
 * A superadmin acting on an owner's request. Approving starts the same 60-day
 * clock a self-service request gets — the owner still has the grace period,
 * they just needed permission to start it.
 */
export async function reviewAccountDeletionRequest(
  requestId: string,
  input: ReviewInput,
  principal: ApiPrincipal,
) {
  await connectToDatabase();

  const request = await AccountDeletionRequestModel.findOne({
    _id: normalizeObjectId(requestId, "request id"),
    kind: "PLATFORM_REVIEW",
  }).lean<(DeletionRequestRecord & { userId: Types.ObjectId }) | null>();

  if (!request) {
    throw new AccountDeletionError("Request was not found.", "NOT_FOUND", 404);
  }

  if (request.reviewStatus !== "PENDING") {
    throw new AccountDeletionError(
      "This request has already been reviewed.",
      "ALREADY_REVIEWED",
      409,
    );
  }

  const approved = input.decision === "APPROVED";
  const now = new Date();
  const scheduledDeletionAt = approved
    ? new Date(now.getTime() + DELETION_GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000)
    : undefined;

  const updated = await AccountDeletionRequestModel.findOneAndUpdate(
    // PENDING in the filter, not only checked above: two superadmins answering
    // at once must not both act on the request.
    { _id: request._id, reviewStatus: "PENDING" },
    {
      $set: {
        // A rejection closes the row so the owner can ask again later; the
        // unique index on userId would otherwise block a second request.
        cancelled: !approved,
        ...(approved ? { scheduledDeletionAt } : { cancelledAt: now }),
        ...(input.note === undefined ? {} : { reviewNote: input.note }),
        reviewStatus: input.decision,
        reviewedAt: now,
        reviewedBy: normalizeObjectId(principal.userId, "user id"),
      },
      $unset: {
        ...(approved ? { cancelledAt: 1 } : { scheduledDeletionAt: 1 }),
        ...(input.note === undefined ? { reviewNote: 1 } : {}),
      },
    },
    { new: true },
  ).lean<DeletionRequestRecord | null>();

  if (!updated) {
    throw new AccountDeletionError(
      "This request has already been reviewed.",
      "ALREADY_REVIEWED",
      409,
    );
  }


  if (approved) {
    await applyImmediateEffects(request.userId);
  }

  await AuditLogModel.create({
    action: approved ? "ACCOUNT_DELETION_APPROVED" : "ACCOUNT_DELETION_REJECTED",
    actorId: normalizeObjectId(principal.userId, "user id"),
    entityType: "User",
    entityId: String(request.userId),
  }).catch(() => {});

  const user = await UserModel.findOne({ _id: request.userId })
    .select("email name")
    .lean<{ email?: string; name?: string } | null>();

  if (user?.email && approved && scheduledDeletionAt) {
    const email = accountDeletionRequestedEmail({
      cancelUrl: await cancelUrlFor(request.userId),
      scheduledDeletionDate: scheduledDeletionAt.toISOString().slice(0, 10),
      userName: user.name,
    });

    await sendNotificationEmail({
      action: "account_deletion_requested",
      html: email.html,
      subject: email.subject,
      to: user.email,
    }).catch(() => {});
  }

  return { request: serializeRequest(updated) };
}
