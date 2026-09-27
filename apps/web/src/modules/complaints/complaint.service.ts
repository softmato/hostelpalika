import { Types } from "mongoose";
import type { z } from "zod";

import type { ApiPrincipal } from "@/lib/api-auth";
import { connectToDatabase } from "@/lib/db";
import {
  MAX_PAGE_SIZE,
  paginationMeta,
  paginationRange,
  type PaginationQuery,
} from "@/lib/pagination";
import { assertHostelAccess } from "@/lib/tenant";
import { AuditLogModel } from "@hostel/db/models/AuditLog";
import { ComplaintAttachmentModel } from "@hostel/db/models/ComplaintAttachment";
import { ComplaintModel } from "@hostel/db/models/Complaint";
import { ComplaintUpdateModel } from "@hostel/db/models/ComplaintUpdate";
import { FileAssetModel } from "@hostel/db/models/FileAsset";
import { complaintTitle } from "@/modules/complaints/complaint-title";
import {
  notifyAdminsOfNewComplaint,
  notifyResidentOfComplaintReply,
  notifyResidentOfComplaintStatus,
} from "@/modules/complaints/complaint-notify";
import { getOperationsConfig } from "@/modules/platform-config/operations-config";
import {
  findCurrentResident,
  normalizeObjectId,
  type ResidentRecord,
  serializeResidentSummary,
} from "@/modules/residents/resident-access";
import type {
  complaintCreateSchema,
  complaintListQuerySchema,
  complaintReplySchema,
  complaintResolutionConfirmSchema,
  complaintStatusUpdateSchema,
} from "@/modules/complaints/complaint.validation";

type ComplaintCreateInput = z.infer<typeof complaintCreateSchema>;
type ComplaintListQuery = z.infer<typeof complaintListQuerySchema>;
type ComplaintStatusUpdateInput = z.infer<typeof complaintStatusUpdateSchema>;
type ComplaintReplyInput = z.infer<typeof complaintReplySchema>;
type ComplaintResolutionConfirmInput = z.infer<typeof complaintResolutionConfirmSchema>;

type ComplaintStatus = "PENDING" | "IN_PROGRESS" | "RESOLVED" | "REJECTED";
type ComplaintCategory =
  | "FOOD"
  | "ROOM"
  | "MAINTENANCE"
  | "SAFETY"
  | "PAYMENT"
  | "STAFF"
  | "NOISE"
  | "OTHER";

type ComplaintRecord = {
  _id: Types.ObjectId;
  adminResponse?: string;
  category: ComplaintCategory;
  confirmedAt?: Date;
  createdAt?: Date;
  createdBy?: Types.ObjectId;
  description?: string;
  hostelId: Types.ObjectId;
  isAnonymous: boolean;
  rejectedAt?: Date;
  residentId: Types.ObjectId;
  resolvedAt?: Date;
  slaBreachedAt?: Date;
  slaDueAt: Date;
  status: ComplaintStatus;
  title: string;
  updatedAt?: Date;
  updatedBy?: Types.ObjectId;
  voiceNoteAssetId?: Types.ObjectId;
};

type ComplaintAttachmentRecord = {
  _id: Types.ObjectId;
  complaintId: Types.ObjectId;
  fileAssetId: string;
  hostelId: Types.ObjectId;
  uploadedAt: Date;
  uploadedBy: Types.ObjectId;
};

type ComplaintUpdateRecord = {
  _id: Types.ObjectId;
  actorId: Types.ObjectId;
  actorRole: string;
  complaintId: Types.ObjectId;
  createdAt?: Date;
  hostelId: Types.ObjectId;
  message?: string;
  nextStatus?: ComplaintStatus;
  previousStatus?: ComplaintStatus;
  type: "CREATED" | "STATUS_CHANGE" | "ADMIN_REPLY" | "RESIDENT_CONFIRMATION";
};

export class ComplaintServiceError extends Error {
  constructor(
    message: string,
    public errorCode = "COMPLAINT_ERROR",
    public status = 400,
  ) {
    super(message);
  }
}

function normalizeObjectIds(values: string[]) {
  return values.map((value) => normalizeObjectId(value, "hostel id"));
}

function resolveAdminHostelId(principal: ApiPrincipal, requestedHostelId?: string) {
  if (requestedHostelId) {
    assertHostelAccess(principal, requestedHostelId);
    return normalizeObjectId(requestedHostelId, "hostel id");
  }

  if (principal.hostelIds.length === 1) {
    return normalizeObjectId(principal.hostelIds[0], "hostel id");
  }

  throw new ComplaintServiceError(
    "A hostelId is required for this hostel admin action.",
    "HOSTEL_SCOPE_REQUIRED",
    422,
  );
}

function scopedHostelFilter(principal: ApiPrincipal, requestedHostelId?: string) {
  if (requestedHostelId) {
    return { hostelId: resolveAdminHostelId(principal, requestedHostelId) };
  }

  return {
    hostelId: {
      $in: normalizeObjectIds(principal.hostelIds),
    },
  };
}

function slaDueDate(slaHours: number, now = new Date()) {
  const dueAt = new Date(now);

  dueAt.setHours(dueAt.getHours() + slaHours);

  return dueAt;
}

function groupByComplaintId<T extends { complaintId: Types.ObjectId }>(records: T[]) {
  const grouped = new Map<string, T[]>();

  for (const record of records) {
    const key = record.complaintId.toString();
    const existing = grouped.get(key) ?? [];

    existing.push(record);
    grouped.set(key, existing);
  }

  return grouped;
}

function serializeAttachment(attachment: ComplaintAttachmentRecord) {
  return {
    complaintId: attachment.complaintId.toString(),
    fileAssetId: attachment.fileAssetId,
    hostelId: attachment.hostelId.toString(),
    id: attachment._id.toString(),
    uploadedAt: attachment.uploadedAt.toISOString(),
    uploadedBy: attachment.uploadedBy.toString(),
  };
}

function serializeUpdate(update: ComplaintUpdateRecord) {
  return {
    actorId: update.actorId.toString(),
    actorRole: update.actorRole,
    complaintId: update.complaintId.toString(),
    createdAt: update.createdAt?.toISOString(),
    hostelId: update.hostelId.toString(),
    id: update._id.toString(),
    message: update.message ?? "",
    nextStatus: update.nextStatus,
    previousStatus: update.previousStatus,
    type: update.type,
  };
}

function serializeComplaint(
  complaint: ComplaintRecord,
  options: {
    attachments?: ComplaintAttachmentRecord[];
    hideResidentIdentity?: boolean;
    updates?: ComplaintUpdateRecord[];
  } = {},
) {
  const hideResidentIdentity = options.hideResidentIdentity && complaint.isAnonymous;

  return {
    adminResponse: complaint.adminResponse ?? "",
    attachments: (options.attachments ?? []).map(serializeAttachment),
    category: complaint.category,
    confirmedAt: complaint.confirmedAt?.toISOString(),
    createdAt: complaint.createdAt?.toISOString(),
    description: complaint.description ?? "",
    hostelId: complaint.hostelId.toString(),
    id: complaint._id.toString(),
    isAnonymous: complaint.isAnonymous,
    isOverdue:
      !["RESOLVED", "REJECTED"].includes(complaint.status) &&
      complaint.slaDueAt.getTime() < Date.now(),
    rejectedAt: complaint.rejectedAt?.toISOString(),
    residentId: hideResidentIdentity ? null : complaint.residentId.toString(),
    resolvedAt: complaint.resolvedAt?.toISOString(),
    slaBreachedAt: complaint.slaBreachedAt?.toISOString(),
    slaDueAt: complaint.slaDueAt.toISOString(),
    status: complaint.status,
    title: complaint.title,
    updatedAt: complaint.updatedAt?.toISOString(),
    updates: (options.updates ?? []).map(serializeUpdate),
    /*
     * The id only. Like every attachment on this payload it is resolved through
     * `files/{assetId}/url`, which is where the reading is authorized — a URL
     * baked in here would be one the serializer had no way to scope.
     */
    voiceNoteAssetId: complaint.voiceNoteAssetId?.toString(),
  };
}

/**
 * Status tallies for the whole filter, not the page.
 *
 * This replaced an in-memory reduce over the returned array. Once the list
 * became paginated that array is one page, so the admin header would have read
 * "20 complaints" no matter how many there really were. Runs against the same
 * filter as the list query, so the two can never disagree.
 */
async function complaintSummaryForFilter(filter: Record<string, unknown>) {
  const openStatuses = ["PENDING", "IN_PROGRESS"];

  const [byStatus, overdue] = await Promise.all([
    ComplaintModel.aggregate<{ _id: string; count: number }>([
      { $match: filter },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]),
    ComplaintModel.countDocuments({
      ...filter,
      slaDueAt: { $lt: new Date() },
      status: { $in: openStatuses },
    }),
  ]);

  const counts = new Map(byStatus.map((row) => [row._id, row.count]));

  return {
    inProgress: counts.get("IN_PROGRESS") ?? 0,
    overdue,
    pending: counts.get("PENDING") ?? 0,
    rejected: counts.get("REJECTED") ?? 0,
    resolved: counts.get("RESOLVED") ?? 0,
    total: [...counts.values()].reduce((sum, count) => sum + count, 0),
  };
}

async function complaintChildren(complaints: ComplaintRecord[]) {
  const complaintIds = complaints.map((complaint) => complaint._id);

  if (complaintIds.length === 0) {
    return {
      attachmentsByComplaintId: new Map<string, ComplaintAttachmentRecord[]>(),
      updatesByComplaintId: new Map<string, ComplaintUpdateRecord[]>(),
    };
  }

  const [attachments, updates] = await Promise.all([
    ComplaintAttachmentModel.find({ complaintId: { $in: complaintIds } })
      .sort({ uploadedAt: -1 })
      .lean<ComplaintAttachmentRecord[]>(),
    ComplaintUpdateModel.find({ complaintId: { $in: complaintIds } })
      .sort({ createdAt: 1 })
      .lean<ComplaintUpdateRecord[]>(),
  ]);

  return {
    attachmentsByComplaintId: groupByComplaintId(attachments),
    updatesByComplaintId: groupByComplaintId(updates),
  };
}

async function auditComplaintAction(
  principal: ApiPrincipal,
  hostelId: Types.ObjectId,
  complaintId: Types.ObjectId,
  action: string,
  metadata: Record<string, unknown> = {},
) {
  await AuditLogModel.create({
    action,
    actorId: principal.userId,
    entityId: complaintId.toString(),
    entityType: "Complaint",
    hostelId,
    metadata,
  });
}

async function addComplaintUpdate(
  complaint: ComplaintRecord,
  principal: ApiPrincipal,
  input: {
    message?: string;
    nextStatus?: ComplaintStatus;
    previousStatus?: ComplaintStatus;
    type: ComplaintUpdateRecord["type"];
  },
) {
  return ComplaintUpdateModel.create({
    actorId: principal.userId,
    actorRole: principal.role,
    complaintId: complaint._id,
    hostelId: complaint.hostelId,
    ...input,
  }) as Promise<ComplaintUpdateRecord>;
}

async function findAdminComplaint(
  complaintId: string,
  principal: ApiPrincipal,
  requestedHostelId?: string,
) {
  const complaint = await ComplaintModel.findOne({
    _id: normalizeObjectId(complaintId, "complaint id"),
    ...scopedHostelFilter(principal, requestedHostelId),
  }).lean<ComplaintRecord | null>();

  if (!complaint) {
    throw new ComplaintServiceError(
      "Complaint was not found.",
      "COMPLAINT_NOT_FOUND",
      404,
    );
  }

  return complaint;
}

async function attachFiles(
  complaint: ComplaintRecord,
  principal: ApiPrincipal,
  attachmentAssetIds: string[],
) {
  return Promise.all(
    attachmentAssetIds.map(
      (fileAssetId) =>
        ComplaintAttachmentModel.create({
          complaintId: complaint._id,
          fileAssetId,
          hostelId: complaint.hostelId,
          uploadedBy: principal.userId,
        }) as Promise<ComplaintAttachmentRecord>,
    ),
  );
}

/**
 * The voice note is checked before it is attached, or the complaint is refused.
 *
 * Same three doors `assertVoiceNoteUsable` closes on the maintenance side, for
 * the same reasons — an asset that never completed may hold no bytes at all, a
 * guessed id must not become readable by being attached to something, and a
 * payment proof must not become a "recording" that staff can open.
 *
 * The one difference is the kind: `COMPLAINT_NOTE`, never `MAINTENANCE_NOTE`.
 * That is not tidiness. `files/{assetId}/url` widens a `MAINTENANCE_NOTE` to the
 * service provider assigned to the job, and a resident recording a complaint
 * about the kitchen staff — possibly anonymously — must not land in a kind whose
 * read rule has an outward-facing branch at all.
 *
 * Throws rather than dropping the id, because a complaint raised silently
 * without the recording that *was* its description is a complaint with nothing
 * in it.
 */
async function assertComplaintVoiceNote(
  assetId: string | undefined,
  hostelId: Types.ObjectId,
  /** The resident filing — only their own recording can be attached. */
  userId: string,
): Promise<Types.ObjectId | undefined> {
  if (!assetId) {
    return undefined;
  }

  const asset = await FileAssetModel.findOne({
    _id: normalizeObjectId(assetId, "voice note id"),
    isDeleted: false,
    status: "ACTIVE",
  }).lean<{
    _id: Types.ObjectId;
    hostelId?: Types.ObjectId;
    kind?: string;
    mimeType?: string;
    ownerId?: Types.ObjectId;
    uploadCompletedAt?: Date;
  } | null>();

  if (!asset || !asset.uploadCompletedAt) {
    throw new ComplaintServiceError(
      "That recording did not finish uploading. Record it again.",
      "VOICE_NOTE_NOT_READY",
      422,
    );
  }

  // Someone else's recording, even from this hostel, is not theirs to file —
  // naming its id would put another resident's voice on this complaint.
  if (
    asset.hostelId?.toString() !== hostelId.toString() ||
    asset.ownerId?.toString() !== userId
  ) {
    throw new ComplaintServiceError(
      "That recording was not found. Record it again.",
      "VOICE_NOTE_NOT_FOUND",
      404,
    );
  }

  if (asset.kind !== "COMPLAINT_NOTE" || !asset.mimeType?.startsWith("audio/")) {
    throw new ComplaintServiceError(
      "A voice note has to be an audio recording.",
      "VOICE_NOTE_INVALID",
      422,
    );
  }

  return asset._id;
}

export async function createComplaint(
  input: ComplaintCreateInput,
  principal: ApiPrincipal,
) {
  await connectToDatabase();

  const resident = await findCurrentResident(principal);
  const { complaintSlaHours } = await getOperationsConfig();
  const voiceNoteAssetId = await assertComplaintVoiceNote(
    input.voiceNoteAssetId,
    resident.hostelId,
    principal.userId,
  );
  const complaint = (await ComplaintModel.create({
    category: input.category,
    createdBy: principal.userId,
    description: input.description,
    hostelId: resident.hostelId,
    isAnonymous: input.isAnonymous,
    residentId: resident._id,
    slaDueAt: slaDueDate(complaintSlaHours),
    status: "PENDING",
    // Derived, because the phone no longer asks for one. See `complaint-title.ts`.
    title: complaintTitle({
      category: input.category,
      description: input.description,
      hasVoiceNote: Boolean(voiceNoteAssetId),
      title: input.title,
    }),
    updatedBy: principal.userId,
    voiceNoteAssetId,
  })) as ComplaintRecord;
  const [attachments, update] = await Promise.all([
    attachFiles(complaint, principal, input.attachmentAssetIds),
    addComplaintUpdate(complaint, principal, {
      message: "Complaint submitted by resident.",
      nextStatus: "PENDING",
      type: "CREATED",
    }),
  ]);

  await auditComplaintAction(
    principal,
    resident.hostelId,
    complaint._id,
    "COMPLAINT_CREATED",
    { category: complaint.category, isAnonymous: complaint.isAnonymous },
  );
  await notifyAdminsOfNewComplaint({
    category: complaint.category,
    complaintId: complaint._id.toString(),
    hostelId: resident.hostelId,
    isAnonymous: complaint.isAnonymous,
    residentName: `${resident.firstName} ${resident.lastName}`.trim(),
    title: complaint.title,
  });

  return {
    complaint: serializeComplaint(complaint, {
      attachments,
      updates: [update],
    }),
    resident: serializeResidentSummary(resident),
  };
}

/**
 * A resident's own complaints.
 *
 * `query` is optional and defaults to a full `MAX_PAGE_SIZE` page so existing
 * callers — including the mobile client, which passes nothing — see exactly the
 * behaviour they had before pagination existed. Pass `{ page }` to walk further
 * back.
 */
export async function listResidentComplaints(
  principal: ApiPrincipal,
  query: PaginationQuery = { page: 1, pageSize: MAX_PAGE_SIZE },
) {
  await connectToDatabase();

  const resident = await findCurrentResident(principal);
  const filter = {
    hostelId: resident.hostelId,
    residentId: resident._id,
  };
  const { limit, skip } = paginationRange(query);

  const [complaints, total] = await Promise.all([
    ComplaintModel.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean<ComplaintRecord[]>(),
    ComplaintModel.countDocuments(filter),
  ]);
  const { attachmentsByComplaintId, updatesByComplaintId } =
    await complaintChildren(complaints);

  return {
    complaints: complaints.map((complaint) =>
      serializeComplaint(complaint, {
        attachments: attachmentsByComplaintId.get(complaint._id.toString()),
        updates: updatesByComplaintId.get(complaint._id.toString()),
      }),
    ),
    pagination: paginationMeta(query, total),
    resident: serializeResidentSummary(resident),
  };
}

/** Statuses that still need something to happen. Mirrors `isOverdue`'s exclusions. */
const OPEN_COMPLAINT_STATUSES: ComplaintStatus[] = ["PENDING", "IN_PROGRESS"];

/**
 * The dashboard's complaints block: how many are still open, and the last few.
 *
 * Takes the resident rather than the principal because the caller already has
 * one, and `findCurrentResident` is a query. Attachments and update threads are
 * deliberately not loaded — the dashboard shows a title and a status, and
 * `complaintChildren` is two more round trips for text nobody renders there.
 *
 * This block used to be the literal `{ openCount: 0, recent: [] }`, which is
 * why the mobile dashboard did not render it at all: a confident zero on a
 * resident who has three open complaints is worse than an absent card.
 */
export async function summarizeResidentComplaints(
  resident: Pick<ResidentRecord, "_id" | "hostelId">,
  limit = 3,
) {
  const filter = { hostelId: resident.hostelId, residentId: resident._id };

  const [recent, openCount] = await Promise.all([
    ComplaintModel.find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean<ComplaintRecord[]>(),
    ComplaintModel.countDocuments({
      ...filter,
      status: { $in: OPEN_COMPLAINT_STATUSES },
    }),
  ]);

  return {
    openCount,
    recent: recent.map((complaint) => ({
      category: complaint.category,
      createdAt: complaint.createdAt?.toISOString(),
      id: complaint._id.toString(),
      isOverdue:
        !["RESOLVED", "REJECTED"].includes(complaint.status) &&
        complaint.slaDueAt.getTime() < Date.now(),
      status: complaint.status,
      title: complaint.title,
    })),
  };
}

export async function listAdminComplaints(
  query: ComplaintListQuery,
  principal: ApiPrincipal,
) {
  await connectToDatabase();

  const filter: Record<string, unknown> = {
    ...scopedHostelFilter(principal, query.hostelId),
  };

  if (query.category) {
    filter.category = query.category;
  }

  if (query.status) {
    filter.status = query.status;
  }

  if (query.sla === "overdue") {
    filter.slaDueAt = { $lt: new Date() };
    filter.status = query.status ?? { $in: ["PENDING", "IN_PROGRESS"] };
  } else if (query.sla === "on_track") {
    filter.$or = [
      { slaDueAt: { $gte: new Date() } },
      { status: { $in: ["RESOLVED", "REJECTED"] } },
    ];
  }

  const { limit, skip } = paginationRange(query);

  const [complaints, total] = await Promise.all([
    ComplaintModel.find(filter)
      .sort({ status: 1, createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean<ComplaintRecord[]>(),
    ComplaintModel.countDocuments(filter),
  ]);
  const { attachmentsByComplaintId, updatesByComplaintId } =
    await complaintChildren(complaints);

  return {
    complaints: complaints.map((complaint) =>
      serializeComplaint(complaint, {
        attachments: attachmentsByComplaintId.get(complaint._id.toString()),
        hideResidentIdentity: true,
        updates: updatesByComplaintId.get(complaint._id.toString()),
      }),
    ),
    pagination: paginationMeta(query, total),
    summary: await complaintSummaryForFilter(filter),
  };
}

export async function updateComplaintStatus(
  complaintId: string,
  input: ComplaintStatusUpdateInput,
  principal: ApiPrincipal,
) {
  await connectToDatabase();

  const complaint = await findAdminComplaint(complaintId, principal, input.hostelId);
  const now = new Date();
  const set: Record<string, unknown> = {
    status: input.status,
    updatedBy: principal.userId,
  };
  const unset: Record<string, ""> = {};

  if (input.response) {
    set.adminResponse = input.response;
  }

  if (input.status === "RESOLVED") {
    set.resolvedAt = now;
    unset.rejectedAt = "";
    unset.confirmedAt = "";
  } else if (input.status === "REJECTED") {
    set.rejectedAt = now;
    unset.resolvedAt = "";
    unset.confirmedAt = "";
  } else {
    unset.resolvedAt = "";
    unset.rejectedAt = "";
    unset.confirmedAt = "";
  }

  const update: Record<string, unknown> = { $set: set };

  if (Object.keys(unset).length > 0) {
    update.$unset = unset;
  }

  const updatedComplaint = await ComplaintModel.findOneAndUpdate(
    { _id: complaint._id },
    update,
    { new: true },
  ).lean<ComplaintRecord | null>();

  if (!updatedComplaint) {
    throw new ComplaintServiceError(
      "Complaint was not found.",
      "COMPLAINT_NOT_FOUND",
      404,
    );
  }

  const timelineUpdate = await addComplaintUpdate(updatedComplaint, principal, {
    message: input.response,
    nextStatus: updatedComplaint.status,
    previousStatus: complaint.status,
    type: "STATUS_CHANGE",
  });

  await auditComplaintAction(
    principal,
    complaint.hostelId,
    complaint._id,
    "COMPLAINT_STATUS_UPDATED",
    { nextStatus: updatedComplaint.status, previousStatus: complaint.status },
  );
  await notifyResidentOfComplaintStatus({
    hostelId: complaint.hostelId,
    residentId: complaint.residentId,
    response: input.response,
    status: updatedComplaint.status,
    title: updatedComplaint.title,
  });

  return {
    complaint: serializeComplaint(updatedComplaint, {
      hideResidentIdentity: true,
      updates: [timelineUpdate],
    }),
  };
}

export async function replyToComplaint(
  complaintId: string,
  input: ComplaintReplyInput,
  principal: ApiPrincipal,
) {
  await connectToDatabase();

  const complaint = await findAdminComplaint(complaintId, principal, input.hostelId);
  const updatedComplaint = await ComplaintModel.findOneAndUpdate(
    { _id: complaint._id },
    {
      $set: {
        adminResponse: input.message,
        updatedBy: principal.userId,
      },
    },
    { new: true },
  ).lean<ComplaintRecord | null>();

  if (!updatedComplaint) {
    throw new ComplaintServiceError(
      "Complaint was not found.",
      "COMPLAINT_NOT_FOUND",
      404,
    );
  }

  const update = await addComplaintUpdate(updatedComplaint, principal, {
    message: input.message,
    type: "ADMIN_REPLY",
  });

  await auditComplaintAction(
    principal,
    complaint.hostelId,
    complaint._id,
    "COMPLAINT_REPLIED",
  );
  // §4.1 only mandates email on a status change, so a reply is in-app only —
  // otherwise a back-and-forth thread would mail the resident on every line.
  await notifyResidentOfComplaintReply({
    hostelId: complaint.hostelId,
    residentId: complaint.residentId,
    title: updatedComplaint.title,
  });

  return {
    complaint: serializeComplaint(updatedComplaint, {
      hideResidentIdentity: true,
      updates: [update],
    }),
  };
}

export async function confirmComplaintResolution(
  complaintId: string,
  input: ComplaintResolutionConfirmInput,
  principal: ApiPrincipal,
) {
  await connectToDatabase();

  const resident = await findCurrentResident(principal);
  const complaint = await ComplaintModel.findOne({
    _id: normalizeObjectId(complaintId, "complaint id"),
    hostelId: resident.hostelId,
    residentId: resident._id,
  }).lean<ComplaintRecord | null>();

  if (!complaint) {
    throw new ComplaintServiceError(
      "Complaint was not found.",
      "COMPLAINT_NOT_FOUND",
      404,
    );
  }

  if (complaint.status !== "RESOLVED") {
    throw new ComplaintServiceError(
      "Only resolved complaints can be confirmed.",
      "COMPLAINT_NOT_RESOLVED",
      409,
    );
  }

  const confirmedComplaint = await ComplaintModel.findOneAndUpdate(
    { _id: complaint._id },
    {
      $set: {
        confirmedAt: new Date(),
        updatedBy: principal.userId,
      },
    },
    { new: true },
  ).lean<ComplaintRecord | null>();

  if (!confirmedComplaint) {
    throw new ComplaintServiceError(
      "Complaint was not found.",
      "COMPLAINT_NOT_FOUND",
      404,
    );
  }

  const update = await addComplaintUpdate(confirmedComplaint, principal, {
    message: input.note,
    type: "RESIDENT_CONFIRMATION",
  });

  await auditComplaintAction(
    principal,
    resident.hostelId,
    complaint._id,
    "COMPLAINT_RESOLUTION_CONFIRMED",
  );

  return {
    complaint: serializeComplaint(confirmedComplaint, {
      updates: [update],
    }),
    resident: serializeResidentSummary(resident),
  };
}
