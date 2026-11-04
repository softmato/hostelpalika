/**
 * Role → route group. Mirrors `packages/shared/src/types/roles.ts`.
 *
 * There is no `SERVICE_PROVIDER` role: a provider is a `PUBLIC` account with an
 * APPROVED `ServiceProvider` record behind it (PHASES.md §6.1, superseded note).
 * So the provider surface is decided from `/auth/me`'s provider flag, not from
 * `role` — which is why `resolveHome` takes the whole account, not just a role.
 */

import type { RoleAccentKey } from "@/constants/theme";

export const ROLE = {
  COOK: "COOK",
  GUARDIAN: "GUARDIAN",
  HOSTEL_ADMIN: "HOSTEL_ADMIN",
  PLATFORM_MODERATOR: "PLATFORM_MODERATOR",
  PUBLIC: "PUBLIC",
  RESIDENT: "RESIDENT",
  SUPERADMIN: "SUPERADMIN",
  WARDEN: "WARDEN",
} as const;

export type Role = (typeof ROLE)[keyof typeof ROLE];

/** Every route group the boot gate can land on. */
export type HomeRoute =
  | "/(admin)"
  | "/(auth)/login"
  | "/(browse)"
  | "/(cook)"
  | "/(guardian)"
  | "/(platform)"
  | "/(provider)"
  | "/(resident)"
  | "/activate";

export type AccountShape = {
  /** True once the account has an APPROVED ServiceProvider record. */
  isApprovedProvider?: boolean;
  /** False for a RESIDENT account that has not yet redeemed its QR code. */
  isResidentActivated?: boolean;
  role: Role;
};

/**
 * The single decision the splash gate makes. Pure and synchronous on purpose —
 * it runs before the first frame, from a cached account, with no network.
 *
 * **Signed out goes to the public app, not to login.** The mobile app is the
 * website: someone who has not signed in can still browse hostels, compare them
 * and send an inquiry, exactly as they can on the web. Login is a destination
 * reached from a button, not a wall in front of the product — a hostel-hunting
 * student has no account yet and nothing to sign in with, and a login form is
 * the fastest way to lose them.
 *
 * **And it goes to the same place a signed-in browser does.** There used to be a
 * second group, `(public)`: the identical discovery screens in a plain stack
 * with a floating Log in pill instead of tabs. Two groups meant two copies of
 * every navigation decision, a pill hovering over the home screen of someone who
 * had nothing to sign in with, and a Compare tab that existed or did not depending
 * on whether you had an account — for screens that read the same public API
 * either way.
 *
 * Now the shell is one shell. `(browse)` renders for everyone who is not routed
 * to a role dashboard, and the only thing a session changes is the card at the
 * top of the Profile tab: your account, or an invitation to make one. Every
 * other audience — resident, guardian, cook, admin, provider — still goes
 * straight to its own tabs, which is what this function is for.
 *
 * **A session always reaches its role's home.** There used to be one exception:
 * an account flagged `mustChangePassword` — a cook or warden holding the
 * temporary password its admin issued — was sent to a set-password screen
 * before its own group, on every launch. It is gone, along with the screen. A
 * provisioned account signs in with the username and password its warden gave
 * it and goes to work; anyone who wants a password of their own takes the
 * ordinary route through Forgot password, off their own mailbox. The flag still
 * exists server-side and the platform admin list still shows which accounts
 * hold an initial password — it just no longer decides where anybody lands,
 * which is what made a Google sign-in on an admin's account open a password
 * form instead of their dashboard.
 */
export function resolveHome(account: AccountShape | null): HomeRoute {
  if (!account) {
    return "/(browse)";
  }

  switch (account.role) {
    case ROLE.RESIDENT:
      // An invited-but-unactivated resident has no dashboard to show yet.
      return account.isResidentActivated === false ? "/activate" : "/(resident)";
    case ROLE.GUARDIAN:
      return "/(guardian)";
    case ROLE.COOK:
      return "/(cook)";
    case ROLE.HOSTEL_ADMIN:
    case ROLE.WARDEN:
      return "/(admin)";
    case ROLE.SUPERADMIN:
      // Owner, 2026-11-03: the superadmin runs the platform from the phone too.
      return "/(platform)";
    case ROLE.PLATFORM_MODERATOR:
      // The System area is superadmin-only (route-access.ts) and no moderator
      // screen is native yet, so a moderator keeps the browsing app.
      return "/(browse)";
    case ROLE.PUBLIC:
      return account.isApprovedProvider ? "/(provider)" : "/(browse)";
    default:
      // An unrecognised role still has a session, so it still needs a way out.
      return "/(browse)";
  }
}

export function accentForAccount(account: AccountShape | null): RoleAccentKey {
  if (!account) return "PUBLIC";

  switch (account.role) {
    case ROLE.RESIDENT:
      return "RESIDENT";
    case ROLE.GUARDIAN:
      return "GUARDIAN";
    case ROLE.COOK:
      return "COOK";
    case ROLE.HOSTEL_ADMIN:
    case ROLE.WARDEN:
      return "ADMIN";
    case ROLE.SUPERADMIN:
    case ROLE.PLATFORM_MODERATOR:
      return "PLATFORM";
    case ROLE.PUBLIC:
      return account.isApprovedProvider ? "PROVIDER" : "PUBLIC";
    default:
      return "PUBLIC";
  }
}

export function readableRole(role: Role): string {
  switch (role) {
    case ROLE.HOSTEL_ADMIN:
      return "Hostel admin";
    case ROLE.PLATFORM_MODERATOR:
      return "Moderator";
    case ROLE.SUPERADMIN:
      return "Platform owner";
    default:
      return role.charAt(0) + role.slice(1).toLowerCase();
  }
}
