import "@/lib/load-root-env";

import { createHash } from "node:crypto";
import { jwtVerify, SignJWT, type JWTPayload } from "jose";

export {
  ACCESS_TOKEN_COOKIE,
  LEGACY_ACCESS_TOKEN_COOKIES,
  LEGACY_REFRESH_TOKEN_COOKIE,
  LEGACY_REFRESH_TOKEN_COOKIES,
  REFRESH_TOKEN_COOKIE,
  hasSessionCookie,
  readAccessTokenCookie,
  readRefreshTokenCookieValue,
} from "@/lib/auth-cookies";
import { Role } from "@/lib/roles";

type TokenType = "access" | "refresh";

export type AuthTokenPayload = JWTPayload & {
  role: Role;
  hostelIds?: string[];
  /**
   * The account has an app-lock PIN: a cookie session must also carry the
   * PIN-unlock cookie for this session (`lib/lock-pin-cookie.ts`). Bearer
   * (app) sessions are locked by the app itself.
   */
  lockPin?: boolean;
  sessionId?: string;
  /**
   * Present only when the session was opened with a temporary credential
   * (Settings → Temporary access). Its presence *is* the "this is a borrowed
   * login" flag, so there is no second boolean to keep in step with it.
   */
  temporaryCredentialId?: string;
  tokenType: TokenType;
};

type TokenInput = {
  hostelIds?: string[];
  lockPin?: boolean;
  role: Role;
  sessionId?: string;
  temporaryCredentialId?: string;
  userId: string;
};

const timeUnitSeconds: Record<string, number> = {
  s: 1,
  m: 60,
  h: 60 * 60,
  d: 24 * 60 * 60,
};

function parseDurationSeconds(value: string | undefined, fallbackSeconds: number) {
  if (!value) {
    return fallbackSeconds;
  }

  const numeric = Number(value);

  if (Number.isFinite(numeric)) {
    return numeric;
  }

  const match = value.match(/^(\d+)([smhd])$/);

  if (!match) {
    return fallbackSeconds;
  }

  const amount = Number(match[1]);
  const unit = match[2];

  return amount * timeUnitSeconds[unit];
}

export function jwtSecret(name: "JWT_ACCESS_SECRET" | "JWT_REFRESH_SECRET") {
  const value = process.env[name];

  if (!value) {
    throw new Error(`${name} is required for authentication.`);
  }

  return new TextEncoder().encode(value);
}

export function accessTokenTtlSeconds() {
  return parseDurationSeconds(process.env.ACCESS_TOKEN_TTL, 15 * 60);
}

export function refreshTokenTtlSeconds() {
  return parseDurationSeconds(process.env.REFRESH_TOKEN_TTL, 30 * 24 * 60 * 60);
}

export function refreshTokenExpiresAt() {
  return new Date(Date.now() + refreshTokenTtlSeconds() * 1000);
}

export function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export async function signAccessToken(input: TokenInput) {
  return new SignJWT({
    role: input.role,
    hostelIds: input.hostelIds ?? [],
    ...(input.lockPin ? { lockPin: true } : {}),
    sessionId: input.sessionId,
    ...(input.temporaryCredentialId
      ? { temporaryCredentialId: input.temporaryCredentialId }
      : {}),
    tokenType: "access",
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(input.userId)
    .setIssuedAt()
    .setExpirationTime(`${accessTokenTtlSeconds()}s`)
    .sign(jwtSecret("JWT_ACCESS_SECRET"));
}

export async function signRefreshToken(input: TokenInput) {
  return new SignJWT({
    role: input.role,
    hostelIds: input.hostelIds ?? [],
    sessionId: input.sessionId,
    ...(input.temporaryCredentialId
      ? { temporaryCredentialId: input.temporaryCredentialId }
      : {}),
    tokenType: "refresh",
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(input.userId)
    .setIssuedAt()
    .setExpirationTime(`${refreshTokenTtlSeconds()}s`)
    .sign(jwtSecret("JWT_REFRESH_SECRET"));
}

async function verifyToken(
  token: string,
  expectedType: TokenType,
  secretName: "JWT_ACCESS_SECRET" | "JWT_REFRESH_SECRET",
) {
  const { payload } = await jwtVerify(token, jwtSecret(secretName));

  if (payload.tokenType !== expectedType || !payload.sub || !payload.role) {
    throw new Error("Invalid authentication token.");
  }

  return payload as AuthTokenPayload;
}

export type PurposeTokenPurpose =
  | "cancel-account-deletion"
  | "lock-pin-unlock"
  | "night-status-answer"
  | "password-reset"
  | "verify-email";

export type PurposeTokenPayload = JWTPayload & {
  tokenType: PurposeTokenPurpose;
  tokenVersion?: number;
  [claim: string]: unknown;
};

/**
 * Single-purpose tokens for email links (verification, password reset).
 * Signed with the access secret but a distinct tokenType, so they can never
 * be replayed as access/refresh tokens.
 */
export async function signPurposeToken(input: {
  userId: string;
  purpose: PurposeTokenPurpose;
  ttlSeconds: number;
  tokenVersion?: number;
  /** Extra claims that narrow what the token is good for. */
  claims?: Record<string, string>;
}) {
  return new SignJWT({
    ...input.claims,
    tokenType: input.purpose,
    ...(input.tokenVersion !== undefined ? { tokenVersion: input.tokenVersion } : {}),
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(input.userId)
    .setIssuedAt()
    .setExpirationTime(`${input.ttlSeconds}s`)
    .sign(jwtSecret("JWT_ACCESS_SECRET"));
}

export async function verifyPurposeToken(token: string, purpose: PurposeTokenPurpose) {
  const { payload } = await jwtVerify(token, jwtSecret("JWT_ACCESS_SECRET"));

  if (payload.tokenType !== purpose || !payload.sub) {
    throw new Error("Invalid token.");
  }

  return payload as PurposeTokenPayload;
}

export function getBearerToken(authorizationHeader: string | null) {
  if (!authorizationHeader?.startsWith("Bearer ")) {
    return null;
  }

  return authorizationHeader.slice("Bearer ".length).trim();
}

export function verifyAccessToken(token: string) {
  return verifyToken(token, "access", "JWT_ACCESS_SECRET");
}

export function verifyRefreshToken(token: string) {
  return verifyToken(token, "refresh", "JWT_REFRESH_SECRET");
}
