import { Types } from "mongoose";
import type { z } from "zod";

import type { ApiPrincipal } from "@/lib/api-auth";
import { connectToDatabase } from "@/lib/db";
import { REALTIME_TOPIC } from "@/lib/realtime/channels";
import { publishResourceChange } from "@/lib/realtime/server";
import { Role } from "@/lib/roles";
import { billingHostelId } from "@/modules/billing/billing-hostel";
import { ownerIdentitiesFor, resolveOwnedHostel } from "@/modules/billing/subscription-access";
import { outstandingFor } from "@/modules/billing/subscription.service";
import { buildLeaveExport } from "@/modules/hostels/hostel-leave-export";
import type {
  hostelLeaveApproveSchema,
  hostelLeaveRejectSchema,
  hostelLeaveSubmitSchema,
} from "@/modules/hostels/hostel-leave.validation";
import { notifyHostelOwnerOf } from "@/modules/hostels/hostel-notify";
import {
  archivePlatformHostel,
  HostelServiceError,
  normalizeObjectId,
  resolveAdminHostelId,
  restorePlatformHostel,
} from "@/modules/hostels/hostel.service";
import { createInAppNotification } from "@/modules/notifications/notification.service";
import { getOperationsConfig } from "@/modules/platform-config/operations-config";
import { appUrl, sendNotificationEmail } from "@/modules/residents/resident-notify";
import { AuditLogModel } from "@hostel/db/models/AuditLog";
import { HostelModel } from "@hostel/db/models/Hostel";
import { HostelLeaveRequestModel } from "@hostel/db/models/HostelLeaveRequest";
import { HostelSubscriptionModel } from "@hostel/db/models/HostelSubscription";
import { StoreOrderModel } from "@hostel/db/models/StoreOrder";
import { SubscriptionInvoiceModel } from "@hostel/db/models/SubscriptionInvoice";
import { SubscriptionPaymentModel } from "@hostel/db/models/SubscriptionPayment";
import { UserModel } from "@hostel/db/models/User";
import type { HostelLeaveSection } from "@hostel/shared/constants/hostel-leave";
import {
  hostelLeaveApprovedEmail,
  hostelLeavePendingEmail,
  hostelLeaveRejectedEmail,
  hostelLeaveRequestedEmail,
  hostelReclaimedEmail,
} from "@hostel/shared/email/templates/hostel/hostel-leave";

/**
 * Leaving the platform (docs/HOSTEL_LEAVE_PLATFORM.md).
 *
 * The owner asks once their plan bills are cleared; a superadmin approves,
 * choosing what data is emailed back. Approval is the existing archive with the
 * owner's chosen hold as its grace period, so everything that already respects
 * `isDeleted` — the public site, every portal, the renewal sweep — drops the
 * hostel in one write, and the `hostel-purge` cron erases it when the hold ends.
 * Until then the owner can claim it back, which is the archive's restore.
 */

type SubmitInput = z.infer<typeof hostelLeaveSubmitSchema>;
type ApproveInput = z.infer<typeof hostelLeaveApproveSchema>;
type RejectInput = z.infer<typeof hostelLeaveRejectSchema>;

const DAY_MS = 24 * 60 * 60 * 1000;

export type LeaveBlocker = {
  code: "PLAN_BILL_OPEN" | "PLAN_CLAIM_IN_REVIEW" | "PLAN_PAST_DUE" | "STORE_ORDER_OPEN";
  message: string;
};

type LeaveFacts = {
  claimInReview: boolean;
  openStoreOrders: number;
  owed: number;
  pastDue: boolean;
};

type LeaveRequestRow = {
  _id: Types.ObjectId;
  branchIds?: Types.ObjectId[];
  exportSections?: string[];
  exportSentAt?: Date;
  exportSentTo?: string;
  holdDays: number;
  holdUntil?: Date;
  hostelId: Types.ObjectId;
  hostelName: string;
  ownerEmail?: string;
  ownerName?: string;
  reason: string;
  reclaimedAt?: Date;
  requestedAt: Date;
  requestedBy: Types.ObjectId;
  reviewNote?: string;
  reviewedAt?: Date;
  status: "APPROVED" | "CANCELLED" | "PENDING" | "RECLAIMED" | "REJECTED";
};

type HostelRow = {
  _id: Types.ObjectId;
  isDeleted?: boolean;
  name?: string;
  ownerId?: Types.ObjectId;
  parentHostelId?: Types.ObjectId | null;
  purgeScheduledAt?: Date;
  slug?: string;
};

/** Plain words for whatever still stands between the hostel and leaving. **Pure.** */
export function leaveBlockers(facts: LeaveFacts): LeaveBlocker[] {
  const blockers: LeaveBlocker[] = [];

  if (facts.claimInReview) {
    blockers.push({
      code: "PLAN_CLAIM_IN_REVIEW",
      message: "We are still checking a plan payment you sent. You can leave once it is confirmed.",
    });
  } else if (facts.owed > 0) {
    blockers.push({
      code: "PLAN_BILL_OPEN",
      message: `Your plan bill of Rs ${facts.owed.toLocaleString("en-IN")} is not paid yet. Pay it on Billing first.`,
    });
  } else if (facts.pastDue) {
    blockers.push({ code: "PLAN_PAST_DUE", message: "Your plan is overdue. Pay it on Billing first." });
  }

  if (facts.openStoreOrders > 0) {
    blockers.push({
      code: "STORE_ORDER_OPEN",
      message:
        facts.openStoreOrders === 1
          ? "You have a supply store order that is not delivered and paid yet."
          : `You have ${facts.openStoreOrders} supply store orders that are not delivered and paid yet.`,
    });
  }

  return blockers;
}

/** The hold the owner may pick, from Platform → Operations. */
export async function leaveHoldBounds() {
  const config = await getOperationsConfig();

  return { max: config.leaveHoldMaxDays, min: config.leaveHoldMinDays };
}

/** Live branches of a main hostel — they leave with it. A branch has none. */
async function liveBranches(hostel: HostelRow) {
  if (hostel.parentHostelId) return [];

  return HostelModel.find({ isDeleted: { $ne: true }, parentHostelId: hostel._id })
    .select("_id name")
    .lean<Array<{ _id: Types.ObjectId; name?: string }>>();
}

type OpenBill = { kind?: string; lifetime?: boolean; outstanding: number };
type PlanState = { currentPeriodEnd?: Date | null; lifetimeSince?: Date | null; status?: string } | null;

/**
 * What of the open plan bills is actually owed. **Pure.**
 *
 * A bill is a debt only when it pays for time the hostel has already had. A
 * setup fee always is. A plan bill is only once the plan has lapsed — overdue,
 * or its paid period over — because while the plan is paid ahead an open bill
 * is an offer the owner has not taken up: a renewal raised early, an upgrade,
 * a lifetime-deal checkout. Leaving simply means not taking it. A lifetime
 * checkout never is: it buys future time, so it is never what lapsed.
 */
export function owedOnPlan(bills: OpenBill[], plan: PlanState, now = new Date()) {
  const lapsed =
    plan?.status === "PAST_DUE" ||
    (plan?.status === "ACTIVE" &&
      !plan.lifetimeSince &&
      Boolean(plan.currentPeriodEnd) &&
      new Date(plan.currentPeriodEnd!).getTime() < now.getTime());

  return bills
    .filter((bill) => bill.kind === "SETUP_FEE" || (lapsed && !bill.lifetime))
    .reduce((sum, bill) => sum + bill.outstanding, 0);
}

/**
 * What the hostel still owes us. Plan bills live on the billing hostel (a
 * branch's are its main's); store orders on each building that is leaving.
 */
async function loadLeaveFacts(hostelId: Types.ObjectId, buildingIds: Types.ObjectId[]): Promise<LeaveFacts> {
  const billing = await billingHostelId(hostelId);
  const [invoices, subscription, openStoreOrders] = await Promise.all([
    SubscriptionInvoiceModel.find({ hostelId: billing, status: { $in: ["OPEN", "PARTIAL"] } })
      .select("_id amount kind lifetime")
      .lean<Array<{ _id: Types.ObjectId; amount: number; kind?: string; lifetime?: boolean }>>(),
    HostelSubscriptionModel.findOne({ hostelId: billing })
      .select("status currentPeriodEnd lifetimeSince")
      .lean<PlanState>(),
    StoreOrderModel.countDocuments({
      $or: [
        { status: { $nin: ["DELIVERED", "CANCELLED"] } },
        { paymentStatus: "PENDING", status: "DELIVERED" },
      ],
      hostelId: { $in: buildingIds },
    }),
  ]);

  const bills = await Promise.all(
    invoices.map(async (invoice) => ({ ...invoice, outstanding: (await outstandingFor(invoice)).outstanding })),
  );
  const owed = owedOnPlan(bills, subscription);
  const claimInReview =
    owed > 0 &&
    Boolean(
      await SubscriptionPaymentModel.exists({
        invoiceId: { $in: invoices.map((invoice) => invoice._id) },
        status: "IN_REVIEW",
      }),
    );

  return { claimInReview, openStoreOrders, owed, pastDue: subscription?.status === "PAST_DUE" };
}

function serializeRequest(row: LeaveRequestRow) {
  return {
    branchCount: row.branchIds?.length ?? 0,
    exportSections: row.exportSections ?? [],
    exportSentAt: row.exportSentAt?.toISOString() ?? null,
    exportSentTo: row.exportSentTo ?? null,
    holdDays: row.holdDays,
    holdUntil: row.holdUntil?.toISOString() ?? null,
    hostelId: row.hostelId.toString(),
    hostelName: row.hostelName,
    id: row._id.toString(),
    ownerEmail: row.ownerEmail ?? null,
    ownerName: row.ownerName ?? null,
    reason: row.reason,
    reclaimedAt: row.reclaimedAt?.toISOString() ?? null,
    requestedAt: row.requestedAt.toISOString(),
    reviewNote: row.reviewNote ?? null,
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
    status: row.status,
  };
}

async function audit(actorId: string, hostelId: Types.ObjectId, action: string, metadata: Record<string, unknown>) {
  await AuditLogModel.create({
    action,
    actorId,
    entityId: hostelId.toString(),
    entityType: "Hostel",
    hostelId,
    metadata,
  }).catch(() => {});
}

/* ── Owner: the form ───────────────────────────────────────────────────── */

async function ownedHostelFor(principal: ApiPrincipal, requestedHostelId?: string) {
  const hostelId = resolveAdminHostelId(principal, requestedHostelId);

  // Only the owner: a warden runs the hostel, it is not theirs to take away.
  await resolveOwnedHostel(hostelId.toString(), principal.userId);

  const hostel = await HostelModel.findById(hostelId)
    .select("name slug ownerId parentHostelId")
    .lean<HostelRow | null>();

  if (!hostel) throw new HostelServiceError("Hostel was not found.", "HOSTEL_NOT_FOUND", 404);

  return hostel;
}

/** `GET /hostel-admin/leave` — can this hostel leave, and is a request already waiting? */
export async function getLeaveOverview(principal: ApiPrincipal, requestedHostelId?: string) {
  await connectToDatabase();

  const hostel = await ownedHostelFor(principal, requestedHostelId);
  const branches = await liveBranches(hostel);
  const [facts, hold, pending] = await Promise.all([
    loadLeaveFacts(hostel._id, [hostel._id, ...branches.map((branch) => branch._id)]),
    leaveHoldBounds(),
    HostelLeaveRequestModel.findOne({ hostelId: hostel._id, status: "PENDING" }).lean<LeaveRequestRow | null>(),
  ]);
  const blockers = leaveBlockers(facts);

  return {
    blockers,
    branches: branches.map((branch) => ({ id: branch._id.toString(), name: branch.name ?? "" })),
    canLeave: blockers.length === 0 && !pending,
    hold,
    hostel: { id: hostel._id.toString(), isBranch: Boolean(hostel.parentHostelId), name: hostel.name ?? "" },
    request: pending ? serializeRequest(pending) : null,
  };
}

/** Our team, by email and the bell. Approving is a superadmin's call alone. */
async function notifyPlatformOfLeave(request: LeaveRequestRow) {
  const staff = await UserModel.find({ isDeleted: { $ne: true }, role: Role.SUPERADMIN, status: "ACTIVE" })
    .select("_id email")
    .lean<Array<{ _id: Types.ObjectId; email?: string }>>();
  const email = hostelLeavePendingEmail({
    holdDays: request.holdDays,
    hostelName: request.hostelName,
    ownerEmail: request.ownerEmail,
    ownerName: request.ownerName,
    queueUrl: appUrl(`/platform/hostel-leaves?request=${request._id.toString()}`),
    reason: request.reason,
  });

  await Promise.all(
    staff.map(async (member) => {
      if (member.email) {
        await sendNotificationEmail({ action: "platform_hostel_leave", html: email.html, subject: email.subject, to: member.email });
      }

      await createInAppNotification({
        actionUrl: `/platform/hostel-leaves?request=${request._id.toString()}`,
        body: `${request.hostelName} asked to leave HostelPalika.`,
        category: "HOSTEL_APPROVAL",
        data: { hostelId: request.hostelId.toString(), requestId: request._id.toString() },
        kind: "ACTION",
        priority: "HIGH",
        title: "Hostel wants to leave",
        userId: member._id.toString(),
      }).catch(() => {});
    }),
  );

  await publishResourceChange({ platform: true, topics: [REALTIME_TOPIC.HOSTELS] }).catch(() => {});
}

/** `POST /hostel-admin/leave` — send the request, bills permitting. */
export async function submitLeaveRequest(principal: ApiPrincipal, input: SubmitInput) {
  await connectToDatabase();

  const hostel = await ownedHostelFor(principal, input.hostelId);
  const branches = await liveBranches(hostel);
  const [facts, hold] = await Promise.all([
    loadLeaveFacts(hostel._id, [hostel._id, ...branches.map((branch) => branch._id)]),
    leaveHoldBounds(),
  ]);
  const blockers = leaveBlockers(facts);

  if (blockers.length > 0) {
    throw new HostelServiceError(blockers[0]!.message, blockers[0]!.code, 409);
  }

  if (input.holdDays < hold.min || input.holdDays > hold.max) {
    throw new HostelServiceError(
      `Choose between ${hold.min} and ${hold.max} days.`,
      "LEAVE_HOLD_OUT_OF_RANGE",
      422,
    );
  }

  const owner = await UserModel.findById(hostel.ownerId ?? principal.userId)
    .select("email name")
    .lean<{ email?: string; name?: string } | null>();

  let created: LeaveRequestRow;

  try {
    created = (
      await HostelLeaveRequestModel.create({
        holdDays: input.holdDays,
        hostelId: hostel._id,
        hostelName: hostel.name ?? "",
        ownerEmail: owner?.email,
        ownerName: owner?.name,
        reason: input.reason,
        requestedBy: new Types.ObjectId(principal.userId),
      })
    ).toObject() as LeaveRequestRow;
  } catch (error) {
    if ((error as { code?: number }).code === 11000) {
      throw new HostelServiceError("A request to leave is already waiting for review.", "LEAVE_ALREADY_PENDING", 409);
    }

    throw error;
  }

  await audit(principal.userId, hostel._id, "HOSTEL_LEAVE_REQUESTED", {
    holdDays: input.holdDays,
    requestId: created._id.toString(),
  });

  await notifyPlatformOfLeave(created).catch(() => {});

  if (owner?.email) {
    const email = hostelLeaveRequestedEmail({
      holdDays: input.holdDays,
      hostelName: created.hostelName,
      ownerName: owner.name,
      pageUrl: appUrl("/hostel-admin/leave"),
    });

    await sendNotificationEmail({ action: "hostel_leave_requested", html: email.html, subject: email.subject, to: owner.email });
  }

  return serializeRequest(created);
}

/** `DELETE /hostel-admin/leave` — take a waiting request back. */
export async function cancelLeaveRequest(principal: ApiPrincipal, requestedHostelId?: string) {
  await connectToDatabase();

  const hostel = await ownedHostelFor(principal, requestedHostelId);
  const cancelled = await HostelLeaveRequestModel.findOneAndUpdate(
    { hostelId: hostel._id, reviewedAt: { $exists: false }, status: "PENDING" },
    { $set: { cancelledAt: new Date(), status: "CANCELLED" } },
    { new: true },
  ).lean<LeaveRequestRow | null>();

  if (!cancelled) {
    throw new HostelServiceError("There is no waiting request to cancel.", "LEAVE_NOT_PENDING", 409);
  }

  await audit(principal.userId, hostel._id, "HOSTEL_LEAVE_CANCELLED", { requestId: cancelled._id.toString() });
  await publishResourceChange({ platform: true, topics: [REALTIME_TOPIC.HOSTELS] }).catch(() => {});

  return serializeRequest(cancelled);
}

/* ── Platform: the queue ───────────────────────────────────────────────── */

export async function listHostelLeaveRequests(status: string) {
  await connectToDatabase();

  // ponytail: one unpaged read of at most 200 — leaving hostels are rare; page by requestedAt if not.
  const rows = await HostelLeaveRequestModel.find(status === "ALL" ? {} : { status })
    .sort({ requestedAt: -1 })
    .limit(200)
    .lean<LeaveRequestRow[]>();

  return { requests: rows.map(serializeRequest) };
}

export async function getHostelLeaveRequest(requestId: string) {
  await connectToDatabase();

  const request = await HostelLeaveRequestModel.findById(normalizeObjectId(requestId)).lean<LeaveRequestRow | null>();

  if (!request) throw new HostelServiceError("Request was not found.", "LEAVE_NOT_FOUND", 404);

  const hostel = await HostelModel.findById(request.hostelId)
    .select("name slug ownerId parentHostelId isDeleted purgeScheduledAt createdAt")
    .lean<(HostelRow & { createdAt?: Date }) | null>();
  const branches = hostel && request.status === "PENDING" ? await liveBranches(hostel) : [];
  const blockers =
    hostel && request.status === "PENDING"
      ? leaveBlockers(await loadLeaveFacts(hostel._id, [hostel._id, ...branches.map((branch) => branch._id)]))
      : [];

  return {
    blockers,
    branches: branches.map((branch) => ({ id: branch._id.toString(), name: branch.name ?? "" })),
    hostel: hostel
      ? {
          erased: false,
          id: hostel._id.toString(),
          isArchived: Boolean(hostel.isDeleted),
          isBranch: Boolean(hostel.parentHostelId),
          since: hostel.createdAt?.toISOString() ?? null,
          slug: hostel.slug ?? null,
        }
      : { erased: true },
    request: serializeRequest(request),
  };
}

/**
 * Approve: re-check the bills, email the data, then archive.
 *
 * The data goes first. If the email cannot be sent nothing is deleted and the
 * request goes back to waiting — the owner's copy matters more than the speed.
 * `reviewedAt` is set as a claim before any of it, so two superadmins pressing
 * Approve at once send one email and archive once.
 */
export async function approveHostelLeaveRequest(requestId: string, input: ApproveInput, principal: ApiPrincipal) {
  await connectToDatabase();

  const now = new Date();
  const request = await HostelLeaveRequestModel.findOneAndUpdate(
    { _id: normalizeObjectId(requestId), reviewedAt: { $exists: false }, status: "PENDING" },
    { $set: { reviewedAt: now, reviewedBy: new Types.ObjectId(principal.userId) } },
    { new: true },
  ).lean<LeaveRequestRow | null>();

  if (!request) {
    throw new HostelServiceError("This request is not waiting for review.", "LEAVE_NOT_PENDING", 409);
  }

  const release = () =>
    HostelLeaveRequestModel.updateOne(
      { _id: request._id, status: "PENDING" },
      { $unset: { reviewedAt: "", reviewedBy: "" } },
    );

  try {
    const hostel = await HostelModel.findOne({ _id: request.hostelId, isDeleted: { $ne: true } })
      .select("name slug ownerId parentHostelId")
      .lean<HostelRow | null>();

    if (!hostel) throw new HostelServiceError("This hostel is already off the platform.", "HOSTEL_NOT_FOUND", 404);

    const branches = await liveBranches(hostel);
    const buildingIds = [hostel._id, ...branches.map((branch) => branch._id)];
    const blockers = leaveBlockers(await loadLeaveFacts(hostel._id, buildingIds));

    if (blockers.length > 0) {
      throw new HostelServiceError(`Not yet: ${blockers[0]!.message}`, blockers[0]!.code, 409);
    }

    const owner = await UserModel.findById(hostel.ownerId)
      .select("email name role")
      .lean<{ _id: Types.ObjectId; email?: string; name?: string; role?: Role } | null>();
    const to = owner?.email || request.ownerEmail;

    if (!to) {
      throw new HostelServiceError("The owner has no email to send the data to.", "LEAVE_NO_OWNER_EMAIL", 422);
    }

    const sections = input.sections as HostelLeaveSection[];
    const exported = sections.length > 0 ? await buildLeaveExport(buildingIds, sections, hostel.slug ?? "") : null;
    const holdUntil = new Date(now.getTime() + request.holdDays * DAY_MS);
    const email = hostelLeaveApprovedEmail({
      claimUrl: appUrl("/hostel-leave"),
      files: exported?.attachments.map((file) => file.filename) ?? [],
      sheets: exported?.sheets.map((sheet) => sheet.label) ?? [],
      holdUntil,
      hostelName: request.hostelName,
      ownerName: owner?.name ?? request.ownerName,
    });
    const sent = await sendNotificationEmail({
      action: "hostel_leave_approved",
      attachments: exported?.attachments ?? [],
      html: email.html,
      subject: email.subject,
      to,
    });

    if (!sent) {
      throw new HostelServiceError(
        "Could not email the data to the owner. Nothing was deleted — try again.",
        "LEAVE_EXPORT_NOT_SENT",
        502,
      );
    }

    // Branches first, the main hostel last: until the main one is archived the
    // request still reads as waiting on a live hostel, and Approve can be retried.
    const reason = `Owner asked to leave: ${request.reason}`.slice(0, 1000);

    // Recorded before archiving, so a retry after a half-finished run still
    // knows every branch it took — the claim-back restores exactly these.
    await HostelLeaveRequestModel.updateOne(
      { _id: request._id },
      { $addToSet: { branchIds: { $each: branches.map((branch) => branch._id) } } },
    );

    for (const building of [...branches.map((branch) => branch._id), hostel._id]) {
      await archivePlatformHostel(building.toString(), { reason }, principal, {
        graceDays: request.holdDays,
        // The owner stays signed in; their next token refresh carries the public role.
        keepSignedIn: owner ? [owner._id] : [],
      });
    }

    // The archive took the hostel off the owner's account. With no hostel left
    // they are a public account again, which is where the claim-back card lives.
    if (owner && owner.role === Role.HOSTEL_ADMIN) {
      await UserModel.updateOne(
        { _id: owner._id, hostelIds: { $size: 0 }, role: Role.HOSTEL_ADMIN },
        { $set: { role: Role.PUBLIC } },
      );
    }

    const approved = await HostelLeaveRequestModel.findOneAndUpdate(
      { _id: request._id },
      {
        $set: {
          exportSections: sections,
          exportSentAt: new Date(),
          exportSentTo: to,
          holdUntil,
          ...(input.note ? { reviewNote: input.note } : {}),
          status: "APPROVED",
        },
      },
      { new: true },
    ).lean<LeaveRequestRow | null>();

    await audit(principal.userId, hostel._id, "HOSTEL_LEAVE_APPROVED", {
      branches: branches.length,
      holdUntil: holdUntil.toISOString(),
      requestId: request._id.toString(),
      sections,
      truncated: exported?.sheets.filter((sheet) => sheet.truncated).map((sheet) => sheet.key) ?? [],
    });

    return {
      sheets: exported?.sheets ?? [],
      request: serializeRequest(approved ?? request),
    };
  } catch (error) {
    await release();
    throw error;
  }
}

export async function rejectHostelLeaveRequest(requestId: string, input: RejectInput, principal: ApiPrincipal) {
  await connectToDatabase();

  const request = await HostelLeaveRequestModel.findOneAndUpdate(
    { _id: normalizeObjectId(requestId), reviewedAt: { $exists: false }, status: "PENDING" },
    {
      $set: {
        reviewNote: input.note,
        reviewedAt: new Date(),
        reviewedBy: new Types.ObjectId(principal.userId),
        status: "REJECTED",
      },
    },
    { new: true },
  ).lean<LeaveRequestRow | null>();

  if (!request) {
    throw new HostelServiceError("This request is not waiting for review.", "LEAVE_NOT_PENDING", 409);
  }

  await audit(principal.userId, request.hostelId, "HOSTEL_LEAVE_REJECTED", { requestId: request._id.toString() });

  if (request.ownerEmail) {
    const email = hostelLeaveRejectedEmail({ hostelName: request.hostelName, note: input.note, ownerName: request.ownerName });

    await sendNotificationEmail({ action: "hostel_leave_rejected", html: email.html, subject: email.subject, to: request.ownerEmail });
  }

  await notifyHostelOwnerOf(request.requestedBy, request.hostelId, {
    actionUrl: "/hostel-admin/leave",
    body: input.note,
    title: "Request to leave not approved",
    type: "HOSTEL_LEAVE",
  });

  return serializeRequest(request);
}

/* ── Owner: claiming back ──────────────────────────────────────────────── */

/** Held hostels this account owns and can still claim back. */
async function claimableRequests(userId: string, now: Date) {
  const identities = [...(await ownerIdentitiesFor(userId))].map((id) => new Types.ObjectId(id));
  const owned = await HostelModel.find({ isDeleted: true, ownerId: { $in: identities } })
    .select("_id")
    .lean<Array<{ _id: Types.ObjectId }>>();

  if (owned.length === 0) return [];

  return HostelLeaveRequestModel.find({
    holdUntil: { $gt: now },
    hostelId: { $in: owned.map((row) => row._id) },
    status: "APPROVED",
  })
    .sort({ holdUntil: 1 })
    .lean<LeaveRequestRow[]>();
}

/** `GET /account/hostel-leave` — the claim-back card. Empty for nearly everyone. */
export async function listHeldHostels(userId: string) {
  await connectToDatabase();

  const rows = await claimableRequests(userId, new Date());

  return { hostels: rows.map(serializeHeld) };
}

function serializeHeld(row: LeaveRequestRow) {
  return {
    holdDays: row.holdDays,
    holdUntil: row.holdUntil!.toISOString(),
    hostelName: row.hostelName,
    requestId: row._id.toString(),
  };
}

/**
 * The held hostel behind a portal address, for its own owner only — what the
 * portal layout shows in place of a 404 (a deleted portal, and how long is
 * left to claim it). Anyone else still gets the 404: we never confirm another
 * account's hostel exists.
 */
export async function heldHostelForSlug(userId: string, slug: string) {
  await connectToDatabase();

  const hostel = await HostelModel.findOne({ isDeleted: true, slug }).select("_id").lean<{ _id: Types.ObjectId } | null>();

  if (!hostel) return null;

  const row = (await claimableRequests(userId, new Date())).find((request) => request.hostelId.equals(hostel._id));

  return row ? serializeHeld(row) : null;
}

/**
 * `POST /account/hostel-leave` — claim it back. Status flips first, as the
 * claim; the restores are idempotent (an already live building is skipped), so
 * if one fails the status goes back and pressing again finishes the job.
 */
export async function reclaimHostel(principal: ApiPrincipal, requestId: string) {
  await connectToDatabase();

  const now = new Date();
  const id = normalizeObjectId(requestId);
  const mine = (await claimableRequests(principal.userId, now)).some((row) => row._id.equals(id));

  if (!mine) {
    throw new HostelServiceError(
      "This hostel cannot be claimed back — its hold has ended or it is not yours.",
      "RECLAIM_NOT_AVAILABLE",
      409,
    );
  }

  const request = await HostelLeaveRequestModel.findOneAndUpdate(
    { _id: id, holdUntil: { $gt: now }, status: "APPROVED" },
    { $set: { reclaimedAt: now, status: "RECLAIMED" } },
    { new: true },
  ).lean<LeaveRequestRow | null>();

  if (!request) {
    throw new HostelServiceError("This hostel was already claimed back.", "RECLAIM_NOT_AVAILABLE", 409);
  }

  try {
    // Branches first, the main hostel last — the reverse of approval.
    for (const building of [...(request.branchIds ?? []), request.hostelId]) {
      const row = await HostelModel.findById(building).select("isDeleted").lean<{ isDeleted?: boolean } | null>();

      if (row?.isDeleted) await restorePlatformHostel(building.toString(), principal);
    }
  } catch (error) {
    await HostelLeaveRequestModel.updateOne(
      { _id: request._id, status: "RECLAIMED" },
      { $set: { status: "APPROVED" }, $unset: { reclaimedAt: "" } },
    );
    throw error;
  }

  // Restore put the hostel back on the owner's account; the portal role comes with it.
  const hostel = await HostelModel.findById(request.hostelId).select("ownerId slug").lean<HostelRow | null>();
  const owner = hostel?.ownerId
    ? await UserModel.findOneAndUpdate(
        { _id: hostel.ownerId, role: Role.PUBLIC },
        { $set: { role: Role.HOSTEL_ADMIN } },
        { new: true },
      )
        .select("email name")
        .lean<{ email?: string; name?: string } | null>()
    : null;

  await audit(principal.userId, request.hostelId, "HOSTEL_LEAVE_RECLAIMED", { requestId: request._id.toString() });

  const to = owner?.email || request.ownerEmail;

  if (to) {
    const email = hostelReclaimedEmail({
      hostelName: request.hostelName,
      ownerName: owner?.name ?? request.ownerName,
      portalUrl: appUrl(hostel?.slug ? `/${hostel.slug}/admin/dashboard` : "/hostel-admin/dashboard"),
    });

    await sendNotificationEmail({ action: "hostel_reclaimed", html: email.html, subject: email.subject, to });
  }

  return { hostelId: request.hostelId.toString(), request: serializeRequest(request) };
}
