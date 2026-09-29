import { Types } from "mongoose";
import type { z } from "zod";

import type { ApiPrincipal } from "@/lib/api-auth";
import { connectToDatabase } from "@/lib/db";
import { assertHostelAccess } from "@/lib/tenant";
import { AuditLogModel } from "@hostel/db/models/AuditLog";
import { DepositRefundModel } from "@hostel/db/models/DepositRefund";
import { MoveInChecklistModel } from "@hostel/db/models/MoveInChecklist";
import { MoveOutChecklistModel } from "@hostel/db/models/MoveOutChecklist";
import { ProvidedItemModel } from "@hostel/db/models/ProvidedItem";
import { outstandingForResident } from "@/modules/finance/ledger-read.service";
import { ResidentModel } from "@hostel/db/models/Resident";
import { releaseBedForRoomType } from "@/modules/hostels/hostel-capacity.service";
import { releaseResidentAccount } from "@/modules/residents/live-residency";
import { notifyMoveOutCompleted } from "@/modules/move-checklist/move-out-notify";
import {
  findCurrentResident,
  normalizeObjectId,
  serializeResidentSummary,
} from "@/modules/residents/resident-access";
import type {
  moveInChecklistSchema,
  moveOutChecklistSchema,
} from "@/modules/move-checklist/move-checklist.validation";

type MoveInInput = z.infer<typeof moveInChecklistSchema>;
type MoveOutInput = z.infer<typeof moveOutChecklistSchema>;

type ResidentRecord = {
  _id: Types.ObjectId;
  depositAmount: number;
  email?: string;
  firstName: string;
  hostelId: Types.ObjectId;
  lastName: string;
  moveInDate: Date;
  phone: string;
  roomType: string;
  status: "PENDING" | "ACTIVE" | "SUSPENDED" | "MOVED_OUT";
  updatedAt?: Date;
  userId?: Types.ObjectId;
};

type MoveInRecord = {
  _id: Types.ObjectId;
  bedCondition?: string;
  completedAt?: Date;
  depositAmount: number;
  documentsCollected: string[];
  hostelId: Types.ObjectId;
  itemsProvided: string[];
  residentId: Types.ObjectId;
  roomCondition?: string;
  roomPhotoAssetIds: string[];
  rulesAccepted: boolean;
};

type MoveOutRecord = {
  _id: Types.ObjectId;
  completedAt?: Date;
  damageNotes?: string;
  depositRefundAmount: number;
  depositRefundDecision: "PENDING" | "APPROVED" | "PARTIAL" | "FORFEITED";
  finalReceiptAssetId?: string;
  hostelId: Types.ObjectId;
  itemReturnNotes?: string;
  pendingFeeAmount: number;
  residentId: Types.ObjectId;
};

export class MoveChecklistServiceError extends Error {
  constructor(
    message: string,
    public errorCode = "MOVE_CHECKLIST_ERROR",
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

  throw new MoveChecklistServiceError(
    "A hostelId is required for this hostel admin action.",
    "HOSTEL_SCOPE_REQUIRED",
    422,
  );
}

function scopedHostelFilter(principal: ApiPrincipal, requestedHostelId?: string) {
  if (requestedHostelId) {
    return { hostelId: resolveAdminHostelId(principal, requestedHostelId) };
  }

  return { hostelId: { $in: normalizeObjectIds(principal.hostelIds) } };
}

async function findAdminResident(
  residentId: string,
  principal: ApiPrincipal,
  requestedHostelId?: string,
) {
  const resident = await ResidentModel.findOne({
    _id: normalizeObjectId(residentId, "resident id"),
    isDeleted: false,
    ...scopedHostelFilter(principal, requestedHostelId),
  }).lean<ResidentRecord | null>();

  if (!resident) {
    throw new MoveChecklistServiceError(
      "Resident was not found.",
      "RESIDENT_NOT_FOUND",
      404,
    );
  }

  return resident;
}

function serializeMoveIn(checklist: MoveInRecord | null) {
  if (!checklist) {
    return null;
  }

  return {
    bedCondition: checklist.bedCondition ?? "",
    completedAt: checklist.completedAt?.toISOString(),
    depositAmount: checklist.depositAmount,
    documentsCollected: checklist.documentsCollected,
    hostelId: checklist.hostelId.toString(),
    id: checklist._id.toString(),
    itemsProvided: checklist.itemsProvided,
    residentId: checklist.residentId.toString(),
    roomCondition: checklist.roomCondition ?? "",
    roomPhotoAssetIds: checklist.roomPhotoAssetIds,
    rulesAccepted: checklist.rulesAccepted,
  };
}

function serializeMoveOut(checklist: MoveOutRecord | null) {
  if (!checklist) {
    return null;
  }

  return {
    completedAt: checklist.completedAt?.toISOString(),
    damageNotes: checklist.damageNotes ?? "",
    depositRefundAmount: checklist.depositRefundAmount,
    depositRefundDecision: checklist.depositRefundDecision,
    finalReceiptAssetId: checklist.finalReceiptAssetId ?? "",
    hostelId: checklist.hostelId.toString(),
    id: checklist._id.toString(),
    itemReturnNotes: checklist.itemReturnNotes ?? "",
    pendingFeeAmount: checklist.pendingFeeAmount,
    residentId: checklist.residentId.toString(),
  };
}

async function auditMoveAction(
  principal: ApiPrincipal,
  hostelId: Types.ObjectId,
  residentId: Types.ObjectId,
  action: string,
  metadata: Record<string, unknown> = {},
) {
  await AuditLogModel.create({
    action,
    actorId: principal.userId,
    entityId: residentId.toString(),
    entityType: "ResidentMoveChecklist",
    hostelId,
    metadata,
  });
}

async function pendingFeeAmount(resident: ResidentRecord) {
  // Through the ledger facade (ADR-3) so the move-out snapshot keeps working
  // unchanged when the source flips from Payment to Invoice + PaymentEvent.
  return outstandingForResident({
    hostelId: resident.hostelId,
    residentId: resident._id,
  });
}

/**
 * A resident's own move-in / move-out record, read-only (PHASES.md §4.1).
 * Scoped by `findCurrentResident`, so there is no id to tamper with — the
 * session decides whose checklist this is.
 */
export async function getResidentMoveChecklists(principal: ApiPrincipal) {
  await connectToDatabase();

  const resident = (await findCurrentResident(principal)) as ResidentRecord;
  const [moveIn, moveOut] = await Promise.all([
    MoveInChecklistModel.findOne({
      hostelId: resident.hostelId,
      residentId: resident._id,
    }).lean<MoveInRecord | null>(),
    MoveOutChecklistModel.findOne({
      hostelId: resident.hostelId,
      residentId: resident._id,
    }).lean<MoveOutRecord | null>(),
  ]);

  return {
    moveIn: serializeMoveIn(moveIn),
    moveOut: serializeMoveOut(moveOut),
    resident: serializeResidentSummary(resident),
  };
}

export async function createMoveInChecklist(
  residentId: string,
  input: MoveInInput,
  principal: ApiPrincipal,
) {
  await connectToDatabase();

  const resident = await findAdminResident(residentId, principal, input.hostelId);
  const checklist = await MoveInChecklistModel.findOneAndUpdate(
    { hostelId: resident.hostelId, residentId: resident._id },
    {
      $set: {
        ...input,
        completedAt: new Date(),
        completedBy: principal.userId,
        createdBy: principal.userId,
        hostelId: resident.hostelId,
        residentId: resident._id,
        updatedBy: principal.userId,
      },
    },
    { new: true, upsert: true },
  ).lean<MoveInRecord>();

  if (!checklist) {
    throw new MoveChecklistServiceError(
      "Move-in checklist could not be saved.",
      "MOVE_IN_SAVE_FAILED",
      500,
    );
  }

  await ProvidedItemModel.deleteMany({ checklistId: checklist._id });
  if (input.itemsProvided.length > 0) {
    await ProvidedItemModel.insertMany(
      input.itemsProvided.map((name) => ({
        checklistId: checklist._id,
        hostelId: resident.hostelId,
        name,
        residentId: resident._id,
      })),
    );
  }

  await auditMoveAction(principal, resident.hostelId, resident._id, "MOVE_IN_COMPLETED");

  return {
    checklist: serializeMoveIn(checklist),
    resident: serializeResidentSummary(resident),
  };
}

export async function getMoveInChecklist(
  residentId: string,
  principal: ApiPrincipal,
  hostelId?: string,
) {
  await connectToDatabase();

  const resident = await findAdminResident(residentId, principal, hostelId);
  const checklist = await MoveInChecklistModel.findOne({
    hostelId: resident.hostelId,
    residentId: resident._id,
  }).lean<MoveInRecord | null>();

  return {
    checklist: serializeMoveIn(checklist),
    resident: serializeResidentSummary(resident),
  };
}

export async function createMoveOutChecklist(
  residentId: string,
  input: MoveOutInput,
  principal: ApiPrincipal,
) {
  await connectToDatabase();

  const resident = await findAdminResident(residentId, principal, input.hostelId);

  // The amount follows the decision, so "full refund" cannot go out as zero
  // and "kept" cannot carry a refund; only a partial one is typed in.
  if (input.depositRefundDecision === "PARTIAL" && input.depositRefundAmount > resident.depositAmount) {
    throw new MoveChecklistServiceError(
      "A partial refund cannot be more than the deposit held.",
      "REFUND_OVER_DEPOSIT",
    );
  }

  const depositRefundAmount =
    input.depositRefundDecision === "APPROVED"
      ? resident.depositAmount
      : input.depositRefundDecision === "PARTIAL"
        ? input.depositRefundAmount
        : 0;
  const pendingFees = await pendingFeeAmount(resident);
  const checklist = await MoveOutChecklistModel.findOneAndUpdate(
    { hostelId: resident.hostelId, residentId: resident._id },
    {
      $set: {
        ...input,
        depositRefundAmount,
        completedAt: new Date(),
        completedBy: principal.userId,
        createdBy: principal.userId,
        hostelId: resident.hostelId,
        pendingFeeAmount: pendingFees,
        residentId: resident._id,
        updatedBy: principal.userId,
      },
    },
    { new: true, upsert: true },
  ).lean<MoveOutRecord>();

  if (!checklist) {
    throw new MoveChecklistServiceError(
      "Move-out checklist could not be saved.",
      "MOVE_OUT_SAVE_FAILED",
      500,
    );
  }

  await Promise.all([
    // One refund row per move-out: settling the deposit later updates it
    // rather than adding a second refund beside the first.
    DepositRefundModel.updateOne(
      { moveOutChecklistId: checklist._id },
      {
        $set: {
          amount: depositRefundAmount,
          decidedAt: new Date(),
          decidedBy: principal.userId,
          decision: input.depositRefundDecision,
          hostelId: resident.hostelId,
          residentId: resident._id,
        },
      },
      { upsert: true },
    ),
    ResidentModel.updateOne(
      { _id: resident._id },
      { $set: { status: "MOVED_OUT", updatedBy: principal.userId } },
    ),
  ]);
  // Moving out hands the bed back to that room type's vacancy count — once.
  // Settling the deposit of somebody already gone must not free a second bed.
  if (resident.status !== "MOVED_OUT") {
    await releaseBedForRoomType(resident.hostelId, resident.roomType);
    await releaseResidentAccount(resident.userId, resident.hostelId);
  }
  await auditMoveAction(
    principal,
    resident.hostelId,
    resident._id,
    "MOVE_OUT_COMPLETED",
    {
      pendingFeeAmount: pendingFees,
    },
  );

  /*
   * And the resident. This path sets `MOVED_OUT` with its own `updateOne`
   * rather than going through `updateResidentStatus`, so the status notifier
   * never sees it — the dropdown was covered and the door people actually leave
   * by was not. It carries the deposit decision too, because that is the same
   * conversation and the part about their own money.
   */
  await notifyMoveOutCompleted({
    depositAmount: depositRefundAmount,
    depositDecision: input.depositRefundDecision,
    hostelId: resident.hostelId,
    resident,
  });

  return {
    checklist: serializeMoveOut(checklist),
    resident: serializeResidentSummary({ ...resident, status: "MOVED_OUT" }),
  };
}

/**
 * Automated move ledger. Move-ins come straight from each resident's
 * `moveInDate` (recorded at registration), move-outs from the completed
 * move-out checklist — no manual data entry keeps this page current.
 */
export async function listMoveEvents(principal: ApiPrincipal, hostelId?: string) {
  await connectToDatabase();

  const scope = scopedHostelFilter(principal, hostelId);
  const [residents, moveOuts] = await Promise.all([
    ResidentModel.find({ isDeleted: false, ...scope }).lean<ResidentRecord[]>(),
    MoveOutChecklistModel.find(scope).lean<MoveOutRecord[]>(),
  ]);

  const moveOutByResident = new Map(
    moveOuts.map((checklist) => [checklist.residentId.toString(), checklist]),
  );

  const events = residents.flatMap((resident) => {
    const base = {
      residentId: resident._id.toString(),
      residentName: `${resident.firstName} ${resident.lastName}`.trim(),
      residentStatus: resident.status,
      roomType: resident.roomType,
    };
    const rows: Array<typeof base & { date: string; type: "MOVE_IN" | "MOVE_OUT" }> = [
      { ...base, date: resident.moveInDate.toISOString(), type: "MOVE_IN" },
    ];

    if (resident.status === "MOVED_OUT") {
      const checklist = moveOutByResident.get(resident._id.toString());
      const movedOutAt = checklist?.completedAt ?? resident.updatedAt;

      if (movedOutAt) {
        rows.push({ ...base, date: movedOutAt.toISOString(), type: "MOVE_OUT" });
      }
    }

    return rows;
  });

  events.sort((a, b) => b.date.localeCompare(a.date));

  return { events };
}

export async function getMoveOutChecklist(
  residentId: string,
  principal: ApiPrincipal,
  hostelId?: string,
) {
  await connectToDatabase();

  const resident = await findAdminResident(residentId, principal, hostelId);
  const [checklist, owed] = await Promise.all([
    MoveOutChecklistModel.findOne({
      hostelId: resident.hostelId,
      residentId: resident._id,
    }).lean<MoveOutRecord | null>(),
    pendingFeeAmount(resident),
  ]);

  return {
    checklist: serializeMoveOut(checklist),
    /** What they owe right now — the move-out screen shows it before anyone confirms. */
    pendingFeeAmount: owed,
    resident: serializeResidentSummary(resident),
  };
}
