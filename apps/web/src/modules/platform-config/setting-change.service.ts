import "server-only";

import { createHash, randomBytes } from "node:crypto";

import { Types } from "mongoose";

import { AuditLogModel } from "@hostel/db/models/AuditLog";
import { PlatformSettingChangeModel } from "@hostel/db/models/PlatformSettingChange";
import { UserModel } from "@hostel/db/models/User";
import { sendEmail } from "@hostel/shared/email/sender";
import { emailDateTime, type ComparisonRow } from "@hostel/shared/email/templates/layout";
import { settingChangeConfirmEmail } from "@hostel/shared/email/templates/platform/setting-change-confirm";

import { assertPrimaryCredentialPrincipal, type ApiPrincipal } from "@/lib/api-auth";
import { connectToDatabase } from "@/lib/db";
import { siteUrl } from "@/lib/site";
import {
  SETTING_CHANGES,
  isSettingChangeKey,
  type SettingChangeDefinition,
  type SettingChangeKey,
} from "@/modules/platform-config/setting-change.registry";
import type { PendingSettingChange } from "@/lib/platform-config/platform-config.types";
export type { PendingSettingChange } from "@/lib/platform-config/platform-config.types";

/**
 * Saving a money setting, in two halves: ask here, apply from the inbox.
 *
 * `requestSettingChange` validates the complete new value, parks it, and emails
 * a single-use link to the superadmin who asked. `confirmSettingChange` applies
 * it — only for that same account, only once, only before the link expires, and
 * only if the setting still holds the value the email showed as "Now".
 *
 * That last check matters because the parked value is a whole document, not a
 * patch. Applying a stale one on top of a newer change would silently undo it.
 */

export const SETTING_CHANGE_LINK_MINUTES = 30;

export class SettingChangeError extends Error {
  constructor(
    message: string,
    public errorCode = "SETTING_CHANGE_ERROR",
    public status = 400,
  ) {
    super(message);
    this.name = "SettingChangeError";
  }
}

type ChangeRecord = {
  _id: Types.ObjectId;
  expiresAt: Date;
  key: string;
  previousValue: unknown;
  proposedValue: unknown;
  requestedBy: Types.ObjectId;
  requestedEmail: string;
  status: string;
};

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

/** `wo•••@gmail.com` — enough to recognise the inbox, not enough to harvest it. */
export function maskEmail(email: string) {
  const [local = "", domain = ""] = email.split("@");

  return `${local.slice(0, 2)}•••@${domain}`;
}

/** Key order independent, so a value read back from Mongo compares equal to what was stored. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }

  if (value && typeof value === "object" && !(value instanceof Date)) {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value ?? null);
}

function definitionFor(key: string): SettingChangeDefinition<unknown> {
  if (!isSettingChangeKey(key)) {
    throw new SettingChangeError("Unknown setting.", "SETTING_NOT_FOUND", 404);
  }

  return SETTING_CHANGES[key] as unknown as SettingChangeDefinition<unknown>;
}

function toPending(record: ChangeRecord): PendingSettingChange {
  const definition = definitionFor(record.key);

  return {
    expiresAt: record.expiresAt.toISOString(),
    id: String(record._id),
    key: record.key as SettingChangeKey,
    label: definition.label,
    rows: definition.rows(record.previousValue, record.proposedValue),
    sentTo: maskEmail(record.requestedEmail),
  };
}

/** The change waiting on an email confirm for this setting, if one is still live. */
export async function getPendingSettingChange(
  key: SettingChangeKey,
): Promise<PendingSettingChange | null> {
  await connectToDatabase();

  const record = await PlatformSettingChangeModel.findOne({
    expiresAt: { $gt: new Date() },
    key,
    status: "PENDING",
  })
    .sort({ createdAt: -1 })
    .lean<ChangeRecord | null>();

  return record ? toPending(record) : null;
}

export async function requestSettingChange(
  key: SettingChangeKey,
  proposedInput: unknown,
  principal: ApiPrincipal,
): Promise<PendingSettingChange> {
  assertPrimaryCredentialPrincipal(principal);
  await connectToDatabase();

  const definition = definitionFor(key);
  const previous = await definition.load();
  const proposed = definition.parse(proposedInput);
  const rows = definition.rows(previous, proposed);

  if (rows.length === 0) {
    throw new SettingChangeError("Nothing was changed.", "SETTING_UNCHANGED", 422);
  }

  const user = await UserModel.findById(principal.userId)
    .select("email name")
    .lean<{ email?: string | null; name?: string | null } | null>();

  if (!user?.email) {
    throw new SettingChangeError(
      "Your account has no email address, so this change cannot be confirmed.",
      "SETTING_CHANGE_NO_EMAIL",
      422,
    );
  }

  // One live request per setting: the newest is the one the superadmin means.
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SETTING_CHANGE_LINK_MINUTES * 60_000);

  const record = await PlatformSettingChangeModel.create({
    expiresAt,
    key,
    previousValue: previous,
    proposedValue: proposed,
    requestedBy: principal.userId,
    requestedEmail: user.email,
    status: "PENDING",
    tokenHash: hashToken(token),
  });

  const message = settingChangeConfirmEmail({
    confirmUrl: `${siteUrl()}/platform/settings/confirm?token=${encodeURIComponent(token)}`,
    expiresAt: emailDateTime(expiresAt) ?? "30 minutes from now",
    name: user.name,
    rows,
    settingLabel: definition.label,
  });

  const delivery = await sendEmail({
    category: message.category,
    html: message.html,
    subject: message.subject,
    to: user.email,
  });

  if (!delivery.sent) {
    // An unconfirmable change is worse than none: say so and leave nothing parked.
    await PlatformSettingChangeModel.updateOne(
      { _id: record._id },
      { $set: { cancelledAt: new Date(), status: "CANCELLED" } },
    );

    throw new SettingChangeError(
      "We could not send the confirmation email, so nothing was changed. Try again.",
      "SETTING_CHANGE_EMAIL_FAILED",
      502,
    );
  }

  // The older request is replaced only once this one's email is out (P7-21):
  // superseding it first left neither link usable when the send failed.
  await PlatformSettingChangeModel.updateMany(
    { _id: { $ne: record._id }, key, status: "PENDING" },
    { $set: { status: "SUPERSEDED" } },
  );

  await AuditLogModel.create({
    action: "PLATFORM_SETTING_CHANGE_REQUESTED",
    actorId: principal.userId,
    actorType: "USER",
    entityId: String(record._id),
    entityType: "PlatformSettingChange",
    metadata: { key, rows },
  });

  return toPending(record.toObject() as ChangeRecord);
}

async function loadByToken(token: string, principal: ApiPrincipal) {
  await connectToDatabase();

  const record = token
    ? await PlatformSettingChangeModel.findOne({ tokenHash: hashToken(token) }).lean<ChangeRecord | null>()
    : null;

  if (!record) {
    throw new SettingChangeError(
      "This confirmation link is not valid.",
      "SETTING_CHANGE_NOT_FOUND",
      404,
    );
  }

  if (String(record.requestedBy) !== principal.userId) {
    throw new SettingChangeError(
      "This link belongs to another superadmin. Sign in as the account that made the change.",
      "SETTING_CHANGE_WRONG_ACCOUNT",
      403,
    );
  }

  return record;
}

const CLOSED_MESSAGES: Record<string, string> = {
  APPLIED: "This change is already saved.",
  CANCELLED: "This change was cancelled.",
  EXPIRED: "This link has expired. Make the change again.",
  SUPERSEDED: "A newer change replaced this one. Use the link in the latest email.",
};

export type SettingChangePreview = PendingSettingChange & { status: string };

/** What the confirm page shows before the button is pressed. */
export async function previewSettingChange(
  token: string,
  principal: ApiPrincipal,
): Promise<SettingChangePreview> {
  const record = await loadByToken(token, principal);
  const expired = record.status === "PENDING" && record.expiresAt.getTime() <= Date.now();

  return { ...toPending(record), status: expired ? "EXPIRED" : record.status };
}

export async function confirmSettingChange(token: string, principal: ApiPrincipal) {
  assertPrimaryCredentialPrincipal(principal);

  const record = await loadByToken(token, principal);
  const definition = definitionFor(record.key);

  if (record.status !== "PENDING") {
    throw new SettingChangeError(
      CLOSED_MESSAGES[record.status] ?? "This change can no longer be confirmed.",
      "SETTING_CHANGE_CLOSED",
      409,
    );
  }

  if (record.expiresAt.getTime() <= Date.now()) {
    await PlatformSettingChangeModel.updateOne(
      { _id: record._id, status: "PENDING" },
      { $set: { status: "EXPIRED" } },
    );

    throw new SettingChangeError(CLOSED_MESSAGES.EXPIRED, "SETTING_CHANGE_EXPIRED", 410);
  }

  const current = await definition.load();

  if (stableJson(current) !== stableJson(definition.parse(record.previousValue))) {
    await PlatformSettingChangeModel.updateOne(
      { _id: record._id, status: "PENDING" },
      { $set: { status: "SUPERSEDED" } },
    );

    throw new SettingChangeError(
      "The setting changed after this email was sent, so this link would undo that. Make the change again.",
      "SETTING_CHANGE_STALE",
      409,
    );
  }

  const claimed = await PlatformSettingChangeModel.findOneAndUpdate(
    { _id: record._id, status: "PENDING" },
    { $set: { appliedAt: new Date(), status: "APPLIED" } },
    { new: true },
  ).lean<ChangeRecord | null>();

  if (!claimed) {
    throw new SettingChangeError(CLOSED_MESSAGES.APPLIED, "SETTING_CHANGE_CLOSED", 409);
  }

  try {
    await definition.apply(definition.parse(record.proposedValue), principal.userId);
  } catch (error) {
    await PlatformSettingChangeModel.updateOne(
      { _id: record._id },
      { $set: { status: "PENDING" }, $unset: { appliedAt: 1 } },
    );

    throw error;
  }

  const rows = definition.rows(record.previousValue, record.proposedValue);

  await AuditLogModel.create({
    action: "PLATFORM_SETTING_CHANGE_APPLIED",
    actorId: principal.userId,
    actorType: "USER",
    entityId: String(record._id),
    entityType: "PlatformSettingChange",
    metadata: { key: record.key, rows },
  });

  return { key: record.key as SettingChangeKey, label: definition.label, rows };
}

export async function cancelSettingChange(id: string, principal: ApiPrincipal) {
  await connectToDatabase();

  if (!Types.ObjectId.isValid(id)) {
    throw new SettingChangeError("Change not found.", "SETTING_CHANGE_NOT_FOUND", 404);
  }

  const cancelled = await PlatformSettingChangeModel.findOneAndUpdate(
    { _id: id, status: "PENDING" },
    { $set: { cancelledAt: new Date(), cancelledBy: principal.userId, status: "CANCELLED" } },
    { new: true },
  ).lean<ChangeRecord | null>();

  if (!cancelled) {
    throw new SettingChangeError(
      "There is no change waiting to be cancelled.",
      "SETTING_CHANGE_CLOSED",
      409,
    );
  }

  await AuditLogModel.create({
    action: "PLATFORM_SETTING_CHANGE_CANCELLED",
    actorId: principal.userId,
    actorType: "USER",
    entityId: id,
    entityType: "PlatformSettingChange",
    metadata: { key: cancelled.key },
  });

  return { cancelled: true };
}
