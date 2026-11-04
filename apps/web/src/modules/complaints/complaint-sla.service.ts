import type { Types } from "mongoose";

import { connectToDatabase } from "@/lib/db";
import { ComplaintModel } from "@hostel/db/models/Complaint";
import { createInAppNotification } from "@/modules/notifications/notification.service";
import {
  appUrl,
  getHostelName,
  resolveHostelAdminContacts,
  sendNotificationEmail,
} from "@/modules/residents/resident-notify";
import { overdueComplaintsEmail } from "@hostel/shared/email/templates/hostel/staff-alerts";

type OverdueComplaint = {
  _id: Types.ObjectId;
  category: string;
  hostelId: Types.ObjectId;
  slaDueAt: Date;
  title: string;
};

const OPEN_STATUSES = ["PENDING", "IN_PROGRESS"];

function hoursLate(dueAt: Date, now: Date) {
  return Math.max(Math.floor((now.getTime() - dueAt.getTime()) / 3_600_000), 0);
}

/**
 * Cron: flag complaints that blew their SLA window (PHASES.md §4.1).
 *
 * Runs at most once per complaint — `slaBreachedAt` is both the flag the admin
 * queue reads and the guard that stops the job re-alerting every morning for a
 * complaint nobody has touched.
 */
export async function runComplaintSlaCheck(now = new Date()) {
  await connectToDatabase();

  const overdue = await ComplaintModel.find({
    slaBreachedAt: { $exists: false },
    slaDueAt: { $lt: now },
    status: { $in: OPEN_STATUSES },
  })
    .sort({ slaDueAt: 1 })
    .limit(500)
    .lean<OverdueComplaint[]>();

  if (overdue.length === 0) {
    return { flagged: 0, hostelsNotified: 0, scanned: 0 };
  }

  await ComplaintModel.updateMany(
    { _id: { $in: overdue.map((complaint) => complaint._id) } },
    { $set: { slaBreachedAt: now } },
  );

  const byHostelId = new Map<string, OverdueComplaint[]>();

  for (const complaint of overdue) {
    const key = complaint.hostelId.toString();

    byHostelId.set(key, [...(byHostelId.get(key) ?? []), complaint]);
  }

  let hostelsNotified = 0;

  for (const [hostelId, complaints] of byHostelId) {
    try {
      const [hostelName, admins] = await Promise.all([
        getHostelName(hostelId),
        resolveHostelAdminContacts(hostelId),
      ]);

      if (admins.length === 0) {
        continue;
      }

      const email = overdueComplaintsEmail({
        complaints: complaints.map((complaint) => ({
          hoursLate: hoursLate(complaint.slaDueAt, now),
          title: complaint.title,
          type: complaint.category,
        })),
        complaintsUrl: appUrl("/hostel-admin/complaints"),
        hostelName,
      });
      const body = `${complaints.length} complaint${complaints.length === 1 ? "" : "s"} passed the response deadline.`;

      await Promise.allSettled(
        admins.flatMap((admin) => {
          const jobs: Promise<unknown>[] = [
            sendNotificationEmail({
              action: "complaint_sla_breached",
              category: email.category, html: email.html,
              subject: email.subject,
              to: admin.email,
              topic: "COMPLAINT_ALERTS",
            }),
          ];

          if (admin.userId) {
            jobs.push(
              createInAppNotification({
                body,
                category: "COMPLAINT",
                data: { overdueCount: complaints.length },
                hostelId,
                title: "Complaints past SLA",
                userId: admin.userId,
              }),
            );
          }

          return jobs;
        }),
      );

      hostelsNotified += 1;
    } catch (error) {
      console.warn(
        JSON.stringify({
          level: "warn",
          action: "complaint_sla_notify_failed",
          hostelId,
          message: error instanceof Error ? error.message : "Unknown error",
        }),
      );
    }
  }

  return { flagged: overdue.length, hostelsNotified, scanned: overdue.length };
}
