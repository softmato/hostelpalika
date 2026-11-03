import type { Types } from "mongoose";

import { connectToDatabase } from "@/lib/db";
import { AccountDeletionRequestModel } from "@hostel/db/models/AccountDeletionRequest";
import { AttendanceLogModel } from "@hostel/db/models/AttendanceLog";
import { AuditLogModel } from "@hostel/db/models/AuditLog";
import { CommunityCommentModel } from "@hostel/db/models/CommunityComment";
import { CommunityPostModel } from "@hostel/db/models/CommunityPost";
import { ConsentLogModel } from "@hostel/db/models/ConsentLog";
import { DeviceTokenModel } from "@hostel/db/models/DeviceToken";
import { FileAssetModel } from "@hostel/db/models/FileAsset";
import { NotificationModel } from "@hostel/db/models/Notification";
import { QuestionCallClickModel } from "@hostel/db/models/QuestionCallClick";
import { ResidentModel } from "@hostel/db/models/Resident";
import { SessionModel } from "@hostel/db/models/Session";
import { UserModel } from "@hostel/db/models/User";

/** One batch of due requests per run; the queue is tiny in practice. */
const PURGE_BATCH_SIZE = 100;

/**
 * An abandoned presign is unrecoverable long before this — the upload URL dies
 * after 10 minutes — but a day of slack costs nothing and keeps a slow client
 * or a retried upload out of the sweep.
 */
const ABANDONED_UPLOAD_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * When upload verification shipped (plan item 0.3). Assets created before this
 * have no `uploadCompletedAt` because the field did not exist, not because they
 * were abandoned — the sweep must not touch them.
 */
const UPLOAD_VERIFICATION_EPOCH = new Date("2026-08-06T00:00:00.000Z");

/**
 * The delete-vs-retain split from ARCHITECTURE.md §13.2 and PRIVACY_POLICY.md
 * §8.3, for one account.
 *
 * The distinction throughout is between data that is *about* the person and
 * data that is a *record of a transaction they were party to*. The first is
 * erased. The second is kept with the person detached from it, because a
 * hostel's financial and audit history cannot develop holes when a former
 * resident leaves — and once `residentId` is gone those rows describe an
 * amount and a date, not a person.
 *
 * Community content follows the same logic in the other direction: the post
 * stays because it is part of a conversation other people took part in, but
 * the authorship link is cut, which is what "set to anonymous" means.
 */
export async function purgeAccount(userId: Types.ObjectId) {
  const residents = await ResidentModel.find({ userId })
    .select("_id")
    .lean<{ _id: Types.ObjectId }[]>();
  const residentIds = residents.map((resident) => resident._id);

  // Erased outright — data about the person.
  await Promise.all([
    AttendanceLogModel.deleteMany({ userId }),
    ConsentLogModel.deleteMany({ userId }),
    DeviceTokenModel.deleteMany({ userId }),
    NotificationModel.deleteMany({ userId }),
    QuestionCallClickModel.deleteMany({ userId }),
    SessionModel.deleteMany({ userId }),
  ]);

  if (residentIds.length > 0) {
    await AttendanceLogModel.deleteMany({ residentId: { $in: residentIds } });
  }

  // Payments and receipts are deliberately left alone.
  //
  // ARCHITECTURE.md §13.2 says to null their `residentId`. That cannot be done
  // as written: `Payment` carries a unique index on
  // `{ hostelId, residentId, month }`, so the second account purged in a given
  // hostel and month would collide on `null` and the purge would fail — turning
  // a privacy guarantee into an error. It is also unnecessary. Neither model
  // stores a name, an email or a phone; `residentId` is their only link to a
  // person, and the `Resident` document it points at is deleted below. What is
  // left is an ObjectId that resolves to nothing, which is the de-identification
  // the policy is asking for, with the ledger's amounts and dates intact.

  // Retained, de-authored.
  await Promise.all([
    CommunityPostModel.updateMany(
      { authorId: userId },
      { $set: { authorId: null, isAnonymous: true } },
    ),
    CommunityCommentModel.updateMany(
      { authorId: userId },
      { $set: { authorId: null, isAnonymous: true } },
    ),
  ]);

  await ResidentModel.deleteMany({ userId });
  await UserModel.deleteOne({ _id: userId });

  // Written last and deliberately kept: the audit trail has to record the
  // erasure itself, or there is no evidence the platform honoured the request.
  await AuditLogModel.create({
    action: "ACCOUNT_PURGED",
    actorType: "SYSTEM",
    entityType: "User",
    entityId: String(userId),
  }).catch(() => {});
}

/**
 * Cron: execute deletion requests whose 60-day grace period has run out
 * (ARCHITECTURE.md §13.1, step 4).
 *
 * A request only qualifies once `scheduledDeletionAt` is set and past, and it
 * is neither cancelled nor already executed. A `PLATFORM_REVIEW` request that
 * nobody has approved has no `scheduledDeletionAt` at all, so it can never be
 * swept up here by accident.
 */
export async function runAccountDeletionPurge(now = new Date()) {
  await connectToDatabase();

  const due = await AccountDeletionRequestModel.find({
    cancelled: false,
    executed: false,
    scheduledDeletionAt: { $lte: now, $ne: null },
  })
    .limit(PURGE_BATCH_SIZE)
    .lean<{ _id: Types.ObjectId; userId: Types.ObjectId }[]>();

  let purged = 0;
  let failed = 0;

  for (const request of due) {
    try {
      await purgeAccount(request.userId);
      // Marked executed only after the purge succeeded, so a crash mid-way
      // leaves the request due and the next run finishes the job.
      await AccountDeletionRequestModel.updateOne(
        { _id: request._id },
        { $set: { executed: true, executedAt: new Date() } },
      );
      purged += 1;
    } catch {
      // One account failing must not strand the rest of the batch.
      failed += 1;
    }
  }

  return {
    abandonedUploads: await sweepAbandonedUploads(now),
    due: due.length,
    failed,
    purged,
  };
}

/**
 * A presign that was never followed by a PUT leaves an `ACTIVE` `FileAsset` row
 * pointing at bytes that do not exist (current §7.10). The presigned URL is dead
 * after 10 minutes, so anything still uncompleted well past that will never
 * complete. Marked DELETED rather than removed: the row is the only record that
 * the upload was attempted.
 *
 * Folded into this daily job rather than given a cron entry of its own —
 * one more scheduled endpoint is one more thing that can silently stop running.
 */
async function sweepAbandonedUploads(now: Date) {
  const cutoff = new Date(now.getTime() - ABANDONED_UPLOAD_AGE_MS);

  const result = await FileAssetModel.updateMany(
    {
      // Every asset predating the verification leg lacks `uploadCompletedAt`
      // through no fault of its own. Without this floor the first run of this
      // sweep would delete every file the product has ever stored.
      createdAt: { $gt: UPLOAD_VERIFICATION_EPOCH, $lt: cutoff },
      isDeleted: false,
      status: "ACTIVE",
      uploadCompletedAt: { $exists: false },
    },
    { $set: { deletedAt: now, isDeleted: true, status: "DELETED" } },
  );

  return result.modifiedCount ?? 0;
}
