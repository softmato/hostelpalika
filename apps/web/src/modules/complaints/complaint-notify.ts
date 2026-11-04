import type { Types } from "mongoose";

import { REALTIME_TOPIC } from "@/lib/realtime/channels";
import { publishResourceChange } from "@/lib/realtime/server";
import { createInAppNotification } from "@/modules/notifications/notification.service";
import { getOperationsConfig } from "@/modules/platform-config/operations-config";
import { newComplaintEmail } from "@hostel/shared/email/templates/hostel/staff-alerts";
import { complaintResolvedEmail } from "@hostel/shared/email/templates/resident/complaint-resolved";
import { complaintStatusUpdatedEmail } from "@hostel/shared/email/templates/resident/complaint-status-updated";
import { ResidentModel } from "@hostel/db/models/Resident";
import {
  appUrl,
  getHostelName,
  resolveHostelAdminContacts,
  resolveResidentContact,
  sendNotificationEmail,
} from "@/modules/residents/resident-notify";

const RESIDENT_COMPLAINTS_URL = "/resident/complaints";
const ADMIN_COMPLAINTS_URL = "/hostel-admin/complaints";

/**
 * Tells the hostel a complaint landed. Anonymous complaints deliberately carry
 * no resident name into the notification body — the admin surface hides the
 * identity, so the alert must not leak it back (PRD.md §10).
 */
export async function notifyAdminsOfNewComplaint(input: {
  category: string;
  complaintId: string;
  hostelId: Types.ObjectId;
  isAnonymous: boolean;
  residentName: string;
  title: string;
}) {
  try {
    const [hostelName, admins] = await Promise.all([
      getHostelName(input.hostelId),
      resolveHostelAdminContacts(input.hostelId),
    ]);
    const author = input.isAnonymous ? "An anonymous resident" : input.residentName;
    const body = `${author} filed a ${input.category.toLowerCase()} complaint: ${input.title}`;
    const email = newComplaintEmail({
      complaintsUrl: appUrl(ADMIN_COMPLAINTS_URL),
      from: author,
      hostelName,
      title: input.title,
      type: input.category,
    });

    await Promise.allSettled(
      admins.flatMap((admin) => {
        const jobs: Promise<unknown>[] = [
          sendNotificationEmail({
            action: "complaint_created",
            category: email.category, html: email.html,
            subject: email.subject,
            to: admin.email,
            topic: "COMPLAINT_ALERTS",
          }),
        ];

        if (admin.userId) {
          jobs.push(
            createInAppNotification({
              // Every complaint needs someone to pick it up, and there is no
              // one-click resolution — so it deep-links rather than offering
              // inline buttons.
              actionUrl: "/hostel-admin/complaints",
              body,
              category: "COMPLAINT",
              data: { complaintId: input.complaintId },
              hostelId: input.hostelId.toString(),
              kind: "ACTION",
              title: "New complaint",
              userId: admin.userId,
            }),
          );
        }

        return jobs;
      }),
    );

    // Wider than the recipients: anyone with the complaints tab open in this
    // hostel should see the new row, staff or not.
    await publishResourceChange({
      hostelIds: [input.hostelId.toString()],
      topics: [REALTIME_TOPIC.COMPLAINTS],
    });
  } catch (error) {
    console.warn(
      JSON.stringify({
        level: "warn",
        action: "complaint_created_notify_failed",
        message: error instanceof Error ? error.message : "Unknown error",
      }),
    );
  }
}

/** In-app only: a reply is not a status change, so it does not earn an email. */
export async function notifyResidentOfComplaintReply(input: {
  hostelId: Types.ObjectId;
  residentId: Types.ObjectId;
  title: string;
}) {
  try {
    const resident = await ResidentModel.findOne({
      _id: input.residentId,
    }).lean<{ userId?: Types.ObjectId } | null>();

    if (!resident?.userId) {
      return;
    }

    await createInAppNotification({
      body: `The hostel replied to “${input.title}”.`,
      category: "COMPLAINT",
      hostelId: input.hostelId.toString(),
      title: "Complaint reply",
      userId: resident.userId.toString(),
    });
  } catch (error) {
    console.warn(
      JSON.stringify({
        level: "warn",
        action: "complaint_reply_notify_failed",
        message: error instanceof Error ? error.message : "Unknown error",
      }),
    );
  }
}

/**
 * Tells the resident their complaint moved. Fires on every status change;
 * RESOLVED gets the dedicated template because it asks for a confirmation.
 */
export async function notifyResidentOfComplaintStatus(input: {
  hostelId: Types.ObjectId;
  residentId: Types.ObjectId;
  response?: string;
  status: string;
  title: string;
}) {
  try {
    const [config, hostelName, resident] = await Promise.all([
      getOperationsConfig(),
      getHostelName(input.hostelId),
      ResidentModel.findOne({ _id: input.residentId }).lean<{
        _id: Types.ObjectId;
        email?: string;
        firstName: string;
        lastName: string;
        userId?: Types.ObjectId;
      } | null>(),
    ]);

    if (!resident) {
      return;
    }

    const contact = await resolveResidentContact(resident);
    const complaintsUrl = appUrl(RESIDENT_COMPLAINTS_URL);
    const jobs: Promise<unknown>[] = [];

    // Email only once the complaint is settled; "in progress" is a bell row.
    const settled = input.status === "RESOLVED" || input.status === "REJECTED";

    if (contact && settled && config.sendComplaintEmails) {
      const email =
        input.status === "RESOLVED"
          ? complaintResolvedEmail({
              complaintsUrl,
              hostelName,
              response: input.response,
              title: input.title,
            })
          : complaintStatusUpdatedEmail({
              complaintsUrl,
              hostelName,
              response: input.response,
              status: input.status,
              title: input.title,
            });

      jobs.push(
        sendNotificationEmail({
          action: "complaint_status_updated",
          category: email.category, html: email.html,
          subject: email.subject,
          to: contact.email,
          topic: "COMPLAINT_UPDATES",
        }),
      );
    }

    if (resident.userId) {
      jobs.push(
        createInAppNotification({
          body: `“${input.title}” is now ${input.status.toLowerCase().replace("_", " ")}.`,
          category: "COMPLAINT",
          data: { status: input.status },
          hostelId: input.hostelId.toString(),
          title: "Complaint update",
          userId: resident.userId.toString(),
        }),
      );
    }

    await Promise.allSettled(jobs);
  } catch (error) {
    console.warn(
      JSON.stringify({
        level: "warn",
        action: "complaint_status_notify_failed",
        message: error instanceof Error ? error.message : "Unknown error",
      }),
    );
  }
}
