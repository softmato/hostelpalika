import { jwtVerify } from "jose";
import { NextResponse, type NextRequest } from "next/server";

import {
  ACCESS_TOKEN_COOKIE,
  hasSessionCookie,
  readAccessTokenCookie,
  readRefreshTokenCookieValue,
} from "@/lib/auth-cookies";
import { applySessionCookies } from "@/lib/session-cookies";
import { isAuthBypassEnabled } from "@/lib/auth-bypass";
import { landingPathForRole, protectedRouteRuleForPath } from "@/lib/route-access";
import { Role } from "@/lib/roles";

function accessSecret() {
  const secret = process.env.JWT_ACCESS_SECRET;

  if (!secret) {
    throw new Error("JWT_ACCESS_SECRET is required for protected routes.");
  }

  return new TextEncoder().encode(secret);
}

function redirectToLogin(request: NextRequest, error?: string) {
  const loginUrl = request.nextUrl.clone();
  loginUrl.pathname = "/login";
  loginUrl.searchParams.set(
    "next",
    `${request.nextUrl.pathname}${request.nextUrl.search}`,
  );

  if (error) {
    loginUrl.searchParams.set("error", error);
  }

  return NextResponse.redirect(loginUrl);
}

function redirectHome(request: NextRequest) {
  const homeUrl = request.nextUrl.clone();
  homeUrl.pathname = "/";
  homeUrl.search = "";

  return NextResponse.redirect(homeUrl);
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  /* 1. Skip auth in development / UI-preview mode (never in production) */
  if (isAuthBypassEnabled()) {
    return NextResponse.next();
  }

  /* 2. Auth guard for protected routes */
  const rule = protectedRouteRuleForPath(pathname);

  if (!rule) {
    return isSoftSessionPath(pathname) ? keepSessionAlive(request) : NextResponse.next();
  }

  const refuse = (error?: string) =>
    rule.refuseTo === "home" ? redirectHome(request) : redirectToLogin(request, error);

  let role = await roleFromAccessToken(readAccessTokenCookie(request.cookies));
  let refreshed: { accessToken: string; refreshToken: string | null } | null = null;

  /*
   * The access cookie dies with its 15-minute token, and a page load never goes
   * through the client's 401 → refresh path. Refresh here, from the refresh
   * cookie, so an idle tab or a fresh navigation keeps the session.
   */
  if (!role) {
    refreshed = await refreshFromCookie(request);
    role = refreshed ? await roleFromAccessToken(refreshed.accessToken) : null;
  }

  if (!role) {
    return hasSessionCookie(request.cookies) ? refuse("session_expired") : refuse();
  }

  const withSession = (response: NextResponse) =>
    refreshed ? applySessionCookies(response, refreshed) : response;

  // `roles: null` means the route only asks that somebody is signed in, which
  // the valid token above has already established.
  if (!rule.roles || rule.roles.includes(role)) {
    if (!refreshed) {
      return NextResponse.next();
    }

    // Hand the new token to this same request too, so server components that
    // read the access cookie don't render signed-out.
    request.cookies.set(ACCESS_TOKEN_COOKIE, refreshed.accessToken);

    return withSession(NextResponse.next({ request: { headers: request.headers } }));
  }

  if (rule.refuseTo === "home") {
    return withSession(redirectHome(request));
  }

  const landingPath = landingPathForRole(role);

  if (landingPath) {
    const landingUrl = request.nextUrl.clone();
    landingUrl.pathname = landingPath;
    landingUrl.search = "";

    return withSession(NextResponse.redirect(landingUrl));
  }

  return withSession(redirectToLogin(request, "forbidden"));
}

/**
 * Every page and API call renews a dead session before it is handled, so no
 * request is ever answered signed-out for someone who is signed in. The access
 * cookie dies with its 15-minute token, and optional-auth reads (the community,
 * `/auth/me` in the header) never 401 — without this they would render
 * "Sign in" first and only recover after a client refresh.
 *
 * The auth routes that manage tokens themselves are left alone: refreshing in
 * front of `/auth/refresh` or `/auth/logout` would rotate the token they are
 * about to act on.
 */
function isSoftSessionPath(pathname: string) {
  return !pathname.startsWith("/api/v1/auth/") || pathname === "/api/v1/auth/me";
}

async function keepSessionAlive(request: NextRequest) {
  if (
    !readRefreshTokenCookieValue(request.cookies) ||
    (await roleFromAccessToken(readAccessTokenCookie(request.cookies)))
  ) {
    return NextResponse.next();
  }

  const refreshed = await refreshFromCookie(request);

  if (!refreshed) {
    return NextResponse.next();
  }

  request.cookies.set(ACCESS_TOKEN_COOKIE, refreshed.accessToken);

  return applySessionCookies(
    NextResponse.next({ request: { headers: request.headers } }),
    refreshed,
  );
}

async function roleFromAccessToken(token: string | undefined) {
  if (!token) {
    return null;
  }

  try {
    const { payload } = await jwtVerify(token, accessSecret());

    return payload.tokenType === "access" &&
      payload.sub &&
      typeof payload.role === "string"
      ? (payload.role as Role)
      : null;
  } catch {
    return null;
  }
}

async function refreshFromCookie(request: NextRequest) {
  const refreshToken = readRefreshTokenCookieValue(request.cookies);

  if (!refreshToken) {
    return null;
  }

  try {
    // Loaded only when a refresh is actually needed, keeping the database out
    // of every signed-in navigation.
    const { refreshAccessToken } = await import("@/modules/auth/auth.service");

    return await refreshAccessToken(refreshToken, { cookieSession: true });
  } catch {
    return null;
  }
}

/*
 * On Vercel this proxy is a function, so every request it matches is billed CPU
 * — including hits the CDN would otherwise answer from cache. It used to match
 * every non-static path; now it runs only where it has work to do.
 *
 * Literals only: Next reads this object statically, so the cookie names cannot
 * come from `auth-cookies.ts` (legacy names included). Keep them in step with it.
 */
export const config = {
  matcher: [
    /* Protected portals — checked on every navigation. */
    "/platform/:path*",
    "/hostel-admin/:path*",
    /* Tenant-scoped hostel workspace: /{hostel-slug}/admin/... */
    "/:hostelSlug/admin/:path*",
    "/resident/:path*",
    "/guardian/:path*",
    "/cook/:path*",
    "/team/:path*",
    "/hostel-registration-track-sheet",
    "/jobs/:path*",
    /*
     * Soft session (isSoftSessionPath): anywhere else, only when there is a
     * refresh cookie to renew from and the access cookie — which dies with its
     * 15-minute token — is gone. A signed-out visitor, a live session and the
     * phone app (bearer tokens, no cookies) never reach this function.
     */
    {
      source: "/((?!_next/static|_next/image|favicon\\.ico|.*\\.(?:png|jpe?g|gif|svg|webp|avif|ico|css|js|map|txt|xml|woff2?|webmanifest)$).*)",
      has: [{ key: "hostelpalika_refresh", type: "cookie" }],
      missing: [
        { key: "hostelpalika_access_token", type: "cookie" },
        { key: "hostelhub_access_token", type: "cookie" },
      ],
    },
    {
      source: "/((?!_next/static|_next/image|favicon\\.ico|.*\\.(?:png|jpe?g|gif|svg|webp|avif|ico|css|js|map|txt|xml|woff2?|webmanifest)$).*)",
      has: [{ key: "hostelhub_refresh", type: "cookie" }],
      missing: [
        { key: "hostelpalika_access_token", type: "cookie" },
        { key: "hostelhub_access_token", type: "cookie" },
      ],
    },
    {
      source: "/((?!_next/static|_next/image|favicon\\.ico|.*\\.(?:png|jpe?g|gif|svg|webp|avif|ico|css|js|map|txt|xml|woff2?|webmanifest)$).*)",
      has: [{ key: "hostelhub_refresh_token", type: "cookie" }],
      missing: [
        { key: "hostelpalika_access_token", type: "cookie" },
        { key: "hostelhub_access_token", type: "cookie" },
      ],
    },
  ],
};
