import { Types } from "mongoose";

import type { ApiPrincipal } from "@/lib/api-auth";
import { OVERALL_SLUG } from "@/lib/branch-cache";
import { type HostelPhoto, resolveHostelPhotos } from "@/lib/hostel-photos";
import { connectToDatabase } from "@/lib/db";
import { claimRegistrationDocuments } from "@/lib/registration-documents";
import { Role } from "@/lib/roles";
import { countBranches } from "@/modules/billing/billing-hostel";
import { panKey } from "@/modules/billing/free-months";
import { resolveOwnedHostel } from "@/modules/billing/subscription-access";
import { getSubscriptionState } from "@/modules/billing/subscription.service";
import { registrationShortStays } from "@/modules/bookings/short-stay-settings.service";
import { hostelNameKey } from "@/modules/hostels/hostel-name-key";
import type { BranchRequestInput } from "./hostel-branch.validation";
export { branchRequestSchema, type BranchRequestInput } from "./hostel-branch.validation";
import { createInAppNotification } from "@/modules/notifications/notification.service";
import { collectionTotals } from "@/modules/finance/ledger-read.service";
import { getSiteConfigSection } from "@/modules/platform-config/site-config.service";
import { AuditLogModel } from "@hostel/db/models/AuditLog";
import { ComplaintModel } from "@hostel/db/models/Complaint";
import { HostelModel } from "@hostel/db/models/Hostel";
import { HostelApplicationModel } from "@hostel/db/models/HostelApplication";
import { HostelDocumentModel } from "@hostel/db/models/HostelDocument";
import { HostelVerificationModel } from "@hostel/db/models/HostelVerification";
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
      .select("name slug status location.area location.city createdAt")
      .sort({ createdAt: 1 })
      .lean<
        Array<{
          _id: Types.ObjectId;
          createdAt?: Date;
          location?: { area?: string; city?: string };
          name: string;
          slug: string;
          status: string;
        }>
      >(),
    getBranchAllowance(mainHostelId),
    HostelModel.findById(main._id)
      .select("panNumber location")
      .lean<{ panNumber?: string; location?: { area?: string; city?: string } } | null>(),
  ]);

  return {
    allowance,
    branches: branches.map((branch) => ({
      area: branch.location?.area ?? "",
      city: branch.location?.city ?? "",
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
      city: mainPan?.location?.city ?? "",
      panNumber: mainPan?.panNumber ?? null,
    },
  };
}

/** Owner-only read, including branches whose registration is still pending. */
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

export async function requestBranch(
  mainHostelId: string,
  input: BranchRequestInput,
  principal: ApiPrincipal,
) {
  await connectToDatabase();

  // Only the owner of the main hostel — not its wardens or cooks.
  const owned = await resolveOwnedHostel(mainHostelId, principal.userId);
  const main = await HostelModel.findById(owned._id)
    .select("contact name ownerId panNumber parentHostelId slug suspension")
    .lean<{
      _id: Types.ObjectId;
      contact?: { phone?: string };
      suspension?: Record<string, unknown> | null;
      name: string;
      ownerId: Types.ObjectId;
      panNumber?: string;
      parentHostelId?: Types.ObjectId | null;
      slug: string;
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

  const key = hostelNameKey(input.name);
  const neighbours = await HostelModel.find({
    isDeleted: { $ne: true },
    "location.area": new RegExp(
      `^${input.location.area.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
      "i",
    ),
    "location.city": new RegExp(
      `^${input.location.city.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
      "i",
    ),
  })
    .select("name")
    .lean<Array<{ name?: string }>>();

  if (key && neighbours.some((hostel) => hostelNameKey(hostel.name ?? "") === key)) {
    throw new BranchError(
      `A hostel with this name is already listed in ${input.location.area}. Give the branch a name that tells them apart.`,
      "HOSTEL_ALREADY_LISTED",
    );
  }

  const shortStays = await registrationShortStays(input);
  const uploadedDocuments = await claimRegistrationDocuments(
    input.documents,
    main.ownerId,
  );
  // Reuse only this owner's approved documents, never a client-supplied hostel or asset ID.
  const sharedDocuments = input.reuseDocuments
    ? await HostelDocumentModel.find({
        hostelId: main._id,
        ownerId: main.ownerId,
        isDeleted: { $ne: true },
        status: "APPROVED",
      })
        .select("documentType fileAssetId")
        .lean<Array<{ documentType: string; fileAssetId: Types.ObjectId }>>()
    : [];
  const documents = [
    ...sharedDocuments.filter(
      (document) =>
        !uploadedDocuments.some(
          (uploaded) => uploaded.documentType === document.documentType,
        ),
    ),
    ...uploadedDocuments,
  ];
  const branch = await HostelModel.create({
    // A branch rides its main hostel's plan, so it starts on the same suspension
    // clock — `startHostelSuspension` only copies onto branches that exist then.
    ...(main.suspension ? { suspension: main.suspension } : {}),
    capacitySummary: input.roomConfigurations.length
      ? {
          totalRooms: input.roomConfigurations.reduce((sum, room) => sum + room.rooms, 0),
          totalBeds: input.roomConfigurations.reduce(
            (sum, room) => sum + room.rooms * room.bedsPerRoom,
            0,
          ),
          vacantBeds: input.roomConfigurations.reduce(
            (sum, room) => sum + room.vacantBeds,
            0,
          ),
        }
      : {
          ...input.capacitySummary,
          ...(input.totalCapacity !== undefined
            ? { totalBeds: input.totalCapacity }
            : {}),
        },
    contact: { ...input.contact, alternatePhone: input.alternatePhone },
    createdBy: principal.userId,
    description: input.description,
    facilities: input.facilities,
    food: input.food,
    hostelType: input.hostelType,
    location: { ...input.location, landmark: input.landmark, mapLink: input.mapLink },
    name: input.name,
    ownerId: main.ownerId,
    panNumber: panKey(input.reuseDocuments ? main.panNumber : input.panNumber),
    parentHostelId: main._id,
    photos: input.photos,
    pricing: input.pricing,
    securityDeposit: input.securityDeposit,
    roomConfigurations: input.roomConfigurations.map((room) => ({
      ...room,
      securityDeposit: room.securityDeposit ?? input.securityDeposit,
    })),
    roomTypes: input.roomTypes,
    rules: input.rules,
    shortStays,
    totalFloors: input.totalFloors,
    yearEstablished: input.yearEstablished,
    slug: await uniqueBranchSlug(input.name, input.location.area),
    status: "PENDING_APPROVAL",
    updatedBy: principal.userId,
    verificationStatus: "PENDING",
  });

  await HostelApplicationModel.create({
    applicantId: main.ownerId,
    hostelId: branch._id,
    notes: input.notes,
    snapshot: {
      cookCount: input.cookCount,
      totalCapacity: input.totalCapacity,
      totalFloors: input.totalFloors,
      yearEstablished: input.yearEstablished,
      reuseDocuments: input.reuseDocuments,
      contact: input.contact,
      documents,
      location: input.location,
      name: input.name,
      parentHostelId: main._id,
      pricing: input.pricing,
      securityDeposit: input.securityDeposit,
      roomConfigurations: input.roomConfigurations,
    },
    source: "BRANCH",
    status: "PENDING",
    submittedBy: principal.userId,
  });

  await HostelVerificationModel.create({
    createdBy: principal.userId,
    hostelId: branch._id,
    status: "PENDING",
    updatedBy: principal.userId,
  });

  if (documents.length > 0) {
    await HostelDocumentModel.insertMany(
      documents.map((document) => ({
        createdBy: principal.userId,
        documentType: document.documentType,
        fileAssetId: document.fileAssetId,
        hostelId: branch._id,
        ownerId: main.ownerId,
        status: "PENDING",
        updatedBy: principal.userId,
      })),
    );
  }

  const { setHostelPayoutAccount } =
    await import("@/modules/bookings/payout-account.service");

  if (input.payoutAccount)
    await setHostelPayoutAccount(branch._id.toString(), input.payoutAccount, {
      source: "REGISTRATION",
      userId: principal.userId,
    });

  await AuditLogModel.create({
    action: "HOSTEL_BRANCH_REQUESTED",
    actorId: principal.userId,
    entityId: branch._id.toString(),
    entityType: "Hostel",
    hostelId: branch._id,
    metadata: { mainHostelId: main._id.toString(), panNumber: panKey(input.panNumber) },
  });

  await notifyPlatformOfBranch({
    branchName: input.name,
    branchPhone: input.contact?.phone ?? "",
    mainName: main.name,
  });

  return {
    branch: { id: branch._id.toString(), name: input.name, status: "PENDING_APPROVAL" },
  };
}

/**
 * A bell to every superadmin, with no one-tap Approve: a branch is approved
 * only after somebody has rung it, so the bell says whom to call and opens the
 * queue.
 */
async function notifyPlatformOfBranch(input: {
  branchName: string;
  branchPhone: string;
  mainName: string;
}) {
  const staff = await UserModel.find({
    isDeleted: { $ne: true },
    role: Role.SUPERADMIN,
    status: "ACTIVE",
  })
    .select("_id")
    .lean<Array<{ _id: Types.ObjectId }>>();

  await Promise.all(
    staff.map((member) =>
      createInAppNotification({
        actionUrl: "/platform/hostels",
        body: `${input.branchName}, a branch of ${input.mainName}. Call ${input.branchPhone || "the branch"} before approving.`,
        category: "HOSTEL_APPROVAL",
        title: "Branch waiting for a call",
        userId: member._id.toString(),
      }).catch(() => undefined),
    ),
  );
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
    .select("capacitySummary location.area location.city name parentHostelId photos.kind photos.url slug status")
    .lean<
      Array<{
        _id: Types.ObjectId;
        capacitySummary?: { totalBeds?: number; vacantBeds?: number };
        location?: { area?: string; city?: string };
        name: string;
        parentHostelId?: Types.ObjectId | null;
        photos?: HostelPhoto[];
        slug: string;
        status: string;
      }>
    >();

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
        beds,
        collected: money.paidAmount,
        /** First exterior photo — the branch's face in the app's switcher. */
        coverUrl: resolveHostelPhotos(hostel.photos, "EXTERIOR")[0]?.url ?? null,
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
