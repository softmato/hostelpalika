import { randomInt } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";

import {
  hashToken,
  refreshTokenExpiresAt,
  signAccessToken,
  signPurposeToken,
  signRefreshToken,
  verifyAccessToken,
  verifyPurposeToken,
  verifyRefreshToken,
} from "@/lib/auth";
import { connectToDatabase } from "@/lib/db";
import { hashPassword, verifyPassword } from "@/lib/password";
import { Role } from "@/lib/roles";
import { landingPathForRole } from "@/lib/route-access";
import { outboundUrl } from "@/lib/site";
import {
  SUSPENDABLE_ROLES,
  suspensionForAccount,
} from "@/modules/hostels/hostel-suspension";
import { sendEmail } from "@hostel/shared/email/sender";
import { otpCodeEmail } from "@hostel/shared/email/templates/auth/otp-code";
import { verificationEmail } from "@hostel/shared/email/templates/auth/verification";
import { passwordResetEmail } from "@hostel/shared/email/templates/auth/password-reset";
import type {
  ChangePasswordInput,
  ForgotPasswordInput,
  ResendVerificationInput,
  ResetPasswordInput,
  SignupInput,
  VerifyEmailInput,
} from "@hostel/shared/schemas/auth.schema";
import { OAuthAccountModel } from "@hostel/db/models/OAuthAccount";
import { OtpChallengeModel } from "@hostel/db/models/OtpChallenge";
import { ResidentModel } from "@hostel/db/models/Resident";
import { SessionModel } from "@hostel/db/models/Session";
import { ServiceProviderModel } from "@hostel/db/models/ServiceProvider";
import { UserModel } from "@hostel/db/models/User";
import {
  authenticateTemporaryCredential,
  isTemporaryCredentialActive,
} from "@/modules/auth/temporary-credential.service";
import type {
  GoogleAuthInput,
  LoginInput,
  OtpRequestInput,
  OtpVerifyInput,
  RegisterInput,
} from "@/modules/auth/auth.validation";

export class AuthServiceError extends Error {
  constructor(
    message: string,
    public errorCode = "AUTH_ERROR",
    public status = 401,
  ) {
    super(message);
  }
}

type RequestContext = {
  ipAddress?: string;
  userAgent?: string;
};

const GOOGLE_JWKS = createRemoteJWKSet(
  new URL("https://www.googleapis.com/oauth2/v3/certs"),
);

/**
 * Statuses a sign-in is allowed to claim. INVITED is an admin-issued account
 * that has not signed in yet — the first sign-in is what turns it ACTIVE — so
 * it is a pending account, not a revoked one. Every other non-ACTIVE status is.
 */
const CLAIMABLE_STATUSES = ["ACTIVE", "INVITED"];

function publicUser(user: {
  _id: unknown;
  email?: string | null;
  emailVerified?: boolean | null;
  emailVerifiedAt?: Date | null;
  hostelIds?: unknown[];
  image?: string | null;
  mustChangePassword?: boolean | null;
  name: string;
  phone?: string | null;
  role: Role;
  status: string;
  userResidentId?: string | null;
}) {
  return {
    id: String(user._id),
    email: user.email ?? null,
    emailVerified: Boolean(user.emailVerified || user.emailVerifiedAt),
    hostelIds: (user.hostelIds ?? []).map((hostelId) => String(hostelId)),
    image: user.image ?? null,
    mustChangePassword: Boolean(user.mustChangePassword),
    name: user.name,
    phone: user.phone ?? null,
    role: user.role,
    redirectPath: landingPathForRole(user.role) ?? "/",
    status: user.status,
    // Only minted once a resident profile is saved, so the account menu can
    // offer "Create resident ID" vs "Show resident QR code" without a second call.
    userResidentId: user.userResidentId ?? null,
  };
}

/**
 * Whether the account is an approved service provider.
 *
 * There is no SERVICE_PROVIDER role — a provider is a PUBLIC account with an
 * approved provider record — so neither the web header nor the phone can tell
 * from the role alone which navigation to draw. Every payload that describes
 * the signed-in account answers it here: `/me`, every sign-in and every
 * refresh. Sign-ins used to leave it out, so the phone routed an approved
 * provider into the browsing app and only moved them to their own tabs on the
 * next resume, from whatever screen they were on by then.
 *
 * Only asked for PUBLIC accounts: no other role can hold a provider listing,
 * and this runs on every one of those calls.
 */
async function isApprovedServiceProvider(user: { _id: unknown; role: Role }) {
  if (user.role !== Role.PUBLIC) {
    return false;
  }

  return Boolean(
    await ServiceProviderModel.exists({
      isDeleted: false,
      status: "APPROVED",
      userId: user._id,
    }),
  );
}

function normalizeEmail(email?: string | null) {
  return email?.trim().toLowerCase() || undefined;
}

function normalizeOtpIdentifier(identifier: string) {
  return identifier.trim().toLowerCase();
}

function otpTtlMs() {
  return Number(process.env.OTP_TTL_MINUTES ?? 10) * 60 * 1000;
}

function otpRateLimitWindowMs() {
  return Number(process.env.OTP_RATE_LIMIT_WINDOW_MINUTES ?? 15) * 60 * 1000;
}

function otpRateLimitMax() {
  return Number(process.env.OTP_RATE_LIMIT_MAX ?? 5);
}

export function otpResendCooldownMs() {
  return Number(process.env.OTP_RESEND_COOLDOWN_SECONDS ?? 60) * 1000;
}

function hashOtpCode(identifier: string, code: string) {
  const secret =
    process.env.OTP_HASH_SECRET ??
    process.env.JWT_ACCESS_SECRET ??
    "development-otp-secret";

  return hashToken(`${identifier}:${code}:${secret}`);
}

function generateOtpCode() {
  return String(randomInt(100000, 1000000));
}

function otpDeliveryProvider() {
  return process.env.RESEND_API_KEY ? "resend" : null;
}

/**
 * Sends the signup one-time code.
 *
 * This used to call Resend directly with its own hand-rolled HTML, its own
 * `From` header read straight from `RESEND_FROM_EMAIL`, and "HostelPalika" hard
 * coded into the heading, the copy and the subject — so the one email a brand
 * new user is guaranteed to receive was the one email that ignored whatever the
 * platform owner had named the product. It now goes through `sendEmail()` and
 * the shared `otpCodeEmail` template like everything else, which also means it
 * arrives from `security@` rather than from the general mailbox.
 */
async function sendResendOtp(input: { code: string; identifier: string }) {
  const delivery = await sendEmail({
    to: input.identifier,
    ...otpCodeEmail({ code: input.code, expiresInMinutes: otpTtlMs() / 60_000 }),
  });

  if (delivery.sent) {
    return;
  }

  if (delivery.reason === "not_configured") {
    throw new AuthServiceError(
      "Resend OTP email is not configured.",
      "OTP_DELIVERY_NOT_CONFIGURED",
      503,
    );
  }

  throw new AuthServiceError("Could not send OTP email.", "OTP_DELIVERY_FAILED", 502);
}

async function dispatchOtpChallenge(input: {
  channel: OtpRequestInput["channel"];
  code: string;
  identifier: string;
}) {
  const provider = otpDeliveryProvider();

  if (!provider) {
    if (process.env.NODE_ENV !== "production") {
      return {
        channel: input.channel,
        provider: "development",
        status: "development",
      };
    }

    throw new AuthServiceError(
      "OTP delivery provider is not configured.",
      "OTP_DELIVERY_NOT_CONFIGURED",
      503,
    );
  }

  if (provider === "resend") {
    await sendResendOtp(input);
  }

  return {
    channel: input.channel,
    provider,
    status: "queued",
  };
}

/**
 * A RESIDENT who lives nowhere — moved out before move-outs released the login
 * — is asked for an activation code on every sign-in. They are a public account
 * again; this makes it so on their next sign-in or token refresh.
 */
async function releaseStrandedResident<T extends { _id: unknown; hostelIds?: unknown[]; role: Role }>(
  user: T,
): Promise<T> {
  if (
    user.role !== Role.RESIDENT ||
    (await ResidentModel.exists({
      isDeleted: { $ne: true },
      status: { $in: ["ACTIVE", "PENDING", "SUSPENDED"] },
      userId: user._id,
    }))
  ) {
    return user;
  }

  await UserModel.updateOne(
    { _id: user._id, role: Role.RESIDENT },
    { $set: { hostelIds: [], role: Role.PUBLIC } },
  );

  // Assigned, not spread: sign-in hands us a hydrated document, and a spread of
  // one drops `_id`, `name` and every other field — they are prototype getters.
  return Object.assign(user, { hostelIds: [], role: Role.PUBLIC });
}

export async function issueSessionForUser(
  user: {
    _id: unknown;
    email?: string | null;
    hostelIds?: unknown[];
    name: string;
    phone?: string | null;
    role: Role;
    status: string;
  },
  context?: RequestContext,
  /**
   * Set when a temporary credential opened this session. It is stamped on both
   * the session row and the tokens, which is what lets a revoke reach live
   * sessions and lets the API refuse account-level actions to a borrowed login.
   */
  options?: { temporaryCredentialId?: string },
) {
  const account = await releaseStrandedResident(user);
  const safeUser = publicUser(account);

  const session = new SessionModel({
    expiresAt: refreshTokenExpiresAt(),
    ipAddress: context?.ipAddress,
    temporaryCredentialId: options?.temporaryCredentialId ?? null,
    userAgent: context?.userAgent,
    userId: safeUser.id,
  });
  const sessionId = String(session._id);

  const tokenInput = {
    hostelIds: safeUser.hostelIds,
    role: safeUser.role,
    sessionId,
    temporaryCredentialId: options?.temporaryCredentialId,
    userId: safeUser.id,
  };
  const [accessToken, refreshToken, isServiceProvider] = await Promise.all([
    signAccessToken(tokenInput),
    signRefreshToken(tokenInput),
    isApprovedServiceProvider(account),
  ]);

  session.refreshTokenHash = hashToken(refreshToken);
  // Stamped here rather than in each sign-in path: Google, OTP, guardian and
  // resident activation all open their sessions through this function, and the
  // platform's "has this portal been opened" read needs every one of them.
  await Promise.all([
    session.save(),
    UserModel.updateOne({ _id: safeUser.id }, { $set: { lastLoginAt: new Date() } }),
  ]);

  return {
    accessToken,
    refreshToken,
    user: {
      ...safeUser,
      isServiceProvider,
      viaTemporaryCredential: Boolean(options?.temporaryCredentialId),
    },
  };
}

export async function requestOtpChallenge(
  // `plan-checkout` is not accepted by the public OTP route — only the plan
  // checkout, after matching the email to a hostel, asks for one.
  input: Omit<OtpRequestInput, "purpose"> & {
    purpose: OtpRequestInput["purpose"] | "plan-checkout";
  },
  context?: RequestContext,
) {
  await connectToDatabase();

  const identifier = normalizeOtpIdentifier(input.identifier);
  const rateLimitStartedAt = new Date(Date.now() - otpRateLimitWindowMs());
  const recentRequestCount = await OtpChallengeModel.countDocuments({
    channel: input.channel,
    createdAt: { $gte: rateLimitStartedAt },
    identifier,
    purpose: input.purpose,
  });

  if (recentRequestCount >= otpRateLimitMax()) {
    throw new AuthServiceError(
      "Too many OTP requests. Please wait before trying again.",
      "OTP_RATE_LIMITED",
      429,
    );
  }

  const latestChallenge = await OtpChallengeModel.findOne({
    channel: input.channel,
    consumedAt: null,
    expiresAt: { $gt: new Date() },
    identifier,
    purpose: input.purpose,
  }).sort({ createdAt: -1 });

  if (
    latestChallenge?.codeLastSentAt &&
    Date.now() - new Date(latestChallenge.codeLastSentAt).getTime() <
      otpResendCooldownMs()
  ) {
    throw new AuthServiceError(
      "Please wait before requesting another OTP.",
      "OTP_RESEND_COOLDOWN",
      429,
    );
  }

  const code = generateOtpCode();
  const expiresAt = new Date(Date.now() + otpTtlMs());
  const delivery = await dispatchOtpChallenge({
    channel: input.channel,
    code,
    identifier,
  });
  const challenge = await OtpChallengeModel.create({
    channel: input.channel,
    codeHash: hashOtpCode(identifier, code),
    codeLastSentAt: new Date(),
    expiresAt,
    identifier,
    ipAddress: context?.ipAddress,
    purpose: input.purpose,
    userAgent: context?.userAgent,
  });

  return {
    challengeId: String(challenge._id),
    delivery,
    expiresAt,
    ...(process.env.NODE_ENV === "production" ? {} : { devCode: code }),
  };
}

export async function verifyOtpChallenge(input: OtpVerifyInput) {
  await connectToDatabase();

  const live = {
    _id: input.challengeId,
    consumedAt: null,
    expiresAt: { $gt: new Date() },
  };

  if (!(await OtpChallengeModel.exists(live))) {
    throw new AuthServiceError(
      "OTP challenge is invalid or expired.",
      "OTP_INVALID",
      400,
    );
  }

  /*
   * The attempt is spent before the code is compared, in one atomic write. The
   * old read-check-then-save let a burst of parallel guesses all read the same
   * count and each get a try, so "five attempts" was as many as an attacker
   * could send at once. A correct code ends the flow, so five tries still means
   * five, right or wrong.
   */
  const challenge = await OtpChallengeModel.findOneAndUpdate(
    { ...live, attempts: { $lt: 5 } },
    { $inc: { attempts: 1 } },
    { new: true },
  ).select("+codeHash");

  if (!challenge) {
    throw new AuthServiceError(
      "Too many OTP verification attempts.",
      "OTP_ATTEMPT_LIMIT",
      429,
    );
  }

  if (challenge.codeHash !== hashOtpCode(challenge.identifier, input.code)) {
    throw new AuthServiceError("OTP code is incorrect.", "OTP_INCORRECT", 400);
  }

  challenge.verifiedAt = new Date();
  await challenge.save();

  return {
    challengeId: String(challenge._id),
    channel: challenge.channel,
    identifier: challenge.identifier,
    verifiedAt: challenge.verifiedAt,
  };
}

async function findVerifiedRegistrationChallenge(input: RegisterInput) {
  const email = normalizeEmail(input.email);
  const challenge = await OtpChallengeModel.findOne({
    _id: input.otpChallengeId,
    consumedAt: null,
    expiresAt: { $gt: new Date() },
    purpose: "registration",
    verifiedAt: { $ne: null },
  });

  if (!challenge) {
    throw new AuthServiceError(
      "A verified registration OTP is required.",
      "REGISTRATION_OTP_REQUIRED",
      400,
    );
  }

  const challengeMatchesEmail =
    challenge.channel === "email" && email === challenge.identifier;

  if (!challengeMatchesEmail) {
    throw new AuthServiceError(
      "Verified OTP does not match this registration.",
      "REGISTRATION_OTP_MISMATCH",
      400,
    );
  }

  return challenge;
}

export async function registerPublicAccount(
  input: RegisterInput,
  context?: RequestContext,
) {
  await connectToDatabase();

  const email = normalizeEmail(input.email);
  if (!email) {
    throw new AuthServiceError("Email is required.", "EMAIL_REQUIRED", 400);
  }

  const existingUser = await UserModel.findOne({
    email,
    isDeleted: { $ne: true },
  });

  if (existingUser) {
    throw new AuthServiceError(
      "An account already exists for this email.",
      "ACCOUNT_ALREADY_EXISTS",
      409,
    );
  }

  const challenge = await findVerifiedRegistrationChallenge({
    ...input,
    email,
  });
  const now = new Date();
  const user = await UserModel.create({
    email,
    emailVerifiedAt: challenge.channel === "email" ? now : undefined,
    name: input.name,
    passwordHash: await hashPassword(input.password),
    role: Role.PUBLIC,
    status: "ACTIVE",
  });

  challenge.consumedAt = now;
  await challenge.save();

  return issueSessionForUser(user, context);
}

async function verifyGoogleIdToken(input: GoogleAuthInput) {
  const googleClientId = process.env.GOOGLE_CLIENT_ID;

  if (!googleClientId) {
    throw new AuthServiceError(
      "Google auth is not configured.",
      "GOOGLE_AUTH_NOT_CONFIGURED",
      503,
    );
  }

  try {
    const { payload } = await jwtVerify(input.idToken, GOOGLE_JWKS, {
      audience: googleClientId,
      issuer: ["https://accounts.google.com", "accounts.google.com"],
    });
    const subject = typeof payload.sub === "string" ? payload.sub : null;
    const email =
      typeof payload.email === "string" ? normalizeEmail(payload.email) : null;
    const emailVerified = payload.email_verified === true;

    if (!subject || !email || !emailVerified) {
      throw new AuthServiceError(
        "Google account email must be verified.",
        "GOOGLE_EMAIL_UNVERIFIED",
        401,
      );
    }

    const picture =
      typeof payload.picture === "string" && payload.picture.trim().length > 0
        ? payload.picture.trim()
        : null;

    return {
      email,
      name:
        typeof payload.name === "string" && payload.name.trim().length > 0
          ? payload.name.trim()
          : email,
      picture,
      providerAccountId: subject,
    };
  } catch (error) {
    if (error instanceof AuthServiceError) {
      throw error;
    }

    throw new AuthServiceError(
      "Google sign-in token is invalid.",
      "GOOGLE_TOKEN_INVALID",
      401,
    );
  }
}

export async function authenticateWithGoogle(
  input: GoogleAuthInput,
  context?: RequestContext,
) {
  const googleAccount = await verifyGoogleIdToken(input);

  await connectToDatabase();

  const linkedAccount = await OAuthAccountModel.findOne({
    isDeleted: { $ne: true },
    provider: "google",
    providerAccountId: googleAccount.providerAccountId,
  });
  const linkedUser = linkedAccount
    ? await UserModel.findOne({
        _id: linkedAccount.userId,
        isDeleted: { $ne: true },
      })
    : null;

  // The linked user still exists but has been suspended/archived — a real denial.
  if (linkedUser && !CLAIMABLE_STATUSES.includes(linkedUser.get("status"))) {
    throw new AuthServiceError(
      "Linked Google account no longer has access.",
      "USER_INACTIVE",
      401,
    );
  }

  // The linked user row is gone entirely (hard-deleted). The link is stale, not a
  // denial: fall through to email match / fresh signup and repoint it below.
  const orphanedLink = Boolean(linkedAccount) && !linkedUser;
  let user = linkedUser;

  if (!user) {
    /*
     * INVITED as well as ACTIVE, the same pair `login` accepts. A cook or
     * warden is created INVITED and stays that way until the first sign-in, so
     * matching only ACTIVE here did not fall through to a fresh signup — it
     * fell into the `UserModel.create` below with an email the unique index
     * already holds, and the duplicate-key error reached the account as a 500
     * on the one button it was most likely to press.
     */
    user = await UserModel.findOne({
      email: googleAccount.email,
      isDeleted: { $ne: true },
      status: { $in: CLAIMABLE_STATUSES },
    });
  }

  if (!user) {
    user = await UserModel.create({
      authProvider: "GOOGLE",
      email: googleAccount.email,
      emailVerified: true,
      emailVerifiedAt: new Date(),
      googleId: googleAccount.providerAccountId,
      image: googleAccount.picture,
      name: googleAccount.name,
      role: Role.PUBLIC,
      status: "ACTIVE",
    });
  } else {
    let changed = false;

    if (googleAccount.picture && !user.get("image")) {
      user.set("image", googleAccount.picture);
      changed = true;
    }

    if (!user.get("googleId")) {
      user.set("googleId", googleAccount.providerAccountId);
      changed = true;
    }

    if (!user.get("emailVerified") && !user.get("emailVerifiedAt")) {
      user.set("emailVerified", true);
      user.set("emailVerifiedAt", new Date());
      changed = true;
    }

    // The first sign-in is what activates an admin-issued account, exactly as
    // it is in `login` — the route in is Google rather than a typed password.
    if (user.get("status") === "INVITED") {
      user.set("status", "ACTIVE");
      changed = true;
    }

    /*
     * `mustChangePassword` is deliberately left alone, along with the password
     * behind it. A provisioned account keeps the credentials its warden issued
     * — that pair is how a shared kitchen login is meant to be used, and a
     * Google sign-in on the same address is an additional way in, not a reason
     * to invalidate the one people have written down. Nothing routes on the
     * flag any more (`resolveHome` in apps/mobile/src/constants/roles.ts), so
     * it costs this sign-in nothing to carry.
     */

    if (changed) {
      await user.save();
    }
  }

  if (orphanedLink && linkedAccount) {
    // Reuse the stale row rather than creating a second one — {provider,
    // providerAccountId} is uniquely indexed.
    linkedAccount.set("email", googleAccount.email);
    linkedAccount.set("userId", user._id);
    linkedAccount.set("linkedAt", new Date());
    await linkedAccount.save();
  } else if (!linkedAccount) {
    await OAuthAccountModel.create({
      email: googleAccount.email,
      provider: "google",
      providerAccountId: googleAccount.providerAccountId,
      userId: user._id,
    });
  }

  return issueSessionForUser(user, context);
}

export async function login(input: LoginInput, context?: RequestContext) {
  await connectToDatabase();

  const identifier = input.identifier.trim().toLowerCase();

  /*
   * A temporary username can never contain `@` (see
   * temporaryCredentialUsernameSchema), and an email address always does — so
   * the two namespaces cannot collide and one character decides which table to
   * look in. No fallback between the branches: an identifier with an `@` that
   * fails is a failed *email* login, and letting it retry as a username would
   * turn one attempt into two against the rate limit.
   */
  if (!identifier.includes("@")) {
    const match = await authenticateTemporaryCredential(identifier, input.password);

    if (!match) {
      throw new AuthServiceError("Invalid credentials.", "INVALID_CREDENTIALS");
    }

    // The owner already proved their email when they created this, and the
    // credential is short-lived by construction, so there is no second
    // verification gate here — only the account's own ACTIVE status, which
    // `authenticateTemporaryCredential` has already enforced.
    return issueSessionForUser(match.owner, context, {
      temporaryCredentialId: match.credentialId,
    });
  }

  // INVITED covers admin-issued accounts (wardens, cooks, upgraded admins)
  // logging in for the first time with their emailed temporary password.
  const user = await UserModel.findOne({
    email: identifier,
    isDeleted: { $ne: true },
    status: { $in: ["ACTIVE", "INVITED"] },
  }).select("+passwordHash");

  if (!user?.passwordHash) {
    throw new AuthServiceError("Invalid credentials.", "INVALID_CREDENTIALS");
  }

  const passwordMatches = await verifyPassword(input.password, user.passwordHash);

  if (!passwordMatches) {
    throw new AuthServiceError("Invalid credentials.", "INVALID_CREDENTIALS");
  }

  if (!user.emailVerified && !user.emailVerifiedAt) {
    throw new AuthServiceError(
      "Email is not verified. Check your inbox for the verification link.",
      "EMAIL_NOT_VERIFIED",
      403,
    );
  }

  if (user.status === "INVITED") {
    user.status = "ACTIVE";
    await user.save();
  }

  return issueSessionForUser(user, context);
}

/*
 * How long a refresh token that was just rotated away still buys an access
 * token. A browser fires several refreshes at once — two tabs, the proxy and a
 * page's 401 handler, a burst of link prefetches — and all of them carry the
 * same cookie. Only one can rotate it; without this window every other one
 * failed with INVALID_SESSION and the user landed on /login. A browser reuse
 * only ever gets a 15-minute access token, never a new refresh token.
 *
 * The phone single-flights, so it never races itself — but on a bad connection
 * the server can rotate and the reply never arrive. It then retries with the
 * token it still holds, and without the window that was a logout. It gets a
 * fresh refresh token instead, since it never received the one it lost.
 */
const REFRESH_REUSE_WINDOW_MS = 60 * 1000;

export async function refreshAccessToken(
  refreshToken: string,
  /**
   * `cookieSession`: the token came from the browser's cookie, which the
   * winning request of a concurrent burst has already replaced in the jar.
   */
  options: { cookieSession?: boolean } = {},
) {
  await connectToDatabase();

  const payload = await verifyRefreshToken(refreshToken);
  const refreshTokenHash = hashToken(refreshToken);
  const now = new Date();
  const reuseWindowStart = new Date(now.getTime() - REFRESH_REUSE_WINDOW_MS);
  const session = await SessionModel.findOne({
    _id: payload.sessionId,
    expiresAt: { $gt: now },
    revokedAt: null,
  });

  if (!session) {
    throw new AuthServiceError("Refresh session is invalid.", "INVALID_SESSION");
  }

  const isCurrent = session.refreshTokenHash === refreshTokenHash;
  const justRotated =
    session.previousRefreshTokenHash === refreshTokenHash &&
    session.refreshTokenRotatedAt instanceof Date &&
    session.refreshTokenRotatedAt.getTime() > reuseWindowStart.getTime();

  if (!isCurrent && !justRotated) {
    /*
     * A correctly signed token for this session that is neither its current one
     * nor the one rotated away moments ago can only be one rotated away earlier.
     * Somebody is replaying a copy, and there is no telling which holder is the
     * owner, so the session ends for both (refresh-token reuse detection, OAuth
     * 2.0 Security BCP). The owner signs in again; the copy is dead.
     */
    await SessionModel.updateOne(
      { _id: session._id, revokedAt: null },
      { $set: { revokedAt: now } },
    );

    throw new AuthServiceError("Refresh session is invalid.", "INVALID_SESSION");
  }

  const user = await UserModel.findOne({
    _id: payload.sub,
    isDeleted: { $ne: true },
    status: "ACTIVE",
  });

  if (!user) {
    throw new AuthServiceError("User no longer has access.", "USER_INACTIVE");
  }

  /*
   * A borrowed session is re-authorised on every refresh, not just at login:
   * without this a temporary credential revoked (or simply expired) an hour ago
   * would keep minting fresh 30-day refresh tokens for as long as the holder
   * kept the tab open, which would make the expiry date decorative.
   */
  const temporaryCredentialId = session.temporaryCredentialId
    ? String(session.temporaryCredentialId)
    : undefined;

  if (
    temporaryCredentialId &&
    !(await isTemporaryCredentialActive(temporaryCredentialId))
  ) {
    session.revokedAt = new Date();
    await session.save();

    throw new AuthServiceError(
      "This temporary login is no longer valid.",
      "TEMPORARY_CREDENTIAL_INVALID",
    );
  }

  const account = await releaseStrandedResident(user);
  const safeUser = publicUser(account);
  const tokenInput = {
    hostelIds: safeUser.hostelIds,
    role: safeUser.role,
    sessionId: String(session._id),
    temporaryCredentialId,
    userId: safeUser.id,
  };
  const [accessToken, signedRefreshToken, isServiceProvider] = await Promise.all([
    signAccessToken(tokenInput),
    signRefreshToken(tokenInput),
    isApprovedServiceProvider(account),
  ]);

  // Compare-and-set on the presented hash: two requests that both read the
  // session before either wrote would otherwise each rotate, and the loser's
  // token — already handed to the client — would be dead on arrival.
  const rotation = isCurrent
    ? await SessionModel.updateOne(
        { _id: session._id, refreshTokenHash },
        {
          $set: {
            lastSeenAt: now,
            previousRefreshTokenHash: refreshTokenHash,
            refreshTokenHash: hashToken(signedRefreshToken),
            refreshTokenRotatedAt: now,
          },
        },
      )
    : null;
  let rotated = rotation?.modifiedCount === 1;

  // Not rotated: the presented token went moments ago — to a concurrent
  // request, or to this very client in a reply it never received.
  if (!rotated && options.cookieSession) {
    await SessionModel.updateOne({ _id: session._id }, { $set: { lastSeenAt: now } });
  } else if (!rotated) {
    // Replaces the token it lost. The window keeps its original start, so
    // retrying cannot stretch it.
    const reissue = await SessionModel.updateOne(
      {
        _id: session._id,
        previousRefreshTokenHash: refreshTokenHash,
        refreshTokenRotatedAt: { $gt: reuseWindowStart },
        revokedAt: null,
      },
      { $set: { lastSeenAt: now, refreshTokenHash: hashToken(signedRefreshToken) } },
    );

    rotated = reissue.modifiedCount === 1;

    if (!rotated) {
      throw new AuthServiceError("Refresh session is invalid.", "INVALID_SESSION");
    }
  }

  return {
    accessToken,
    // null on a browser reuse: the jar keeps the cookie the winning request set.
    refreshToken: rotated ? signedRefreshToken : null,
    user: {
      ...safeUser,
      isServiceProvider,
      viaTemporaryCredential: Boolean(temporaryCredentialId),
    },
  };
}

export async function getCurrentUser(accessToken: string) {
  await connectToDatabase();

  const payload = await verifyAccessToken(accessToken);
  const viaTemporaryCredential = typeof payload.temporaryCredentialId === "string";

  /*
   * This endpoint answers "who is signed in?", and the portal shell renders on
   * the strength of it. Checking the token's signature alone would leave a
   * revoked holder looking signed in — shell drawn, nav drawn — until the
   * access token expired, with every data call underneath it 401ing. Same
   * database check the API guard makes, for the same reason.
   */
  if (
    viaTemporaryCredential &&
    !(await isTemporaryCredentialActive(payload.temporaryCredentialId as string))
  ) {
    throw new AuthServiceError(
      "This temporary login is no longer valid.",
      "TEMPORARY_CREDENTIAL_INVALID",
    );
  }

  const user = await UserModel.findOne({
    _id: payload.sub,
    isDeleted: { $ne: true },
    status: "ACTIVE",
  });

  if (!user) {
    throw new AuthServiceError("User no longer has access.", "USER_INACTIVE");
  }

  // Resolved with the session rather than in a second client request, so the
  // nav never renders the wrong set first.
  const isServiceProvider = await isApprovedServiceProvider(user);

  const safeUser = publicUser(user);

  /*
   * The plan suspension this account's hostel is under, if any. Every portal —
   * web and app — draws its countdown or its suspended screen from this one
   * read; the API refuses the same hostels on its own (`lib/api-auth.ts`).
   */
  const hostelSuspension = SUSPENDABLE_ROLES.has(safeUser.role)
    ? await suspensionForAccount(safeUser.hostelIds)
    : null;

  return {
    ...safeUser,
    hostelSuspension,
    isServiceProvider,
    /**
     * The account outgrew the token in this tab, and nothing else would say so.
     *
     * Every API route authorises from the claims baked into the access token
     * (`loadApiPrincipal`), while this endpoint answers from the database. When
     * a hostel registers somebody, `promoteAccountToResident` raises their row
     * to RESIDENT and adds the hostel — and the tab they are holding keeps a
     * PUBLIC token for the rest of its fifteen minutes. The symptom is exactly
     * the one reported: a resident who has just been registered is still in the
     * public site, with no resident portal, until they sign out and back in.
     *
     * `browser-api` already heals this, but only once it has been *refused* —
     * it needs a 403 from a resident-only route to react to, and the public
     * site never calls one. So the answer to "who is signed in?" carries the
     * mismatch itself, and {@link checkAuthWithRefresh} rotates the token the
     * moment it sees it. One comparison on a call the shell already makes.
     *
     * Hostels are compared as well as the role: a resident registered at a
     * second hostel keeps their RESIDENT role and gains a `hostelId` that every
     * tenant guard reads off the token (`assertHostelAccess`).
     */
    sessionStale:
      payload.role !== safeUser.role ||
      !sameIds(payload.hostelIds, safeUser.hostelIds),
    /**
     * Lets the portal header say "you are on a temporary login" — the account
     * looks identical otherwise, and a borrower who does not realise it will
     * report the blocked account-settings actions as a bug.
     */
    viaTemporaryCredential,
  };
}

/** Set equality over two id lists, order and duplicates ignored. */
function sameIds(fromToken: unknown, fromAccount: string[]) {
  const claimed = new Set(
    (Array.isArray(fromToken) ? fromToken : []).map((id) => String(id)),
  );

  return (
    claimed.size === new Set(fromAccount).size &&
    fromAccount.every((id) => claimed.has(id))
  );
}

export async function logout(refreshToken: string) {
  await connectToDatabase();

  await SessionModel.updateOne(
    { refreshTokenHash: hashToken(refreshToken), revokedAt: null },
    { $set: { revokedAt: new Date() } },
  );
}

// --- Phase 1 email-verification + password flows (ARCHITECTURE.md §3.1) ---

const VERIFY_EMAIL_TTL_HOURS = 24;
const PASSWORD_RESET_TTL_MINUTES = 60;

/** Verify and reset links are read in a mail client, so they can never be this machine. */
function appBaseUrl() {
  return outboundUrl();
}

async function revokeAllSessions(userId: unknown) {
  await SessionModel.updateMany(
    { userId, revokedAt: null },
    { $set: { revokedAt: new Date() } },
  );
}

/**
 * Returns an account to the plain public role it had before a hostel took it
 * on — used when a resident profile is deleted. The account itself is
 * untouched: still ACTIVE, still signed in, still holding its history. It
 * simply stops being a resident, so `/resident` is no longer its to open and
 * it lands on the public site instead.
 *
 * Sessions are deliberately *not* revoked and `tokenVersion` is deliberately
 * *not* bumped — either would sign the person out, which is the opposite of
 * the intent. `refreshAccessToken` re-reads the role from here, so the next
 * refresh hands the browser a PUBLIC token; until then the access token in
 * hand still claims RESIDENT, for at most ACCESS_TOKEN_TTL (15 min default).
 */
export async function demoteToPublicAccount(userId: unknown) {
  await connectToDatabase();

  await UserModel.updateOne(
    { _id: userId, isDeleted: { $ne: true }, role: Role.RESIDENT },
    { $set: { role: Role.PUBLIC } },
  );
}

async function dispatchVerificationEmail(user: { _id: unknown; email?: string | null }) {
  if (!user.email) {
    return;
  }

  const token = await signPurposeToken({
    userId: String(user._id),
    purpose: "verify-email",
    ttlSeconds: VERIFY_EMAIL_TTL_HOURS * 60 * 60,
  });
  const verifyUrl = `${appBaseUrl()}/verify-email?token=${encodeURIComponent(token)}`;

  await sendEmail({
    to: user.email,
    ...verificationEmail({ verifyUrl, expiresInHours: VERIFY_EMAIL_TTL_HOURS }),
  });
}

/**
 * Docs-standard signup (API.md §2): creates a PUBLIC account with
 * emailVerified=false and sends a verification link. No session is issued —
 * the user logs in after verifying.
 */
export async function signupWithEmailVerification(input: SignupInput) {
  await connectToDatabase();

  const email = normalizeEmail(input.email);

  if (!email) {
    throw new AuthServiceError("Email is required.", "EMAIL_REQUIRED", 400);
  }

  const existingUser = await UserModel.findOne({ email, isDeleted: { $ne: true } });

  if (existingUser) {
    throw new AuthServiceError(
      "An account already exists for this email.",
      "ACCOUNT_ALREADY_EXISTS",
      409,
    );
  }

  const user = await UserModel.create({
    authProvider: "LOCAL",
    email,
    emailVerified: false,
    name: input.name,
    passwordHash: await hashPassword(input.password),
    role: Role.PUBLIC,
    status: "ACTIVE",
  });

  await dispatchVerificationEmail(user);

  return { email, userId: String(user._id) };
}

export async function verifyEmailWithToken(input: VerifyEmailInput) {
  await connectToDatabase();

  let payload;

  try {
    payload = await verifyPurposeToken(input.token, "verify-email");
  } catch {
    throw new AuthServiceError(
      "Verification link is invalid or expired.",
      "VERIFICATION_TOKEN_INVALID",
      400,
    );
  }

  const user = await UserModel.findOne({ _id: payload.sub, isDeleted: { $ne: true } });

  if (!user) {
    throw new AuthServiceError("Account no longer exists.", "USER_INACTIVE", 401);
  }

  if (!user.emailVerified) {
    user.emailVerified = true;
    user.emailVerifiedAt ??= new Date();
    await user.save();
  }

  return { verified: true };
}

/** Always returns success — never reveals whether the email exists. */
export async function resendVerificationEmail(input: ResendVerificationInput) {
  await connectToDatabase();

  const email = normalizeEmail(input.email);
  const user = email
    ? await UserModel.findOne({ email, isDeleted: { $ne: true } })
    : null;

  if (user && !user.emailVerified && !user.emailVerifiedAt) {
    await dispatchVerificationEmail(user);
  }

  return { requested: true };
}

/**
 * Says plainly when no account uses the address. Hiding that bought nothing:
 * `/signup` already answers "An account already exists for this email", and
 * the route is rate limited. INVITED counts — an issued warden or guardian who
 * lost the temporary-password email is exactly who needs a reset, and matching
 * only ACTIVE skipped them while the screen still said "sent".
 */
export async function requestPasswordReset(input: ForgotPasswordInput) {
  await connectToDatabase();

  const email = normalizeEmail(input.email);
  const user = email
    ? await UserModel.findOne({ email, isDeleted: { $ne: true } })
    : null;

  if (!user?.email) {
    throw new AuthServiceError(
      "No HostelPalika account uses this email.",
      "ACCOUNT_NOT_FOUND",
      404,
    );
  }

  if (!CLAIMABLE_STATUSES.includes(user.get("status"))) {
    throw new AuthServiceError(
      "This account is switched off. Ask your hostel to turn it back on.",
      "USER_INACTIVE",
      403,
    );
  }

  const token = await signPurposeToken({
    userId: String(user._id),
    purpose: "password-reset",
    ttlSeconds: PASSWORD_RESET_TTL_MINUTES * 60,
    tokenVersion: user.tokenVersion ?? 0,
  });
  const resetUrl = `${appBaseUrl()}/reset-password?token=${encodeURIComponent(token)}`;
  const result = await sendEmail({
    to: user.email,
    ...passwordResetEmail({ resetUrl, expiresInMinutes: PASSWORD_RESET_TTL_MINUTES }),
  });

  if (!result.sent && result.reason === "send_failed") {
    throw new AuthServiceError(
      "We could not send the reset email. Try again in a minute.",
      "EMAIL_SEND_FAILED",
      502,
    );
  }

  return { requested: true };
}

export async function resetPasswordWithToken(input: ResetPasswordInput) {
  await connectToDatabase();

  let payload;

  try {
    payload = await verifyPurposeToken(input.token, "password-reset");
  } catch {
    throw new AuthServiceError(
      "Reset link is invalid or expired.",
      "RESET_TOKEN_INVALID",
      400,
    );
  }

  const user = await UserModel.findOne({
    _id: payload.sub,
    isDeleted: { $ne: true },
  }).select("+passwordHash");

  if (!user) {
    throw new AuthServiceError("Account no longer exists.", "USER_INACTIVE", 401);
  }

  if ((user.tokenVersion ?? 0) !== (payload.tokenVersion ?? 0)) {
    throw new AuthServiceError(
      "Reset link is no longer valid.",
      "RESET_TOKEN_STALE",
      400,
    );
  }

  user.passwordHash = await hashPassword(input.newPassword);
  user.mustChangePassword = false;
  user.tokenVersion = (user.tokenVersion ?? 0) + 1;
  await user.save();
  await revokeAllSessions(user._id);

  return { reset: true };
}

/**
 * Change password for the authenticated user. `currentPassword` is required
 * unless the account is flagged `mustChangePassword` (admin-issued temp
 * password, API.md §2). Revokes every session and issues a fresh one so the
 * caller stays logged in.
 */
export async function changePassword(
  userId: string,
  input: ChangePasswordInput,
  context?: RequestContext,
) {
  await connectToDatabase();

  const user = await UserModel.findOne({
    _id: userId,
    isDeleted: { $ne: true },
    status: "ACTIVE",
  }).select("+passwordHash");

  if (!user) {
    throw new AuthServiceError("User no longer has access.", "USER_INACTIVE", 401);
  }

  if (!user.mustChangePassword) {
    if (!input.currentPassword) {
      throw new AuthServiceError(
        "Current password is required.",
        "CURRENT_PASSWORD_REQUIRED",
        400,
      );
    }

    const currentMatches =
      user.passwordHash &&
      (await verifyPassword(input.currentPassword, user.passwordHash));

    if (!currentMatches) {
      throw new AuthServiceError(
        "Current password is incorrect.",
        "INVALID_CREDENTIALS",
        401,
      );
    }
  }

  user.passwordHash = await hashPassword(input.newPassword);
  user.mustChangePassword = false;
  user.tokenVersion = (user.tokenVersion ?? 0) + 1;
  await user.save();
  await revokeAllSessions(user._id);

  return issueSessionForUser(user, context);
}
