import { randomBytes } from "node:crypto";
import { Types } from "mongoose";
import type { z } from "zod";

import type { ApiPrincipal } from "@/lib/api-auth";
import { hashToken } from "@/lib/auth";
import { connectToDatabase } from "@/lib/db";
import { Role } from "@/lib/roles";
import { assertHostelAccess } from "@/lib/tenant";
import { type HostelPhoto, resolveHostelPhotoUrls } from "@/lib/hostel-photos";
import { AuditLogModel } from "@hostel/db/models/AuditLog";
import { HostelModel } from "@hostel/db/models/Hostel";
import { QRActivationModel } from "@hostel/db/models/QRActivation";
import { ResidentModel } from "@hostel/db/models/Resident";
import { UserModel } from "@hostel/db/models/User";
import { issueSessionForUser } from "@/modules/auth/auth.service";
import { getOperationsConfig } from "@/modules/platform-config/operations-config";
import {
  normalizeObjectId,
  serializeResidentSummary,
  type ResidentRecord,
} from "@/modules/residents/resident-access";
import {
  appUrl,
  getHostelName,
  resolveResidentContact,
  sendNotificationEmail,
} from "@/modules/residents/resident-notify";
import { storePublicAsset } from "@/lib/public-upload";
import { residentQrActivationEmail } from "@hostel/shared/email/templates/resident/qr-activation";
import type {
  activationCodeGenerateSchema,
  activationCodeSchema,
  activationStatusQuerySchema,
} from "@/modules/residents/activation.validation";

type ActivationCodeGenerateInput = z.infer<typeof activationCodeGenerateSchema>;
type ActivationCodeInput = z.infer<typeof activationCodeSchema>;
type ActivationStatusQuery = z.infer<typeof activationStatusQuerySchema>;

type ActivationStatus = "PENDING" | "USED" | "EXPIRED" | "CANCELLED";

type QRActivationRecord = {
  _id: Types.ObjectId;
  codeHash?: string;
  createdAt?: Date;
  createdBy: Types.ObjectId;
  deviceInfo?: Record<string, unknown>;
  expiresAt: Date;
  hostelId: Types.ObjectId;
  residentId: Types.ObjectId;
  sessionInfo?: Record<string, unknown>;
  status: ActivationStatus;
  usedAt?: Date;
  usedBy?: Types.ObjectId;
};

type HostelTargetRecord = {
  location?: { area?: string; city?: string };
  name: string;
  photos?: HostelPhoto[];
  verificationStatus?: string;
};

type UserRecord = {
  _id: Types.ObjectId;
  email?: string | null;
  hostelIds?: Types.ObjectId[];
  name: string;
  phone?: string | null;
  role: Role;
  status: string;
};

export class ActivationServiceError extends Error {
  constructor(
    message: string,
    public errorCode = "ACTIVATION_ERROR",
    public status = 400,
  ) {
    super(message);
  }
}

function activationSecret() {
  return (
    process.env.ACTIVATION_CODE_SECRET ??
    process.env.JWT_ACCESS_SECRET ??
    "development-activation-secret"
  );
}

function hashActivationCode(code: string) {
  return hashToken(`${code.trim().toUpperCase()}:${activationSecret()}`);
}

function generatePlainCode() {
  let code = "";

  while (code.length < 8) {
    code += randomBytes(6)
      .toString("base64url")
      .replace(/[^A-Z0-9]/gi, "");
  }

  return code.slice(0, 8).toUpperCase();
}

function serializeActivation(activation: QRActivationRecord, code?: string) {
  return {
    code,
    createdAt: activation.createdAt?.toISOString(),
    createdBy: activation.createdBy.toString(),
    expiresAt: activation.expiresAt.toISOString(),
    hostelId: activation.hostelId.toString(),
    id: activation._id.toString(),
    residentId: activation.residentId.toString(),
    status: activation.status,
    usedAt: activation.usedAt?.toISOString(),
    usedBy: activation.usedBy?.toString(),
  };
}

function scopedHostelFilter(principal: ApiPrincipal, requestedHostelId?: string) {
  if (requestedHostelId) {
    assertHostelAccess(principal, requestedHostelId);
    return { hostelId: normalizeObjectId(requestedHostelId, "hostel id") };
  }

  return {
    hostelId: {
      $in: principal.hostelIds.map((hostelId) =>
        normalizeObjectId(hostelId, "hostel id"),
      ),
    },
  };
}

async function findAdminResident(
  residentId: string,
  principal: ApiPrincipal,
  requestedHostelId?: string,
) {
  const resident = await ResidentModel.findOne({
    _id: normalizeObjectId(residentId, "resident id"),
    isDeleted: false,
    ...scopedHostelFilter(principal, requestedHostelId),
  }).lean<ResidentRecord | null>();

  if (!resident) {
    throw new ActivationServiceError(
      "Resident was not found.",
      "RESIDENT_NOT_FOUND",
      404,
    );
  }

  return resident;
}

async function auditActivation(
  principal: ApiPrincipal,
  hostelId: Types.ObjectId,
  activationId: Types.ObjectId,
  action: string,
  metadata: Record<string, unknown> = {},
) {
  await AuditLogModel.create({
    action,
    actorId: principal.userId,
    entityId: activationId.toString(),
    entityType: "QRActivation",
    hostelId,
    metadata,
  });
}

export function activationUrl(code: string) {
  return appUrl(`/resident-activation?code=${encodeURIComponent(code)}`);
}

/**
 * Renders the activation link as a QR PNG and stores it where an email client
 * can fetch it. Returns `null` when QR rendering or storage is unavailable —
 * the email still carries the typed fallback code and link.
 */
async function renderActivationQr(code: string) {
  try {
    const { toBuffer } = await import("qrcode");
    const png = await toBuffer(activationUrl(code), {
      errorCorrectionLevel: "M",
      margin: 1,
      type: "png",
      width: 400,
    });

    return await storePublicAsset({
      body: png,
      contentType: "image/png",
      fileName: `activation-${code}.png`,
      prefix: "activation-qr",
    });
  } catch (error) {
    console.warn(
      JSON.stringify({
        level: "warn",
        action: "activation_qr_render_failed",
        message: error instanceof Error ? error.message : "Unknown QR error",
      }),
    );

    return null;
  }
}



/**
 * A fresh activation code for one resident, cancelling any still pending.
 *
 * The scope check is the caller's: `generateActivationCode` does it for a hostel
 * screen, and the existing-residents list does it for the whole list before it
 * gets here — a field agent adding a hostel's residents has no hostel on their
 * token, so the per-resident admin lookup would refuse them.
 */
export async function issueActivationCode(
  resident: { _id: Types.ObjectId; hostelId: Types.ObjectId },
  principal: ApiPrincipal,
  expiresInHours?: number,
) {
  const config = await getOperationsConfig();
  const code = generatePlainCode();
  const hours = expiresInHours ?? config.qrActivationExpiryDays * 24;
  const expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000);

  await QRActivationModel.updateMany(
    {
      residentId: resident._id,
      status: "PENDING",
    },
    { $set: { status: "CANCELLED" } },
  );

  const activation = await QRActivationModel.create({
    codeHash: hashActivationCode(code),
    createdBy: principal.userId,
    expiresAt,
    hostelId: resident.hostelId,
    residentId: resident._id,
    status: "PENDING",
  });

  await auditActivation(
    principal,
    resident.hostelId,
    activation._id,
    "RESIDENT_ACTIVATION_CODE_GENERATED",
    { residentId: resident._id.toString() },
  );

  return { activation, code, expiresAt };
}
export async function generateActivationCode(
  residentId: string,
  input: ActivationCodeGenerateInput,
  principal: ApiPrincipal,
) {
  await connectToDatabase();

  const resident = await findAdminResident(residentId, principal, input.hostelId);
  const { activation, code, expiresAt } = await issueActivationCode(
    resident,
    principal,
    input.expiresInHours,
  );

  const delivery = input.sendEmail
    ? await deliverActivationEmail(resident, code, expiresAt)
    : { reason: "email_suppressed", sent: false };

  return {
    activation: serializeActivation(activation as QRActivationRecord, code),
    delivery,
    resident: serializeResidentSummary(resident),
  };
}

/** Never throws — the code is already issued and returned to the admin. */
async function deliverActivationEmail(
  resident: ResidentRecord,
  code: string,
  expiresAt: Date,
) {
  try {
    return await sendActivationEmail(resident, code, expiresAt);
  } catch (error) {
    console.warn(
      JSON.stringify({
        level: "warn",
        action: "resident_activation_email_failed",
        message:
          error instanceof Error ? error.message : "Unknown activation email error",
        residentId: resident._id.toString(),
      }),
    );

    return { reason: "delivery_failed", sent: false };
  }
}

async function sendActivationEmail(
  resident: ResidentRecord,
  code: string,
  expiresAt: Date,
) {
  const contact = await resolveResidentContact(resident);

  if (!contact) {
    return { reason: "no_resident_email", sent: false };
  }

  const [hostelName, qrImageUrl] = await Promise.all([
    getHostelName(resident.hostelId),
    renderActivationQr(code),
  ]);

  const email = residentQrActivationEmail({
    activationUrl: activationUrl(code),
    code,
    expiresAt,
    hostelName,
    qrImageUrl: qrImageUrl ?? undefined,
    residentName: contact.name,
  });

  const sent = await sendNotificationEmail({
    action: "resident_activation",
    category: email.category, html: email.html,
    subject: email.subject,
    to: contact.email,
  });

  return { sent, to: contact.email, ...(sent ? {} : { reason: "delivery_failed" }) };
}

export async function regenerateActivationCode(
  residentId: string,
  input: ActivationCodeGenerateInput,
  principal: ApiPrincipal,
) {
  return generateActivationCode(residentId, input, principal);
}

export async function activateResident(
  input: ActivationCodeInput,
  principal: ApiPrincipal,
) {
  await connectToDatabase();

  const now = new Date();
  const activation = await QRActivationModel.findOne({
    codeHash: hashActivationCode(input.code),
  })
    .select("+codeHash")
    .sort({ createdAt: -1 })
    .lean<QRActivationRecord | null>();

  if (!activation) {
    throw new ActivationServiceError(
      "Activation code is invalid.",
      "ACTIVATION_CODE_INVALID",
      400,
    );
  }

  if (activation.status !== "PENDING" || activation.usedAt) {
    throw new ActivationServiceError(
      "Activation code was already used or cancelled.",
      "ACTIVATION_CODE_USED",
      409,
    );
  }

  if (activation.expiresAt <= now) {
    await QRActivationModel.updateOne(
      { _id: activation._id },
      { $set: { status: "EXPIRED" } },
    );
    throw new ActivationServiceError(
      "Activation code has expired.",
      "ACTIVATION_CODE_EXPIRED",
      410,
    );
  }

  const resident = await ResidentModel.findOne({
    _id: activation.residentId,
    hostelId: activation.hostelId,
    isDeleted: false,
    status: { $ne: "MOVED_OUT" },
  }).lean<ResidentRecord | null>();

  if (!resident) {
    throw new ActivationServiceError(
      "Resident was not found.",
      "RESIDENT_NOT_FOUND",
      404,
    );
  }

  if (resident.userId && resident.userId.toString() !== principal.userId) {
    throw new ActivationServiceError(
      "Resident profile is already linked to another account.",
      "RESIDENT_ALREADY_LINKED",
      409,
    );
  }

  const existingResident = await ResidentModel.findOne({
    _id: { $ne: resident._id },
    isDeleted: false,
    status: { $in: ["ACTIVE", "PENDING"] },
    userId: normalizeObjectId(principal.userId, "user id"),
  }).lean<ResidentRecord | null>();

  if (existingResident) {
    throw new ActivationServiceError(
      "This account is already linked to another active resident profile.",
      "RESIDENT_ACCOUNT_ALREADY_LINKED",
      409,
    );
  }

  const updatedResident = await ResidentModel.findOneAndUpdate(
    { _id: resident._id, isDeleted: false },
    {
      $set: {
        status: "ACTIVE",
        updatedBy: principal.userId,
        userId: normalizeObjectId(principal.userId, "user id"),
      },
    },
    { new: true },
  ).lean<ResidentRecord | null>();

  if (!updatedResident) {
    throw new ActivationServiceError(
      "Resident was not found.",
      "RESIDENT_NOT_FOUND",
      404,
    );
  }

  await QRActivationModel.updateOne(
    { _id: activation._id },
    {
      $set: {
        deviceInfo: input.deviceInfo,
        sessionInfo: input.sessionInfo,
        status: "USED",
        usedAt: now,
        usedBy: principal.userId,
      },
    },
  );

  const user = await UserModel.findOneAndUpdate(
    {
      _id: normalizeObjectId(principal.userId, "user id"),
      isDeleted: { $ne: true },
      status: "ACTIVE",
    },
    {
      $addToSet: { hostelIds: activation.hostelId },
      $set: { role: Role.RESIDENT, updatedBy: principal.userId },
    },
    { new: true },
  ).lean<UserRecord | null>();

  if (!user) {
    throw new ActivationServiceError(
      "User account was not found.",
      "USER_NOT_FOUND",
      404,
    );
  }

  await auditActivation(
    principal,
    activation.hostelId,
    activation._id,
    "RESIDENT_ACTIVATED",
    { residentId: resident._id.toString(), userId: principal.userId },
  );

  const session = await issueSessionForUser(user);

  return {
    activation: serializeActivation({
      ...activation,
      status: "USED",
      usedAt: now,
      usedBy: normalizeObjectId(principal.userId, "user id"),
    }),
    resident: serializeResidentSummary(updatedResident),
    session,
  };
}

export async function getActivationStatus(
  query: ActivationStatusQuery,
  principal: ApiPrincipal,
) {
  await connectToDatabase();

  const linkedResident = await ResidentModel.findOne({
    isDeleted: false,
    status: { $in: ["ACTIVE", "PENDING"] },
    userId: normalizeObjectId(principal.userId, "user id"),
  }).lean<ResidentRecord | null>();

  const activation = query.code
    ? await QRActivationModel.findOne({
        codeHash: hashActivationCode(query.code),
      })
        .sort({ createdAt: -1 })
        .lean<QRActivationRecord | null>()
    : null;

  return {
    activation: activation ? serializeActivation(activation) : null,
    isActivated: Boolean(linkedResident),
    resident: linkedResident ? serializeResidentSummary(linkedResident) : null,
    target: activation ? await describeActivationTarget(activation) : null,
  };
}

export type ActivationTarget = {
  area: string;
  city: string;
  hostelName: string;
  photoUrl: string | null;
  roomType: string;
  verified: boolean;
};

/**
 * What the code is *for* — the hostel and the bed on the other side of it.
 *
 * Somebody typing a code they were handed has no way to check they are about to
 * attach their account to the right hostel, and "Activate" is not an action you
 * want taken on faith. So the screen shows the destination before the button is
 * pressed, and this is where that comes from.
 *
 * Deliberately **nothing about the resident**: not their name, phone or email.
 * The person redeeming is supposed to be them, but the code is a bearer secret
 * and a screen that printed somebody's details on receipt of one would make a
 * stray code a small data leak. The hostel and the room type are what the
 * redeemer needs in order to recognise their own activation, and no more.
 */
async function describeActivationTarget(
  activation: QRActivationRecord,
): Promise<ActivationTarget | null> {
  const [hostel, resident] = await Promise.all([
    HostelModel.findById(activation.hostelId)
      .select("location name photos verificationStatus")
      .lean<HostelTargetRecord | null>(),
    ResidentModel.findById(activation.residentId)
      .select("roomType")
      .lean<{ roomType?: string } | null>(),
  ]);

  if (!hostel) {
    return null;
  }

  return {
    area: hostel.location?.area ?? "",
    city: hostel.location?.city ?? "",
    hostelName: hostel.name,
    photoUrl: resolveHostelPhotoUrls(hostel.photos, "EXTERIOR")[0] ?? null,
    roomType: resident?.roomType ?? "",
    verified: hostel.verificationStatus === "VERIFIED",
  };
}
