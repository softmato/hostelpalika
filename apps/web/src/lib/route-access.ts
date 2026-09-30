import { TEAM_ROLES } from "@/lib/permissions";
import { Role } from "@/lib/roles";

export type ProtectedRouteRule = {
  prefix: string;
  /**
   * The roles allowed through, or `null` for "any signed-in account".
   *
   * `null` is not laziness — it is the honest answer for a page whose audience
   * is not a role. A service provider is a PUBLIC account with an approved
   * `ServiceProvider` record behind it, and that approval is not in the access
   * token, so the edge cannot check it. What the edge *can* say is that an
   * anonymous visitor has no business on the page, which is the difference
   * between a guarded route and an unguarded one.
   */
  roles: Role[] | null;
  /**
   * Where a refused visitor goes. `"login"` (the default) sends the signed-out
   * to sign in and a wrong role to its own landing page. `"home"` sends
   * everybody who is not let in to `/` — for a portal whose existence an
   * ordinary account has no reason to be shown.
   */
  refuseTo?: "home" | "login";
};

/**
 * First match wins, so the narrow superadmin-only prefixes must sit above the
 * broad `/platform` rule. A PLATFORM_MODERATOR moderates content (hostels,
 * providers, reviews, reports) but never touches platform configuration,
 * subscription billing, or the admin roster — PHASES.md §5.1.
 */
export const protectedRouteRules: ProtectedRouteRule[] = [
  {
    // Closing a hostel owner's account is not a moderation action.
    prefix: "/platform/account-deletions",
    roles: [Role.SUPERADMIN],
  },
  {
    prefix: "/platform/config",
    roles: [Role.SUPERADMIN],
  },
  {
    prefix: "/platform/settings",
    roles: [Role.SUPERADMIN],
  },
  {
    // Buzzing every phone on the platform is not a moderation action.
    prefix: "/platform/push",
    roles: [Role.SUPERADMIN],
  },
  {
    // Customers' money: checking payments, sending refunds, revealing account numbers.
    prefix: "/platform/bookings",
    roles: [Role.SUPERADMIN],
  },
  {
    // Selling a placement is a commercial decision, not a moderation one.
    prefix: "/platform/sponsors",
    roles: [Role.SUPERADMIN],
  },
  {
    // Same rule: what the platform sells, at what price, and who has been
    // charged for it is commercial, not content to be moderated.
    prefix: "/platform/store",
    roles: [Role.SUPERADMIN],
  },
  {
    // Resident Offer Program awards spend HostelPalika's money.
    prefix: "/platform/offer-program",
    roles: [Role.SUPERADMIN],
  },
  {
    // Free plan time and partner commission are HostelPalika's money too.
    prefix: "/platform/referrals",
    roles: [Role.SUPERADMIN],
  },
  {
    prefix: "/platform",
    roles: [Role.SUPERADMIN, Role.PLATFORM_MODERATOR],
  },
  /*
   * The field team's own portal.
   *
   * Above `/hostel-admin` and below `/platform` because it is neither: an agent
   * registers hostels and collects the first payment, and has no business in
   * the superadmin portal or inside any one hostel's workspace. Superadmins are
   * allowed through as well, since they are the ones who invite agents and need
   * to see what the desk actually looks like.
   */
  {
    prefix: "/team",
    refuseTo: "home",
    roles: TEAM_ROLES,
  },
  /*
   * The company-wide record of every hostel agreement signed — outside `/team`
   * only for its URL. Same people, same refusal: an ordinary account is not
   * told the page exists.
   */
  {
    prefix: "/hostel-registration-track-sheet",
    refuseTo: "home",
    roles: TEAM_ROLES,
  },
  {
    prefix: "/hostel-admin",
    roles: [Role.HOSTEL_ADMIN, Role.WARDEN],
  },
  {
    prefix: "/resident",
    roles: [Role.RESIDENT],
  },
  {
    prefix: "/guardian",
    roles: [Role.GUARDIAN],
  },
  {
    prefix: "/cook",
    roles: [Role.COOK],
  },
  /*
   * The service provider's work list — the maintenance jobs hostels have
   * assigned to one account. It lives under `(public)` for URL reasons and was
   * therefore guarded by nothing at all: an anonymous visitor reached it and
   * was shown an empty page rather than a login.
   *
   * `null` rather than a role, because provider is not one — see the type
   * above. The page already renders empty for a signed-in non-provider, and the
   * API behind it authenticates on its own, so requiring an account is both
   * what this layer can enforce and all it needs to.
   */
  {
    prefix: "/jobs",
    roles: null,
  },
];

export const roleLandingPath: Record<Role, string> = {
  [Role.SUPERADMIN]: "/platform/dashboard",
  [Role.PLATFORM_MODERATOR]: "/platform/dashboard",
  [Role.PLATFORM_AGENT]: "/team",
  [Role.HOSTEL_ADMIN]: "/hostel-admin/dashboard",
  [Role.WARDEN]: "/hostel-admin/dashboard",
  [Role.COOK]: "/cook",
  [Role.RESIDENT]: "/resident/dashboard",
  [Role.GUARDIAN]: "/guardian/dashboard",
  [Role.PUBLIC]: "/",
};

export const roleAllowedNextPrefixes: Partial<Record<Role, string[]>> = {
  [Role.SUPERADMIN]: ["/platform", "/team"],
  [Role.PLATFORM_MODERATOR]: ["/platform"],
  [Role.PLATFORM_AGENT]: ["/team"],
  [Role.HOSTEL_ADMIN]: ["/hostel-admin"],
  [Role.WARDEN]: ["/hostel-admin"],
  [Role.RESIDENT]: ["/resident"],
  [Role.GUARDIAN]: ["/guardian"],
  [Role.COOK]: ["/cook"],
};

export function pathMatchesPrefix(pathname: string, prefix: string) {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/** Tenant-scoped hostel workspace: `/{hostel-slug}/admin/...`. */
const HOSTEL_WORKSPACE_PATTERN = /^\/[^/]+\/admin(\/|$)/;

export function isHostelWorkspacePath(pathname: string) {
  return HOSTEL_WORKSPACE_PATTERN.test(pathname);
}

export function protectedRouteRuleForPath(pathname: string) {
  if (isHostelWorkspacePath(pathname)) {
    return protectedRouteRules.find((rule) => rule.prefix === "/hostel-admin");
  }

  return protectedRouteRules.find((rule) => pathMatchesPrefix(pathname, rule.prefix));
}

export function landingPathForRole(role: Role | string) {
  return roleLandingPath[role as Role];
}

export function dashboardHrefForRole(role: Role) {
  return landingPathForRole(role) ?? "/";
}

export function isSafeLocalPath(value: string) {
  return value.startsWith("/") && !value.startsWith("//");
}

export function isAllowedNextPath(role: Role, value: string) {
  if (
    (role === Role.HOSTEL_ADMIN || role === Role.WARDEN) &&
    isHostelWorkspacePath(value)
  ) {
    return true;
  }

  /*
   * A `next` the visitor was *already* standing on. Public pages that send
   * someone to `/login?next=…` — the service-provider funnel, resident
   * activation — belong to no role, so a role-prefix-only check silently threw
   * the visitor onto their dashboard instead of back where they started. What
   * `next` must not do is carry an account into another role's portal, and that
   * is exactly what the protected-route rules already say.
   */
  const rule = protectedRouteRuleForPath(value);

  if (!rule) {
    return true;
  }

  // `roles: null` — guarded, but against anonymity rather than against a role.
  if (rule.roles === null) {
    return true;
  }

  if (rule.roles.includes(role)) {
    return true;
  }

  const allowedPrefixes = roleAllowedNextPrefixes[role] ?? [];

  return allowedPrefixes.some((prefix) => pathMatchesPrefix(value, prefix));
}

export function destinationForRole(role: Role, requestedNext?: string | null) {
  if (
    requestedNext &&
    isSafeLocalPath(requestedNext) &&
    isAllowedNextPath(role, requestedNext)
  ) {
    return requestedNext;
  }

  return landingPathForRole(role) ?? "/";
}
