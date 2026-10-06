import { assertPlanRoom } from "@/modules/billing/plan-limits";
import { randomBytes } from "node:crypto";

import { Types } from "mongoose";
import type { z } from "zod";

import type { ApiPrincipal } from "@/lib/api-auth";
import { connectToDatabase } from "@/lib/db";
import { hashPassword } from "@/lib/password";
import { Role } from "@/lib/roles";
import { AuditLogModel } from "@hostel/db/models/AuditLog";
import { CookAccountModel } from "@hostel/db/models/CookAccount";
import { HostelModel } from "@hostel/db/models/Hostel";
import { HostelSettingsModel } from "@hostel/db/models/HostelSettings";
import { SessionModel } from "@hostel/db/models/Session";
import { UserModel } from "@hostel/db/models/User";
import { CookServiceError, resolveAdminHostelId } from "@/modules/food/cook-scope";
import {
  generateCookPassword,
  mintCookLogin,
  previousCookLabel,
} from "@/modules/food/cook-identity";
import { cookCredentialsEmail } from "@hostel/shared/email/templates/cook/credentials";
import { cookInvitationEmail } from "@hostel/shared/email/templates/cook/invitation";
import {
  appUrl,
  resolveHostelAdminContacts,
  sendNotificationEmail,
} from "@/modules/residents/resident-notify";
import { normalizeObjectId } from "@/modules/residents/resident-access";
import { registerOrUpgradeUserByEmail } from "@/modules/users/user.service";
import type {
  cookCreateSchema,
  cookInvitationAcceptSchema,
  cookUpdateSchema,
} from "@/modules/food/cook.validation";

/**
 * The hostel's roster of cooks — who can sign in to the kitchen, how they were
 * given access, and who used to be able to.
 *
 * ## What changed, and why
 *
 * A hostel had exactly one cook: a generated login pinned to
 * `HostelSettings.cookUserId`. There was no way to add a second, no way to
 * remove one without leaving the pointer dangling at a suspended account, and
 * no way to give access to a cook who has their own phone and their own email.
 *
 * The roster is `CookAccount` rows. Two ways onto it:
 *
 * - **Generated credentials.** We mint a short login and a first-time password
 *   and mail both to the admin, who hands them over. No mailbox is involved.
 *   This is the kitchen-shares-one-phone case, and it is still the default.
 * - **An invitation.** The admin types the cook's own email; the cook opens the
 *   link and their account becomes the cook account. The same shape a resident
 *   uses to bring in a guardian — `guardian-invite.service.ts` — because it is
 *   the same problem: give a real person a scoped role on an address they
 *   already control, without ever handling their password.
 *
 * ## Removal is real, attribution survives it
 *
 * Removing a cook ends their access for good — the generated account is deleted
 * and an invited person's account drops back to `PUBLIC`. What does *not* go is
 * the record of what they did: the row stays with `status: "REMOVED"` and a
 * frozen `historicalName`, so a meal they announced in Bhadra still reads
 * "Previous Sunrise cook" rather than a blank or, worse, the name of whoever
 * holds the login now.
 */

type CookCreateInput = z.infer<typeof cookCreateSchema>;
type CookUpdateInput = z.infer<typeof cookUpdateSchema>;
type CookInvitationAcceptInput = z.infer<typeof cookInvitationAcceptSchema>;

const INVITATION_EXPIRY_DAYS = 7;

/**
 * A hostel cannot hold an unbounded number of live logins. The cap is generous
 * for a real kitchen and small enough that a compromised admin session cannot
 * quietly mint a hundred accounts.
 */
const MAX_ACTIVE_COOKS = 10;

type CookAccountRecord = {
  _id: Types.ObjectId;
  acceptedAt?: Date;
  createdAt?: Date;
  credentialIssuedAt?: Date;
  historicalName?: string;
  hostelId: Types.ObjectId;
  invitationExpiresAt?: Date;
  invitationToken?: string;
  kind: "CREDENTIAL" | "INVITE";
  loginEmail: string;
  name: string;
  removedAt?: Date;
  status: "INVITED" | "ACTIVE" | "REMOVED";
  userId?: Types.ObjectId;
};

function invitationToken() {
  return randomBytes(32).toString("hex");
}

function daysFromNow(days: number) {
  const date = new Date();

  date.setDate(date.getDate() + days);

  return date;
}

async function loadHostel(hostelId: Types.ObjectId) {
  const hostel = await HostelModel.findOne({ _id: hostelId })
    .select("name slug")
    .lean<{ name?: string; slug?: string } | null>();

  if (!hostel) {
    throw new CookServiceError("Hostel was not found.", "HOSTEL_NOT_FOUND", 404);
  }

  return { name: hostel.name ?? "Hostel", slug: hostel.slug ?? hostelId.toString() };
}

/**
 * What the admin screens are given for one cook.
 *
 * Never the password and never the invitation token — only whether one is
 * outstanding. Once a cook has chosen their own password, all that exists is a
 * bcrypt hash, so `initialPasswordPending: false` is the honest way to say
 * "there is nothing here to show you".
 */
function serializeCook(
  cook: CookAccountRecord,
  account?: { mustChangePassword?: boolean } | null,
) {
  return {
    acceptedAt: cook.acceptedAt?.toISOString(),
    addedAt: cook.createdAt?.toISOString(),
    credentialIssuedAt: cook.credentialIssuedAt?.toISOString(),
    /** The name this cook's past work is filed under once removed. */
    historicalName: cook.historicalName,
    id: cook._id.toString(),
    /** True while the emailed hand-off password is still unused. */
    initialPasswordPending: Boolean(account?.mustChangePassword),
    invitationExpiresAt: cook.invitationExpiresAt?.toISOString(),
    /** Whether an invitation is still outstanding — never the token itself. */
    invitationPending: cook.status === "INVITED",
    kind: cook.kind,
    loginEmail: cook.loginEmail,
    name: cook.name,
    removedAt: cook.removedAt?.toISOString(),
    status: cook.status,
    userId: cook.userId?.toString(),
  };
}

export type SerializedCook = ReturnType<typeof serializeCook>;

async function isLoginTaken(email: string) {
  const [user, cook] = await Promise.all([
    UserModel.findOne({ email }).select("_id").lean<{ _id: Types.ObjectId } | null>(),
    CookAccountModel.findOne({ loginEmail: email })
      .select("_id")
      .lean<{ _id: Types.ObjectId } | null>(),
  ]);

  // A removed cook's row still counts as taken: reusing the address would
  // re-point old attribution at a new person.
  return Boolean(user || cook);
}

/**
 * Points `HostelSettings` at whichever cook should be treated as the hostel's
 * primary one, so the older single-cook reads keep answering.
 *
 * The oldest live cook wins rather than the newest — the primary is "the one
 * who has been here longest", which is stable, instead of flipping every time
 * a second cook is added.
 */
async function syncPrimaryCook(hostelId: Types.ObjectId, actorId?: string) {
  const primary = await CookAccountModel.findOne({
    hostelId,
    status: { $in: ["ACTIVE", "INVITED"] },
    userId: { $ne: null },
  })
    .sort({ createdAt: 1 })
    .lean<CookAccountRecord | null>();

  await HostelSettingsModel.updateOne(
    { hostelId },
    {
      $set: {
        cookCredentialIssuedAt: primary?.credentialIssuedAt ?? null,
        cookName: primary?.name ?? "",
        cookUserId: primary?.userId ?? null,
        hostelId,
        ...(actorId ? { updatedBy: actorId } : {}),
      },
    },
    { upsert: true },
  );

  return primary;
}

/**
 * Brings a hostel whose only cook predates the roster into it.
 *
 * Rather than a migration script: the first time anybody opens the Cooks
 * screen, the legacy `HostelSettings.cookUserId` — if it still names a live
 * account with no row of its own — becomes a `CREDENTIAL` row. Hostels
 * approved before this feature therefore see their existing cook where they
 * expect it, with the login they have already written down, instead of an
 * empty roster that silently invalidates the credentials in their drawer.
 */
async function backfillLegacyCook(hostelId: Types.ObjectId) {
  const settings = await HostelSettingsModel.findOne({ hostelId })
    .select("cookCredentialIssuedAt cookName cookUserId")
    .lean<{
      cookCredentialIssuedAt?: Date;
      cookName?: string;
      cookUserId?: Types.ObjectId;
    } | null>();

  if (!settings?.cookUserId) {
    return;
  }

  const existing = await CookAccountModel.findOne({
    hostelId,
    userId: settings.cookUserId,
  })
    .select("_id")
    .lean<{ _id: Types.ObjectId } | null>();

  if (existing) {
    return;
  }

  const user = await UserModel.findOne({
    _id: settings.cookUserId,
    isDeleted: { $ne: true },
  })
    .select("email name status")
    .lean<{ email?: string; name?: string; status?: string } | null>();

  if (!user?.email) {
    return;
  }

  await CookAccountModel.create({
    credentialIssuedAt: settings.cookCredentialIssuedAt,
    hostelId,
    kind: "CREDENTIAL",
    loginEmail: user.email,
    name: settings.cookName || user.name || "Cook",
    // A suspended legacy account is one the admin turned the portal off on.
    // It comes back as ACTIVE only if the account itself still is.
    status: user.status === "ACTIVE" ? "ACTIVE" : "REMOVED",
    ...(user.status === "ACTIVE"
      ? {}
      : { historicalName: undefined, removedAt: new Date() }),
    userId: settings.cookUserId,
  });
}

/**
 * Mints a generated cook login: a short address, a first-time password, a User
 * and the roster row that owns them.
 *
 * Returns the plaintext password — the only moment it exists in the clear.
 * Callers are responsible for getting it to the admin.
 */
export async function issueCredentialCook(input: {
  actorId: string;
  cookName: string;
  hostelId: Types.ObjectId;
  hostelName: string;
  hostelSlug: string;
}) {
  const loginEmail = await mintCookLogin(
    input.hostelSlug || input.hostelName,
    isLoginTaken,
  );
  const temporaryPassword = generateCookPassword();
  const issuedAt = new Date();

  const user = await UserModel.create({
    authProvider: "LOCAL",
    email: loginEmail,
    // There is no mailbox to verify and no verification mail that could ever
    // arrive; treating it as unverified would only strand the account behind a
    // gate nobody can open.
    emailVerified: true,
    emailVerifiedAt: issuedAt,
    hostelIds: [input.hostelId],
    // The handed-over password is a one-time hand-off. The cook replaces it on
    // first sign-in, and that replacement is what the kitchen actually uses.
    mustChangePassword: true,
    name: input.cookName,
    passwordHash: await hashPassword(temporaryPassword),
    role: Role.COOK,
    status: "ACTIVE",
    updatedBy: input.actorId,
  });

  const cook = (await CookAccountModel.create({
    createdBy: input.actorId,
    credentialIssuedAt: issuedAt,
    hostelId: input.hostelId,
    kind: "CREDENTIAL",
    loginEmail,
    name: input.cookName,
    status: "ACTIVE",
    updatedBy: input.actorId,
    userId: user._id,
  })) as CookAccountRecord;

  await syncPrimaryCook(input.hostelId, input.actorId);

  return { cook, credentials: { email: loginEmail, temporaryPassword } };
}

/** Mails a generated login to every admin of the hostel. */
async function mailCredentialsToAdmins(input: {
  cookName: string;
  credentials: { email: string; temporaryPassword: string };
  hostelId: Types.ObjectId;
  hostelName: string;
  rotated?: boolean;
}) {
  const admins = await resolveHostelAdminContacts(input.hostelId);
  const message = cookCredentialsEmail({
    cookName: input.cookName,
    credentials: input.credentials,
    hostelName: input.hostelName,
    loginUrl: appUrl("/login"),
    rotated: input.rotated,
  });

  await Promise.all(
    admins.map((admin) =>
      sendNotificationEmail({
        action: input.rotated ? "cook_password_rotated" : "cook_credentials_issued",
        html: message.html,
        subject: message.subject,
        to: admin.email,
      }),
    ),
  );
}

/** The hostel's cooks, current first, with the removed ones kept at the end. */
export async function listCookAccounts(
  principal: ApiPrincipal,
  requestedHostelId?: string,
) {
  await connectToDatabase();

  const hostelId = resolveAdminHostelId(principal, requestedHostelId);

  await backfillLegacyCook(hostelId);

  const cooks = await CookAccountModel.find({ hostelId })
    .sort({ createdAt: 1 })
    .lean<CookAccountRecord[]>();
  const settings = await HostelSettingsModel.findOne({ hostelId })
    .select("cookCanRecordExpenses cookFingerprintLock cookPortalEnabled")
    .lean<{
      cookCanRecordExpenses?: boolean;
      cookFingerprintLock?: boolean;
      cookPortalEnabled?: boolean;
    } | null>();

  // One query for every live cook's account rather than one per row: the flag
  // being read is `mustChangePassword`, which only exists on the User.
  const userIds = cooks
    .filter((cook) => cook.status !== "REMOVED" && cook.userId)
    .map((cook) => cook.userId as Types.ObjectId);
  const accounts = await UserModel.find({ _id: { $in: userIds } })
    .select("mustChangePassword")
    .lean<{ _id: Types.ObjectId; mustChangePassword?: boolean }[]>();
  const accountById = new Map(
    accounts.map((account) => [account._id.toString(), account]),
  );

  const serialized = cooks.map((cook) =>
    serializeCook(
      cook,
      cook.userId ? accountById.get(cook.userId.toString()) : null,
    ),
  );

  return {
    cooks: [
      ...serialized.filter((cook) => cook.status !== "REMOVED"),
      ...serialized.filter((cook) => cook.status === "REMOVED").reverse(),
    ],
    /** Whether the cook may add expenses. Only the owner can change it. */
    expensesEnabled: Boolean(settings?.cookCanRecordExpenses),
    /** Whether cooks are asked for a fingerprint lock in the app. Owner only. */
    fingerprintLock: Boolean(settings?.cookFingerprintLock),
    portalEnabled: Boolean(settings?.cookPortalEnabled),
  };
}

/**
 * The owner's call, like the cook's *Add expense*: whether every cook of this
 * hostel is asked to lock the app with a fingerprint. Reaches the cook through
 * `/auth/me` and the sign-in payload (`cookFingerprintLock`).
 */
export async function setCookFingerprintLock(
  principal: ApiPrincipal,
  enabled: boolean,
  requestedHostelId?: string,
) {
  await connectToDatabase();

  const hostelId = resolveAdminHostelId(principal, requestedHostelId);

  await HostelSettingsModel.updateOne(
    { hostelId },
    {
      $set: { cookFingerprintLock: enabled, updatedBy: principal.userId },
      $setOnInsert: { hostelId },
    },
    { upsert: true },
  );

  return { fingerprintLock: enabled };
}

async function assertRoomForAnotherCook(hostelId: Types.ObjectId) {
  await assertPlanRoom(hostelId, "cooks");

  const live = await CookAccountModel.countDocuments({
    hostelId,
    status: { $in: ["ACTIVE", "INVITED"] },
  });

  if (live >= MAX_ACTIVE_COOKS) {
    throw new CookServiceError(
      `A hostel can have ${MAX_ACTIVE_COOKS} cooks at a time. Remove one before adding another.`,
      "COOK_LIMIT_REACHED",
      409,
    );
  }
}

/**
 * Adds a cook — either by minting a login, or by inviting an address.
 *
 * The two branches share the cap and the audit trail and nothing else: one
 * returns a password and mails the admin, the other returns no secret at all
 * and mails the cook.
 */
export async function addCookAccount(input: CookCreateInput, principal: ApiPrincipal) {
  await connectToDatabase();

  const hostelId = resolveAdminHostelId(principal, input.hostelId);
  const hostel = await loadHostel(hostelId);

  await backfillLegacyCook(hostelId);
  await assertRoomForAnotherCook(hostelId);

  if (input.kind === "CREDENTIAL") {
    const { cook, credentials } = await issueCredentialCook({
      actorId: principal.userId,
      cookName: input.name,
      hostelId,
      hostelName: hostel.name,
      hostelSlug: hostel.slug,
    });

    // Adding a cook is the act that means the kitchen is in use, so it turns
    // the portal on rather than leaving a working login behind a switch the
    // admin has to find on another screen.
    await HostelSettingsModel.updateOne(
      { hostelId },
      { $set: { cookPortalEnabled: true, hostelId, updatedBy: principal.userId } },
      { upsert: true },
    );

    await AuditLogModel.create({
      action: "COOK_CREDENTIALS_ISSUED",
      actorId: principal.userId,
      entityId: cook._id.toString(),
      entityType: "CookAccount",
      hostelId,
      metadata: { cookName: input.name, loginEmail: credentials.email },
    });

    await mailCredentialsToAdmins({
      cookName: input.name,
      credentials,
      hostelId,
      hostelName: hostel.name,
    });

    return {
      /** Returned once so the admin can hand it over if the email never lands. */
      credentials,
      cook: serializeCook(cook, { mustChangePassword: true }),
    };
  }

  const email = input.email.trim().toLowerCase();
  const clash = await CookAccountModel.findOne({
    hostelId,
    loginEmail: email,
    status: { $in: ["ACTIVE", "INVITED"] },
  })
    .select("_id")
    .lean<{ _id: Types.ObjectId } | null>();

  if (clash) {
    throw new CookServiceError(
      "That email is already a cook here.",
      "COOK_ALREADY_INVITED",
      409,
    );
  }

  const token = invitationToken();
  const cook = (await CookAccountModel.create({
    createdBy: principal.userId,
    hostelId,
    invitationExpiresAt: daysFromNow(INVITATION_EXPIRY_DAYS),
    invitationToken: token,
    kind: "INVITE",
    loginEmail: email,
    name: input.name,
    status: "INVITED",
    updatedBy: principal.userId,
  })) as CookAccountRecord;

  await HostelSettingsModel.updateOne(
    { hostelId },
    { $set: { cookPortalEnabled: true, hostelId, updatedBy: principal.userId } },
    { upsert: true },
  );

  await AuditLogModel.create({
    action: "COOK_INVITED",
    actorId: principal.userId,
    entityId: cook._id.toString(),
    entityType: "CookAccount",
    hostelId,
    metadata: { cookName: input.name, email },
  });

  const message = cookInvitationEmail({
    acceptUrl: appUrl(`/cook-invite?token=${token}`),
    cookName: input.name,
    expiresInDays: INVITATION_EXPIRY_DAYS,
    hostelName: hostel.name,
  });

  await sendNotificationEmail({
    action: "cook_invitation",
    html: message.html,
    subject: message.subject,
    to: email,
  });

  return { cook: serializeCook(cook) };
}

async function findHostelCook(cookId: string, hostelId: Types.ObjectId) {
  const cook = await CookAccountModel.findOne({
    _id: normalizeObjectId(cookId, "cook id"),
    hostelId,
  }).lean<CookAccountRecord | null>();

  if (!cook) {
    throw new CookServiceError("That cook was not found.", "COOK_NOT_FOUND", 404);
  }

  return cook;
}

/**
 * Renames a cook, rotates their password, or both.
 *
 * Rotation is the answer to every "the cook is locked out" and "the password
 * has been seen by too many people" question — the stored value is a bcrypt
 * hash, so there is nothing to look up and nothing to un-leak. A fresh
 * first-time password is issued and every session on the account is revoked,
 * because a rotation that left the leaked session signed in would not be one.
 */
export async function updateCookAccount(
  cookId: string,
  input: CookUpdateInput,
  principal: ApiPrincipal,
) {
  await connectToDatabase();

  const hostelId = resolveAdminHostelId(principal, input.hostelId);
  const hostel = await loadHostel(hostelId);
  const cook = await findHostelCook(cookId, hostelId);

  if (cook.status === "REMOVED") {
    throw new CookServiceError(
      "This cook has been removed and cannot be changed.",
      "COOK_REMOVED",
      409,
    );
  }

  const name = input.name?.trim() || cook.name;
  const update: Record<string, unknown> = { name, updatedBy: principal.userId };
  let credentials: { email: string; temporaryPassword: string } | undefined;

  if (input.rotate) {
    if (cook.kind !== "CREDENTIAL" || !cook.userId) {
      throw new CookServiceError(
        "This cook signs in with their own email, so there is no password here to rotate.",
        "COOK_NOT_CREDENTIAL",
        409,
      );
    }

    const temporaryPassword = generateCookPassword();

    await UserModel.updateOne(
      { _id: cook.userId },
      {
        $set: {
          mustChangePassword: true,
          name,
          passwordHash: await hashPassword(temporaryPassword),
          status: "ACTIVE",
          updatedBy: principal.userId,
        },
      },
    );
    await SessionModel.updateMany(
      { revokedAt: null, userId: cook.userId },
      { $set: { revokedAt: new Date() } },
    );

    update.credentialIssuedAt = new Date();
    credentials = { email: cook.loginEmail, temporaryPassword };
  } else if (cook.userId && input.name) {
    await UserModel.updateOne(
      { _id: cook.userId },
      { $set: { name, updatedBy: principal.userId } },
    );
  }

  const updated = await CookAccountModel.findOneAndUpdate(
    { _id: cook._id },
    { $set: update },
    { new: true },
  ).lean<CookAccountRecord | null>();

  await syncPrimaryCook(hostelId, principal.userId);

  if (credentials) {
    await AuditLogModel.create({
      action: "COOK_PASSWORD_ROTATED",
      actorId: principal.userId,
      entityId: cook._id.toString(),
      entityType: "CookAccount",
      hostelId,
    });
    await mailCredentialsToAdmins({
      cookName: name,
      credentials,
      hostelId,
      hostelName: hostel.name,
      rotated: true,
    });
  }

  return {
    cook: serializeCook(updated ?? cook, { mustChangePassword: Boolean(credentials) }),
    ...(credentials ? { credentials } : {}),
  };
}

/**
 * Removes a cook for good.
 *
 * What "for good" means depends on how they got in:
 *
 * - A **generated** login is an account we created for one purpose, so it is
 *   deleted — flagged `isDeleted`, blanked of its password, its sessions
 *   revoked. Nobody can sign in with it again, and the address is not reissued.
 * - An **invited** cook's account is *their own*. It is not ours to delete, so
 *   it loses the hostel and drops back to `PUBLIC`: the person keeps their
 *   account and their sign-in, and stops being a cook. Their sessions are
 *   revoked so the change is immediate rather than at the next token refresh.
 *
 * The roster row survives either way, carrying the frozen `historicalName` that
 * everything they already did is attributed to from here on.
 */
export async function removeCookAccount(
  cookId: string,
  principal: ApiPrincipal,
  requestedHostelId?: string,
) {
  await connectToDatabase();

  const hostelId = resolveAdminHostelId(principal, requestedHostelId);
  const hostel = await loadHostel(hostelId);
  const cook = await findHostelCook(cookId, hostelId);

  if (cook.status === "REMOVED") {
    return { cook: serializeCook(cook) };
  }

  const historicalName = previousCookLabel(hostel.name);

  if (cook.userId) {
    if (cook.kind === "CREDENTIAL") {
      await UserModel.updateOne(
        { _id: cook.userId },
        {
          $set: {
            isDeleted: true,
            status: "DELETED",
            updatedBy: principal.userId,
          },
          // Without this the deleted row still holds a usable hash. The account
          // is unreachable either way, but a credential nobody can use should
          // not still be sitting in the database.
          $unset: { passwordHash: "" },
        },
      );
    } else {
      await UserModel.updateOne(
        { _id: cook.userId, role: Role.COOK },
        {
          $pull: { hostelIds: hostelId },
          $set: { role: Role.PUBLIC, updatedBy: principal.userId },
        },
      );
    }

    await SessionModel.updateMany(
      { revokedAt: null, userId: cook.userId },
      { $set: { revokedAt: new Date() } },
    );
  }

  const removed = await CookAccountModel.findOneAndUpdate(
    { _id: cook._id },
    {
      $set: {
        historicalName,
        removedAt: new Date(),
        status: "REMOVED",
        updatedBy: principal.userId,
      },
      // A pending invitation dies with the cook: the link in that mailbox must
      // stop working the moment the admin decides they are not coming.
      $unset: { invitationToken: "" },
    },
    { new: true },
  ).lean<CookAccountRecord | null>();

  const primary = await syncPrimaryCook(hostelId, principal.userId);

  // The portal switch follows the roster: an enabled portal with nobody on it
  // is a door with no key behind it, and the next cook added turns it back on.
  if (!primary) {
    await HostelSettingsModel.updateOne(
      { hostelId },
      { $set: { cookPortalEnabled: false, hostelId, updatedBy: principal.userId } },
      { upsert: true },
    );
  }

  await AuditLogModel.create({
    action: "COOK_REMOVED",
    actorId: principal.userId,
    entityId: cook._id.toString(),
    entityType: "CookAccount",
    hostelId,
    metadata: { historicalName, kind: cook.kind, loginEmail: cook.loginEmail },
  });

  return { cook: serializeCook(removed ?? cook) };
}

/**
 * The cook opens the emailed link.
 *
 * Runs through `registerOrUpgradeUserByEmail`, the one entry point for
 * admin-issued accounts, so an address that already belongs to a resident or an
 * admin is refused (409) rather than quietly repurposed into a cook login — the
 * same guarantee the guardian flow relies on.
 *
 * No session is minted here. Accepting a link proves you can open a mailbox; it
 * does not prove who you are, so the cook is handed off to sign-in.
 */
export async function acceptCookInvitation(input: CookInvitationAcceptInput) {
  await connectToDatabase();

  const cook = await CookAccountModel.findOne({
    invitationToken: input.token,
    status: "INVITED",
  })
    .select("+invitationToken")
    .lean<CookAccountRecord | null>();

  if (!cook) {
    throw new CookServiceError(
      "This invitation is not valid.",
      "COOK_INVITATION_INVALID",
      404,
    );
  }

  if (cook.invitationExpiresAt && cook.invitationExpiresAt.getTime() < Date.now()) {
    await CookAccountModel.updateOne(
      { _id: cook._id },
      { $set: { status: "REMOVED" }, $unset: { invitationToken: "" } },
    );

    throw new CookServiceError(
      "This invitation has expired. Ask the hostel to send a new one.",
      "COOK_INVITATION_EXPIRED",
      410,
    );
  }

  const hostel = await loadHostel(cook.hostelId);
  const result = await registerOrUpgradeUserByEmail({
    email: cook.loginEmail,
    hostelId: cook.hostelId.toString(),
    hostelName: hostel.name,
    name: input.name ?? cook.name,
    role: Role.COOK,
  });

  await CookAccountModel.updateOne(
    { _id: cook._id },
    {
      $set: { acceptedAt: new Date(), status: "ACTIVE", userId: result.user.id },
      $unset: { invitationToken: "" },
    },
  );

  await syncPrimaryCook(cook.hostelId);

  await AuditLogModel.create({
    action: "COOK_INVITATION_ACCEPTED",
    actorId: result.user.id,
    entityId: cook._id.toString(),
    entityType: "CookAccount",
    hostelId: cook.hostelId,
  });

  return {
    accepted: true,
    accountCreated: result.created,
    email: result.user.email,
    hostelName: hostel.name,
    /** True when credentials were emailed and the cook must now sign in. */
    requiresLogin: result.created || result.upgraded,
  };
}

/**
 * The display name for each user id that has done something in this hostel's
 * kitchen — the current cook's name while they are on the roster, the frozen
 * "Previous Sunrise cook" once they are not.
 *
 * Every read that shows *who* announced a meal or posted a photo goes through
 * here rather than joining to `User.name`, because a removed generated account
 * has no name left to join to and an invited cook's account name is theirs, not
 * the kitchen's.
 */
export async function resolveCookLabels(
  hostelId: Types.ObjectId | string,
  userIds: (Types.ObjectId | string | undefined)[],
) {
  const wanted = new Set(
    userIds.filter(Boolean).map((userId) => userId!.toString()),
  );

  if (wanted.size === 0) {
    return new Map<string, string>();
  }

  const cooks = await CookAccountModel.find({
    hostelId,
    userId: { $in: [...wanted].map((id) => new Types.ObjectId(id)) },
  })
    .select("historicalName name status userId")
    .lean<
      {
        historicalName?: string;
        name: string;
        status: CookAccountRecord["status"];
        userId?: Types.ObjectId;
      }[]
    >();

  return new Map(
    cooks
      .filter((cook) => cook.userId)
      .map((cook) => [
        cook.userId!.toString(),
        cook.status === "REMOVED"
          ? cook.historicalName || "Previous cook"
          : cook.name,
      ]),
  );
}
