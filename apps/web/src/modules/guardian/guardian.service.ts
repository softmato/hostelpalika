import { Types } from "mongoose";

import type { ApiPrincipal } from "@/lib/api-auth";
import { connectToDatabase } from "@/lib/db";
import { ComplaintModel } from "@hostel/db/models/Complaint";
import { GuardianAccessModel } from "@hostel/db/models/GuardianAccess";
import { GuardianModel } from "@hostel/db/models/Guardian";
import { getFoodRoutine, mealsOn } from "@/modules/food/food-routine.service";
import { GuardianPermissionModel } from "@hostel/db/models/GuardianPermission";
import { HostelModel } from "@hostel/db/models/Hostel";
import { NightStatusModel } from "@hostel/db/models/NightStatus";
import { NoticeModel } from "@hostel/db/models/Notice";
import {
  listResidentInvoices,
  type LedgerInvoice,
} from "@/modules/finance/ledger-read.service";
import { ReceiptModel } from "@hostel/db/models/Receipt";
import { ResidentModel } from "@hostel/db/models/Resident";
import {
  findResidentAvatars,
  normalizeObjectId,
} from "@/modules/residents/resident-access";

type GuardianRecord = {
  _id: Types.ObjectId;
  email?: string;
  firstName: string;
  hostelId: Types.ObjectId;
  lastName: string;
  phone: string;
  relation: string;
  residentId: Types.ObjectId;
};

type GuardianAccessRecord = {
  _id: Types.ObjectId;
  accessCode: string;
  allowComplaintStatus: boolean;
  expiresAt: Date;
  guardianId: Types.ObjectId;
  hostelId: Types.ObjectId;
  phone: string;
  residentId: Types.ObjectId;
  status: "ACTIVE" | "USED" | "REVOKED" | "EXPIRED";
  userId?: Types.ObjectId;
};

type GuardianPermissionRecord = {
  canViewComplaintStatus: boolean;
  canViewFood: boolean;
  canViewNotices: boolean;
  canViewPayments: boolean;
  canViewReceipts: boolean;
  canViewSafety: boolean;
};

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
  userId?: Types.ObjectId;
};

export class GuardianServiceError extends Error {
  constructor(
    message: string,
    public errorCode = "GUARDIAN_ERROR",
    public status = 400,
  ) {
    super(message);
  }
}

function serializeGuardianAccess(access: GuardianAccessRecord) {
  return {
    expiresAt: access.expiresAt.toISOString(),
    guardianId: access.guardianId.toString(),
    hostelId: access.hostelId.toString(),
    id: access._id.toString(),
    phone: access.phone,
    residentId: access.residentId.toString(),
    status: access.status,
    userId: access.userId?.toString(),
  };
}

async function loadGuardianAccess(principal: ApiPrincipal) {
  // One account can hold several access rows — a guardian invited again after
  // their ward was deleted and re-registered keeps the old USED row too. Newest
  // first, and the first whose ward is still on the books wins: an unsorted
  // findOne kept handing back the dead link and 404ed a guardian who had a
  // perfectly good one.
  const accesses = (
    await GuardianAccessModel.find({
      status: { $in: ["ACTIVE", "USED"] },
      userId: normalizeObjectId(principal.userId, "user id"),
    })
      .sort({ createdAt: -1 })
      .lean<GuardianAccessRecord[]>()
  )
    // Out-of-scope rows are reported exactly like a genuine miss (RULES.md §3).
    .filter((access) => principal.hostelIds.includes(access.hostelId.toString()));

  if (accesses.length === 0) {
    throw new GuardianServiceError(
      "Guardian access was not found for this account.",
      "GUARDIAN_ACCESS_NOT_FOUND",
      404,
    );
  }

  for (const access of accesses) {
    const [resident, guardian] = await Promise.all([
      ResidentModel.findOne({
        _id: access.residentId,
        hostelId: access.hostelId,
        isDeleted: false,
      }).lean<ResidentRecord | null>(),
      GuardianModel.findOne({
        _id: access.guardianId,
        hostelId: access.hostelId,
        residentId: access.residentId,
      }).lean<GuardianRecord | null>(),
    ]);

    if (!resident || !guardian) {
      continue;
    }

    const permission = await GuardianPermissionModel.findOne({
      guardianAccessId: access._id,
    }).lean<GuardianPermissionRecord | null>();

    return {
      access,
      guardian,
      // Default-deny (PRD.md §10). A missing or partial permission document means
      // the resident has not shared that field, never "share everything" — the
      // guardian dashboard is opt-in field by field.
      permission: {
        canViewComplaintStatus:
          permission?.canViewComplaintStatus ?? access.allowComplaintStatus ?? false,
        canViewFood: permission?.canViewFood ?? false,
        canViewNotices: permission?.canViewNotices ?? false,
        canViewPayments: permission?.canViewPayments ?? false,
        canViewReceipts: permission?.canViewReceipts ?? false,
        canViewSafety: permission?.canViewSafety ?? false,
      },
      resident,
    };
  }

  throw new GuardianServiceError(
    "Guardian resident link was not found.",
    "GUARDIAN_LINK_NOT_FOUND",
    404,
  );
}

function serializePayment(payment: LedgerInvoice) {
  return {
    dueAmount: payment.dueAmount,
    dueDate: payment.dueDate?.toISOString(),
    id: payment.id,
    month: payment.period,
    paidAmount: payment.paidAmount,
    status: payment.status,
  };
}

export async function getGuardianDashboard(principal: ApiPrincipal) {
  await connectToDatabase();

  const { access, guardian, permission, resident } = await loadGuardianAccess(principal);
  // Each query is gated by its own permission flag rather than fetched and
  // filtered afterwards: a field the resident did not share is never read out
  // of the database at all, so it cannot leak through a serializer mistake.
  const [hostel, payments, notices, food, nightStatus, complaints, receipts] =
    await Promise.all([
      HostelModel.findOne({ _id: access.hostelId, isDeleted: false }).lean<{
        _id: Types.ObjectId;
        contact?: { email?: string; phone?: string };
        name: string;
        location?: Record<string, unknown>;
        photos?: Array<{ kind?: string; url?: string }>;
        slug?: string;
        status?: string;
        verificationStatus?: string;
      } | null>(),
      permission.canViewPayments
        ? listResidentInvoices(
            { hostelId: access.hostelId, residentId: access.residentId },
            { limit: 6 },
          )
        : Promise.resolve<LedgerInvoice[]>([]),
      permission.canViewNotices
        ? NoticeModel.find({
            hostelId: access.hostelId,
            targetAudience: { $in: ["ALL", "GUARDIANS"] },
          })
            .sort({ isUrgent: -1, publishedAt: -1 })
            .limit(5)
            .lean<
              Array<{
                _id: Types.ObjectId;
                title: string;
                content: string;
                category: string;
                isUrgent: boolean;
              }>
            >()
        : Promise.resolve([]),
      permission.canViewFood ? getFoodRoutine(access.hostelId) : Promise.resolve(null),
      permission.canViewSafety
        ? NightStatusModel.findOne({ residentId: resident._id }).lean<{
            checkedAt: Date;
            status: string;
          } | null>()
        : Promise.resolve(null),
      permission.canViewComplaintStatus
        ? ComplaintModel.find({
            hostelId: access.hostelId,
            residentId: access.residentId,
          })
            .sort({ createdAt: -1 })
            .limit(5)
            .lean<Array<{ _id: Types.ObjectId; status: string; title: string }>>()
        : Promise.resolve([]),
      permission.canViewReceipts
        ? ReceiptModel.find({
            hostelId: access.hostelId,
            residentId: access.residentId,
          })
            .sort({ issuedAt: -1 })
            .limit(12)
            .lean<
              Array<{
                _id: Types.ObjectId;
                amount: number;
                issuedAt: Date;
                month: string;
                receiptNumber: string;
              }>
            >()
        : Promise.resolve([]),
    ]);
  const dueAmount = payments.reduce(
    (sum, payment) =>
      ["UNPAID", "PARTIAL", "OVERDUE", "PENDING_PROOF"].includes(payment.status)
        ? sum + Math.max(payment.dueAmount - payment.paidAmount, 0)
        : sum,
    0,
  );

  return {
    dashboard: {
      access: serializeGuardianAccess(access),
      complaints: complaints.map((complaint) => ({
        id: complaint._id.toString(),
        status: complaint.status,
        title: complaint.title,
      })),
      // Today's meals off the weekly routine — a guardian wants "what are they
      // eating", not the whole week.
      food: food ? mealsOn(food, new Date()) : [],
      guardian: {
        id: guardian._id.toString(),
        name: `${guardian.firstName} ${guardian.lastName}`.trim(),
        phone: guardian.phone,
        relation: guardian.relation,
      },
      hostel: hostel
        ? {
            // The office's own published number, already on the public listing.
            // A guardian dashboard that says "24/7 emergency helpline" and then
            // has no number to dial is worse than not offering the row at all.
            contact: {
              email: hostel.contact?.email ?? "",
              phone: hostel.contact?.phone ?? "",
            },
            id: hostel._id.toString(),
            // Reported, not assumed: the dashboard used to draw a "Verified"
            // badge on every hostel it rendered.
            isVerified: hostel.verificationStatus === "VERIFIED",
            location: hostel.location ?? {},
            name: hostel.name,
            // The building, not a bedroom — the same cover the resident
            // dashboard and the public listing lead with. Any photo beats none.
            photoUrl:
              ((hostel.photos ?? []).find(
                (photo) => photo.kind === "EXTERIOR" && photo.url,
              ) ?? (hostel.photos ?? [])[0])?.url ?? "",
            // Only when there is actually a page to open: /hostels/{slug} serves
            // published + verified listings and 404s on everything else.
            slug:
              hostel.status === "PUBLISHED" &&
              hostel.verificationStatus === "VERIFIED" &&
              hostel.slug
                ? hostel.slug
                : "",
          }
        : null,
      notices: notices.map((notice) => ({
        category: notice.category,
        content: notice.content,
        id: notice._id.toString(),
        isUrgent: notice.isUrgent,
        title: notice.title,
      })),
      payments: payments.map(serializePayment),
      permissions: permission,
      receipts: receipts.map((receipt) => ({
        amount: receipt.amount,
        id: receipt._id.toString(),
        issuedOn: receipt.issuedAt.toISOString().slice(0, 10),
        month: receipt.month,
        receiptNumber: receipt.receiptNumber,
      })),
      // A guardian gets the resident's identity and room, never their deposit,
      // contact details or account linkage (PRD.md §10). Their photograph is
      // part of that identity — it is their own child's face, and it is the
      // picture the resident chose for themselves.
      resident: {
        fullName: `${resident.firstName} ${resident.lastName}`.trim(),
        id: resident._id.toString(),
        image: resident.userId
          ? ((await findResidentAvatars([resident])).get(resident.userId.toString()) ??
            null)
          : null,
        roomType: resident.roomType,
        status: resident.status,
      },
      // Day-level only. `checkedAt` is deliberately truncated to a date: the
      // exact time a resident was checked is the sort of surveillance detail
      // §4.1 forbids showing a guardian.
      safety: permission.canViewSafety
        ? {
            asOf: nightStatus?.checkedAt.toISOString().slice(0, 10) ?? null,
            status: nightStatus?.status ?? "NOT_VERIFIED",
          }
        : null,
      summary: permission.canViewPayments
        ? {
            dueAmount,
            unpaidCount: payments.filter((payment) =>
              ["UNPAID", "PARTIAL", "OVERDUE", "PENDING_PROOF"].includes(payment.status),
            ).length,
          }
        : null,
    },
  };
}

export async function listGuardianPayments(principal: ApiPrincipal) {
  const result = await getGuardianDashboard(principal);

  return {
    payments: result.dashboard.payments,
    receipts: result.dashboard.receipts,
    summary: result.dashboard.summary,
  };
}

export async function listGuardianNotices(principal: ApiPrincipal) {
  const result = await getGuardianDashboard(principal);

  return { notices: result.dashboard.notices };
}

export async function listGuardianFood(principal: ApiPrincipal) {
  const result = await getGuardianDashboard(principal);

  return { food: result.dashboard.food };
}

export async function getGuardianSafetySummary(principal: ApiPrincipal) {
  const result = await getGuardianDashboard(principal);

  return {
    complaints: result.dashboard.complaints,
    safety: result.dashboard.safety,
  };
}
