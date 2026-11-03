import { Types } from "mongoose";

import type { ApiPrincipal } from "@/lib/api-auth";
import { connectToDatabase } from "@/lib/db";
import { Role } from "@/lib/roles";
import { AuditLogModel } from "@hostel/db/models/AuditLog";
import { HostelSubscriptionModel } from "@hostel/db/models/HostelSubscription";
import { OAuthAccountModel } from "@hostel/db/models/OAuthAccount";
import { PlatformAdminInviteModel } from "@hostel/db/models/PlatformAdminInvite";
import { SessionModel } from "@hostel/db/models/Session";
import { SubscriptionPaymentModel } from "@hostel/db/models/SubscriptionPayment";
import { UserModel } from "@hostel/db/models/User";

/**
 * Taking somebody off the field team — the write side of `team.service.ts`,
 * which only reads.
 *
 * ## Three actions, because "remove" means three different things
 *
 * A superadmin looking at a roster row wants one of three outcomes, and
 * collapsing them into a single button would either destroy work or fail to do
 * what was asked:
 *
 * - **Suspend.** They stop being able to sign in, today, and everything they
 *   registered stays attributed to them. This is the one to reach for while a
 *   reconciliation is unfinished or somebody is on leave. Reversible.
 * - **Remove from team.** The platform grant ends. The account survives and
 *   goes back to whatever role it held before the invitation took it over —
 *   `previousRole`, written by `acceptPlatformAdminInvitation` — or to PUBLIC
 *   if the team was the only thing it ever was. The registrations they filed
 *   keep pointing at a real account, so the money history stays readable.
 * - **Delete the account.** The row is gone from the database and the address
 *   is free again. Only offered when nothing references the account: no hostel
 *   filed, no payment collected, no role to fall back to. That is the case the
 *   word "delete" is honestly available for, and it is exactly the case a test
 *   agent or a mistyped invitation leaves behind.
 *
 * ## Why the third one is guarded rather than soft
 *
 * The obvious alternative — `isDeleted: true` everywhere — is what the rest of
 * this codebase does, and it is wrong here for one specific reason: the unique
 * index on `email` is not partial. A soft-deleted account keeps its address
 * forever, so "delete this agent and re-invite them properly" would fail on the
 * second half with a duplicate-key error and no way round it from the UI. A
 * real delete, allowed only when nothing points at the row, is the version that
 * does what the button says.
 *
 * ## Sessions are ended, with one honest gap
 *
 * Every write here bumps `tokenVersion` and drops the account's `Session` rows,
 * which kills the refresh: `refreshAccessToken` compares the version and
 * refuses, so nothing new can be minted.
 *
 * The access token already in the browser is *not* killed. It is a signed JWT
 * carrying the role, nothing reads `tokenVersion` on the way past, and it lives
 * for `ACCESS_TOKEN_TTL` (fifteen minutes by default). So a suspended agent
 * with a tab already open keeps working for up to that long and is then locked
 * out for good. Closing the gap properly means checking the version on every
 * authenticated request — a database read per call — and that is a decision
 * about the whole auth layer, not something to smuggle in behind a Suspend
 * button. It is written down here so nobody reads "suspended" on the roster and
 * believes it took effect this second.
 */

export class TeamMemberError extends Error {
  constructor(
    message: string,
    public errorCode = "TEAM_MEMBER_ERROR",
    public status = 400,
  ) {
    super(message);
  }
}

type MemberRecord = {
  _id: Types.ObjectId;
  email?: string;
  name?: string;
  previousRole?: string;
  role?: string;
  status?: string;
};

/**
 * The roster row, or a 404 phrased as one.
 *
 * Scoped to `PLATFORM_AGENT` on purpose: this endpoint is reachable only by a
 * superadmin, and a superadmin passing another superadmin's id must not be able
 * to suspend a peer through the team screen. Privilege changes live on the
 * admin roster, behind the last-superadmin guard.
 */
async function findMember(memberId: string) {
  if (!Types.ObjectId.isValid(memberId)) {
    throw new TeamMemberError("Invalid member id.", "INVALID_OBJECT_ID", 422);
  }

  const member = await UserModel.findOne({
    _id: memberId,
    isDeleted: { $ne: true },
    role: Role.PLATFORM_AGENT,
  }).lean<MemberRecord | null>();

  if (!member) {
    throw new TeamMemberError("That team member was not found.", "NOT_FOUND", 404);
  }

  return member;
}

/**
 * Stops the session being renewed. See the note at the top of this file for the
 * one thing this does not do — the access token already issued runs its course.
 */
async function endSessions(memberId: Types.ObjectId) {
  await Promise.all([
    UserModel.updateOne({ _id: memberId }, { $inc: { tokenVersion: 1 } }),
    SessionModel.deleteMany({ userId: memberId }),
  ]);
}

/**
 * What still points at this account, and therefore whether deleting it would
 * leave a hole in the books.
 *
 * Both reads are counts rather than fetches — the answer is a yes or no, and a
 * roster of thirty must not become sixty document loads.
 */
export async function teamMemberFootprint(memberId: Types.ObjectId) {
  const [registrations, collections] = await Promise.all([
    HostelSubscriptionModel.countDocuments({ agentId: memberId }),
    SubscriptionPaymentModel.countDocuments({ collectedBy: memberId }),
  ]);

  return { collections, registrations };
}

/* ── Suspend and reinstate ─────────────────────────────────────────────── */

export async function suspendTeamMember(memberId: string, principal: ApiPrincipal) {
  await connectToDatabase();

  if (memberId === principal.userId) {
    throw new TeamMemberError(
      "You cannot suspend your own account.",
      "CANNOT_SUSPEND_SELF",
      409,
    );
  }

  const member = await findMember(memberId);

  if (member.status === "SUSPENDED") {
    return { member: { id: memberId, status: "SUSPENDED" }, suspended: true };
  }

  await UserModel.updateOne({ _id: member._id }, { $set: { status: "SUSPENDED" } });
  await endSessions(member._id);

  await AuditLogModel.create({
    action: "TEAM_MEMBER_SUSPENDED",
    actorId: principal.userId,
    entityId: memberId,
    entityType: "User",
    metadata: { email: member.email ?? "", previousStatus: member.status ?? "ACTIVE" },
  });

  return { member: { id: memberId, status: "SUSPENDED" }, suspended: true };
}

/**
 * Puts a suspended member back to work.
 *
 * ACTIVE rather than back to whatever they were: the only two statuses a member
 * can be suspended *from* are ACTIVE and INVITED, and an INVITED account that
 * has been suspended and lifted again has demonstrably been signed into by
 * somebody a superadmin recognises. Restoring INVITED would put the account
 * back in a state whose only meaning is "has never signed in".
 */
export async function reinstateTeamMember(memberId: string, principal: ApiPrincipal) {
  await connectToDatabase();

  const member = await findMember(memberId);

  if (member.status !== "SUSPENDED" && member.status !== "ARCHIVED") {
    return {
      member: { id: memberId, status: member.status ?? "ACTIVE" },
      reinstated: false,
    };
  }

  await UserModel.updateOne({ _id: member._id }, { $set: { status: "ACTIVE" } });

  await AuditLogModel.create({
    action: "TEAM_MEMBER_REINSTATED",
    actorId: principal.userId,
    entityId: memberId,
    entityType: "User",
    metadata: { email: member.email ?? "" },
  });

  return { member: { id: memberId, status: "ACTIVE" }, reinstated: true };
}

/* ── Remove and delete ─────────────────────────────────────────────────── */

/**
 * Ends the platform grant and hands the account back its previous life.
 *
 * The restore is the whole point. An invitation may now land on a warden or a
 * resident and take that account over, which is only defensible because this
 * function exists to undo it: `previousRole` is read, applied, and cleared in
 * the same write, so a second removal cannot resurrect a role the account has
 * since been moved off deliberately.
 *
 * Without a `previousRole` the account was never anything but a team member, so
 * PUBLIC is where it lands — the same soft-revoke `revokePlatformAdmin` does,
 * and for the same reason: the audit trail and the money have to keep pointing
 * at a real account.
 */
export async function removeTeamMember(memberId: string, principal: ApiPrincipal) {
  await connectToDatabase();

  if (memberId === principal.userId) {
    throw new TeamMemberError(
      "You cannot remove your own account from the team.",
      "CANNOT_REMOVE_SELF",
      409,
    );
  }

  const member = await findMember(memberId);
  const restoredRole = member.previousRole ?? Role.PUBLIC;

  await UserModel.updateOne(
    { _id: member._id },
    {
      $set: { role: restoredRole },
      $unset: { previousRole: "" },
    },
  );
  await endSessions(member._id);

  /*
   * Any invitation still outstanding for this address is withdrawn on the way
   * out. Leaving it would hand back the grant the moment they opened an old
   * mail, which is the opposite of what the superadmin just pressed.
   */
  if (member.email) {
    await PlatformAdminInviteModel.updateMany(
      { email: member.email, status: "PENDING" },
      {
        $set: { revokedAt: new Date(), revokedBy: principal.userId, status: "REVOKED" },
        $unset: { tokenHash: "" },
      },
    );
  }

  await AuditLogModel.create({
    action: "TEAM_MEMBER_REMOVED",
    actorId: principal.userId,
    entityId: memberId,
    entityType: "User",
    metadata: {
      email: member.email ?? "",
      restoredRole,
      /** True when the account went back to a life it had before the team. */
      restoredPreviousRole: Boolean(member.previousRole),
    },
  });

  return { removed: true, restoredRole };
}

/**
 * Deletes the account outright, and refuses when that would cost something.
 *
 * The guard is not squeamishness. `agentId` on a subscription and `collectedBy`
 * on a payment are how the platform knows who registered a hostel and who is
 * answerable for the cash in their pocket; deleting the row those point at
 * turns a reconciliation into a name nobody can look up. So an account with any
 * registration or any collected payment cannot be deleted, and the caller is
 * told to remove them from the team instead — which keeps the history and ends
 * the access, the thing they actually wanted.
 *
 * A `previousRole` blocks it too, for a plainer reason: that account had a life
 * before the team, and deleting it would take a resident's bed or a warden's
 * hostel with it.
 */
export async function deleteTeamMember(memberId: string, principal: ApiPrincipal) {
  await connectToDatabase();

  if (memberId === principal.userId) {
    throw new TeamMemberError(
      "You cannot delete your own account.",
      "CANNOT_DELETE_SELF",
      409,
    );
  }

  const member = await findMember(memberId);
  const { collections, registrations } = await teamMemberFootprint(member._id);

  if (registrations > 0 || collections > 0) {
    throw new TeamMemberError(
      `${member.name ?? member.email ?? "This member"} has ${registrations} registration${registrations === 1 ? "" : "s"} and ${collections} payment${collections === 1 ? "" : "s"} attributed to them, and the books have to keep pointing at a real account. Remove them from the team instead — that ends their access and leaves the history intact.`,
      "MEMBER_HAS_HISTORY",
      409,
    );
  }

  if (member.previousRole) {
    throw new TeamMemberError(
      "This address belonged to another account before it joined the team, so deleting it would take that account with it. Remove them from the team instead — they go back to the role they came from.",
      "MEMBER_HAS_PRIOR_ACCOUNT",
      409,
    );
  }

  /*
   * A real delete, not a soft one. The unique index on `email` is not partial,
   * so a soft-deleted row would hold the address forever and make re-inviting
   * the same person impossible. Nothing references this account — that is what
   * the two guards above establish — so there is nothing to orphan.
   */
  await Promise.all([
    SessionModel.deleteMany({ userId: member._id }),
    OAuthAccountModel.deleteMany({ userId: member._id }),
    // Without an email mongoose drops the key and this deletes every invite (P7-13).
    member.email ? PlatformAdminInviteModel.deleteMany({ email: member.email }) : null,
  ]);

  await UserModel.deleteOne({ _id: member._id });

  /*
   * Written after the delete and pointed at an id that no longer resolves. That
   * is correct for a log: the entry is the only remaining record that the
   * account existed, and dropping it to avoid a dangling reference would erase
   * the fact it exists to preserve.
   */
  await AuditLogModel.create({
    action: "TEAM_MEMBER_DELETED",
    actorId: principal.userId,
    entityId: memberId,
    entityType: "User",
    metadata: { email: member.email ?? "", name: member.name ?? "" },
  });

  return { deleted: true };
}
