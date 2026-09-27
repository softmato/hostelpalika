import { Types } from "mongoose";
import type { NextRequest } from "next/server";

import { getBearerToken, readAccessTokenCookie, verifyAccessToken } from "@/lib/auth";
import { connectToDatabase } from "@/lib/db";
import { HOSTEL_STAFF_ROLES, PLATFORM_ROLES, TEAM_ROLES, assertAllowedRole } from "@/lib/permissions";
import { assertHostelAccess } from "@/lib/tenant";
import { Role } from "@/lib/roles";
import { grantingPermissionKeys } from "@/lib/warden-capability";
import { HostelModel } from "@hostel/db/models/Hostel";
import { HostelMemberModel } from "@hostel/db/models/HostelMember";
import { isTemporaryCredentialActive } from "@/modules/auth/temporary-credential.service";
import {
  HOSTEL_SUSPENDED_MESSAGE,
  isOpenWhileSuspended,
  SUSPENDABLE_ROLES,
  suspensionStage,
  type SuspensionRecord,
} from "@/modules/hostels/hostel-suspension";
import type { WardenPermissionKey } from "@/modules/wardens/warden.validation";

export type ApiPrincipal = {
  /**
   * Every live hostel a staff member may open, before `hostelIds` was narrowed
   * to the one this request is about. Read only by what spans them on purpose:
   * the branch switcher and the branches summary.
   */
  allHostelIds?: string[];
  hostelIds: string[];
  role: Role;
  sessionId?: string;
  /**
   * Hostels taken out of `hostelIds` because their plan suspension has landed.
   * Kept so a role guard can answer "suspended" rather than an empty-hostel 404.
   */
  suspendedHostelIds?: string[];
  /**
   * Set when the caller signed in with a temporary credential instead of the
   * account's own password. The identity is otherwise identical — same user,
   * same role, same hostels — so anything that must stay with the real owner
   * gates on this via {@link assertPrimaryCredentialPrincipal}.
   */
  temporaryCredentialId?: string;
  userId: string;
};

export class ApiAuthError extends Error {
  constructor(
    message: string,
    public errorCode = "UNAUTHENTICATED",
    public status = 401,
  ) {
    super(message);
  }
}

function isRole(value: unknown): value is Role {
  return typeof value === "string" && Object.values(Role).includes(value as Role);
}

function cookieAccessToken(request: NextRequest) {
  return readAccessTokenCookie(request.cookies) ?? null;
}

export async function loadApiPrincipal(request: NextRequest) {
  const accessToken =
    getBearerToken(request.headers.get("authorization")) ?? cookieAccessToken(request);

  if (!accessToken) {
    return null;
  }

  try {
    const payload = await verifyAccessToken(accessToken);

    if (!payload.sub || !isRole(payload.role)) {
      return null;
    }

    const temporaryCredentialId =
      typeof payload.temporaryCredentialId === "string"
        ? payload.temporaryCredentialId
        : undefined;

    /*
     * Revocation has to bite now, not at the next token refresh: the whole
     * point of "revoke" is that the person you handed the login to loses it
     * while you watch. Costs one indexed lookup, and only on the rare requests
     * that carry a temporary token — an ordinary session never reaches here.
     */
    if (
      temporaryCredentialId &&
      !(await isTemporaryCredentialActive(temporaryCredentialId))
    ) {
      return null;
    }

    return {
      hostelIds: Array.isArray(payload.hostelIds)
        ? payload.hostelIds.map((hostelId) => String(hostelId))
        : [],
      role: payload.role,
      sessionId: typeof payload.sessionId === "string" ? payload.sessionId : undefined,
      temporaryCredentialId,
      userId: payload.sub,
    } satisfies ApiPrincipal;
  } catch {
    /*
     * A bearer token the app sent but that no longer verifies (usually just
     * expired) is a session to refresh, not a signed-out reader. Answering null
     * gave optional-auth reads — the community's `viewer.canPost` — a 200 that
     * said "sign in" and never set off the client's 401 → refresh → replay.
     */
    if (getBearerToken(request.headers.get("authorization"))) {
      throw new ApiAuthError("Your session has expired.");
    }

    return null;
  }
}

/**
 * Refuses a caller who is signed in with a temporary credential.
 *
 * Guards the actions that must stay with whoever owns the account rather than
 * whoever is currently holding a borrowed login: minting or revoking temporary
 * credentials (otherwise a borrower could issue themselves a fresh one and
 * outlive the expiry date), and changing the account password (otherwise a
 * borrower could lock the owner out of their own account).
 */
export function assertPrimaryCredentialPrincipal(principal: ApiPrincipal) {
  if (principal.temporaryCredentialId) {
    throw new ApiAuthError(
      "Sign in with your own password to manage account access.",
      "TEMPORARY_CREDENTIAL_FORBIDDEN",
      403,
    );
  }
}

/** The path a guard is answering for. `nextUrl` is absent on a plain `Request`. */
function requestPath(request: NextRequest) {
  return request.nextUrl?.pathname ?? new URL(request.url).pathname;
}

/**
 * Takes hostels the caller can no longer act for out of the principal, in one
 * `_id $in` read: those whose plan suspension has landed, and — for hostel
 * staff — those deleted since the token was issued.
 *
 * Every service already scopes by `principal.hostelIds`, so narrowing once here
 * shuts a suspended hostel out of every route without any of them knowing
 * suspensions exist — for its admin, wardens, residents, guardians and cooks
 * alike. Routes with nothing hostel-scoped (signing out, releasing a push
 * subscription) keep working, because an empty list is all they ever see.
 *
 * Deleted hostels: `hostelIds` is baked into the token at sign-in, and deleting
 * a hostel does not reach a token somebody already holds. An owner whose hostel
 * was deleted — or who had a duplicate registration removed — kept arriving
 * with every id they ever had. `resolveAdminHostelId` reads more than one id as
 * "which hostel do you mean?", so a one-hostel owner was served the
 * multi-hostel fallback on every screen, and billing read `hostelIds[0]` — the
 * *deleted* hostel's invoices. Deleting a hostel also pulls it from
 * `User.hostelIds`, so the token heals at the next refresh; this covers the gap.
 * It used to be a second read in the staff guard, which the admin-only and
 * hostel-scoped guards skipped.
 *
 * Plan billing is exempt from the suspension (`isOpenWhileSuspended`): paying is
 * the way out. Token order is preserved: `hostelIds[0]` is "the" hostel for a
 * one-hostel reader, and reordering would change which one that is.
 */
async function narrowToLiveHostels(
  request: NextRequest,
  principal: ApiPrincipal,
): Promise<ApiPrincipal> {
  const isStaff = HOSTEL_STAFF_ROLES.includes(principal.role);
  const suspensionApplies = !isOpenWhileSuspended(requestPath(request));

  if (
    !SUSPENDABLE_ROLES.has(principal.role) ||
    principal.hostelIds.length === 0 ||
    (!isStaff && !suspensionApplies)
  ) {
    return principal;
  }

  const validIds = principal.hostelIds.filter((id) => Types.ObjectId.isValid(id));
  // Staff keep only hostels found live; everyone else keeps what they carried.
  const candidates = isStaff ? validIds : principal.hostelIds;

  if (validIds.length === 0) {
    return isStaff ? ({ ...principal, hostelIds: [] } satisfies ApiPrincipal) : principal;
  }

  await connectToDatabase();

  const now = new Date();
  const rows = await HostelModel.find({
    _id: { $in: validIds.map((id) => new Types.ObjectId(id)) },
    ...(isStaff ? { isDeleted: { $ne: true } } : {}),
  })
    .select("_id slug suspension")
    .lean<{ _id: Types.ObjectId; slug?: string; suspension?: SuspensionRecord | null }[]>();

  const live = new Set(rows.map((row) => row._id.toString()));
  const suspended = suspensionApplies
    ? rows
        .filter((row) => suspensionStage(row.suspension, now) === "SUSPENDED")
        .map((row) => row._id.toString())
    : [];
  const open = candidates.filter((id) => (!isStaff || live.has(id)) && !suspended.includes(id));

  return {
    ...principal,
    ...(isStaff ? { allHostelIds: open } : {}),
    hostelIds: isStaff ? activeHostel(request, open, rows) : open,
    ...(suspended.length > 0 ? { suspendedHostelIds: suspended } : {}),
  } satisfies ApiPrincipal;
}

/**
 * The hostel a staff request is about — the branch switcher's choice. Its id,
 * or its slug: the web portal lives at `/{slug}/admin`, so the slug is what a
 * page already knows.
 */
export const ACTIVE_HOSTEL_HEADER = "x-hostel-id";

/**
 * Staff with more than one hostel — an owner and their branches — work in one
 * at a time. The client names it in {@link ACTIVE_HOSTEL_HEADER}; without it
 * (an older app build) it is the first, which the token lists first because it
 * was granted first: the main hostel.
 *
 * Narrowed here, once, so every service that reads `hostelIds` — the
 * `hostelIds[0]` routes and the `$in` lists alike — works on that one hostel
 * without knowing branches exist. A header naming a hostel the caller does not
 * hold is ignored, never trusted.
 */
function activeHostel(
  request: NextRequest,
  hostelIds: string[],
  rows: Array<{ _id: Types.ObjectId; slug?: string }>,
) {
  if (hostelIds.length <= 1) return hostelIds;

  const requested = request.headers.get(ACTIVE_HOSTEL_HEADER)?.trim();
  const bySlug = requested ? rows.find((row) => row.slug === requested)?._id.toString() : undefined;
  const chosen = [requested, bySlug].find((id) => id && hostelIds.includes(id));

  return [chosen ?? hostelIds[0]!];
}

/** 423 when every hostel the caller belongs to is suspended. */
function assertNotSuspended(principal: ApiPrincipal) {
  if (principal.hostelIds.length === 0 && principal.suspendedHostelIds?.length) {
    throw new ApiAuthError(HOSTEL_SUSPENDED_MESSAGE, "HOSTEL_SUSPENDED", 423);
  }
}

export async function requireApiPrincipal(request: NextRequest) {
  const principal = await loadApiPrincipal(request);

  if (!principal) {
    throw new ApiAuthError("Authentication is required.");
  }

  return narrowToLiveHostels(request, principal);
}

export function assertApiRoles(principal: ApiPrincipal, roles: Role[]) {
  try {
    assertAllowedRole(principal, roles);
  } catch {
    throw new ApiAuthError(
      "This role is not allowed to perform this action.",
      "FORBIDDEN",
      403,
    );
  }
}

/**
 * Grants the platform portal to both SUPERADMIN and PLATFORM_MODERATOR — the
 * "acting superadmin" role, which sees and moderates everything a superadmin
 * does. The one thing it must not do is create or revoke other platform admins;
 * that is gated separately by {@link requireSuperadminPrincipal}.
 *
 * Matches the routing layer, which already lets PLATFORM_MODERATOR reach
 * /platform (see PLATFORM_ROLES and protectedRouteRules).
 */
export async function requirePlatformPrincipal(request: NextRequest) {
  const principal = await requireApiPrincipal(request);

  assertApiRoles(principal, PLATFORM_ROLES);

  return principal;
}

/**
 * Stricter than {@link requirePlatformPrincipal}: only a full SUPERADMIN passes.
 * Used for privilege management, so an acting superadmin cannot escalate itself
 * or mint further admins.
 */
export async function requireSuperadminPrincipal(request: NextRequest) {
  const principal = await requireApiPrincipal(request);

  assertApiRoles(principal, [Role.SUPERADMIN]);

  return principal;
}

/**
 * The field team's desk.
 *
 * `PLATFORM_AGENT` registers hostels and collects the first payment;
 * `SUPERADMIN` is admitted too, because superadmins invite agents and have to
 * be able to see and use what they gave them. `PLATFORM_MODERATOR` is
 * deliberately absent — moderating content carries no authority to take money.
 *
 * Mirrors `protectedRouteRules` for `/team`, so the edge and the API agree on
 * who belongs there.
 */
export async function requireTeamPrincipal(request: NextRequest) {
  const principal = await requireApiPrincipal(request);

  assertApiRoles(principal, TEAM_ROLES);

  return principal;
}

/**
 * Hostel staff, scoped to the hostels that still **exist** and are not
 * suspended — both narrowed in `requireApiPrincipal`, see
 * {@link narrowToLiveHostels}. `requireHostelCapability` inherits it because it
 * starts from this function.
 */
export async function requireHostelStaffPrincipal(request: NextRequest) {
  const principal = await requireApiPrincipal(request);

  assertApiRoles(principal, HOSTEL_STAFF_ROLES);
  assertNotSuspended(principal);

  return principal;
}

/**
 * Hostel-staff gate that also enforces a warden's per-capability flags
 * (`HostelMember.permissions`, set from Warden Management).
 *
 * HOSTEL_ADMIN holds every capability implicitly and passes unchanged. For a
 * WARDEN, the returned principal's `hostelIds` is **narrowed** to just those
 * hostels where the flag is granted — so every downstream service, which
 * already scopes its queries by `principal.hostelIds`, is restricted without
 * needing to know capabilities exist. No grant anywhere → 403.
 *
 * Permissions are read per request rather than carried in the JWT, so revoking
 * a capability takes effect immediately instead of at the next token refresh.
 */
export async function requireHostelCapability(
  request: NextRequest,
  capability: WardenPermissionKey,
) {
  const principal = await requireHostelStaffPrincipal(request);

  if (principal.role !== Role.WARDEN) {
    return principal;
  }

  await connectToDatabase();

  const memberships = await HostelMemberModel.find({
    hostelId: { $in: principal.hostelIds.filter((id) => Types.ObjectId.isValid(id)) },
    isDeleted: { $ne: true },
    // Mongo matches a scalar against array membership; `$in` widens that to the
    // deprecated key a row may still be carrying.
    permissions: { $in: grantingPermissionKeys(capability) },
    status: "ACTIVE",
    userId: principal.userId,
  })
    .select("hostelId")
    .lean<{ hostelId: Types.ObjectId }[]>();

  const allowedHostelIds = memberships.map((member) => member.hostelId.toString());

  if (allowedHostelIds.length === 0) {
    throw new ApiAuthError(
      "Your warden account does not have permission for this action.",
      "CAPABILITY_DENIED",
      403,
    );
  }

  return { ...principal, hostelIds: allowedHostelIds } satisfies ApiPrincipal;
}

/**
 * Stricter than {@link requireHostelStaffPrincipal}: only HOSTEL_ADMIN may pass.
 * Wardens are hostel staff but cannot manage other wardens (PHASES.md §2 —
 * "Warden Management (HOSTEL_ADMIN only)").
 */
export async function requireHostelAdminPrincipal(request: NextRequest) {
  const principal = await requireApiPrincipal(request);

  assertApiRoles(principal, [Role.HOSTEL_ADMIN]);
  assertNotSuspended(principal);

  return principal;
}

export function assertHostelScopedApiAccess(principal: ApiPrincipal, hostelId: string) {
  try {
    assertHostelAccess(principal, hostelId);
  } catch {
    // 404, not 403 — see TenantAccessError in lib/tenant.ts.
    throw new ApiAuthError("Not found.", "NOT_FOUND", 404);
  }
}

export async function requireHostelScopedPrincipal(
  request: NextRequest,
  hostelId: string,
) {
  const principal = await requireApiPrincipal(request);

  assertApiRoles(principal, [Role.SUPERADMIN, ...HOSTEL_STAFF_ROLES]);
  assertNotSuspended(principal);
  assertHostelScopedApiAccess(principal, hostelId);

  return principal;
}

export async function requireResidentPrincipal(request: NextRequest) {
  const principal = await requireApiPrincipal(request);

  assertApiRoles(principal, [Role.RESIDENT]);
  assertNotSuspended(principal);

  return principal;
}

export async function requireGuardianPrincipal(request: NextRequest) {
  const principal = await requireApiPrincipal(request);

  assertApiRoles(principal, [Role.GUARDIAN]);
  assertNotSuspended(principal);

  return principal;
}
