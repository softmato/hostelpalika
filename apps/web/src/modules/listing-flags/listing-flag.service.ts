import { Types } from "mongoose";
import type { z } from "zod";

import type { ApiPrincipal } from "@/lib/api-auth";
import { connectToDatabase } from "@/lib/db";
import { paginationMeta, paginationRange } from "@/lib/pagination";
import { AuditLogModel } from "@hostel/db/models/AuditLog";
import { DuplicateCheckResultModel } from "@hostel/db/models/DuplicateCheckResult";
import { HostelModel } from "@hostel/db/models/Hostel";
import { ListingFlagModel } from "@hostel/db/models/ListingFlag";
import type {
  listingFlagListQuerySchema,
  listingFlagResolveSchema,
} from "@/modules/listing-flags/listing-flag.validation";

type ListingFlagListQuery = z.infer<typeof listingFlagListQuerySchema>;
type ListingFlagResolveInput = z.infer<typeof listingFlagResolveSchema>;

type ListingFlagRecord = {
  _id: Types.ObjectId;
  createdAt?: Date;
  hostelId: Types.ObjectId;
  matchedHostelIds?: Types.ObjectId[];
  reason: string;
  resolutionNote?: string;
  resolvedAt?: Date;
  resolvedBy?: Types.ObjectId;
  riskLevel: "LOW" | "MEDIUM" | "HIGH";
  signals?: string[];
  status: "OPEN" | "RESOLVED" | "DISMISSED";
  updatedAt?: Date;
};

type DuplicateCheckResultRecord = {
  _id: Types.ObjectId;
  checkedBy: Types.ObjectId;
  createdAt?: Date;
  flagId?: Types.ObjectId;
  hostelId: Types.ObjectId;
  matchedHostelIds?: Types.ObjectId[];
  riskLevel: "LOW" | "MEDIUM" | "HIGH";
  signals?: string[];
};

type HostelRecord = {
  _id: Types.ObjectId;
  contact?: {
    phone?: string;
  };
  location?: {
    address?: string;
    area?: string;
  };
  name: string;
  ownerId: Types.ObjectId;
};

export class ListingFlagServiceError extends Error {
  constructor(
    message: string,
    public errorCode = "LISTING_FLAG_ERROR",
    public status = 400,
  ) {
    super(message);
  }
}

function normalizeObjectId(value: string, label = "id") {
  if (!Types.ObjectId.isValid(value)) {
    throw new ListingFlagServiceError(`Invalid ${label}.`, "INVALID_OBJECT_ID", 422);
  }

  return new Types.ObjectId(value);
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function serializeFlag(flag: ListingFlagRecord | null) {
  if (!flag) {
    return null;
  }

  return {
    createdAt: flag.createdAt?.toISOString(),
    hostelId: flag.hostelId.toString(),
    id: flag._id.toString(),
    matchedHostelIds: (flag.matchedHostelIds ?? []).map((id) => id.toString()),
    reason: flag.reason,
    resolutionNote: flag.resolutionNote ?? "",
    resolvedAt: flag.resolvedAt?.toISOString(),
    resolvedBy: flag.resolvedBy?.toString(),
    riskLevel: flag.riskLevel,
    signals: flag.signals ?? [],
    status: flag.status,
    updatedAt: flag.updatedAt?.toISOString(),
  };
}

function serializeCheckResult(result: DuplicateCheckResultRecord) {
  return {
    checkedBy: result.checkedBy.toString(),
    createdAt: result.createdAt?.toISOString(),
    flagId: result.flagId?.toString(),
    hostelId: result.hostelId.toString(),
    id: result._id.toString(),
    matchedHostelIds: (result.matchedHostelIds ?? []).map((id) => id.toString()),
    riskLevel: result.riskLevel,
    signals: result.signals ?? [],
  };
}

async function auditListingFlagAction(
  principal: ApiPrincipal,
  flag: ListingFlagRecord,
  action: string,
  metadata: Record<string, unknown> = {},
) {
  await AuditLogModel.create({
    action,
    actorId: principal.userId,
    entityId: flag._id.toString(),
    entityType: "ListingFlag",
    hostelId: flag.hostelId,
    metadata,
  });
}

export async function listListingFlags(query: ListingFlagListQuery) {
  await connectToDatabase();

  const filter: Record<string, unknown> = {
    isDeleted: false,
  };

  if (query.riskLevel) {
    filter.riskLevel = query.riskLevel;
  }

  if (query.status) {
    filter.status = query.status;
  }

  const { limit, skip } = paginationRange(query);

  const [flags, total] = await Promise.all([
    // Open first, then the riskiest (P7-19): sorting the enum strings put
    // DISMISSED before OPEN and MEDIUM before HIGH.
    ListingFlagModel.aggregate<ListingFlagRecord>([
      { $match: filter },
      {
        $addFields: {
          _riskRank: { $indexOfArray: [["HIGH", "MEDIUM", "LOW"], "$riskLevel"] },
          _statusRank: { $indexOfArray: [["OPEN", "RESOLVED", "DISMISSED"], "$status"] },
        },
      },
      { $sort: { _statusRank: 1, _riskRank: 1, createdAt: -1 } },
      { $skip: skip },
      { $limit: limit },
    ]),
    ListingFlagModel.countDocuments(filter),
  ]);

  return {
    flags: flags.map(serializeFlag),
    pagination: paginationMeta(query, total),
  };
}

export async function runDuplicateCheck(hostelId: string, principal: ApiPrincipal) {
  await connectToDatabase();

  const objectId = normalizeObjectId(hostelId, "hostel id");
  const hostel = await HostelModel.findOne({
    _id: objectId,
    isDeleted: false,
  }).lean<HostelRecord | null>();

  if (!hostel) {
    throw new ListingFlagServiceError("Hostel was not found.", "HOSTEL_NOT_FOUND", 404);
  }

  const signals: string[] = [];
  const or: Record<string, unknown>[] = [];

  if (hostel.location?.address) {
    or.push({
      "location.address": new RegExp(escapeRegex(hostel.location.address), "i"),
    });
    signals.push("same_address");
  }

  if (hostel.contact?.phone) {
    or.push({ "contact.phone": hostel.contact.phone });
    signals.push("same_phone");
  }

  if (hostel.ownerId) {
    or.push({ ownerId: hostel.ownerId });
    signals.push("same_owner");
  }

  if (hostel.name && hostel.location?.area) {
    const namePrefix = hostel.name.split(/\s+/).slice(0, 2).join(" ");

    if (namePrefix.length >= 3) {
      or.push({
        "location.area": new RegExp(escapeRegex(hostel.location.area), "i"),
        name: new RegExp(escapeRegex(namePrefix), "i"),
      });
      signals.push("similar_name_same_area");
    }
  }

  const matches =
    or.length > 0
      ? await HostelModel.find({
          _id: { $ne: objectId },
          isDeleted: false,
          $or: or,
        })
          .limit(10)
          .lean<HostelRecord[]>()
      : [];
  const matchedHostelIds = matches.map((match) => match._id);
  const matchedSignals = matchedHostelIds.length > 0 ? signals : [];
  const riskLevel =
    matchedSignals.includes("same_phone") || matchedSignals.includes("same_owner")
      ? "HIGH"
      : matchedHostelIds.length > 0
        ? "MEDIUM"
        : "LOW";
  let flag: ListingFlagRecord | null = null;

  if (matchedHostelIds.length > 0) {
    // One open flag per hostel, brought up to date on a re-run (P7-20).
    flag = await ListingFlagModel.findOneAndUpdate(
      { hostelId: objectId, isDeleted: false, status: "OPEN" },
      {
        $set: {
          matchedHostelIds,
          reason: "Possible duplicate or ghost listing detected.",
          riskLevel,
          signals: matchedSignals,
          updatedBy: principal.userId,
        },
        $setOnInsert: { createdBy: principal.userId },
      },
      { new: true, upsert: true },
    ).lean<ListingFlagRecord>();

    await auditListingFlagAction(principal, flag as ListingFlagRecord, "LISTING_DUPLICATE_FLAG_CREATED", {
      matchedHostelIds: matchedHostelIds.map((id) => id.toString()),
      riskLevel,
    });
  }

  const result = (await DuplicateCheckResultModel.create({
    checkedBy: principal.userId,
    flagId: flag?._id,
    hostelId: objectId,
    matchedHostelIds,
    riskLevel,
    signals: matchedSignals,
  })) as DuplicateCheckResultRecord;

  return {
    flag: serializeFlag(flag),
    result: serializeCheckResult(result),
  };
}

export async function resolveListingFlag(
  flagId: string,
  input: ListingFlagResolveInput,
  principal: ApiPrincipal,
) {
  await connectToDatabase();

  const flag = await ListingFlagModel.findOneAndUpdate(
    {
      _id: normalizeObjectId(flagId, "listing flag id"),
      isDeleted: false,
    },
    {
      $set: {
        resolutionNote: input.resolutionNote,
        resolvedAt: new Date(),
        resolvedBy: principal.userId,
        status: input.status,
        updatedBy: principal.userId,
      },
    },
    { new: true },
  ).lean<ListingFlagRecord | null>();

  if (!flag) {
    throw new ListingFlagServiceError(
      "Listing flag was not found.",
      "LISTING_FLAG_NOT_FOUND",
      404,
    );
  }

  await auditListingFlagAction(principal, flag, "LISTING_FLAG_RESOLVED", {
    status: input.status,
  });

  return {
    flag: serializeFlag(flag),
  };
}
