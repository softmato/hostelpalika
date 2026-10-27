import { createHash } from "node:crypto";

import { mongo, Types, type Model } from "mongoose";

import { AdmissionFormModel } from "@hostel/db/models/AdmissionForm";
import { AdmissionFormLinkModel } from "@hostel/db/models/AdmissionFormLink";
import { AttendanceAlertModel } from "@hostel/db/models/AttendanceAlert";
import { AttendanceLogModel } from "@hostel/db/models/AttendanceLog";
import { AuditLogModel } from "@hostel/db/models/AuditLog";
import { BookingModel } from "@hostel/db/models/Booking";
import { BookingPaymentModel } from "@hostel/db/models/BookingPayment";
import { BookingTransferModel } from "@hostel/db/models/BookingTransfer";
import { CommunityCommentModel } from "@hostel/db/models/CommunityComment";
import { CommunityPostModel } from "@hostel/db/models/CommunityPost";
import { CommunityReactionModel } from "@hostel/db/models/CommunityReaction";
import { ComplaintModel } from "@hostel/db/models/Complaint";
import { ComplaintAttachmentModel } from "@hostel/db/models/ComplaintAttachment";
import { ComplaintUpdateModel } from "@hostel/db/models/ComplaintUpdate";
import { CookAccountModel } from "@hostel/db/models/CookAccount";
import { CreditBalanceModel } from "@hostel/db/models/CreditBalance";
import { DepositRecordModel } from "@hostel/db/models/DepositRecord";
import { DepositRefundModel } from "@hostel/db/models/DepositRefund";
import { EmergencyContactModel } from "@hostel/db/models/EmergencyContact";
import { ExistingResidentListModel } from "@hostel/db/models/ExistingResidentList";
import { ExpenseModel } from "@hostel/db/models/Expense";
import { FeeScheduleModel } from "@hostel/db/models/FeeSchedule";
import { FileAssetModel } from "@hostel/db/models/FileAsset";
import { FoodFeedbackModel } from "@hostel/db/models/FoodFeedback";
import { FoodPhotoModel } from "@hostel/db/models/FoodPhoto";
import { FoodReadyLogModel } from "@hostel/db/models/FoodReadyLog";
import { FoodRoutineModel } from "@hostel/db/models/FoodRoutine";
import { GuardianModel } from "@hostel/db/models/Guardian";
import { GuardianAccessModel } from "@hostel/db/models/GuardianAccess";
import { GuardianPermissionModel } from "@hostel/db/models/GuardianPermission";
import { HostelModel } from "@hostel/db/models/Hostel";
import { HostelAgreementSignatureModel } from "@hostel/db/models/HostelAgreementSignature";
import { HostelApplicationModel } from "@hostel/db/models/HostelApplication";
import { HostelDocumentModel } from "@hostel/db/models/HostelDocument";
import { HostelExpenseCategoryModel } from "@hostel/db/models/HostelExpenseCategory";
import { HostelLeaveRequestModel } from "@hostel/db/models/HostelLeaveRequest";
import { HostelMemberModel } from "@hostel/db/models/HostelMember";
import { HostelPaymentProfileModel } from "@hostel/db/models/HostelPaymentProfile";
import { HostelPayoutAccountModel } from "@hostel/db/models/HostelPayoutAccount";
import { HostelRoomModel } from "@hostel/db/models/HostelRoom";
import { HostelSettingsModel } from "@hostel/db/models/HostelSettings";
import { HostelSubscriptionModel } from "@hostel/db/models/HostelSubscription";
import { HostelVerificationModel } from "@hostel/db/models/HostelVerification";
import { IncidentLogModel } from "@hostel/db/models/IncidentLog";
import { InquiryModel } from "@hostel/db/models/Inquiry";
import { InquiryNoteModel } from "@hostel/db/models/InquiryNote";
import { InvoiceModel } from "@hostel/db/models/Invoice";
import { InvoiceBalanceModel } from "@hostel/db/models/InvoiceBalance";
import { KhataEntryModel } from "@hostel/db/models/KhataEntry";
import { MaintenanceCommentModel } from "@hostel/db/models/MaintenanceComment";
import { MaintenanceHistoryModel } from "@hostel/db/models/MaintenanceHistory";
import { MaintenanceRequestModel } from "@hostel/db/models/MaintenanceRequest";
import { ManualStatusOverrideModel } from "@hostel/db/models/ManualStatusOverride";
import { MealCallReminderModel } from "@hostel/db/models/MealCallReminder";
import { MoveInChecklistModel } from "@hostel/db/models/MoveInChecklist";
import { MoveOutChecklistModel } from "@hostel/db/models/MoveOutChecklist";
import { NightStatusModel } from "@hostel/db/models/NightStatus";
import { NightStatusLogModel } from "@hostel/db/models/NightStatusLog";
import { NightStatusPromptModel } from "@hostel/db/models/NightStatusPrompt";
import { NoticeModel } from "@hostel/db/models/Notice";
import { NoticePushModel } from "@hostel/db/models/NoticePush";
import { OfferAwardModel } from "@hostel/db/models/OfferAward";
import { PaymentEventModel } from "@hostel/db/models/PaymentEvent";
import { PaymentIntentModel } from "@hostel/db/models/PaymentIntent";
import { ProvidedItemModel } from "@hostel/db/models/ProvidedItem";
import { QRActivationModel } from "@hostel/db/models/QRActivation";
import { RatingReviewModel } from "@hostel/db/models/RatingReview";
import { ReceiptModel } from "@hostel/db/models/Receipt";
import { ReceiptCounterModel } from "@hostel/db/models/ReceiptCounter";
import { RentConcessionModel } from "@hostel/db/models/RentConcession";
import { ResidentModel } from "@hostel/db/models/Resident";
import { ResidentApplicationModel } from "@hostel/db/models/ResidentApplication";
import { ResidentDocumentModel } from "@hostel/db/models/ResidentDocument";
import { ResidentJoinLinkModel } from "@hostel/db/models/ResidentJoinLink";
import { ResidentLeaveModel } from "@hostel/db/models/ResidentLeave";
import { RolePermissionModel } from "@hostel/db/models/RolePermission";
import { RoomChangeRequestModel } from "@hostel/db/models/RoomChangeRequest";
import { RoomConditionPhotoModel } from "@hostel/db/models/RoomConditionPhoto";
import { SOSAlertModel } from "@hostel/db/models/SOSAlert";
import { StatementImportModel } from "@hostel/db/models/StatementImport";
import { StockEntryModel } from "@hostel/db/models/StockEntry";
import { StockItemModel } from "@hostel/db/models/StockItem";
import { StockPaymentModel } from "@hostel/db/models/StockPayment";
import { StockSupplierModel } from "@hostel/db/models/StockSupplier";
import { StoreCartModel } from "@hostel/db/models/StoreCart";
import { StoreOrderModel } from "@hostel/db/models/StoreOrder";
import { SubscriptionInvoiceModel } from "@hostel/db/models/SubscriptionInvoice";
import { SubscriptionPaymentModel } from "@hostel/db/models/SubscriptionPayment";
import { UserModel } from "@hostel/db/models/User";

/**
 * One hostel's data, everything of it, for its own encrypted backup
 * (docs/FIELD_REVIEW_2026_10_27.md I3).
 *
 * Unlike `hostel-leave-export.ts` (sheets for people), this is rows for a
 * restore: whole documents as Extended JSON, so ids and dates come back as the
 * types they left as.
 *
 * **Every collection that carries a hostel is listed here or in `EXCLUDED`** —
 * `tenant-export.test.ts` reads the models folder and fails on one that is in
 * neither, so a new model cannot silently miss the backup.
 *
 * Scope is decided here, never by the caller's data: the root hostel plus its
 * branches when it is a main hostel; a branch exports only itself. Each
 * collection is read with its tenant key `$in` those ids and nothing else.
 *
 * File bytes (photos, documents) stay in our storage; the backup holds their
 * `FileAsset` records.
 */

export const TENANT_EXPORT_FORMAT = "hostelpalika-tenant-export";
export const TENANT_EXPORT_VERSION = 1;

type TenantKey = "hostelId" | "groupHostelId" | "hostelIds" | "_id";

export type TenantCollection = {
  key: TenantKey;
  model: Model<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  name: string;
  /** Restore may add missing rows back. False = platform state the hostel cannot write. */
  restore: boolean;
};

const ops = (name: string, model: TenantCollection["model"], key: TenantKey = "hostelId"): TenantCollection => ({
  key,
  model,
  name,
  restore: true,
});
const record = (name: string, model: TenantCollection["model"], key: TenantKey = "hostelId"): TenantCollection => ({
  key,
  model,
  name,
  restore: false,
});

/** Hostel operations — exported, and restorable. */
export const TENANT_COLLECTIONS: TenantCollection[] = [
  // Residents and joining
  ops("Resident", ResidentModel),
  ops("ResidentApplication", ResidentApplicationModel),
  ops("ResidentDocument", ResidentDocumentModel),
  ops("ResidentJoinLink", ResidentJoinLinkModel),
  ops("ResidentLeave", ResidentLeaveModel),
  ops("AdmissionForm", AdmissionFormModel),
  ops("AdmissionFormLink", AdmissionFormLinkModel),
  ops("ExistingResidentList", ExistingResidentListModel),
  ops("EmergencyContact", EmergencyContactModel),
  ops("Guardian", GuardianModel),
  ops("GuardianAccess", GuardianAccessModel),
  ops("GuardianPermission", GuardianPermissionModel),
  ops("MoveInChecklist", MoveInChecklistModel),
  ops("MoveOutChecklist", MoveOutChecklistModel),
  ops("QRActivation", QRActivationModel),
  ops("Booking", BookingModel),
  ops("BookingPayment", BookingPaymentModel),
  ops("BookingTransfer", BookingTransferModel),
  ops("Inquiry", InquiryModel),
  ops("InquiryNote", InquiryNoteModel),
  // Rooms
  ops("HostelRoom", HostelRoomModel),
  ops("RoomChangeRequest", RoomChangeRequestModel),
  ops("RoomConditionPhoto", RoomConditionPhotoModel),
  ops("ProvidedItem", ProvidedItemModel),
  // Money
  ops("Invoice", InvoiceModel),
  ops("InvoiceBalance", InvoiceBalanceModel),
  ops("PaymentEvent", PaymentEventModel),
  ops("Receipt", ReceiptModel),
  ops("ReceiptCounter", ReceiptCounterModel),
  ops("DepositRecord", DepositRecordModel),
  ops("DepositRefund", DepositRefundModel),
  ops("CreditBalance", CreditBalanceModel),
  ops("FeeSchedule", FeeScheduleModel),
  ops("RentConcession", RentConcessionModel),
  ops("KhataEntry", KhataEntryModel),
  ops("Expense", ExpenseModel),
  ops("HostelExpenseCategory", HostelExpenseCategoryModel),
  ops("StatementImport", StatementImportModel),
  // Stock — items and suppliers belong to the group (main hostel)
  ops("StockEntry", StockEntryModel),
  ops("StockPayment", StockPaymentModel),
  ops("StockItem", StockItemModel, "groupHostelId"),
  ops("StockSupplier", StockSupplierModel, "groupHostelId"),
  // Staff and settings
  ops("HostelMember", HostelMemberModel),
  ops("CookAccount", CookAccountModel),
  ops("RolePermission", RolePermissionModel),
  ops("HostelSettings", HostelSettingsModel),
  ops("HostelDocument", HostelDocumentModel),
  ops("FileAsset", FileAssetModel),
  // Daily life
  ops("AttendanceLog", AttendanceLogModel),
  ops("AttendanceAlert", AttendanceAlertModel),
  ops("ManualStatusOverride", ManualStatusOverrideModel),
  ops("NightStatus", NightStatusModel),
  ops("NightStatusLog", NightStatusLogModel),
  ops("NightStatusPrompt", NightStatusPromptModel),
  ops("Complaint", ComplaintModel),
  ops("ComplaintAttachment", ComplaintAttachmentModel),
  ops("ComplaintUpdate", ComplaintUpdateModel),
  ops("MaintenanceRequest", MaintenanceRequestModel),
  ops("MaintenanceComment", MaintenanceCommentModel),
  ops("MaintenanceHistory", MaintenanceHistoryModel),
  ops("IncidentLog", IncidentLogModel),
  ops("SOSAlert", SOSAlertModel),
  ops("Notice", NoticeModel),
  ops("NoticePush", NoticePushModel),
  ops("CommunityPost", CommunityPostModel),
  ops("CommunityComment", CommunityCommentModel),
  ops("CommunityReaction", CommunityReactionModel),
  ops("FoodRoutine", FoodRoutineModel),
  ops("FoodReadyLog", FoodReadyLogModel),
  ops("FoodPhoto", FoodPhotoModel),
  ops("FoodFeedback", FoodFeedbackModel),
  ops("MealCallReminder", MealCallReminderModel),

  // The hostel's record with us — exported so the owner has it, never restored.
  record("Hostel", HostelModel, "_id"),
  record("User", UserModel, "hostelIds"),
  record("AuditLog", AuditLogModel),
  record("HostelSubscription", HostelSubscriptionModel),
  record("SubscriptionInvoice", SubscriptionInvoiceModel),
  record("SubscriptionPayment", SubscriptionPaymentModel),
  record("HostelVerification", HostelVerificationModel),
  record("HostelApplication", HostelApplicationModel),
  record("HostelAgreementSignature", HostelAgreementSignatureModel),
  record("HostelLeaveRequest", HostelLeaveRequestModel),
  record("HostelPaymentProfile", HostelPaymentProfileModel),
  record("HostelPayoutAccount", HostelPayoutAccountModel),
  record("PaymentIntent", PaymentIntentModel),
  record("OfferAward", OfferAwardModel),
  record("RatingReview", RatingReviewModel),
  record("StoreCart", StoreCartModel),
  record("StoreOrder", StoreOrderModel),
];

/** Users: who they are and their role here — never a credential. */
export const USER_FIELDS = "name firstName lastName email phone role status hostelIds createdAt updatedAt";

/** Collections that carry a hostel but are not the hostel's to take, and why. */
export const EXCLUDED: Record<string, string> = {
  AccountDeletionRequest: "a person's request to us, not the hostel's",
  CommunityReport: "names who reported a post",
  ConsentLog: "our legal record of a person's consent",
  DuplicateCheckResult: "our fraud check",
  EncryptedSecret: "server-held gateway secrets",
  Feedback: "feedback sent to us",
  FreePlanClaim: "our plan bookkeeping",
  HostelBackup: "the backup's own settings and sealed Drive token",
  HostelBackupRun: "the backup's own history",
  HostelListingImpression: "our listing analytics",
  HostelPageView: "our listing analytics",
  HostelReferralCode: "our referral programme",
  ListingFlag: "names who flagged the listing",
  Notification: "per-person inbox, rebuilt by use",
  NotificationCampaign: "our own campaigns",
  QuestionCallClick: "our partner analytics",
  ReconciliationRun: "our nightly checks",
  Referral: "our referral programme",
  ReferralCode: "our referral programme",
  ReferralReward: "our referral programme",
  ReviewModerationLog: "our moderation record",
  TeamPrepayment: "our field-sales ledger",
  TeamWalletEntry: "our field-sales ledger",
};

type Doc = Record<string, unknown>;

/** Where rows come from. Mongo in production; an array in the leak test. */
export type TenantSource = {
  find(entry: TenantCollection, filter: Doc, projection: string | null): Promise<Doc[]>;
};

export const mongoSource: TenantSource = {
  find: (entry, filter, projection) => {
    const query = entry.model.find(filter);

    if (projection) query.select(projection);

    return query.lean<Doc[]>().exec();
  },
};

/** The root hostel plus, for a main hostel, its branches. */
export async function tenantHostelIds(rootHostelId: Types.ObjectId, source: TenantSource = mongoSource) {
  const root = TENANT_COLLECTIONS.find((entry) => entry.name === "Hostel")!;
  const [hostel] = await source.find(root, { _id: rootHostelId }, "parentHostelId");

  if (!hostel) return [];
  if (hostel.parentHostelId) return [rootHostelId];

  const branches = await source.find(root, { parentHostelId: rootHostelId }, "_id");

  return [rootHostelId, ...branches.map((branch) => branch._id as Types.ObjectId)];
}

export type TenantExport = {
  collections: Record<string, Doc[]>;
  counts: Record<string, number>;
  createdAt: string;
  format: typeof TENANT_EXPORT_FORMAT;
  hostelId: string;
  hostelIds: string[];
  version: typeof TENANT_EXPORT_VERSION;
};

export async function buildTenantExport(
  rootHostelId: Types.ObjectId,
  source: TenantSource = mongoSource,
  now = new Date(),
): Promise<TenantExport> {
  const ids = await tenantHostelIds(rootHostelId, source);

  if (ids.length === 0) {
    throw Object.assign(new Error("Hostel was not found."), { errorCode: "HOSTEL_NOT_FOUND", status: 404 });
  }

  const collections: Record<string, Doc[]> = {};
  const counts: Record<string, number> = {};

  for (const entry of TENANT_COLLECTIONS) {
    // `select: false` fields (code hashes, invite tokens) stay out on their own.
    const projection = entry.name === "User" ? USER_FIELDS : null;
    const rows = await source.find(entry, { [entry.key]: { $in: ids } }, projection);

    // A person working at two hostels: keep only this hostel's ids on their row.
    if (entry.key === "hostelIds") {
      const own = new Set(ids.map(String));

      for (const row of rows) row.hostelIds = (row.hostelIds as unknown[]).filter((id) => own.has(String(id)));
    }

    collections[entry.name] = rows;
    counts[entry.name] = rows.length;
  }

  return {
    collections,
    counts,
    createdAt: now.toISOString(),
    format: TENANT_EXPORT_FORMAT,
    hostelId: rootHostelId.toString(),
    hostelIds: ids.map(String),
    version: TENANT_EXPORT_VERSION,
  };
}

/**
 * Restore sends rows back a chunk at a time (a request body on Vercel is capped
 * at 4.5 MB), so the archive is cut into chunks here and each chunk's hash is
 * recorded with the run. A chunk is an Extended JSON string kept verbatim, so
 * the phone can hand it back byte for byte and the server can check it.
 */
export const CHUNK_BYTES = 1_000_000;

export type PackedChunk = { collection: string; index: number; rows: number; sha256: string };

export type PackedArchive = Omit<TenantExport, "collections"> & {
  chunks: Array<{ collection: string; data: string; index: number }>;
};

export function packTenantExport(data: TenantExport) {
  const { collections, ...meta } = data;
  const archive: PackedArchive = { ...meta, chunks: [] };
  const chunks: PackedChunk[] = [];

  for (const [collection, rows] of Object.entries(collections)) {
    let parts: string[] = [];
    let size = 0;
    const flush = () => {
      if (!parts.length) return;

      const text = `[${parts.join(",")}]`;
      const index = chunks.filter((chunk) => chunk.collection === collection).length;

      archive.chunks.push({ collection, data: text, index });
      chunks.push({ collection, index, rows: parts.length, sha256: sha256Hex(Buffer.from(text, "utf8")) });
      parts = [];
      size = 0;
    };

    for (const row of rows) {
      const text = mongo.BSON.EJSON.stringify(row, { relaxed: false });

      if (size + text.length > CHUNK_BYTES) flush();
      parts.push(text);
      size += text.length;
    }

    flush();
  }

  return { bytes: Buffer.from(JSON.stringify(archive), "utf8"), chunks };
}

/** One chunk's rows, with ObjectIds and Dates restored. */
export function parseChunk(data: string): Doc[] {
  return mongo.BSON.EJSON.parse(data, { relaxed: false }) as Doc[];
}

export const sha256Hex = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
