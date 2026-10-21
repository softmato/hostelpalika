import { Types } from "mongoose";
import type { z } from "zod";

import type { ApiPrincipal } from "@/lib/api-auth";
import { connectToDatabase } from "@/lib/db";
import { REALTIME_TOPIC } from "@/lib/realtime/channels";
import { publishResourceChange } from "@/lib/realtime/server";
import { getPresignedReadUrl, privateBucket, putToR2, readFromR2, withKeyPrefix } from "@/lib/r2";
import { Role } from "@/lib/roles";
import { hostelCalendarDay } from "@hostel/shared/calendar/bs";
import { safeEntryName, toReadableStream, zipStream, type ZipEntry } from "@/lib/zip-stream";
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
import { FileAssetModel } from "@hostel/db/models/FileAsset";
import { HostelModel } from "@hostel/db/models/Hostel";
import { HostelLeaveRequestModel } from "@hostel/db/models/HostelLeaveRequest";
import { HostelSubscriptionModel } from "@hostel/db/models/HostelSubscription";
import { StoreOrderModel } from "@hostel/db/models/StoreOrder";
import { SubscriptionInvoiceModel } from "@hostel/db/models/SubscriptionInvoice";
import { SubscriptionPaymentModel } from "@hostel/db/models/SubscriptionPayment";
import { UserModel } from "@hostel/db/models/User";
import { leaveFileGroup, type HostelLeaveSection } from "@hostel/shared/constants/hostel-leave";
import type { EmailAttachment } from "@hostel/shared/email/sender";
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

/**
 * How long the original files stay downloadable after leaving — the agreement's
 * point 9 ("ask us ... within 30 days after"). A fact of the signed agreement,
 * not a setting: changing it means changing the agreement first.
 */
export const LEAVE_FILES_DAYS = 30;

/** The files window: 30 days from leaving, or the hold if that is longer. **Pure.** */
export function leaveFilesUntil(approvedAt: Date, holdDays: number) {
  return new Date(approvedAt.getTime() + Math.max(LEAVE_FILES_DAYS, holdDays) * DAY_MS);
}

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
  exportFiles?: HeldFileRow[];
  exportSentTo?: string;
  fileLinkCount?: number;
  fileLinkDay?: string;
  filesUntil?: Date;
  holdDays: number;
  holdUntil?: Date;
  hostelId: Types.ObjectId;
  hostelName: string;
  keptFiles?: HeldFileRow[];
  ownerEmail?: string;
  ownerId?: Types.ObjectId;
  ownerName?: string;
  reason: string;
  reclaimedAt?: Date;
  requestedAt: Date;
  requestedBy: Types.ObjectId;
  reviewNote?: string;
  reviewedAt?: Date;
  status: "APPROVED" | "CANCELLED" | "PENDING" | "RECLAIMED" | "REJECTED";
  zipDownloads?: Array<{ at: Date; part: number }>;
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
    const filesUntil = leaveFilesUntil(now, request.holdDays);
    const email = hostelLeaveApprovedEmail({
      claimUrl: appUrl("/hostel-leave"),
      filesUntil,
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
          filesUntil,
          holdUntil,
          ...(hostel.ownerId ? { ownerId: hostel.ownerId } : {}),
          ...(input.note ? { reviewNote: input.note } : {}),
          status: "APPROVED",
        },
      },
      { new: true },
    ).lean<LeaveRequestRow | null>();

    // Kept for the files page; the email already carried them, so a failure here waits for the backfill.
    if (exported) await storeExportFiles(request._id, exported.attachments).catch(() => []);

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

  const now = new Date();
  const [claimable, downloadable] = await Promise.all([
    claimableRequests(userId, now),
    downloadableRequests(userId, now),
  ]);
  const canClaim = new Set(claimable.map((row) => row._id.toString()));

  // Every request whose files are still out, claimable ones first.
  return {
    hostels: downloadable
      .map((row) => serializeHeld(row, canClaim.has(row._id.toString())))
      .sort((a, b) => Number(b.canClaim) - Number(a.canClaim)),
  };
}

function serializeHeld(row: LeaveRequestRow, canClaim = true) {
  return {
    canClaim,
    filesUntil: (row.filesUntil ?? row.holdUntil)!.toISOString(),
    holdDays: row.holdDays,
    holdUntil: row.holdUntil!.toISOString(),
    hostelName: row.hostelName,
    requestId: row._id.toString(),
  };
}

/**
 * Requests whose original files this account may still download: approved,
 * inside the files window, and owned by this person — by the owner recorded at
 * approval, since once the hostel is erased there is no hostel row to ask.
 * Requests approved before `filesUntil` existed fall back to the hold.
 */
async function downloadableRequests(userId: string, now: Date) {
  const identities = [...(await ownerIdentitiesFor(userId))].map((id) => new Types.ObjectId(id));

  return HostelLeaveRequestModel.find({
    $and: [
      { $or: [{ ownerId: { $in: identities } }, { ownerId: { $exists: false }, requestedBy: { $in: identities } }] },
      { $or: [{ filesUntil: { $gt: now } }, { filesUntil: { $exists: false }, holdUntil: { $gt: now } }] },
    ],
    status: "APPROVED",
  })
    .sort({ filesUntil: 1 })
    .lean<LeaveRequestRow[]>();
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

/* ── Owner: the original files ─────────────────────────────────────────── */

/**
 * The hostel's uploaded files, handed back as the agreement's point 9 promises
 * ("the original files") — while the hold runs, to the signed-in owner only.
 *
 * Never a lasting URL: one file opens through a 15-minute presigned link (the
 * private bucket's rule), and "download everything" streams the bytes through
 * this server into a ZIP, so the object keys never leave it.
 */
/**
 * Bandwidth caps. A ZIP streams through this server, so each part may be
 * downloaded this many times in any 24 hours; a single file comes straight
 * from R2 on a presigned link, so those are only capped per day against abuse.
 */
export const LEAVE_ZIP_DOWNLOADS_PER_DAY = 3;
/** Files requested from R2 ahead of the one streaming into the ZIP. */
const LEAVE_ZIP_PREFETCH = 6;
export const LEAVE_FILE_LINKS_PER_DAY = 200;

/** ZIP downloads of `part` still allowed in the 24 hours up to `now`. **Pure.** */
export function zipDownloadsLeft(log: Array<{ at: Date | string; part: number }> | undefined, part: number, now = new Date()) {
  const since = now.getTime() - DAY_MS;
  const used = (log ?? []).filter((entry) => entry.part === part && new Date(entry.at).getTime() > since).length;

  return Math.max(0, LEAVE_ZIP_DOWNLOADS_PER_DAY - used);
}

/** File links still allowed today (Nepal day). **Pure.** */
export function fileLinksLeft(request: { fileLinkCount?: number; fileLinkDay?: string }, today: string) {
  return request.fileLinkDay === today
    ? Math.max(0, LEAVE_FILE_LINKS_PER_DAY - (request.fileLinkCount ?? 0))
    : LEAVE_FILE_LINKS_PER_DAY;
}

const nepalDay = (now: Date) => hostelCalendarDay(now).toISOString().slice(0, 10);

// ponytail: a part is at most this many bytes, so one ZIP fits in a request's
// time; a hostel with more gets Part 1, Part 2… rather than one bigger archive.
export const LEAVE_ZIP_PART_BYTES = 200 * 1024 * 1024;

type HeldFileRow = {
  _id: Types.ObjectId;
  bucket?: string;
  createdAt?: Date;
  fileName?: string;
  hostelId?: Types.ObjectId;
  key?: string;
  kind?: string;
  mimeType?: string;
  sizeBytes?: number;
};

/** Splits files, in order, into parts of at most `limit` bytes. **Pure.** */
export function partitionBySize<T extends { sizeBytes?: number }>(files: T[], limit = LEAVE_ZIP_PART_BYTES) {
  const parts: T[][] = [];
  let current: T[] = [];
  let bytes = 0;

  for (const file of files) {
    const size = file.sizeBytes ?? 0;

    // A file bigger than a part goes on its own rather than being refused.
    if (current.length > 0 && bytes + size > limit) {
      parts.push(current);
      current = [];
      bytes = 0;
    }

    current.push(file);
    bytes += size;
  }

  if (current.length > 0) parts.push(current);

  return parts;
}

/** Every original file of a request the caller may still claim, oldest first. */
async function heldFiles(userId: string, requestId: string) {
  await connectToDatabase();

  const id = normalizeObjectId(requestId);
  const request = (await downloadableRequests(userId, new Date())).find((row) => row._id.equals(id));

  if (!request) {
    throw new HostelServiceError(
      `These files are no longer available — they are kept for ${LEAVE_FILES_DAYS} days after leaving.`,
      "LEAVE_FILES_NOT_AVAILABLE",
      404,
    );
  }

  const records = request.exportFiles?.length ? request.exportFiles : await backfillExportFiles(request);

  // Buildings not yet erased still have their rows; an erased one's originals
  // are listed on the request (`keptFiles`, written by the purge).
  const live = await FileAssetModel.find({
    bucket: { $exists: true, $ne: "" },
    hostelId: { $in: [request.hostelId, ...(request.branchIds ?? [])] },
    isDeleted: { $ne: true },
    key: { $exists: true, $ne: "" },
  })
    .sort({ createdAt: 1 })
    .select("bucket createdAt fileName hostelId key kind mimeType sizeBytes")
    .lean<HeldFileRow[]>();
  const seen = new Set(live.map((file) => file._id.toString()));
  const uploads = [...live, ...(request.keptFiles ?? []).filter((file) => !seen.has(file._id.toString()))];
  // Grouped as the ZIP's folders and the list's headings are, oldest first inside each.
  const files = [...records.map((file) => ({ ...file, kind: "RECORDS" })), ...uploads].sort(
    (a, b) =>
      leaveFileGroup(a.kind).order - leaveFileGroup(b.kind).order ||
      (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0),
  );

  return { files, request };
}

/**
 * Keeps the approval's workbook and JSON in our private storage, so they
 * download with the files after the hostel's rows are gone. Best effort: the
 * owner already has them by email, and a request without them is backfilled on
 * the next look while the hostel still exists.
 */
async function storeExportFiles(requestId: Types.ObjectId, attachments: EmailAttachment[]) {
  const now = new Date();
  const stored: Array<Omit<HeldFileRow, "_id">> = [];

  for (const file of attachments) {
    const key = withKeyPrefix(`hostel-leave/${requestId.toString()}/${file.filename}`);
    const mimeType = file.filename.endsWith(".json")
      ? "application/json"
      : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

    await putToR2(privateBucket(), key, file.content, mimeType);
    stored.push({ bucket: privateBucket(), createdAt: now, fileName: file.filename, key, mimeType, sizeBytes: file.content.length });
  }

  const updated = await HostelLeaveRequestModel.findOneAndUpdate(
    { _id: requestId },
    { $set: { exportFiles: stored } },
    { new: true },
  ).lean<LeaveRequestRow | null>();

  return updated?.exportFiles ?? [];
}

/** A request approved before the workbook was kept: build it now, if its hostel still exists. */
async function backfillExportFiles(request: LeaveRequestRow) {
  const sections = (request.exportSections ?? []) as HostelLeaveSection[];
  const hostel = sections.length
    ? await HostelModel.findById(request.hostelId).select("slug").lean<{ slug?: string } | null>()
    : null;

  if (!hostel) return [];

  try {
    const exported = await buildLeaveExport([request.hostelId, ...(request.branchIds ?? [])], sections, hostel.slug ?? "");

    return await storeExportFiles(request._id, exported.attachments);
  } catch {
    return [];
  }
}

/** `GET /account/hostel-leave/{id}/files` — the list, its size and its ZIP parts. */
export async function listHeldFiles(userId: string, requestId: string) {
  const { files, request } = await heldFiles(userId, requestId);
  const parts = partitionBySize(files);

  return {
    files: files.map((file) => ({
      group: leaveFileGroup(file.kind).label,
      id: file._id.toString(),
      kind: file.kind ?? null,
      name: file.fileName ?? "file",
      sizeBytes: file.sizeBytes ?? 0,
      uploadedAt: file.createdAt?.toISOString() ?? null,
    })),
    filesUntil: (request.filesUntil ?? request.holdUntil)?.toISOString() ?? null,
    holdUntil: request.holdUntil?.toISOString() ?? null,
    hostelName: request.hostelName,
    fileLinksLeft: fileLinksLeft(request, nepalDay(new Date())),
    parts: parts.map((part, index) => ({
      bytes: part.reduce((sum, file) => sum + (file.sizeBytes ?? 0), 0),
      files: part.length,
      left: zipDownloadsLeft(request.zipDownloads, index + 1),
      part: index + 1,
    })),
    totalBytes: files.reduce((sum, file) => sum + (file.sizeBytes ?? 0), 0),
  };
}

/** `GET /account/hostel-leave/{id}/files/{fileId}` — a 15-minute link to one file. */
export async function heldFileUrl(userId: string, requestId: string, fileId: string) {
  const { files, request } = await heldFiles(userId, requestId);
  const file = files.find((row) => row._id.toString() === fileId);

  if (!file?.bucket || !file.key) {
    throw new HostelServiceError("File not found.", "FILE_NOT_FOUND", 404);
  }

  // Counted in one write: a new day starts the count again, and a full day refuses.
  const today = nepalDay(new Date());
  const counted = await HostelLeaveRequestModel.updateOne(
    {
      $or: [{ fileLinkDay: { $ne: today } }, { fileLinkCount: { $lt: LEAVE_FILE_LINKS_PER_DAY } }],
      _id: request._id,
    },
    [
      {
        $set: {
          fileLinkCount: { $cond: [{ $eq: ["$fileLinkDay", today] }, { $add: [{ $ifNull: ["$fileLinkCount", 0] }, 1] }, 1] },
          fileLinkDay: today,
        },
      },
    ],
  );

  if (counted.modifiedCount === 0) {
    throw new HostelServiceError(
      `That is ${LEAVE_FILE_LINKS_PER_DAY} files today. Download the rest tomorrow, or take them all as one ZIP.`,
      "LEAVE_FILE_LINKS_EXHAUSTED",
      429,
    );
  }

  return getPresignedReadUrl(file.bucket, file.key);
}

/** Folder inside the ZIP: by what the file was, so 400 photos do not bury one PAN card. **Pure.** */
function folderFor(kind?: string) {
  return safeEntryName(leaveFileGroup(kind).label);
}

/**
 * `GET /account/hostel-leave/{id}/files/zip?part=N` — one part as a ZIP stream.
 * A file R2 cannot read is skipped and named in `missing-files.txt` at the end,
 * so one lost object never costs the owner the other four hundred.
 */
export async function heldFilesZip(userId: string, requestId: string, part: number) {
  const { files, request } = await heldFiles(userId, requestId);
  const parts = partitionBySize(files);
  const chosen = parts[part - 1];

  if (!chosen) {
    throw new HostelServiceError("That part does not exist.", "LEAVE_FILES_PART_NOT_FOUND", 404);
  }

  const now = new Date();

  if (zipDownloadsLeft(request.zipDownloads, part, now) === 0) {
    throw new HostelServiceError(
      `You have downloaded this ${LEAVE_ZIP_DOWNLOADS_PER_DAY} times today. You can download it again tomorrow.`,
      "LEAVE_ZIP_DOWNLOADS_EXHAUSTED",
      429,
    );
  }

  // Counted when the download starts. Entries older than a day are dropped as
  // the log is rewritten, so it never grows past a day of downloads.
  // ponytail: read-then-write, so two clicks in the same instant can both pass.
  await HostelLeaveRequestModel.updateOne(
    { _id: request._id },
    {
      $set: {
        zipDownloads: [
          ...(request.zipDownloads ?? []).filter((entry) => new Date(entry.at).getTime() > now.getTime() - DAY_MS),
          { at: now, part },
        ],
      },
    },
  );

  const used = new Set<string>();
  const missing: string[] = [];

  async function* entries(): AsyncGenerator<ZipEntry> {
    // Fetched ahead: while one file streams into the ZIP, the next few are
    // already on their way, so 400 files do not wait 400 round trips to R2.
    // A failure is held as `null` rather than thrown, so it cannot stop the rest.
    const fetchFile = (file: HeldFileRow) =>
      readFromR2(file.bucket!, file.key!).catch(() => null);
    const queue = chosen!.slice(0, LEAVE_ZIP_PREFETCH).map(fetchFile);

    for (const [index, file] of chosen!.entries()) {
      const next = chosen![index + LEAVE_ZIP_PREFETCH];

      if (next) queue.push(fetchFile(next));

      const data = await queue.shift()!;
      const base = safeEntryName(file.fileName ?? "file");
      const folder = folderFor(file.kind);
      let name = `${folder}/${base}`;

      // Two files called IMG_0001.jpg both arrive, the second as "IMG_0001 (2).jpg".
      for (let copy = 2; used.has(name.toLowerCase()); copy += 1) {
        const dot = base.lastIndexOf(".");
        name = `${folder}/${dot > 0 ? `${base.slice(0, dot)} (${copy})${base.slice(dot)}` : `${base} (${copy})`}`;
      }

      if (!data) {
        missing.push(`${name} (uploaded ${file.createdAt?.toISOString().slice(0, 10) ?? "unknown"})`);
        continue;
      }

      used.add(name.toLowerCase());
      yield { data, date: file.createdAt ?? new Date(), name };
    }

    if (missing.length > 0) {
      const note = `These files could not be read from storage and are not in this ZIP:\n\n${missing.join("\n")}\n`;

      yield {
        data: (async function* () {
          yield new TextEncoder().encode(note);
        })(),
        date: new Date(),
        name: "missing-files.txt",
      };
    }
  }

  const slug = safeEntryName(request.hostelName).toLowerCase().replace(/\s+/g, "-");

  return {
    filename: parts.length > 1 ? `${slug}-files-part-${part}-of-${parts.length}.zip` : `${slug}-files.zip`,
    stream: toReadableStream(zipStream(entries())),
  };
}
