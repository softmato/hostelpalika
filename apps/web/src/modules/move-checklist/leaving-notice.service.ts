import { Types } from "mongoose";
import { z } from "zod";

import type { ApiPrincipal } from "@/lib/api-auth";
import { connectToDatabase } from "@/lib/db";
import { formatBsDate, hostelToday } from "@/lib/hostel-day";
import { getMoneyRules } from "@/modules/finance/money-rules.service";
import { createInAppNotification } from "@/modules/notifications/notification.service";
import { findCurrentResident } from "@/modules/residents/resident-access";
import { resolveHostelStaffUserIds } from "@/modules/residents/resident-notify";
import { ResidentModel } from "@hostel/db/models/Resident";

/**
 * A resident's move-out notice (field review E5).
 *
 * The resident names the day; nobody approves it. The day must be at least the
 * hostel's notice days ahead (Money rules), and the server is what enforces it.
 * Giving notice sets `moveOutDate` with `TILL_DAY`, so the billing run already
 * stops the rent on that day; the move-out checklist on the day cuts any bill
 * raised before and finishes the rest. Cancelling clears all of it.
 */

const DAY = 24 * 60 * 60 * 1000;

export const leavingNoticeSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a day."),
  reason: z.string().trim().max(300).optional(),
});

const dayKey = (date: Date) => date.toISOString().slice(0, 10);

/** The first day a resident may name: today plus the hostel's notice days. */
export function earliestLeavingDay(today: Date, noticeDays: number): Date {
  return new Date(today.getTime() + Math.max(noticeDays, 0) * DAY);
}

type NoticeResident = {
  _id: Types.ObjectId;
  firstName: string;
  hostelId: Types.ObjectId;
  lastName: string;
  leavingOn?: Date | null;
  leavingReason?: string | null;
  userId?: Types.ObjectId;
};

async function snapshot(resident: NoticeResident) {
  const { moveOutNoticeDays } = await getMoneyRules(resident.hostelId);

  return {
    earliest: dayKey(earliestLeavingDay(hostelToday(), moveOutNoticeDays)),
    leavingOn: resident.leavingOn ? dayKey(resident.leavingOn) : null,
    leavingOnLabel: resident.leavingOn ? formatBsDate(resident.leavingOn) : null,
    noticeDays: moveOutNoticeDays,
    reason: resident.leavingReason ?? null,
  };
}

export async function getMyLeavingNotice(principal: ApiPrincipal) {
  await connectToDatabase();

  return snapshot((await findCurrentResident(principal)) as unknown as NoticeResident);
}

async function tellStaff(resident: NoticeResident, title: string, body: string) {
  const staff = await resolveHostelStaffUserIds(resident.hostelId).catch(() => [] as string[]);

  await Promise.all(
    staff.map((userId) =>
      createInAppNotification({
        actionUrl: "/hostel-admin/residents",
        body,
        category: "ACCOUNT",
        data: { residentId: resident._id.toString(), type: "RESIDENT_LEAVING" },
        hostelId: resident.hostelId.toString(),
        title,
        userId,
      }).catch(() => null),
    ),
  );
}

const name = (resident: NoticeResident) => `${resident.firstName} ${resident.lastName}`.trim();

export async function giveLeavingNotice(
  principal: ApiPrincipal,
  input: z.infer<typeof leavingNoticeSchema>,
) {
  await connectToDatabase();

  const resident = (await findCurrentResident(principal)) as unknown as NoticeResident;
  const day = new Date(`${input.date}T00:00:00.000Z`);
  const { moveOutNoticeDays } = await getMoneyRules(resident.hostelId);
  const earliest = earliestLeavingDay(hostelToday(), moveOutNoticeDays);

  if (Number.isNaN(day.getTime()) || day < earliest) {
    throw new LeavingNoticeError(
      moveOutNoticeDays > 0
        ? `This hostel needs ${moveOutNoticeDays} days' notice. The earliest day is ${formatBsDate(earliest)}.`
        : "Pick today or a later day.",
    );
  }

  const changed = Boolean(resident.leavingOn);

  await ResidentModel.updateOne(
    { _id: resident._id },
    {
      $set: {
        lastMonthCharge: "TILL_DAY",
        leavingNoticeAt: new Date(),
        leavingOn: day,
        leavingReason: input.reason || null,
        moveOutDate: day,
      },
    },
  );

  const updated = { ...resident, leavingOn: day, leavingReason: input.reason || null };

  await tellStaff(
    updated,
    changed ? `${name(resident)} changed their leaving day` : `${name(resident)} is leaving`,
    `Leaving on ${formatBsDate(day)}.${input.reason ? ` ${input.reason}` : ""}`,
  );

  return snapshot(updated);
}

export async function cancelLeavingNotice(principal: ApiPrincipal) {
  await connectToDatabase();

  const resident = (await findCurrentResident(principal)) as unknown as NoticeResident;

  if (!resident.leavingOn) return snapshot(resident);

  await ResidentModel.updateOne(
    { _id: resident._id },
    {
      $set: { lastMonthCharge: null, leavingOn: null, leavingReason: null, moveOutDate: null },
    },
  );
  await tellStaff(resident, `${name(resident)} is staying`, "They cancelled their move-out notice.");

  return snapshot({ ...resident, leavingOn: null, leavingReason: null });
}

/** Residents still here whose leaving day is today or already past — the warden's "Leaving today". */
export async function listLeavingToday(hostelId: Types.ObjectId | string) {
  await connectToDatabase();

  const rows = await ResidentModel.find({
    hostelId,
    isDeleted: { $ne: true },
    leavingOn: { $lte: hostelToday() },
    status: "ACTIVE",
  })
    .select("firstName lastName leavingOn roomNumber")
    .lean<{ _id: Types.ObjectId; firstName: string; lastName: string; leavingOn: Date; roomNumber?: string }[]>();

  return rows.map((row) => ({
    id: row._id.toString(),
    leavingOn: dayKey(row.leavingOn),
    name: `${row.firstName} ${row.lastName}`.trim(),
    roomNumber: row.roomNumber ?? null,
  }));
}

/**
 * The day before and on the day: push to the resident and the hostel's staff.
 * After the day, staff keep being reminded until someone moves them out. Rides
 * the payment-reminders cron (twice a day). Never throws.
 */
export async function sendLeavingReminders(now = new Date()) {
  await connectToDatabase();

  const today = hostelToday(now);
  const tomorrow = new Date(today.getTime() + DAY);
  const rows = await ResidentModel.find({
    isDeleted: { $ne: true },
    leavingOn: { $lte: tomorrow },
    status: "ACTIVE",
  })
    .select("firstName hostelId lastName leavingOn userId")
    .lean<NoticeResident[]>();

  let sent = 0;

  for (const resident of rows) {
    const when = resident.leavingOn!.getTime() === tomorrow.getTime() ? "tomorrow" : "today";
    const overdue = resident.leavingOn! < today;

    if (resident.userId && !overdue) {
      await createInAppNotification({
        actionUrl: "/resident/dashboard",
        body: `You are moving out ${when}. Settle anything still owed with the hostel.`,
        category: "ACCOUNT",
        data: { type: "RESIDENT_LEAVING" },
        hostelId: resident.hostelId.toString(),
        title: when === "today" ? "Moving out today" : "Moving out tomorrow",
        userId: resident.userId.toString(),
      }).catch(() => null);
    }

    await tellStaff(
      resident,
      overdue ? `${name(resident)} has not been moved out` : `${name(resident)} leaves ${when}`,
      overdue
        ? `They left on ${formatBsDate(resident.leavingOn!)}. Open Move out to finish.`
        : `Open Move out on ${when === "today" ? "Home" : "their page"} to finish.`,
    );
    sent += 1;
  }

  return { leavingReminders: sent };
}

export class LeavingNoticeError extends Error {
  readonly errorCode = "LEAVING_TOO_SOON";
  readonly status = 400;

  constructor(message: string) {
    super(message);
  }
}
