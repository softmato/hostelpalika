import { Types } from "mongoose";
import type { z } from "zod";

import type { ApiPrincipal } from "@/lib/api-auth";
import { connectToDatabase } from "@/lib/db";
import { REALTIME_TOPIC } from "@/lib/realtime/channels";
import { publishResourceChange } from "@/lib/realtime/server";
import { assertHostelAccess } from "@/lib/tenant";
import {
  notifyProviderOfMaintenanceNote,
  notifyProviderOfAssignment,
  notifyProviderOfStatusChange,
  notifyStaffOfJobProgress,
  notifyStaffOfNewMaintenanceRequest,
} from "@/modules/maintenance/maintenance-notify";
import { AuditLogModel } from "@hostel/db/models/AuditLog";
import { MaintenanceCommentModel } from "@hostel/db/models/MaintenanceComment";
import { MaintenanceHistoryModel } from "@hostel/db/models/MaintenanceHistory";
import { FileAssetModel } from "@hostel/db/models/FileAsset";
import { MaintenanceRequestModel } from "@hostel/db/models/MaintenanceRequest";
import { ServiceProviderModel } from "@hostel/db/models/ServiceProvider";
import { maintenanceCategorySchema } from "@/modules/maintenance/maintenance.validation";
import {
  DEFAULT_MINIMUM_CHARGE,
  getOperationsConfig,
} from "@/modules/platform-config/operations-config";
import type {
  maintenanceCommentCreateSchema,
  maintenanceRequestCreateSchema,
  maintenanceProviderAssignSchema,
  maintenanceRequestListQuerySchema,
  maintenanceStatusUpdateSchema,
} from "@/modules/maintenance/maintenance.validation";

type MaintenanceRequestCreateInput = z.infer<typeof maintenanceRequestCreateSchema>;
type MaintenanceRequestListQuery = z.infer<typeof maintenanceRequestListQuerySchema>;
type MaintenanceStatusUpdateInput = z.infer<typeof maintenanceStatusUpdateSchema>;
type MaintenanceCommentCreateInput = z.infer<typeof maintenanceCommentCreateSchema>;
type MaintenanceProviderAssignInput = z.infer<typeof maintenanceProviderAssignSchema>;

type MaintenanceStatus =
  | "PENDING"
  | "CONTACTED"
  | "SCHEDULED"
  | "COMPLETED"
  | "CANCELLED";

type MaintenanceRequestRecord = {
  _id: Types.ObjectId;
  category: string;
  completedAt?: Date;
  costNote?: string;
  createdAt?: Date;
  description?: string;
  hostelId: Types.ObjectId;
  minimumCharge?: number;
  priority: "LOW" | "MEDIUM" | "HIGH" | "URGENT";
  providerId?: Types.ObjectId;
  remarks?: string;
  requestedBy: Types.ObjectId;
  location?: string;
  scheduledFor?: Date;
  status: MaintenanceStatus;
  title: string;
  updatedAt?: Date;
  voiceNoteAssetId?: Types.ObjectId;
};

type MaintenanceHistoryRecord = {
  _id: Types.ObjectId;
  action: string;
  actorId: Types.ObjectId;
  costNote?: string;
  createdAt?: Date;
  hostelId: Types.ObjectId;
  nextStatus?: MaintenanceStatus;
  note?: string;
  previousStatus?: MaintenanceStatus;
  requestId: Types.ObjectId;
};

type MaintenanceCommentRecord = {
  _id: Types.ObjectId;
  authorId: Types.ObjectId;
  createdAt?: Date;
  hostelId: Types.ObjectId;
  message: string;
  requestId: Types.ObjectId;
  visibility: "INTERNAL" | "PROVIDER_NOTE";
};

type ServiceProviderRecord = {
  _id: Types.ObjectId;
  status: "PENDING_APPROVAL" | "APPROVED" | "REJECTED" | "HIDDEN" | "INACTIVE";
};

export class MaintenanceServiceError extends Error {
  constructor(
    message: string,
    public errorCode = "MAINTENANCE_ERROR",
    public status = 400,
  ) {
    super(message);
  }
}

function normalizeObjectId(value: string, label = "id") {
  if (!Types.ObjectId.isValid(value)) {
    throw new MaintenanceServiceError(`Invalid ${label}.`, "INVALID_OBJECT_ID", 422);
  }

  return new Types.ObjectId(value);
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

  throw new MaintenanceServiceError(
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

function serializeHistory(history: MaintenanceHistoryRecord) {
  return {
    action: history.action,
    actorId: history.actorId.toString(),
    costNote: history.costNote ?? "",
    createdAt: history.createdAt?.toISOString(),
    hostelId: history.hostelId.toString(),
    id: history._id.toString(),
    nextStatus: history.nextStatus,
    note: history.note ?? "",
    previousStatus: history.previousStatus,
    requestId: history.requestId.toString(),
  };
}

function serializeComment(comment: MaintenanceCommentRecord) {
  return {
    authorId: comment.authorId.toString(),
    createdAt: comment.createdAt?.toISOString(),
    hostelId: comment.hostelId.toString(),
    id: comment._id.toString(),
    message: comment.message,
    requestId: comment.requestId.toString(),
    visibility: comment.visibility,
  };
}

function serializeMaintenanceRequest(
  request: MaintenanceRequestRecord,
  options: {
    comments?: MaintenanceCommentRecord[];
    history?: MaintenanceHistoryRecord[];
  } = {},
) {
  return {
    category: request.category,
    comments: (options.comments ?? []).map(serializeComment),
    completedAt: request.completedAt?.toISOString(),
    costNote: request.costNote ?? "",
    createdAt: request.createdAt?.toISOString(),
    description: request.description ?? "",
    history: (options.history ?? []).map(serializeHistory),
    hostelId: request.hostelId.toString(),
    id: request._id.toString(),
    minimumCharge: request.minimumCharge ?? null,
    priority: request.priority,
    providerId: request.providerId?.toString(),
    remarks: request.remarks ?? "",
    requestedBy: request.requestedBy.toString(),
    location: request.location ?? "",
    scheduledFor: request.scheduledFor?.toISOString(),
    status: request.status,
    title: request.title,
    updatedAt: request.updatedAt?.toISOString(),
    /** Absent, not `""` — a screen branches on whether there is one at all. */
    voiceNoteAssetId: request.voiceNoteAssetId?.toString(),
  };
}

async function auditMaintenanceAction(
  principal: ApiPrincipal,
  request: MaintenanceRequestRecord,
  action: string,
  metadata: Record<string, unknown> = {},
) {
  await AuditLogModel.create({
    action,
    actorId: principal.userId,
    entityId: request._id.toString(),
    entityType: "MaintenanceRequest",
    hostelId: request.hostelId,
    metadata,
  });

  // Creation, status change and comment all pass through here, so one publish
  // keeps the admin queue and the resident's request view in step.
  //
  // The assigned service provider is not covered: they are not a member of the
  // hostel, so they are not on its channel, and `request.providerId` is a
  // ServiceProvider id rather than the User id the personal channel is keyed
  // on. Their job list refreshes by polling until that lookup is worth adding.
  await publishResourceChange({
    hostelIds: [request.hostelId.toString()],
    topics: [REALTIME_TOPIC.MAINTENANCE],
  });
}

async function assertProviderApproved(providerId?: string) {
  if (!providerId) {
    return undefined;
  }

  const provider = await ServiceProviderModel.findOne({
    _id: normalizeObjectId(providerId, "service provider id"),
    isDeleted: false,
    status: "APPROVED",
  }).lean<ServiceProviderRecord | null>();

  if (!provider) {
    throw new MaintenanceServiceError(
      "Approved service provider was not found.",
      "SERVICE_PROVIDER_NOT_FOUND",
      404,
    );
  }

  return provider._id;
}

async function addHistory(
  request: MaintenanceRequestRecord,
  principal: ApiPrincipal,
  input: {
    action: string;
    costNote?: string;
    nextStatus?: MaintenanceStatus;
    note?: string;
    previousStatus?: MaintenanceStatus;
  },
) {
  return MaintenanceHistoryModel.create({
    actorId: principal.userId,
    hostelId: request.hostelId,
    requestId: request._id,
    ...input,
  }) as Promise<MaintenanceHistoryRecord>;
}

async function findScopedMaintenanceRequest(
  requestId: string,
  principal: ApiPrincipal,
  requestedHostelId?: string,
) {
  const request = await MaintenanceRequestModel.findOne({
    _id: normalizeObjectId(requestId, "maintenance request id"),
    isDeleted: false,
    ...scopedHostelFilter(principal, requestedHostelId),
  }).lean<MaintenanceRequestRecord | null>();

  if (!request) {
    throw new MaintenanceServiceError(
      "Maintenance request was not found.",
      "MAINTENANCE_REQUEST_NOT_FOUND",
      404,
    );
  }

  return request;
}

async function requestChildren(requests: MaintenanceRequestRecord[]) {
  const requestIds = requests.map((request) => request._id);

  if (requestIds.length === 0) {
    return {
      commentsByRequestId: new Map<string, MaintenanceCommentRecord[]>(),
      historyByRequestId: new Map<string, MaintenanceHistoryRecord[]>(),
    };
  }

  const [comments, histories] = await Promise.all([
    MaintenanceCommentModel.find({ requestId: { $in: requestIds } })
      .sort({ createdAt: -1 })
      .lean<MaintenanceCommentRecord[]>(),
    MaintenanceHistoryModel.find({ requestId: { $in: requestIds } })
      .sort({ createdAt: -1 })
      .lean<MaintenanceHistoryRecord[]>(),
  ]);
  const commentsByRequestId = new Map<string, MaintenanceCommentRecord[]>();
  const historyByRequestId = new Map<string, MaintenanceHistoryRecord[]>();

  for (const comment of comments) {
    const key = comment.requestId.toString();
    const grouped = commentsByRequestId.get(key) ?? [];

    grouped.push(comment);
    commentsByRequestId.set(key, grouped);
  }

  for (const history of histories) {
    const key = history.requestId.toString();
    const grouped = historyByRequestId.get(key) ?? [];

    grouped.push(history);
    historyByRequestId.set(key, grouped);
  }

  return {
    commentsByRequestId,
    historyByRequestId,
  };
}

/**
 * The voice note is checked before it is attached, or it is refused.
 *
 * Three ways a client could hand over an id that would go wrong quietly, and
 * all three are somebody else's failure showing up as a silent one here:
 *
 * - **Not completed.** `uploadCompletedAt` is stamped by `files/{id}/complete`,
 *   which reads the stored object back and checks its bytes against what was
 *   declared. An asset that never completed may have no bytes at all, and the
 *   provider would open a job with a play button that does nothing.
 * - **Another hostel's.** The id is a 24-character string a client supplies; a
 *   guessed one must not become readable by attaching it to a request. Same
 *   rule the finance evidence path already applies.
 * - **Not audio, or not a note.** `MAINTENANCE_NOTE` is the kind
 *   `files/{id}/url` widens to the assigned provider, so attaching a payment
 *   proof here would be the way to hand a contractor a resident's bank
 *   screenshot.
 *
 * Throws rather than dropping the id. A request raised silently without the
 * recording the warden just made is worse than one that fails and can be
 * retried — they would only find out when the plumber rang to ask what the job
 * was.
 */
async function assertVoiceNoteUsable(
  assetId: string | undefined,
  hostelId: Types.ObjectId,
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
    uploadCompletedAt?: Date;
  } | null>();

  if (!asset || !asset.uploadCompletedAt) {
    throw new MaintenanceServiceError(
      "That voice note did not finish uploading. Record it again.",
      "VOICE_NOTE_NOT_READY",
      422,
    );
  }

  if (asset.hostelId?.toString() !== hostelId.toString()) {
    throw new MaintenanceServiceError(
      "That voice note does not belong to this hostel.",
      "VOICE_NOTE_NOT_FOUND",
      404,
    );
  }

  if (asset.kind !== "MAINTENANCE_NOTE" || !asset.mimeType?.startsWith("audio/")) {
    throw new MaintenanceServiceError(
      "A voice note has to be an audio recording.",
      "VOICE_NOTE_INVALID",
      422,
    );
  }

  return asset._id;
}

export async function createMaintenanceRequest(
  input: MaintenanceRequestCreateInput,
  principal: ApiPrincipal,
) {
  await connectToDatabase();

  const hostelId = resolveAdminHostelId(principal, input.hostelId);
  const providerId = await assertProviderApproved(input.providerId);
  const voiceNoteAssetId = await assertVoiceNoteUsable(input.voiceNoteAssetId, hostelId);
  const minimumCharge = await minimumChargeFor(input.category);
  const request = (await MaintenanceRequestModel.create({
    category: input.category,
    costNote: input.costNote,
    minimumCharge,
    createdBy: principal.userId,
    description: input.description,
    hostelId,
    location: input.location,
    priority: input.priority,
    providerId,
    remarks: input.remarks,
    requestedBy: principal.userId,
    scheduledFor: input.scheduledFor,
    status: "PENDING",
    title: input.title,
    updatedBy: principal.userId,
    voiceNoteAssetId,
  })) as MaintenanceRequestRecord;
  const history = await addHistory(request, principal, {
    action: "MAINTENANCE_REQUEST_CREATED",
    nextStatus: "PENDING",
    note: "Maintenance request created.",
  });

  await auditMaintenanceAction(principal, request, "MAINTENANCE_REQUEST_CREATED", {
    category: request.category,
    providerId: request.providerId?.toString(),
    voiceNote: Boolean(voiceNoteAssetId),
  });

  // Everyone else running this hostel, plus the contractor when the raise sheet
  // already named one. Not awaited for its result — the row is saved and the
  // notifier swallows its own failures — but awaited so the serverless
  // invocation is not frozen out from under it.
  await notifyStaffOfNewMaintenanceRequest(request, principal.userId);

  return {
    request: serializeMaintenanceRequest(request, { history: [history] }),
  };
}

export async function listMaintenanceRequests(
  query: MaintenanceRequestListQuery,
  principal: ApiPrincipal,
) {
  await connectToDatabase();

  const filter: Record<string, unknown> = {
    isDeleted: false,
    ...scopedHostelFilter(principal, query.hostelId),
  };

  if (query.category) {
    filter.category = query.category;
  }

  if (query.providerId) {
    filter.providerId = normalizeObjectId(query.providerId, "service provider id");
  }

  if (query.status) {
    filter.status = query.status;
  }

  const requests = await MaintenanceRequestModel.find(filter)
    .sort({ status: 1, createdAt: -1 })
    .limit(150)
    .lean<MaintenanceRequestRecord[]>();
  const { commentsByRequestId, historyByRequestId } = await requestChildren(requests);

  return {
    requests: requests.map((request) =>
      serializeMaintenanceRequest(request, {
        comments: commentsByRequestId.get(request._id.toString()),
        history: historyByRequestId.get(request._id.toString()),
      }),
    ),
    summary: {
      cancelled: requests.filter((request) => request.status === "CANCELLED").length,
      completed: requests.filter((request) => request.status === "COMPLETED").length,
      open: requests.filter((request) =>
        ["PENDING", "CONTACTED", "SCHEDULED"].includes(request.status),
      ).length,
      total: requests.length,
    },
  };
}

export async function updateMaintenanceRequestStatus(
  requestId: string,
  input: MaintenanceStatusUpdateInput,
  principal: ApiPrincipal,
) {
  await connectToDatabase();

  const request = await findScopedMaintenanceRequest(
    requestId,
    principal,
    input.hostelId,
  );
  const set: Record<string, unknown> = {
    status: input.status,
    updatedBy: principal.userId,
  };
  const unset: Record<string, ""> = {};

  if (input.costNote) {
    set.costNote = input.costNote;
  }

  if (input.scheduledFor) {
    set.scheduledFor = input.scheduledFor;
  }

  if (input.status === "COMPLETED") {
    set.completedAt = new Date();
  } else {
    unset.completedAt = "";
  }

  const update: Record<string, unknown> = { $set: set };

  if (Object.keys(unset).length > 0) {
    update.$unset = unset;
  }

  const updatedRequest = await MaintenanceRequestModel.findOneAndUpdate(
    { _id: request._id, isDeleted: false },
    update,
    { new: true },
  ).lean<MaintenanceRequestRecord | null>();

  if (!updatedRequest) {
    throw new MaintenanceServiceError(
      "Maintenance request was not found.",
      "MAINTENANCE_REQUEST_NOT_FOUND",
      404,
    );
  }

  const history = await addHistory(updatedRequest, principal, {
    action: "MAINTENANCE_STATUS_UPDATED",
    costNote: input.costNote,
    nextStatus: updatedRequest.status,
    note: input.note,
    previousStatus: request.status,
  });

  await auditMaintenanceAction(principal, updatedRequest, "MAINTENANCE_STATUS_UPDATED", {
    nextStatus: updatedRequest.status,
    previousStatus: request.status,
  });

  /*
   * The contractor is told what the hostel decided. Cancellation is the one
   * that has to arrive: it means "do not travel", and it is worth nothing after
   * they already have.
   *
   * The rest of the desk is told too, and the actor is excluded inside the
   * notifier — a warden who just clicked "scheduled" does not need telling.
   */
  await notifyProviderOfStatusChange({
    previousStatus: request.status,
    request: updatedRequest,
  });
  await notifyStaffOfJobProgress({
    actorUserId: principal.userId,
    previousStatus: request.status,
    providerName: "The hostel",
    request: updatedRequest,
  });

  return {
    request: serializeMaintenanceRequest(updatedRequest, { history: [history] }),
  };
}

/**
 * Sending a raised request to a contractor.
 *
 * ## Why this exists now and did not before
 *
 * The provider used to be picked on the raise sheet and could never be changed,
 * and this file said so: *a request that went to the wrong person is cancelled
 * and raised again*. On 2026-09-02 the picker was taken off that sheet — asking
 * a warden reporting a leak to choose a contractor is asking them to make a
 * judgement about somebody's availability that they cannot make — which would
 * otherwise have left **no** path to a provider at all, and a permanently empty
 * provider job list.
 *
 * ## Assign once, still
 *
 * The original rule is kept rather than quietly dropped: this refuses a request
 * that already has somebody on it. Re-pointing a live job is a decision with a
 * person's wasted trip on the other end of it, and it stays a cancel-and-raise.
 * What changed is only *when* the one assignment happens, not how many there
 * are.
 *
 * A closed request is refused too — sending a contractor to a job somebody
 * already finished is the same mistake in a different order.
 */
export async function assignMaintenanceProvider(
  requestId: string,
  input: MaintenanceProviderAssignInput,
  principal: ApiPrincipal,
) {
  await connectToDatabase();

  const request = await findScopedMaintenanceRequest(
    requestId,
    principal,
    input.hostelId,
  );

  if (request.providerId) {
    throw new MaintenanceServiceError(
      "This request already has somebody assigned. Cancel it and raise a new one to change who is coming.",
      "MAINTENANCE_ALREADY_ASSIGNED",
      409,
    );
  }

  if (request.status === "CANCELLED" || request.status === "COMPLETED") {
    throw new MaintenanceServiceError(
      "This request is closed, so nobody can be assigned to it.",
      "MAINTENANCE_REQUEST_CLOSED",
      409,
    );
  }

  const providerId = await assertProviderApproved(input.providerId);

  const updatedRequest = await MaintenanceRequestModel.findOneAndUpdate(
    // Pinned to "still unassigned", so two taps racing cannot both win and the
    // loser is reported rather than silently overwriting the winner.
    { _id: request._id, isDeleted: false, providerId: { $exists: false } },
    { $set: { providerId, updatedBy: principal.userId } },
    { new: true },
  ).lean<MaintenanceRequestRecord | null>();

  if (!updatedRequest) {
    throw new MaintenanceServiceError(
      "This request already has somebody assigned.",
      "MAINTENANCE_ALREADY_ASSIGNED",
      409,
    );
  }

  const history = await addHistory(updatedRequest, principal, {
    action: "MAINTENANCE_PROVIDER_ASSIGNED",
    note: "Assigned to a service provider.",
  });

  await auditMaintenanceAction(
    principal,
    updatedRequest,
    "MAINTENANCE_PROVIDER_ASSIGNED",
    { providerId: providerId?.toString() },
  );

  /*
   * The point of the whole feature. Until this line a job "sent to a
   * contractor" sat in a list waiting for that contractor to open the app of
   * their own accord — which for a trade that schedules its day in the morning
   * means the leak keeps leaking until they happen to look.
   */
  await notifyProviderOfAssignment(updatedRequest);

  return {
    request: serializeMaintenanceRequest(updatedRequest, { history: [history] }),
  };
}

export async function addMaintenanceComment(
  requestId: string,
  input: MaintenanceCommentCreateInput,
  principal: ApiPrincipal,
) {
  await connectToDatabase();

  const request = await findScopedMaintenanceRequest(
    requestId,
    principal,
    input.hostelId,
  );
  const comment = (await MaintenanceCommentModel.create({
    authorId: principal.userId,
    hostelId: request.hostelId,
    message: input.message,
    requestId: request._id,
    visibility: input.visibility,
  })) as MaintenanceCommentRecord;

  await addHistory(request, principal, {
    action: "MAINTENANCE_COMMENT_ADDED",
    note: input.message,
  });
  await auditMaintenanceAction(principal, request, "MAINTENANCE_COMMENT_ADDED");

  /*
   * INTERNAL notes stay inside the hostel. The visibility flag exists precisely
   * so a desk can talk about a contractor without talking to them, and a
   * notifier that ignored it would be the fastest possible way to send an
   * internal remark to its subject.
   */
  if (input.visibility !== "INTERNAL") {
    await notifyProviderOfMaintenanceNote({ body: input.message, request });
  }

  return {
    comment: serializeComment(comment),
    request: serializeMaintenanceRequest(request),
  };
}

/* -------------------------------------------------------------------------- */
/* Settings — what a call-out of each trade costs                             */
/* -------------------------------------------------------------------------- */

export type MinimumCharge = { amount: number; category: string };

/**
 * All eleven trades at the platform's call-out minimum.
 *
 * Set by the superadmin in operations config, not per hostel — see
 * `maintenanceMinimumCharges` there for why a hostel cannot edit its own.
 */
async function resolveMinimumCharges(): Promise<MinimumCharge[]> {
  const { maintenanceMinimumCharges } = await getOperationsConfig();

  return maintenanceCategorySchema.options.map((category) => ({
    amount: maintenanceMinimumCharges[category] ?? DEFAULT_MINIMUM_CHARGE,
    category,
  }));
}

async function minimumChargeFor(category: string) {
  const charges = await resolveMinimumCharges();

  return charges.find((row) => row.category === category)?.amount ?? DEFAULT_MINIMUM_CHARGE;
}

/** The hostel's minimum fee per trade — always all eleven, never blank. */
export async function getMaintenanceSettings(
  principal: ApiPrincipal,
  requestedHostelId?: string,
) {
  await connectToDatabase();

  const hostelId = resolveAdminHostelId(principal, requestedHostelId);

  return {
    hostelId: hostelId.toString(),
    minimumCharges: await resolveMinimumCharges(),
  };
}

