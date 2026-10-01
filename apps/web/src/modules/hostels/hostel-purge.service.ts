import type { Types } from "mongoose";

import type { ApiPrincipal } from "@/lib/api-auth";
import { connectToDatabase } from "@/lib/db";
import { deleteFromR2 } from "@/lib/r2";
import { HostelServiceError, normalizeObjectId } from "@/modules/hostels/hostel.service";
import { AccountDeletionRequestModel } from "@hostel/db/models/AccountDeletionRequest";
import { AttendanceAlertModel } from "@hostel/db/models/AttendanceAlert";
import { AttendanceLogModel } from "@hostel/db/models/AttendanceLog";
import { AuditLogModel } from "@hostel/db/models/AuditLog";
import { CommunityCommentModel } from "@hostel/db/models/CommunityComment";
import { CommunityCommentVoteModel } from "@hostel/db/models/CommunityCommentVote";
import { CommunityPostModel } from "@hostel/db/models/CommunityPost";
import { CommunityReactionModel } from "@hostel/db/models/CommunityReaction";
import { CommunityReportModel } from "@hostel/db/models/CommunityReport";
import { ComplaintModel } from "@hostel/db/models/Complaint";
import { ComplaintAttachmentModel } from "@hostel/db/models/ComplaintAttachment";
import { ComplaintUpdateModel } from "@hostel/db/models/ComplaintUpdate";
import { ConsentLogModel } from "@hostel/db/models/ConsentLog";
import { CookAccountModel } from "@hostel/db/models/CookAccount";
import { CreditBalanceModel } from "@hostel/db/models/CreditBalance";
import { DepositRecordModel } from "@hostel/db/models/DepositRecord";
import { DepositRefundModel } from "@hostel/db/models/DepositRefund";
import { DuplicateCheckResultModel } from "@hostel/db/models/DuplicateCheckResult";
import { EmergencyContactModel } from "@hostel/db/models/EmergencyContact";
import { EncryptedSecretModel } from "@hostel/db/models/EncryptedSecret";
import { ExistingResidentListModel } from "@hostel/db/models/ExistingResidentList";
import { ResidentApplicationModel } from "@hostel/db/models/ResidentApplication";
import { ResidentJoinLinkModel } from "@hostel/db/models/ResidentJoinLink";
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
import { HostelApplicationModel } from "@hostel/db/models/HostelApplication";
import { HostelDocumentModel } from "@hostel/db/models/HostelDocument";
import { HostelListingImpressionModel } from "@hostel/db/models/HostelListingImpression";
import { HostelMemberModel } from "@hostel/db/models/HostelMember";
import { HostelPageViewModel } from "@hostel/db/models/HostelPageView";
import { HostelPaymentProfileModel } from "@hostel/db/models/HostelPaymentProfile";
import { HostelPayoutAccountModel } from "@hostel/db/models/HostelPayoutAccount";
import { HostelSettingsModel } from "@hostel/db/models/HostelSettings";
import { HostelSubscriptionModel } from "@hostel/db/models/HostelSubscription";
import { HostelVerificationModel } from "@hostel/db/models/HostelVerification";
import { IncidentLogModel } from "@hostel/db/models/IncidentLog";
import { InquiryModel } from "@hostel/db/models/Inquiry";
import { InquiryNoteModel } from "@hostel/db/models/InquiryNote";
import { InvoiceModel } from "@hostel/db/models/Invoice";
import { InvoiceBalanceModel } from "@hostel/db/models/InvoiceBalance";
import { ListingFlagModel } from "@hostel/db/models/ListingFlag";
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
import { NoticeReadStatusModel } from "@hostel/db/models/NoticeReadStatus";
import { NotificationModel } from "@hostel/db/models/Notification";
import { NotificationCampaignModel } from "@hostel/db/models/NotificationCampaign";
import { PaymentEventModel } from "@hostel/db/models/PaymentEvent";
import { PaymentIntentModel } from "@hostel/db/models/PaymentIntent";
import { ProvidedItemModel } from "@hostel/db/models/ProvidedItem";
import { QRActivationModel } from "@hostel/db/models/QRActivation";
import { QuestionCallClickModel } from "@hostel/db/models/QuestionCallClick";
import { RatingReviewModel } from "@hostel/db/models/RatingReview";
import { OfferAwardModel } from "@hostel/db/models/OfferAward";
import { ReceiptModel } from "@hostel/db/models/Receipt";
import { ReceiptCounterModel } from "@hostel/db/models/ReceiptCounter";
import { ReconciliationRunModel } from "@hostel/db/models/ReconciliationRun";
import { ReferralModel } from "@hostel/db/models/Referral";
import { HostelReferralCodeModel } from "@hostel/db/models/HostelReferralCode";
import { ReferralCodeModel } from "@hostel/db/models/ReferralCode";
import { ReferralRewardModel } from "@hostel/db/models/ReferralReward";
import { RentConcessionModel } from "@hostel/db/models/RentConcession";
import { ResidentModel } from "@hostel/db/models/Resident";
import { ResidentDocumentModel } from "@hostel/db/models/ResidentDocument";
import { ReviewModerationLogModel } from "@hostel/db/models/ReviewModerationLog";
import { RolePermissionModel } from "@hostel/db/models/RolePermission";
import { RoomConditionPhotoModel } from "@hostel/db/models/RoomConditionPhoto";
import { SOSAlertModel } from "@hostel/db/models/SOSAlert";
import { StatementImportModel } from "@hostel/db/models/StatementImport";
import { StoreCartModel } from "@hostel/db/models/StoreCart";
import { StoreOrderModel } from "@hostel/db/models/StoreOrder";
import { SubscriptionInvoiceModel } from "@hostel/db/models/SubscriptionInvoice";
import { SubscriptionPaymentModel } from "@hostel/db/models/SubscriptionPayment";
import { TeamPrepaymentModel } from "@hostel/db/models/TeamPrepayment";
import { UserModel } from "@hostel/db/models/User";

/**
 * Erasing an archived hostel.
 *
 * The archive is the reversible half; this is the half that is not. It runs
 * from the `hostel-purge` cron once the 60-day grace period is up, and from the
 * superadmin's explicit "purge now" on a hostel that is already archived.
 *
 * ## What is erased, and what is not
 *
 * Nearly everything. A hostel is not a user: its residents' records, its
 * ledger, its complaints, its food log and its photos exist *because* the
 * hostel exists, and once it is gone they describe nothing.
 *
 * That includes the platform's own money records for this hostel — its
 * subscription invoices, the cash its field agents collected, its supply-store
 * orders. `account-purge.service.ts` keeps the equivalent rows when a *person*
 * leaves, and deliberately so: a hostel's books are not the departing
 * resident's to erase. The reasoning inverts here. These are the platform
 * owner's own books, and the purge only ever runs because the platform owner
 * asked for it — twice, with a 60-day pause in between. Erasing your own
 * revenue record is a decision you are allowed to make about your own records.
 *
 * The one exception is {@link AuditLogModel}, which is kept and then written
 * to. It is the only remaining evidence that the hostel existed and that the
 * erasure was carried out on purpose.
 */

/**
 * The two operations this file performs, and nothing else.
 *
 * The models in `@hostel/db` are declared without generics, so Mongoose types
 * them as `Model<any>`; naming the two methods used here keeps the registry
 * arrays honest without an `any` cast per entry.
 */
type PurgeableModel = {
  deleteMany: (filter: Record<string, unknown>) => Promise<{ deletedCount?: number }>;
  updateMany: (
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
  ) => Promise<unknown>;
};

/**
 * Every collection erased for a purged hostel, keyed by the model's own name so
 * {@link hostelScopedModelNames} can be checked against it.
 *
 * Ordering matters in one place only — {@link FileAssetModel} is handled
 * separately, before this list runs, because its rows are pointers to bytes in
 * R2 and deleting the pointer first orphans the bytes forever.
 */
const ERASED_BY_HOSTEL_ID: Array<{ model: PurgeableModel; name: string }> = (
  [
    ["AttendanceAlert", AttendanceAlertModel],
    ["AttendanceLog", AttendanceLogModel],
    ["CommunityComment", CommunityCommentModel],
    ["CommunityPost", CommunityPostModel],
    ["CommunityReaction", CommunityReactionModel],
    ["CommunityReport", CommunityReportModel],
    ["Complaint", ComplaintModel],
    ["ComplaintAttachment", ComplaintAttachmentModel],
    ["ComplaintUpdate", ComplaintUpdateModel],
    ["ConsentLog", ConsentLogModel],
    ["CookAccount", CookAccountModel],
    ["CreditBalance", CreditBalanceModel],
    ["DepositRecord", DepositRecordModel],
    ["DepositRefund", DepositRefundModel],
    ["DuplicateCheckResult", DuplicateCheckResultModel],
    ["EmergencyContact", EmergencyContactModel],
    ["EncryptedSecret", EncryptedSecretModel],
    ["ExistingResidentList", ExistingResidentListModel],
    ["ResidentApplication", ResidentApplicationModel],
    ["ResidentJoinLink", ResidentJoinLinkModel],
    ["FeeSchedule", FeeScheduleModel],
    ["FileAsset", FileAssetModel],
    ["FoodFeedback", FoodFeedbackModel],
    ["FoodPhoto", FoodPhotoModel],
    ["FoodReadyLog", FoodReadyLogModel],
    ["FoodRoutine", FoodRoutineModel],
    ["Guardian", GuardianModel],
    ["GuardianAccess", GuardianAccessModel],
    ["GuardianPermission", GuardianPermissionModel],
    ["HostelApplication", HostelApplicationModel],
    ["HostelDocument", HostelDocumentModel],
    ["HostelListingImpression", HostelListingImpressionModel],
    ["HostelMember", HostelMemberModel],
    ["HostelPageView", HostelPageViewModel],
    ["HostelPaymentProfile", HostelPaymentProfileModel],
    ["HostelPayoutAccount", HostelPayoutAccountModel],
    ["HostelSettings", HostelSettingsModel],
    ["HostelSubscription", HostelSubscriptionModel],
    ["HostelVerification", HostelVerificationModel],
    ["IncidentLog", IncidentLogModel],
    ["Inquiry", InquiryModel],
    ["InquiryNote", InquiryNoteModel],
    ["Invoice", InvoiceModel],
    ["InvoiceBalance", InvoiceBalanceModel],
    ["ListingFlag", ListingFlagModel],
    ["MaintenanceComment", MaintenanceCommentModel],
    ["MaintenanceHistory", MaintenanceHistoryModel],
    ["MaintenanceRequest", MaintenanceRequestModel],
    ["ManualStatusOverride", ManualStatusOverrideModel],
    ["MealCallReminder", MealCallReminderModel],
    ["MoveInChecklist", MoveInChecklistModel],
    ["MoveOutChecklist", MoveOutChecklistModel],
    ["NightStatus", NightStatusModel],
    ["NightStatusLog", NightStatusLogModel],
    ["NightStatusPrompt", NightStatusPromptModel],
    ["Notice", NoticeModel],
    ["NoticePush", NoticePushModel],
    ["Notification", NotificationModel],
    ["NotificationCampaign", NotificationCampaignModel],
    ["OfferAward", OfferAwardModel],
    ["PaymentEvent", PaymentEventModel],
    ["PaymentIntent", PaymentIntentModel],
    ["ProvidedItem", ProvidedItemModel],
    ["QRActivation", QRActivationModel],
    ["QuestionCallClick", QuestionCallClickModel],
    ["RatingReview", RatingReviewModel],
    ["Receipt", ReceiptModel],
    ["ReceiptCounter", ReceiptCounterModel],
    ["ReconciliationRun", ReconciliationRunModel],
    ["Referral", ReferralModel],
    ["ReferralCode", ReferralCodeModel],
    // The hostel's own invite code. `HostelReferral` rows stay: a partner's commission is money.
    ["HostelReferralCode", HostelReferralCodeModel],
    ["ReferralReward", ReferralRewardModel],
    ["RentConcession", RentConcessionModel],
    ["Resident", ResidentModel],
    ["ResidentDocument", ResidentDocumentModel],
    ["ReviewModerationLog", ReviewModerationLogModel],
    ["RolePermission", RolePermissionModel],
    ["RoomConditionPhoto", RoomConditionPhotoModel],
    ["SOSAlert", SOSAlertModel],
    ["StatementImport", StatementImportModel],
    ["StoreCart", StoreCartModel],
    ["StoreOrder", StoreOrderModel],
    ["SubscriptionInvoice", SubscriptionInvoiceModel],
    ["SubscriptionPayment", SubscriptionPaymentModel],
    // A claimed one is the payment behind this hostel's first invoice, so it goes with it.
    ["TeamPrepayment", TeamPrepaymentModel],
  ] as Array<[string, PurgeableModel]>
).map(([name, model]) => ({ model, name }));

/**
 * Collections that carry a `hostelId` and are deliberately **not** erased.
 * Every entry needs a reason, because the alternative — a model quietly missing
 * from both lists — is how a purge leaves rows behind.
 */
export const RETAINED_BY_HOSTEL_ID: Record<string, string> = {
  AuditLog:
    "The record that this hostel existed and was erased on purpose. Erasing it would remove the only evidence the purge was authorised.",
  Booking:
    "HostelPalika's own money record: a fee a person paid us, under a numbered invoice and receipt. It belongs to the platform's accounts and to the person who booked, not to the hostel, and carries a snapshot of the hostel so it still reads after the hostel is gone.",
  BookingPayment:
    "The proof a person sent for a booking fee paid to HostelPalika, and who checked it. Part of the platform's payment trail.",
  BookingTransfer:
    "A refund or payout HostelPalika sent, with its transaction id and numbered document. Erasing it would leave money that left our account with no record of where it went.",
  FreePlanClaim:
    "The fingerprint of a building that has had its free months. Erasing it would let the same building register again and claim them a second time.",
  TeamWalletEntry:
    "A field agent's commission earned on this hostel, in the ledger their wallet balance is summed from. Erasing it would drop what they earned below payouts already sent to them.",
};

/** The models a purge touches by name — what {@link RETAINED_BY_HOSTEL_ID} is checked against. */
export const ERASED_MODEL_NAMES = ERASED_BY_HOSTEL_ID.map((entry) => entry.name);

/**
 * Collections holding a `hostelIds` **array** rather than a scalar. The hostel
 * is pulled out of the array; the document itself belongs to someone else and
 * survives. A `User` is a person, not a tenant of the hostel they happen to
 * live or work in.
 */
const PULLED_FROM_HOSTEL_IDS: Array<{ model: PurgeableModel; name: string }> = (
  [
    ["AccountDeletionRequest", AccountDeletionRequestModel],
    ["NotificationCampaign", NotificationCampaignModel],
    ["User", UserModel],
  ] as Array<[string, PurgeableModel]>
).map(([name, model]) => ({ model, name }));

type FileAssetRow = {
  _id: Types.ObjectId;
  bucket?: string;
  key?: string;
  variants?: Array<{ key?: string }>;
};

/**
 * Delete the hostel's bytes from R2 before the rows that point at them.
 *
 * An orphaned object is invisible — nothing left in the database names it, so
 * nothing will ever find it again, and it bills for storage forever. Failures
 * are counted and reported rather than thrown: one unreachable object must not
 * abort a purge and leave the hostel half-erased, and the rows are about to go
 * either way.
 */
async function deleteHostelObjects(hostelId: Types.ObjectId) {
  const assets = await FileAssetModel.find({ hostelId })
    .select("bucket key variants")
    .lean<FileAssetRow[]>();

  let deleted = 0;
  let failed = 0;

  for (const asset of assets) {
    if (!asset.bucket) {
      continue;
    }

    // The original plus every derived size. A thumbnail left behind is the same
    // orphan as the original, just cheaper.
    const keys = [asset.key, ...(asset.variants ?? []).map((variant) => variant.key)];

    for (const key of keys) {
      if (!key) {
        continue;
      }

      try {
        await deleteFromR2(asset.bucket, key);
        deleted += 1;
      } catch {
        failed += 1;
      }
    }
  }

  return { objectsDeleted: deleted, objectsFailed: failed };
}

/**
 * Erase one hostel and everything scoped to it.
 *
 * The `Hostel` row itself goes **last**. Until it is gone the hostel is still
 * archived and still due, so a crash part-way through leaves it in the queue
 * and the next run finishes the job — the same property
 * `runAccountDeletionPurge` relies on.
 */
export async function purgeHostel(
  hostelId: Types.ObjectId,
  /** Who asked. Unset for the cron, which acts on a decision made 60 days ago. */
  actorId?: string,
) {
  const storage = await deleteHostelObjects(hostelId);

  const hostel = await HostelModel.findById(hostelId)
    .select("name slug ownerId")
    .lean<{ name?: string; ownerId?: Types.ObjectId; slug?: string } | null>();

  // Read *before* anything is deleted. These two collections carry no
  // `hostelId` of their own — they hang off a notice and a post — so once the
  // parents are gone there is nothing left to identify the children by, and
  // they become permanent orphans nothing can ever find.
  const [notices, posts] = await Promise.all([
    NoticeModel.find({ hostelId }).select("_id").lean<Array<{ _id: Types.ObjectId }>>(),
    CommunityPostModel.find({ hostelId })
      .select("_id")
      .lean<Array<{ _id: Types.ObjectId }>>(),
  ]);

  let documentsDeleted = 0;

  for (const entry of ERASED_BY_HOSTEL_ID) {
    const result = await entry.model.deleteMany({ hostelId });
    documentsDeleted += result.deletedCount ?? 0;
  }

  for (const [model, filter] of [
    [NoticeReadStatusModel, { noticeId: { $in: notices.map((row) => row._id) } }],
    [CommunityCommentVoteModel, { postId: { $in: posts.map((row) => row._id) } }],
  ] as const) {
    const result = await model.deleteMany(filter);
    documentsDeleted += result.deletedCount ?? 0;
  }

  for (const entry of PULLED_FROM_HOSTEL_IDS) {
    await entry.model.updateMany(
      { hostelIds: hostelId },
      { $pull: { hostelIds: hostelId } },
    );
  }

  await HostelModel.deleteOne({ _id: hostelId });

  // Written last and deliberately kept — see the note at the top of this file.
  await AuditLogModel.create({
    action: "HOSTEL_PURGED",
    ...(actorId ? { actorId } : {}),
    entityId: hostelId.toString(),
    entityType: "Hostel",
    metadata: {
      // Which of the two paths erased it. The cron acts on a decision taken 60
      // days earlier; a manual purge is somebody deciding now.
      trigger: actorId ? "MANUAL" : "CRON",
      documentsDeleted,
      name: hostel?.name ?? null,
      objectsDeleted: storage.objectsDeleted,
      objectsFailed: storage.objectsFailed,
      slug: hostel?.slug ?? null,
    },
    targetResource: "Hostel",
    targetResourceId: hostelId,
  }).catch(() => {});

  return { documentsDeleted, ...storage };
}

/**
 * One batch per run. Twenty rather than the account purge's hundred: a hostel
 * is eighty-odd collections and a round-trip to R2 for every photo it ever had,
 * and the route has sixty seconds.
 */
const PURGE_BATCH_SIZE = 20;

/**
 * Cron: erase archived hostels whose 60-day grace period has run out.
 *
 * A hostel qualifies only once `purgeScheduledAt` is both set and past. A
 * hostel archived before that field existed has no purge date and can never be
 * swept up by accident — the same guard `runAccountDeletionPurge` gets from an
 * unset `scheduledDeletionAt`.
 */
export async function runHostelArchivePurge(now = new Date()) {
  await connectToDatabase();

  const due = await HostelModel.find({
    isDeleted: true,
    purgeScheduledAt: { $lte: now, $ne: null },
  })
    .select("_id")
    .limit(PURGE_BATCH_SIZE)
    .lean<Array<{ _id: Types.ObjectId }>>();

  let purged = 0;
  let failed = 0;

  for (const hostel of due) {
    try {
      await purgeHostel(hostel._id);
      purged += 1;
    } catch {
      // One hostel failing must not strand the rest of the batch. It stays
      // archived and due, and the next run tries again.
      failed += 1;
    }
  }

  return { due: due.length, failed, purged };
}

/**
 * The superadmin's "purge now", for an archive they do not want to wait out.
 *
 * Refuses anything that is not already archived. That is the whole safety
 * property: erasure is always the *second* deliberate act on a hostel that is
 * already off the site, its staff already signed out, and its owner already
 * told. There is no path from a live hostel to erased in one click.
 */
export async function purgeArchivedHostel(hostelId: string, principal: ApiPrincipal) {
  await connectToDatabase();

  const objectId = normalizeObjectId(hostelId);
  const hostel = await HostelModel.findById(objectId)
    .select("isDeleted name")
    .lean<{ isDeleted?: boolean; name?: string } | null>();

  if (!hostel) {
    throw new HostelServiceError("Hostel was not found.", "HOSTEL_NOT_FOUND", 404);
  }

  if (!hostel.isDeleted) {
    throw new HostelServiceError(
      "Archive this hostel first. A live hostel cannot be erased directly.",
      "HOSTEL_NOT_ARCHIVED",
      409,
    );
  }

  const result = await purgeHostel(objectId, principal.userId);

  return { name: hostel.name ?? "", ...result };
}
