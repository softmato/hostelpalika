import type { Types } from "mongoose";

import { connectToDatabase } from "@/lib/db";
import { AttendanceAlertModel } from "@hostel/db/models/AttendanceAlert";
import { AttendanceLogModel } from "@hostel/db/models/AttendanceLog";
import { createInAppNotification } from "@/modules/notifications/notification.service";
import { HostelSettingsModel } from "@hostel/db/models/HostelSettings";
import { ResidentModel } from "@hostel/db/models/Resident";
import { attendanceAlertEmail } from "@hostel/shared/email/templates/hostel/staff-alerts";
import {
  ATTENDANCE_DEFAULTS,
  dayKey,
  type AttendanceConfig,
  type AttendanceZone,
} from "@/modules/attendance/attendance.service";
import {
  appUrl,
  getHostelName,
  resolveHostelAdminContacts,
  sendNotificationEmail,
} from "@/modules/residents/resident-notify";

const ABSENT_ZONES: AttendanceZone[] = ["OUTSIDE", "UNKNOWN"];

type SettingsRecord = {
  attendance?: Partial<AttendanceConfig>;
  hostelId: Types.ObjectId;
};

/**
 * Counts back from today for as long as the resident was absent. A day with no
 * reading at all counts as absent — an off phone is exactly the case the alert
 * exists for — and the streak stops at the first day they were seen, or at
 * `watchedFrom`: a day before the resident was registered (or before the hostel
 * turned the geofence on) had nobody to read, so it is not an absence.
 */
export function absenceStreak(
  zoneByDay: Map<string, AttendanceZone>,
  today: Date,
  maxDays: number,
  watchedFrom: Date,
) {
  let streak = 0;

  for (let offset = 0; offset < maxDays; offset += 1) {
    const day = new Date(today);

    day.setUTCDate(day.getUTCDate() - offset);

    if (day < watchedFrom) {
      break;
    }

    const zone = zoneByDay.get(day.toISOString().slice(0, 10));

    if (zone && !ABSENT_ZONES.includes(zone)) {
      break;
    }

    streak += 1;
  }

  return streak;
}

/**
 * Cron: raise attendance alerts for residents absent past their hostel's
 * threshold, then purge attendance rows older than the retention window
 * (PHASES.md §4.1, PRIVACY_POLICY.md).
 *
 * Alerts are unique per open resident, so a continuing absence updates the day
 * count on the existing alert instead of mailing the admin every morning.
 */
async function purgeExpiredLogs(hostelId: Types.ObjectId, today: Date, retentionDays: number) {
  const retentionCutoff = new Date(today);

  retentionCutoff.setUTCDate(retentionCutoff.getUTCDate() - retentionDays);

  const deleted = await AttendanceLogModel.deleteMany({ day: { $lt: retentionCutoff }, hostelId });

  return deleted.deletedCount ?? 0;
}

export async function runAttendanceMaintenance(now = new Date()) {
  await connectToDatabase();

  const today = dayKey(now);
  const settings = await HostelSettingsModel.find({
    "attendance.enabled": true,
  }).lean<SettingsRecord[]>();

  let alertsRaised = 0;
  let alertsUpdated = 0;
  let purged = 0;

  for (const record of settings) {
    const config = { ...ATTENDANCE_DEFAULTS, ...(record.attendance ?? {}) };
    const hostelId = record.hostelId;

    try {
      const residents = await ResidentModel.find({
        hostelId,
        isDeleted: false,
        status: "ACTIVE",
      }).lean<
        Array<{
          _id: Types.ObjectId;
          createdAt: Date;
          firstName: string;
          lastName: string;
          moveInDate: Date;
        }>
      >();

      // Nobody ACTIVE: no alerts to raise, but the retention purge is still owed (P9-1).
      if (residents.length === 0) {
        purged += await purgeExpiredLogs(hostelId, today, config.retentionDays);
        continue;
      }

      const windowStart = new Date(today);

      windowStart.setUTCDate(windowStart.getUTCDate() - config.absenceAlertDays);

      const logs = await AttendanceLogModel.find({
        day: { $gte: windowStart },
        hostelId,
      }).lean<Array<{ day: Date; residentId: Types.ObjectId; zone: AttendanceZone }>>();
      const logsByResidentId = new Map<string, Map<string, AttendanceZone>>();

      for (const log of logs) {
        const key = log.residentId.toString();
        const byDay = logsByResidentId.get(key) ?? new Map<string, AttendanceZone>();

        byDay.set(log.day.toISOString().slice(0, 10), log.zone);
        logsByResidentId.set(key, byDay);
      }

      const breached: Array<{ name: string; days: number; residentId: Types.ObjectId }> =
        [];

      for (const resident of residents) {
        const byDay = logsByResidentId.get(resident._id.toString()) ?? new Map();
        const watchedFrom = dayKey(
          new Date(
            Math.max(
              resident.createdAt.getTime(),
              new Date(resident.moveInDate).getTime(),
              config.enabledAt ? new Date(config.enabledAt).getTime() : 0,
            ),
          ),
        );
        const streak = absenceStreak(byDay, today, config.absenceAlertDays, watchedFrom);

        if (streak < config.absenceAlertDays) {
          // Back in the building: close any alert still standing for them.
          await AttendanceAlertModel.updateOne(
            { residentId: resident._id, status: "OPEN" },
            {
              $set: {
                resolutionNote: "Resident was seen again.",
                resolvedAt: now,
                status: "RESOLVED",
              },
            },
          );

          continue;
        }

        const existing = await AttendanceAlertModel.findOne({
          residentId: resident._id,
          status: "OPEN",
        }).lean<{ _id: Types.ObjectId } | null>();

        if (existing) {
          await AttendanceAlertModel.updateOne(
            { _id: existing._id },
            { $set: { consecutiveDays: streak } },
          );
          alertsUpdated += 1;

          continue;
        }

        await AttendanceAlertModel.create({
          consecutiveDays: streak,
          hostelId,
          residentId: resident._id,
          status: "OPEN",
        });
        alertsRaised += 1;
        breached.push({
          days: streak,
          name: `${resident.firstName} ${resident.lastName}`.trim(),
          residentId: resident._id,
        });
      }

      if (breached.length > 0) {
        const [hostelName, admins] = await Promise.all([
          getHostelName(hostelId),
          resolveHostelAdminContacts(hostelId),
        ]);
        const email = attendanceAlertEmail({
          attendanceUrl: appUrl("/hostel-admin/attendance"),
          hostelName,
          residents: breached,
        });
        const body = `${breached.length} resident${breached.length === 1 ? " has" : "s have"} been away past the alert threshold.`;

        await Promise.allSettled(
          admins.flatMap((admin) => {
            const jobs: Promise<unknown>[] = [
              sendNotificationEmail({
                action: "attendance_alert",
                category: email.category, html: email.html,
                subject: email.subject,
                to: admin.email,
                topic: "ATTENDANCE_ALERTS",
              }),
            ];

            if (admin.userId) {
              jobs.push(
                createInAppNotification({
                  body,
                  category: "ATTENDANCE",
                  data: { count: breached.length },
                  hostelId: hostelId.toString(),
                  title: "Attendance alert",
                  userId: admin.userId,
                }),
              );
            }

            return jobs;
          }),
        );
      }

      purged += await purgeExpiredLogs(hostelId, today, config.retentionDays);
    } catch (error) {
      console.warn(
        JSON.stringify({
          level: "warn",
          action: "attendance_maintenance_failed",
          hostelId: hostelId.toString(),
          message: error instanceof Error ? error.message : "Unknown error",
        }),
      );
    }
  }

  return {
    alertsRaised,
    alertsUpdated,
    hostelsProcessed: settings.length,
    logsPurged: purged,
  };
}
