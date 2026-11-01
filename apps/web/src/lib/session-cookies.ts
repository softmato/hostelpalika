import type { NextRequest, NextResponse } from "next/server";

import {
  ACCESS_TOKEN_COOKIE,
  LEGACY_ACCESS_TOKEN_COOKIES,
  LEGACY_REFRESH_TOKEN_COOKIE,
  REFRESH_TOKEN_COOKIE,
  accessTokenTtlSeconds,
  readRefreshTokenCookieValue,
  refreshTokenTtlSeconds,
} from "@/lib/auth";

const LEGACY_REFRESH_COOKIE_PATH = "/api";

/**
 * The pre-rename cookies that sat at "/", alongside their replacements.
 *
 * `LEGACY_REFRESH_TOKEN_COOKIE` is deliberately not in here: it lives at "/api"
 * and is cleared at that path instead, below.
 */
const RENAMED_ROOT_PATH_COOKIES = [
  ...LEGACY_ACCESS_TOKEN_COOKIES,
  "hostelhub_refresh",
] as const;

/**
 * `COOKIE_DOMAIN` (`.hostelpalika.com`) lets the session reach the API host.
 * Unset, every cookie stays host-only.
 */
function cookieDomain() {
  return process.env.COOKIE_DOMAIN || undefined;
}

/** The pre-rename cookies were only ever host-only, so that is how they are cleared. */
function hostOnlyOptions(maxAge: number, path = "/") {
  return {
    httpOnly: true,
    maxAge,
    path,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
  };
}

function cookieOptions(maxAge: number) {
  return { ...hostOnlyOptions(maxAge), ...domainCookieOption() };
}

/**
 * A browser keeps a host-only cookie and a domain cookie of the same name side
 * by side, so a widened write has to expire the host-only copy or it stays behind
 * to be read after sign-out. These go first: the older cookie rules treat the two
 * as one cookie, and a later expiry would delete the one just written.
 */
export function expireHostOnlyCopies(response: NextResponse, names: readonly string[]) {
  if (!cookieDomain()) return;

  const written = response.headers.getSetCookie();
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";

  response.headers.delete("Set-Cookie");
  for (const name of names) {
    response.headers.append("Set-Cookie", `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure}`);
  }
  for (const line of written) response.headers.append("Set-Cookie", line);
}

/** {@link cookieDomain} for the unlock cookie, which is written elsewhere. */
export function domainCookieOption() {
  const domain = cookieDomain();

  return domain ? { domain } : {};
}

export function readRefreshTokenCookie(request: NextRequest) {
  return readRefreshTokenCookieValue(request.cookies);
}

/**
 * `refreshToken: null` is a reuse-window refresh (see `refreshAccessToken`):
 * only the access cookie is renewed and the refresh cookie the winning request
 * wrote is left alone.
 */
export function applySessionCookies(
  response: NextResponse,
  tokens: { accessToken: string; refreshToken: string | null },
) {
  response.cookies.set(
    ACCESS_TOKEN_COOKIE,
    tokens.accessToken,
    cookieOptions(accessTokenTtlSeconds()),
  );

  if (tokens.refreshToken) {
    response.cookies.set(
      REFRESH_TOKEN_COOKIE,
      tokens.refreshToken,
      cookieOptions(refreshTokenTtlSeconds()),
    );
    response.cookies.set(
      LEGACY_REFRESH_TOKEN_COOKIE,
      "",
      hostOnlyOptions(0, LEGACY_REFRESH_COOKIE_PATH),
    );
  }

  // The pre-rename pair goes the moment a new one is written, so a browser
  // never carries both. Left in place they would outlive the session they
  // belong to and keep being offered to `readAccessTokenCookie` as a fallback
  // long after they stopped being valid.
  for (const name of RENAMED_ROOT_PATH_COOKIES) {
    response.cookies.set(name, "", hostOnlyOptions(0));
  }

  // A reuse-window refresh writes no refresh cookie, so its host-only copy stays.
  expireHostOnlyCopies(
    response,
    tokens.refreshToken ? [ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE] : [ACCESS_TOKEN_COOKIE],
  );

  return response;
}

export function clearSessionCookies(response: NextResponse) {
  response.cookies.set(ACCESS_TOKEN_COOKIE, "", cookieOptions(0));
  response.cookies.set(REFRESH_TOKEN_COOKIE, "", cookieOptions(0));

  // Signing out has to reach every spelling, or the next request reads a
  // pre-rename cookie through the fallback and the person is still signed in.
  for (const name of RENAMED_ROOT_PATH_COOKIES) {
    response.cookies.set(name, "", hostOnlyOptions(0));
  }

  response.cookies.set(
    LEGACY_REFRESH_TOKEN_COOKIE,
    "",
    hostOnlyOptions(0, LEGACY_REFRESH_COOKIE_PATH),
  );

  expireHostOnlyCopies(response, [ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE]);

  // `response.cookies` keeps one entry per name, so the older "/api/v1/auth"
  // copy of the legacy cookie is appended raw, after every `cookies.set`.
  response.headers.append(
    "Set-Cookie",
    `${LEGACY_REFRESH_TOKEN_COOKIE}=; Path=/api/v1/auth; Max-Age=0; HttpOnly; SameSite=Lax${
      process.env.NODE_ENV === "production" ? "; Secure" : ""
    }`,
  );

  return response;
}
