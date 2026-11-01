import { Types } from "mongoose";
import type { z } from "zod";

import type { ApiPrincipal } from "@/lib/api-auth";
import { connectToDatabase } from "@/lib/db";
import { paginationMeta, paginationRange } from "@/lib/pagination";
import { AuditLogModel } from "@hostel/db/models/AuditLog";
import { SponsorModel } from "@hostel/db/models/Sponsor";
import { normalizeObjectId } from "@/modules/residents/resident-access";
import type {
  sponsorCreateSchema,
  sponsorListQuerySchema,
  sponsorUpdateSchema,
} from "@/modules/sponsors/sponsor.validation";

type CreateInput = z.infer<typeof sponsorCreateSchema>;
type UpdateInput = z.infer<typeof sponsorUpdateSchema>;
type ListQuery = z.infer<typeof sponsorListQuerySchema>;

type SponsorRecord = {
  _id: Types.ObjectId;
  accentColor?: string;
  clickCount: number;
  createdAt?: Date;
  ctaLabel?: string;
  endsAt?: Date;
  highlight?: string;
  imageAssetId?: string;
  imageUrl?: string;
  impressionCount: number;
  isActive: boolean;
  kind: "COLLEGE" | "HOSTEL" | "BUSINESS" | "OTHER";
  linkUrl?: string;
  name: string;
  priority: number;
  startsAt?: Date;
  subtitle?: string;
};

export class SponsorServiceError extends Error {
  constructor(
    message: string,
    public errorCode = "SPONSOR_ERROR",
    public status = 400,
  ) {
    super(message);
  }
}

/** The full record, for the platform owner's table. */
function serializeSponsor(sponsor: SponsorRecord) {
  return {
    accentColor: sponsor.accentColor ?? "#0a8a4b",
    clickCount: sponsor.clickCount ?? 0,
    createdAt: sponsor.createdAt?.toISOString(),
    ctaLabel: sponsor.ctaLabel ?? "View",
    endsAt: sponsor.endsAt?.toISOString() ?? null,
    highlight: sponsor.highlight ?? "",
    id: sponsor._id.toString(),
    imageAssetId: sponsor.imageAssetId ?? "",
    imageUrl: sponsor.imageUrl ?? "",
    impressionCount: sponsor.impressionCount ?? 0,
    isActive: sponsor.isActive,
    kind: sponsor.kind,
    linkUrl: sponsor.linkUrl ?? "",
    name: sponsor.name,
    priority: sponsor.priority,
    startsAt: sponsor.startsAt?.toISOString() ?? null,
    subtitle: sponsor.subtitle ?? "",
  };
}

/**
 * What a reader gets. Deliberately narrower than the admin shape: counters and
 * the campaign window are the platform owner's business, not the visitor's.
 */
function serializePublicSponsor(sponsor: SponsorRecord) {
  return {
    accentColor: sponsor.accentColor ?? "#0a8a4b",
    ctaLabel: sponsor.ctaLabel ?? "View",
    highlight: sponsor.highlight ?? "",
    id: sponsor._id.toString(),
    imageAssetId: sponsor.imageAssetId ?? "",
    imageUrl: sponsor.imageUrl ?? "",
    kind: sponsor.kind,
    linkUrl: sponsor.linkUrl ?? "",
    name: sponsor.name,
    subtitle: sponsor.subtitle ?? "",
  };
}

/**
 * Live right now: active, and inside its campaign window if it has one. The
 * window is evaluated per request rather than by a cron flipping `isActive`,
 * so a campaign starts and ends on time without anything having to run.
 */
export function liveSponsorFilter(now = new Date()) {
  return {
    $and: [
      { isActive: true },
      { $or: [{ startsAt: { $lte: now } }, { startsAt: { $exists: false } }, { startsAt: null }] },
      { $or: [{ endsAt: { $gte: now } }, { endsAt: { $exists: false } }, { endsAt: null }] },
    ],
  };
}

/** The community rail's sponsors, best priority first. Open to signed-out readers. */
export async function listLiveSponsors(limit = 4) {
  await connectToDatabase();

  const sponsors = await SponsorModel.find(liveSponsorFilter())
    .sort({ priority: -1, createdAt: -1 })
    .limit(limit)
    .lean<SponsorRecord[]>();

  // Counted here rather than from the client: a render is an impression, and a
  // client-reported one is a number anybody can inflate. Never blocks the read.
  if (sponsors.length > 0) {
    void SponsorModel.updateMany(
      { _id: { $in: sponsors.map((sponsor) => sponsor._id) } },
      { $inc: { impressionCount: 1 } },
    ).catch(() => {});
  }

  return sponsors.map(serializePublicSponsor);
}

export async function recordSponsorClick(sponsorId: string) {
  await connectToDatabase();

  await SponsorModel.updateOne(
    { _id: normalizeObjectId(sponsorId, "sponsor id") },
    { $inc: { clickCount: 1 } },
  );

  return { recorded: true };
}

/* -------------------------------------------------------------------------- */
/* Platform owner                                                             */
/* -------------------------------------------------------------------------- */

export async function listSponsors(query: ListQuery) {
  await connectToDatabase();

  const filter =
    query.status === "all" ? {} : { isActive: query.status === "active" };
  const { limit, skip } = paginationRange(query);

  const [sponsors, total, active] = await Promise.all([
    SponsorModel.find(filter)
      .sort({ priority: -1, createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean<SponsorRecord[]>(),
    SponsorModel.countDocuments(filter),
    SponsorModel.countDocuments(liveSponsorFilter()),
  ]);

  return {
    pagination: paginationMeta(query, total),
    sponsors: sponsors.map(serializeSponsor),
    summary: { live: active, total },
  };
}

export async function createSponsor(input: CreateInput, principal: ApiPrincipal) {
  await connectToDatabase();

  assertWindow(input.startsAt, input.endsAt);

  const sponsor = (await SponsorModel.create({
    ...input,
    createdBy: principal.userId,
    updatedBy: principal.userId,
  })) as SponsorRecord;

  await writeAudit("SPONSOR_CREATED", sponsor, principal);

  return { sponsor: serializeSponsor(sponsor) };
}

export async function updateSponsor(
  sponsorId: string,
  input: UpdateInput,
  principal: ApiPrincipal,
) {
  await connectToDatabase();

  const existing = await SponsorModel.findById(
    normalizeObjectId(sponsorId, "sponsor id"),
  ).lean<SponsorRecord | null>();

  if (!existing) {
    throw new SponsorServiceError("Sponsor was not found.", "SPONSOR_NOT_FOUND", 404);
  }

  assertWindow(
    input.startsAt ?? existing.startsAt,
    input.endsAt ?? existing.endsAt,
  );

  const sponsor = (await SponsorModel.findOneAndUpdate(
    { _id: existing._id },
    { $set: { ...input, updatedBy: principal.userId } },
    { new: true },
  ).lean<SponsorRecord | null>())!;

  await writeAudit("SPONSOR_UPDATED", sponsor, principal);

  return { sponsor: serializeSponsor(sponsor) };
}

export async function deleteSponsor(sponsorId: string, principal: ApiPrincipal) {
  await connectToDatabase();

  const sponsor = await SponsorModel.findOneAndDelete({
    _id: normalizeObjectId(sponsorId, "sponsor id"),
  }).lean<SponsorRecord | null>();

  if (!sponsor) {
    throw new SponsorServiceError("Sponsor was not found.", "SPONSOR_NOT_FOUND", 404);
  }

  await writeAudit("SPONSOR_DELETED", sponsor, principal);

  return { sponsorId };
}

function assertWindow(startsAt?: Date | null, endsAt?: Date | null) {
  if (startsAt && endsAt && startsAt > endsAt) {
    throw new SponsorServiceError(
      "The campaign cannot end before it starts.",
      "INVALID_CAMPAIGN_WINDOW",
      422,
    );
  }
}

async function writeAudit(
  action: string,
  sponsor: SponsorRecord,
  principal: ApiPrincipal,
) {
  try {
    await AuditLogModel.create({
      action,
      actorId: principal.userId,
      entityId: sponsor._id.toString(),
      entityType: "Sponsor",
      metadata: { name: sponsor.name, priority: sponsor.priority },
    });
  } catch {
    // A paid placement changing hands is worth logging, but never worth
    // failing the change the owner just made.
  }
}
