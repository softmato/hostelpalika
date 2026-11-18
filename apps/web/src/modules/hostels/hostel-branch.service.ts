import { Types } from "mongoose";

import type { ApiPrincipal } from "@/lib/api-auth";
import { OVERALL_SLUG } from "@/lib/branch-cache";
import { type HostelPhoto, resolveHostelPhotos } from "@/lib/hostel-photos";
import { connectToDatabase } from "@/lib/db";
import { countBranches } from "@/modules/billing/billing-hostel";
import { resolveOwnedHostel } from "@/modules/billing/subscription-access";
import { getSubscriptionState } from "@/modules/billing/subscription.service";
import type { BranchRequestInput } from "@/lib/hostels/hostel-branch.validation";
export { branchRequestSchema, type BranchRequestInput } from "@/lib/hostels/hostel-branch.validation";
import { collectionTotals } from "@/modules/finance/ledger-read.service";
import { getSiteConfigSection } from "@/modules/platform-config/site-config.service";
import { AuditLogModel } from "@hostel/db/models/AuditLog";
import { ComplaintModel } from "@hostel/db/models/Complaint";
import { HostelModel } from "@hostel/db/models/Hostel";
import { HostelDocumentModel } from "@hostel/db/models/HostelDocument";
import { ResidentModel } from "@hostel/db/models/Resident";
import { UserModel } from "@hostel/db/models/User";
import { currentBsPeriod } from "@hostel/shared/calendar/bs";
import { getPlan } from "@hostel/shared/plans/catalog";
import { serializeHostel, type HostelRecord } from "./hostel.service";

/** Branches share an owner and plan; business details and accounts belong to each hostel. */

export class BranchError extends Error {
  constructor(
    message: string,
    public errorCode: string,
    public status = 409,
  ) {
    super(message);
  }
}

async function uniqueBranchSlug(name: string, area: string) {
  const base =
    `${name}-${area}`
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "hostel";

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const slug = attempt === 0 ? base : `${base}-${attempt + 1}`;

    if (slug !== OVERALL_SLUG && !(await HostelModel.exists({ slug }))) return slug;
  }

  return `${base}-${new Types.ObjectId().toString().slice(-6)}`;
}

/** The main hostel's plan, its branch cap and what it already has. */
export async function getBranchAllowance(mainHostelId: string) {
  const state = await getSubscriptionState(mainHostelId);
  const plan = state?.subscription.planId
    ? getPlan(await getSiteConfigSection("plans"), state.subscription.planId)
    : null;
  const used = await countBranches(new Types.ObjectId(mainHostelId));

  return {
    active: state?.subscription.status === "ACTIVE",
    cap: plan?.maxBranches ?? 0,
    planName: state?.subscription.planName ?? null,
    used,
  };
}

/** The main hostel's branches, for the owner's Branches screen. */
export async function listBranches(mainHostelId: string, principal: ApiPrincipal) {
  await connectToDatabase();

  const main = await resolveOwnedHostel(mainHostelId, principal.userId);
  const [branches, allowance, mainPan] = await Promise.all([
    HostelModel.find({ isDeleted: { $ne: true }, parentHostelId: main._id })
      .select("branchLabel name slug status location.area location.city photos.kind photos.url createdAt")
      .sort({ createdAt: 1 })
      .lean<
        Array<{
          _id: Types.ObjectId;
          branchLabel?: string;
          createdAt?: Date;
          location?: { area?: string; city?: string };
          name: string;
          photos?: HostelPhoto[];
          slug: string;
          status: string;
        }>
      >(),
    getBranchAllowance(mainHostelId),
    HostelModel.findById(main._id)
      .select("branchLabel panNumber location photos.kind photos.url")
      .lean<{
        branchLabel?: string;
        panNumber?: string;
        location?: { area?: string; city?: string };
        photos?: HostelPhoto[];
      } | null>(),
  ]);

  return {
    allowance,
    branches: branches.map((branch) => ({
      area: branch.location?.area ?? "",
      branchLabel: branch.branchLabel ?? "",
      city: branch.location?.city ?? "",
      coverUrl: resolveHostelPhotos(branch.photos, "EXTERIOR")[0]?.url ?? null,
      createdAt: branch.createdAt?.toISOString() ?? null,
      id: branch._id.toString(),
      name: branch.name,
      slug: branch.slug,
      status: branch.status,
    })),
    main: {
      id: main._id.toString(),
      name: main.name ?? "",
      slug: main.slug ?? "",
      status: main.status ?? "",
      area: mainPan?.location?.area ?? "",
      branchLabel: mainPan?.branchLabel ?? "",
      city: mainPan?.location?.city ?? "",
      coverUrl: resolveHostelPhotos(mainPan?.photos, "EXTERIOR")[0]?.url ?? null,
      panNumber: mainPan?.panNumber ?? null,
    },
  };
}

/** Owner-only read, including branches whose registration is still pending. */
/** Renames the short key a hostel in this group goes by ("Block B"). */
export async function setBranchLabel(mainHostelId: string, branchId: string, label: string, principal: ApiPrincipal) {
  await connectToDatabase();
  const main = await resolveOwnedHostel(mainHostelId, principal.userId);
  if (!Types.ObjectId.isValid(branchId)) throw new BranchError("Branch not found.", "HOSTEL_NOT_FOUND", 404);
  const done = await HostelModel.updateOne(
    { _id: new Types.ObjectId(branchId), isDeleted: { $ne: true }, $or: [{ _id: main._id }, { parentHostelId: main._id }] },
    { $set: { branchLabel: label, updatedBy: principal.userId } },
  );
  if (!done.matchedCount) throw new BranchError("Branch not found.", "HOSTEL_NOT_FOUND", 404);
  return { branchLabel: label };
}

export async function getBranchDetails(mainHostelId: string, branchId: string, principal: ApiPrincipal) {
  await connectToDatabase();
  const main = await resolveOwnedHostel(mainHostelId, principal.userId);
  if (!Types.ObjectId.isValid(branchId)) throw new BranchError("Branch not found.", "HOSTEL_NOT_FOUND", 404);
  const hostel = await HostelModel.findOne({
    _id: new Types.ObjectId(branchId),
    isDeleted: { $ne: true },
    $or: [{ _id: main._id }, { parentHostelId: main._id }],
  }).lean<(Omit<HostelRecord, "roomConfigurations"> & {
    contact?: HostelRecord["contact"] & { alternatePhone?: string };
    location: HostelRecord["location"] & { landmark?: string; mapLink?: string };
    yearEstablished?: string;
    securityDeposit?: number;
    shortStays?: { enabled?: boolean; minNights?: number; rates?: Array<{ roomType: string; dailyRate: number }> };
    roomConfigurations?: Array<NonNullable<HostelRecord["roomConfigurations"]>[number] & { securityDeposit?: number }>;
  }) | null>();
  if (!hostel) throw new BranchError("Branch not found.", "HOSTEL_NOT_FOUND", 404);
  const documents = await HostelDocumentModel.find({ hostelId: hostel._id, isDeleted: { $ne: true } })
    .select("documentType status rejectionReason")
    .lean<Array<{ _id: Types.ObjectId; documentType: string; status: string; rejectionReason?: string }>>();
  const saved = serializeHostel(hostel);
  return {
    hostel: {
      ...saved,
      contact: hostel.contact ?? {},
      location: hostel.location,
      photos: saved.photos.map((photo) => ({ ...photo, url: photo.url || (photo.fileAssetId ? `/api/v1/files/${photo.fileAssetId}/url` : "") })),
      yearEstablished: hostel.yearEstablished ?? "",
      securityDeposit: hostel.securityDeposit,
      shortStays: hostel.shortStays,
      roomConfigurations: (hostel.roomConfigurations ?? []).map((room) => ({
        roomType: room.roomType, rooms: room.rooms, bedsPerRoom: room.bedsPerRoom,
        vacantBeds: room.vacantBeds, monthlyRent: room.monthlyRent,
        securityDeposit: room.securityDeposit, mealInclusion: room.mealInclusion,
      })),
    },
    main: { id: main._id.toString(), name: main.name ?? "", slug: main.slug ?? "" },
    documents: documents.map((document) => ({ id: document._id.toString(), type: document.documentType, status: document.status, rejectionReason: document.rejectionReason ?? "" })),
  };
}

/**
 * A branch starts the way a quick sign-up does: its name and label, then the
 * branch's own KYC carries the rest — location, rooms, documents, payout and
 * the signed agreement. It stays DRAFT, unlisted and KYC-locked until a
 * superadmin approves that KYC. It rides the main hostel's plan, so it has no
 * trial of its own.
 */
export async function requestBranch(
  mainHostelId: string,
  input: BranchRequestInput,
  principal: ApiPrincipal,
) {
  await connectToDatabase();

  // Only the owner of the main hostel — not its wardens or cooks.
  const owned = await resolveOwnedHostel(mainHostelId, principal.userId);
  const main = await HostelModel.findById(owned._id)
    .select("contact name ownerId parentHostelId suspension")
    .lean<{
      _id: Types.ObjectId;
      contact?: { email?: string; phone?: string };
      suspension?: Record<string, unknown> | null;
      name: string;
      ownerId: Types.ObjectId;
      parentHostelId?: Types.ObjectId | null;
    } | null>();

  if (!main) {
    throw new BranchError("Hostel not found.", "HOSTEL_NOT_FOUND", 404);
  }

  if (main.parentHostelId) {
    throw new BranchError(
      "This hostel is itself a branch. Add branches from the main hostel.",
      "BRANCH_OF_BRANCH",
    );
  }

  const allowance = await getBranchAllowance(mainHostelId);

  if (allowance.cap === 0) {
    throw new BranchError(
      `Branches come with the plan that includes them. ${allowance.planName ?? "This plan"} has none.`,
      "PLAN_HAS_NO_BRANCHES",
    );
  }

  if (!allowance.active) {
    throw new BranchError(
      "The main hostel's plan has to be active — clear any due first.",
      "PLAN_NOT_ACTIVE",
    );
  }

  if (allowance.used >= allowance.cap) {
    throw new BranchError(
      `${allowance.planName} includes ${allowance.cap} ${allowance.cap === 1 ? "branch" : "branches"}, and you have ${allowance.used}.`,
      "BRANCH_LIMIT_REACHED",
    );
  }

  const branch = await HostelModel.create({
    // A branch rides its main hostel's plan, so it starts on the same suspension
    // clock — `startHostelSuspension` only copies onto branches that exist then.
    ...(main.suspension ? { suspension: main.suspension } : {}),
    branchLabel: input.branchLabel,
    // The main hostel's phone and email to start from; the KYC can change them.
    contact: { email: main.contact?.email, phone: main.contact?.phone },
    createdBy: principal.userId,
    kyc: { required: true, status: "DRAFT" },
    name: input.name,
    ownerId: main.ownerId,
    parentHostelId: main._id,
    slug: await uniqueBranchSlug(input.name, ""),
    status: "DRAFT",
    updatedBy: principal.userId,
    verificationStatus: "UNVERIFIED",
  });

  // The owner works in the branch from now on — its KYC is done from inside it —
  // so it joins their hostels here, not at approval. The token heals at refresh.
  await UserModel.updateOne({ _id: main.ownerId }, { $addToSet: { hostelIds: branch._id } });

  await AuditLogModel.create({
    action: "HOSTEL_BRANCH_REQUESTED",
    actorId: principal.userId,
    entityId: branch._id.toString(),
    entityType: "Hostel",
    hostelId: branch._id,
    metadata: { mainHostelId: main._id.toString() },
  });

  return { branch: { id: branch._id.toString(), name: input.name, status: "DRAFT" } };
}

/**
 * Every hostel an owner runs — the main one and its branches — side by side,
 * for the dashboard. The only read that spans them: every other screen works
 * on the one hostel the switcher chose (`allHostelIds` vs `hostelIds`).
 *
 * Includes a single hostel so the switcher can offer branch creation.
 */
export async function getBranchesSummary(principal: ApiPrincipal) {
  await connectToDatabase();

  const ids = (principal.allHostelIds ?? principal.hostelIds).filter((id) =>
    Types.ObjectId.isValid(id),
  );

  if (ids.length === 0) {
    return { hostels: [], period: currentBsPeriod() };
  }

  const period = currentBsPeriod();
  const hostels = await HostelModel.find({
    _id: { $in: ids.map((id) => new Types.ObjectId(id)) },
    isDeleted: { $ne: true },
  })
    .select("branchLabel capacitySummary location.area location.city name parentHostelId photos.kind photos.url slug status")
    .lean<
      Array<{
        _id: Types.ObjectId;
        branchLabel?: string;
        capacitySummary?: { totalBeds?: number; vacantBeds?: number };
        location?: { area?: string; city?: string };
        name: string;
        parentHostelId?: Types.ObjectId | null;
        photos?: HostelPhoto[];
        slug: string;
        status: string;
      }>
    >();

  const exterior = new Map(
    hostels.map((hostel) => [hostel._id.toString(), resolveHostelPhotos(hostel.photos, "EXTERIOR")[0]?.url ?? null]),
  );

  const rows = await Promise.all(
    hostels.map(async (hostel) => {
      const [residents, openComplaints, money] = await Promise.all([
        ResidentModel.countDocuments({
          hostelId: hostel._id,
          isDeleted: false,
          status: { $ne: "MOVED_OUT" },
        }),
        ComplaintModel.countDocuments({
          hostelId: hostel._id,
          status: { $in: ["PENDING", "IN_PROGRESS"] },
        }),
        collectionTotals({ hostelId: hostel._id, period }),
      ]);
      const beds = hostel.capacitySummary?.totalBeds ?? 0;
      const vacant = hostel.capacitySummary?.vacantBeds ?? 0;

      return {
        area: hostel.location?.area ?? "",
        city: hostel.location?.city ?? "",
        branchLabel: hostel.branchLabel ?? "",
        beds,
        collected: money.paidAmount,
        /** First exterior photo — the branch's face in the app's switcher. */
        // A branch with no exterior photo of its own wears its main hostel's.
        coverUrl:
          exterior.get(hostel._id.toString()) ??
          (hostel.parentHostelId ? (exterior.get(hostel.parentHostelId.toString()) ?? null) : null),
        due: Math.max(0, money.dueAmount - money.paidAmount),
        id: hostel._id.toString(),
        isBranch: Boolean(hostel.parentHostelId),
        name: hostel.name,
        occupancyPercent: beds > 0 ? Math.round(((beds - vacant) / beds) * 100) : null,
        openComplaints,
        residents,
        slug: hostel.slug,
        status: hostel.status,
      };
    }),
  );

  // Main hostel first, then branches in the order they were added.
  const order = new Map(ids.map((id, index) => [id, index]));
  rows.sort(
    (a, b) =>
      Number(a.isBranch) - Number(b.isBranch) ||
      (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0),
  );

  return { hostels: rows, period };
}

/**
 * The hostel group a warden works in, by name only — the app shows it in a
 * read-only switcher so they know which branch they are in and what else the
 * group runs. No counts and no money: those stay the owner's
 * ({@link getBranchesSummary}). `current` is the hostel this request is about.
 */
export async function getBranchNames(principal: ApiPrincipal) {
  await connectToDatabase();

  const ids = (principal.allHostelIds ?? principal.hostelIds)
    .filter((id) => Types.ObjectId.isValid(id))
    .map((id) => new Types.ObjectId(id));
  const current = principal.hostelIds[0] ?? null;

  if (ids.length === 0) return { current, hostels: [] };

  const own = await HostelModel.find({ _id: { $in: ids } })
    .select("parentHostelId")
    .lean<Array<{ _id: Types.ObjectId; parentHostelId?: Types.ObjectId | null }>>();
  const groups = own.map((hostel) => hostel.parentHostelId ?? hostel._id);
  const hostels = await HostelModel.find({
    $or: [{ _id: { $in: groups } }, { parentHostelId: { $in: groups } }],
    isDeleted: { $ne: true },
  })
    .select("branchLabel location.area location.city name parentHostelId photos.kind photos.url")
    .sort({ _id: 1 })
    .lean<
      Array<{
        _id: Types.ObjectId;
        branchLabel?: string;
        location?: { area?: string; city?: string };
        name: string;
        parentHostelId?: Types.ObjectId | null;
        photos?: HostelPhoto[];
      }>
    >();

  return {
    current,
    // Main hostel first, then branches in the order they were added.
    hostels: hostels
      .map((hostel) => ({
        area: hostel.location?.area ?? "",
        city: hostel.location?.city ?? "",
        branchLabel: hostel.branchLabel ?? "",
        coverUrl: resolveHostelPhotos(hostel.photos, "EXTERIOR")[0]?.url ?? null,
        id: hostel._id.toString(),
        isBranch: Boolean(hostel.parentHostelId),
        name: hostel.name,
      }))
      .sort((a, b) => Number(a.isBranch) - Number(b.isBranch)),
  };
}
