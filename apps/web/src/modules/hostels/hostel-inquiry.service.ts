import { Types } from "mongoose";

import type { ApiPrincipal } from "@/lib/api-auth";
import { connectToDatabase } from "@/lib/db";
import { paginationMeta, paginationRange } from "@/lib/pagination";
import { AuditLogModel } from "@hostel/db/models/AuditLog";
import { InquiryModel } from "@hostel/db/models/Inquiry";
import { InquiryNoteModel } from "@hostel/db/models/InquiryNote";
import type {
  hostelAdminInquiryListQuerySchema,
  hostelAdminInquiryStatusSchema,
  inquiryNoteCreateSchema,
} from "@/lib/hostels/hostel.validation";
import {
  HostelServiceError,
  normalizeObjectId,
  scopedHostelFilter,
} from "@/modules/hostels/hostel.service";
import type { z } from "zod";

type HostelAdminInquiryListQuery = z.infer<typeof hostelAdminInquiryListQuerySchema>;
type HostelAdminInquiryStatusInput = z.infer<typeof hostelAdminInquiryStatusSchema>;
type InquiryNoteCreateInput = z.infer<typeof inquiryNoteCreateSchema>;

type InquiryStatus = "NEW" | "CONTACTED" | "VISIT_SCHEDULED" | "CONVERTED" | "CLOSED";

type InquiryRecord = {
  _id: Types.ObjectId;
  budgetRange?: string;
  createdAt?: Date;
  email?: string;
  gender?: string;
  hostelId: Types.ObjectId;
  message?: string;
  name: string;
  phone: string;
  preferredRoomType?: string;
  preferredVisitDate?: Date;
  source: "PUBLIC_WEBSITE" | "ADMIN_CREATED";
  status: InquiryStatus;
  updatedAt?: Date;
};

type InquiryNoteRecord = {
  _id: Types.ObjectId;
  authorId: Types.ObjectId;
  createdAt?: Date;
  hostelId: Types.ObjectId;
  inquiryId: Types.ObjectId;
  nextFollowUpAt?: Date;
  note: string;
  statusSnapshot?: InquiryStatus;
};

function serializeInquiry(inquiry: InquiryRecord) {
  return {
    budgetRange: inquiry.budgetRange ?? "",
    createdAt: inquiry.createdAt?.toISOString(),
    email: inquiry.email ?? "",
    gender: inquiry.gender ?? "",
    hostelId: inquiry.hostelId.toString(),
    id: inquiry._id.toString(),
    message: inquiry.message ?? "",
    name: inquiry.name,
    phone: inquiry.phone,
    preferredRoomType: inquiry.preferredRoomType ?? "",
    preferredVisitDate: inquiry.preferredVisitDate?.toISOString(),
    source: inquiry.source,
    status: inquiry.status,
    updatedAt: inquiry.updatedAt?.toISOString(),
  };
}

function serializeInquiryNote(note: InquiryNoteRecord) {
  return {
    authorId: note.authorId.toString(),
    createdAt: note.createdAt?.toISOString(),
    hostelId: note.hostelId.toString(),
    id: note._id.toString(),
    inquiryId: note.inquiryId.toString(),
    nextFollowUpAt: note.nextFollowUpAt?.toISOString(),
    note: note.note,
    statusSnapshot: note.statusSnapshot,
  };
}

async function findScopedInquiry(
  inquiryId: string,
  principal: ApiPrincipal,
  requestedHostelId?: string,
) {
  const inquiry = await InquiryModel.findOne({
    _id: normalizeObjectId(inquiryId),
    isDeleted: false,
    ...scopedHostelFilter(principal, requestedHostelId),
  }).lean<InquiryRecord | null>();

  if (!inquiry) {
    throw new HostelServiceError("Inquiry was not found.", "INQUIRY_NOT_FOUND", 404);
  }

  return inquiry;
}

async function auditInquiryAction(
  principal: ApiPrincipal,
  inquiry: InquiryRecord,
  action: string,
  metadata: Record<string, unknown> = {},
) {
  await AuditLogModel.create({
    action,
    actorId: principal.userId,
    entityId: inquiry._id.toString(),
    entityType: "Inquiry",
    hostelId: inquiry.hostelId,
    metadata,
  });
}

export async function listHostelAdminInquiries(
  query: HostelAdminInquiryListQuery,
  principal: ApiPrincipal,
) {
  await connectToDatabase();

  const filter: Record<string, unknown> = {
    isDeleted: false,
    ...scopedHostelFilter(principal, query.hostelId),
  };

  if (query.status) {
    filter.status = query.status;
  }

  const { limit, skip } = paginationRange(query);

  const [inquiries, total] = await Promise.all([
    InquiryModel.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean<InquiryRecord[]>(),
    InquiryModel.countDocuments(filter),
  ]);

  return {
    inquiries: inquiries.map(serializeInquiry),
    pagination: paginationMeta(query, total),
  };
}

export async function updateHostelAdminInquiryStatus(
  inquiryId: string,
  input: HostelAdminInquiryStatusInput,
  principal: ApiPrincipal,
) {
  await connectToDatabase();

  const inquiry = await findScopedInquiry(inquiryId, principal, input.hostelId);
  const updatedInquiry = await InquiryModel.findOneAndUpdate(
    { _id: inquiry._id, isDeleted: false },
    {
      $set: {
        status: input.status,
        updatedBy: principal.userId,
      },
    },
    { new: true },
  ).lean<InquiryRecord | null>();

  if (!updatedInquiry) {
    throw new HostelServiceError("Inquiry was not found.", "INQUIRY_NOT_FOUND", 404);
  }

  await auditInquiryAction(principal, inquiry, "INQUIRY_STATUS_UPDATED", {
    inquiryId: inquiry._id.toString(),
    status: input.status,
  });

  return {
    inquiry: serializeInquiry(updatedInquiry),
  };
}

export async function addHostelAdminInquiryNote(
  inquiryId: string,
  input: InquiryNoteCreateInput,
  principal: ApiPrincipal,
) {
  await connectToDatabase();

  const inquiry = await findScopedInquiry(inquiryId, principal, input.hostelId);
  const note = await InquiryNoteModel.create({
    authorId: principal.userId,
    hostelId: inquiry.hostelId,
    inquiryId: inquiry._id,
    nextFollowUpAt: input.nextFollowUpAt,
    note: input.note,
    statusSnapshot: inquiry.status,
  });

  await auditInquiryAction(principal, inquiry, "INQUIRY_NOTE_ADDED", {
    inquiryId: inquiry._id.toString(),
    noteId: note._id.toString(),
  });

  return {
    inquiry: serializeInquiry(inquiry),
    note: serializeInquiryNote(note),
  };
}
