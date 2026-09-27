import { Types } from "mongoose";
import { z } from "zod";

import type { ApiPrincipal } from "@/lib/api-auth";
import { connectToDatabase } from "@/lib/db";
import { claimRegistrationDocuments } from "@/lib/registration-documents";
import { Role } from "@/lib/roles";
import { countBranches } from "@/modules/billing/billing-hostel";
import { panKey } from "@/modules/billing/free-months";
import { resolveOwnedHostel } from "@/modules/billing/subscription-access";
import { getSubscriptionState } from "@/modules/billing/subscription.service";
import { payoutAccountInputSchema } from "@/modules/bookings/payout-account.validation";
import { hostelNameKey } from "@/modules/hostels/hostel-name-key";
import { platformHostelCreateSchema } from "@/modules/hostels/hostel.validation";
import { createInAppNotification } from "@/modules/notifications/notification.service";
import { collectionTotals } from "@/modules/finance/ledger-read.service";
import { getSiteConfigSection } from "@/modules/platform-config/site-config.service";
import { AuditLogModel } from "@hostel/db/models/AuditLog";
import { ComplaintModel } from "@hostel/db/models/Complaint";
import { HostelModel } from "@hostel/db/models/Hostel";
import { HostelApplicationModel } from "@hostel/db/models/HostelApplication";
import { HostelDocumentModel } from "@hostel/db/models/HostelDocument";
import { HostelPayoutAccountModel } from "@hostel/db/models/HostelPayoutAccount";
import { HostelVerificationModel } from "@hostel/db/models/HostelVerification";
import { ResidentModel } from "@hostel/db/models/Resident";
import { UserModel } from "@hostel/db/models/User";
import { currentBsPeriod } from "@hostel/shared/calendar/bs";
import { getPlan } from "@hostel/shared/plans/catalog";

/**
 * Branches: more hostels under one Max plan, with no bill of their own.
 *
 * A branch is free to run, which is exactly what makes a fake one worth
 * creating — register one hostel on Max, then sell "branches" to strangers.
 * So a branch must prove it is the same business before anyone sees it:
 *
 * 1. **the same PAN/VAT number** as the main hostel, with its certificate;
 * 2. **a payout account in the main hostel's holder name**, the main account
 *    already verified — a stranger's bookings would pay the main owner;
 * 3. **a superadmin's approval**, after calling the branch. Until then it is
 *    `PENDING_APPROVAL`: not listed, no portal, no plan.
 *
 * The first two are checked here; the third is `approvePlatformHostel`.
 */

export class BranchError extends Error {
  constructor(
    message: string,
    public errorCode: string,
    public status = 409,
  ) {
    super(message);
  }
}

export const branchRequestSchema = platformHostelCreateSchema
  .omit({ documents: true, ownerId: true })
  .extend({
    alternatePhone: z.string().trim().min(7).max(24).optional(),
    documents: platformHostelCreateSchema.shape.documents.refine(
      (documents) => documents.length > 0,
      "Upload the branch's PAN/VAT certificate.",
    ),
    landmark: z.string().trim().max(240).optional(),
    mapLink: z.string().trim().max(500).optional(),
    panNumber: z.string().trim().regex(/^\d{9}$/, "A PAN/VAT number is 9 digits."),
    payoutAccount: payoutAccountInputSchema,
  });

export type BranchRequestInput = z.infer<typeof branchRequestSchema>;

/** Case and spacing do not make a different person. */
function holderKey(name?: string | null) {
  return (name ?? "").toLowerCase().replace(/[^a-z0-9ऀ-ॿ]+/g, " ").trim();
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

    if (!(await HostelModel.exists({ slug }))) return slug;
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
    HostelModel.findById(main._id).select("panNumber").lean<{ panNumber?: string } | null>(),
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
    main: { id: main._id.toString(), name: main.name ?? "", panNumber: mainPan?.panNumber ?? null },
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
    .select("contact name ownerId panNumber parentHostelId slug")
    .lean<{
      _id: Types.ObjectId;
      contact?: { phone?: string };
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

  // 1. Same business: the PAN/VAT on file for the main hostel.
  if (!panKey(main.panNumber)) {
    throw new BranchError(
      "Your main hostel has no PAN/VAT number on file. Add it in the hostel profile first.",
      "MAIN_HAS_NO_PAN",
    );
  }

  if (panKey(input.panNumber) !== panKey(main.panNumber)) {
    throw new BranchError(
      "A branch has to be under the same PAN/VAT number as the main hostel.",
      "PAN_MISMATCH",
      422,
    );
  }

  // 2. Same money: a payout account in the main hostel's verified holder name.
  const mainPayout = await HostelPayoutAccountModel.findOne({ hostelId: main._id })
    .select("holderName status")
    .lean<{ holderName?: string; status?: string } | null>();

  if (mainPayout?.status !== "VERIFIED") {
    throw new BranchError(
      "The main hostel's payout account has to be verified before it can have branches.",
      "MAIN_PAYOUT_NOT_VERIFIED",
    );
  }

  if (holderKey(input.payoutAccount.holderName) !== holderKey(mainPayout.holderName)) {
    throw new BranchError(
      `A branch's payout account has to be in the same name as the main hostel's (${mainPayout.holderName}).`,
      "PAYOUT_HOLDER_MISMATCH",
      422,
    );
  }

  const key = hostelNameKey(input.name);
  const neighbours = await HostelModel.find({
    isDeleted: { $ne: true },
    "location.area": new RegExp(`^${input.location.area.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"),
  })
    .select("name")
    .lean<Array<{ name?: string }>>();

  if (key && neighbours.some((hostel) => hostelNameKey(hostel.name ?? "") === key)) {
    throw new BranchError(
      `A hostel with this name is already listed in ${input.location.area}. Give the branch a name that tells them apart.`,
      "HOSTEL_ALREADY_LISTED",
    );
  }

  const documents = await claimRegistrationDocuments(input.documents, main.ownerId);
  const branch = await HostelModel.create({
    capacitySummary: input.capacitySummary,
    contact: { ...input.contact, alternatePhone: input.alternatePhone },
    createdBy: principal.userId,
    description: input.description,
    facilities: input.facilities,
    food: input.food,
    hostelType: input.hostelType,
    location: { ...input.location, landmark: input.landmark, mapLink: input.mapLink },
    name: input.name,
    ownerId: main.ownerId,
    panNumber: panKey(input.panNumber),
    parentHostelId: main._id,
    photos: input.photos,
    pricing: input.pricing,
    roomConfigurations: input.roomConfigurations,
    roomTypes: input.roomTypes,
    rules: input.rules,
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
      contact: input.contact,
      documents,
      location: input.location,
      name: input.name,
      parentHostelId: main._id,
      pricing: input.pricing,
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

  const { setHostelPayoutAccount } = await import("@/modules/bookings/payout-account.service");

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

  return { branch: { id: branch._id.toString(), name: input.name, status: "PENDING_APPROVAL" } };
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
  const staff = await UserModel.find({ isDeleted: { $ne: true }, role: Role.SUPERADMIN, status: "ACTIVE" })
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
 * Empty for an owner with one hostel, so the card does not render.
 */
export async function getBranchesSummary(principal: ApiPrincipal) {
  await connectToDatabase();

  const ids = (principal.allHostelIds ?? principal.hostelIds).filter((id) => Types.ObjectId.isValid(id));

  if (ids.length < 2) {
    return { hostels: [], period: currentBsPeriod() };
  }

  const period = currentBsPeriod();
  const hostels = await HostelModel.find({
    _id: { $in: ids.map((id) => new Types.ObjectId(id)) },
    isDeleted: { $ne: true },
  })
    .select("capacitySummary name parentHostelId slug status")
    .lean<
      Array<{
        _id: Types.ObjectId;
        capacitySummary?: { totalBeds?: number; vacantBeds?: number };
        name: string;
        parentHostelId?: Types.ObjectId | null;
        slug: string;
        status: string;
      }>
    >();

  const rows = await Promise.all(
    hostels.map(async (hostel) => {
      const [residents, openComplaints, money] = await Promise.all([
        ResidentModel.countDocuments({ hostelId: hostel._id, isDeleted: false, status: { $ne: "MOVED_OUT" } }),
        ComplaintModel.countDocuments({ hostelId: hostel._id, status: { $in: ["PENDING", "IN_PROGRESS"] } }),
        collectionTotals({ hostelId: hostel._id, period }),
      ]);
      const beds = hostel.capacitySummary?.totalBeds ?? 0;
      const vacant = hostel.capacitySummary?.vacantBeds ?? 0;

      return {
        beds,
        collected: money.paidAmount,
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
  rows.sort((a, b) => Number(a.isBranch) - Number(b.isBranch) || (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));

  return { hostels: rows, period };
}
