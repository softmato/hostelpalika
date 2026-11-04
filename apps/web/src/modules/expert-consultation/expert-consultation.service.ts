import type { Types } from "mongoose";
import type { z } from "zod";

import { connectToDatabase } from "@/lib/db";
import { getSiteConfigSection } from "@/modules/platform-config/site-config.service";
import { sendNotificationEmail } from "@/modules/residents/resident-notify";
import { getResidentIdentity } from "@/modules/users/resident-identity.service";
import { ExpertConsultationRequestModel } from "@hostel/db/models/ExpertConsultationRequest";
import { consultationRequestEmail } from "@hostel/shared/email/templates/platform/team-requests";

import type { expertConsultationCreateSchema } from "./expert-consultation.validation";

type ExpertConsultationCreateInput = z.infer<typeof expertConsultationCreateSchema>;

export class ExpertConsultationError extends Error {
  constructor(
    message: string,
    public errorCode = "EXPERT_CONSULTATION_ERROR",
    public status = 400,
  ) {
    super(message);
  }
}

/**
 * Fire-and-forget: a delivery failure must reach the logs, never the visitor
 * who just asked for a call back (RULES.md — notifications never fail the
 * action that triggered them).
 */
async function notifyTeamOfRequest(
  input: ExpertConsultationCreateInput & { requestId: string },
) {
  try {
    const identity = await getSiteConfigSection("identity");

    if (!identity.supportEmail) {
      return;
    }

    const rows: Array<[string, string | undefined]> = [
      ["Name", input.fullName],
      ["Phone", input.phone],
      ["Email", input.email],
      ["Budget", input.budgetRange],
      ["Environment", input.environment],
      ["Preferred college", input.preferredCollege],
      ["Liked spots", input.likedSpots],
    ];
    const detailRows = rows.filter(
      (row): row is [string, string] => typeof row[1] === "string" && row[1].length > 0,
    );

    const email = consultationRequestEmail({
      details: detailRows.map(([label, value]) => ({ label, value })),
      name: input.fullName,
    });

    await sendNotificationEmail({
      action: "expert_consultation_request",
      category: email.category, html: email.html,
      subject: email.subject,
      to: identity.supportEmail,
    });
  } catch (error) {
    console.warn(
      JSON.stringify({
        action: "expert_consultation_notify_failed",
        level: "warn",
        message: error instanceof Error ? error.message : "Unknown error",
      }),
    );
  }
}

/**
 * Records a "help me choose a hostel" request. The route has already
 * authenticated the visitor; this enforces the one product rule — a
 * completed resident profile must back the request, so the team calling back
 * already has a verified name and phone instead of whatever was typed here.
 */
export async function createExpertConsultationRequest(
  userId: string,
  input: ExpertConsultationCreateInput,
) {
  await connectToDatabase();

  const { identity } = await getResidentIdentity(userId);

  if (!identity.hasProfile) {
    throw new ExpertConsultationError(
      "Save your resident profile first so our team knows who to call.",
      "PROFILE_INCOMPLETE",
      422,
    );
  }

  const request = await ExpertConsultationRequestModel.create({
    budgetRange: input.budgetRange,
    email: input.email,
    environment: input.environment,
    fullName: input.fullName,
    likedSpots: input.likedSpots,
    phone: input.phone,
    preferredCollege: input.preferredCollege,
    userId,
  });

  await notifyTeamOfRequest({ ...input, requestId: request._id.toString() });

  return { id: request._id.toString() };
}

type ExpertConsultationRequestRecord = {
  _id: Types.ObjectId;
  budgetRange?: string;
  createdAt?: Date;
  environment?: string;
  likedSpots?: string;
  preferredCollege?: string;
};

/**
 * The visitor's own latest request, if any. Deliberately returns only the
 * preference fields (not status/notes/contactedBy — that's the staff queue),
 * so the compare page can tell "hasn't answered yet" from "answered, here's
 * what to recommend" without exposing internal callback tracking to them.
 */
export async function getMyExpertConsultationRequest(userId: string) {
  await connectToDatabase();

  const request = await ExpertConsultationRequestModel.findOne({ userId })
    .sort({ createdAt: -1 })
    .lean<ExpertConsultationRequestRecord | null>();

  if (!request) {
    return { request: null };
  }

  return {
    request: {
      budgetRange: request.budgetRange ?? null,
      createdAt: request.createdAt?.toISOString() ?? null,
      environment: request.environment ?? null,
      id: request._id.toString(),
      likedSpots: request.likedSpots ?? null,
      preferredCollege: request.preferredCollege ?? null,
    },
  };
}
