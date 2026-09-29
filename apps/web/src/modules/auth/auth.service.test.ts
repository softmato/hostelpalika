import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Role } from "@/lib/roles";

const serviceMocks = vi.hoisted(() => ({
  connectToDatabase: vi.fn(),
  hashPassword: vi.fn(),
  hashToken: vi.fn((token: string) => `hash:${token}`),
  refreshTokenExpiresAt: vi.fn(() => new Date("2030-01-01T00:00:00.000Z")),
  sendEmail: vi.fn(),
  sessionFindOne: vi.fn(),
  sessionInstances: [] as Array<Record<string, unknown>>,
  sessionSave: vi.fn(),
  sessionUpdateMany: vi.fn(),
  sessionUpdateOne: vi.fn(),
  residentExists: vi.fn(),
  serviceProviderExists: vi.fn(),
  signAccessToken: vi.fn(),
  signPurposeToken: vi.fn(),
  signRefreshToken: vi.fn(),
  authenticateTemporaryCredential: vi.fn(),
  isTemporaryCredentialActive: vi.fn(),
  jwtVerify: vi.fn(),
  oauthAccountCreate: vi.fn(),
  oauthAccountFindOne: vi.fn(),
  otpExists: vi.fn(),
  otpFindOneAndUpdate: vi.fn(),
  userCreate: vi.fn(),
  userFindOne: vi.fn(),
  userUpdateOne: vi.fn(),
  verifyAccessToken: vi.fn(),
  verifyPassword: vi.fn(),
  verifyPurposeToken: vi.fn(),
  verifyRefreshToken: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  connectToDatabase: serviceMocks.connectToDatabase,
}));

vi.mock("@/lib/password", () => ({
  hashPassword: serviceMocks.hashPassword,
  verifyPassword: serviceMocks.verifyPassword,
}));

vi.mock("@/lib/auth", () => ({
  hashToken: serviceMocks.hashToken,
  refreshTokenExpiresAt: serviceMocks.refreshTokenExpiresAt,
  signAccessToken: serviceMocks.signAccessToken,
  signPurposeToken: serviceMocks.signPurposeToken,
  signRefreshToken: serviceMocks.signRefreshToken,
  verifyAccessToken: serviceMocks.verifyAccessToken,
  verifyPurposeToken: serviceMocks.verifyPurposeToken,
  verifyRefreshToken: serviceMocks.verifyRefreshToken,
}));

vi.mock("@hostel/db/models/Session", () => {
  class MockSessionModel {
    static findOne = serviceMocks.sessionFindOne;
    static updateMany = serviceMocks.sessionUpdateMany;
    static updateOne = serviceMocks.sessionUpdateOne;

    _id = `session-${serviceMocks.sessionInstances.length + 1}`;
    refreshTokenHash: string | undefined;
    save = serviceMocks.sessionSave;

    constructor(data: Record<string, unknown>) {
      Object.assign(this, data);
      serviceMocks.sessionInstances.push(this as unknown as Record<string, unknown>);
    }
  }

  return { SessionModel: MockSessionModel };
});

vi.mock("@hostel/db/models/User", () => ({
  UserModel: {
    create: serviceMocks.userCreate,
    findOne: serviceMocks.userFindOne,
    updateOne: serviceMocks.userUpdateOne,
  },
}));

vi.mock("@hostel/db/models/Resident", () => ({
  ResidentModel: { exists: serviceMocks.residentExists },
}));

vi.mock("@hostel/db/models/ServiceProvider", () => ({
  ServiceProviderModel: { exists: serviceMocks.serviceProviderExists },
}));

vi.mock("@hostel/db/models/OAuthAccount", () => ({
  OAuthAccountModel: {
    create: serviceMocks.oauthAccountCreate,
    findOne: serviceMocks.oauthAccountFindOne,
  },
}));

// `createRemoteJWKSet` runs at module load, so it has to answer with something
// before any test does. Nothing reads the key set — `jwtVerify` is the mock the
// tests drive.
vi.mock("jose", () => ({
  createRemoteJWKSet: vi.fn(() => "jwks"),
  jwtVerify: serviceMocks.jwtVerify,
}));

vi.mock("@hostel/db/models/OtpChallenge", () => ({
  OtpChallengeModel: {
    exists: serviceMocks.otpExists,
    findOneAndUpdate: serviceMocks.otpFindOneAndUpdate,
  },
}));

vi.mock("@hostel/shared/email/sender", () => ({
  sendEmail: serviceMocks.sendEmail,
}));

vi.mock("@/modules/auth/temporary-credential.service", () => ({
  authenticateTemporaryCredential: serviceMocks.authenticateTemporaryCredential,
  isTemporaryCredentialActive: serviceMocks.isTemporaryCredentialActive,
}));

import {
  authenticateWithGoogle,
  getCurrentUser,
  login,
  logout,
  refreshAccessToken,
  requestPasswordReset,
  verifyOtpChallenge,
} from "@/modules/auth/auth.service";

function createUser(overrides: Record<string, unknown> = {}) {
  return {
    _id: "user-1",
    email: "owner@example.com",
    emailVerified: true,
    emailVerifiedAt: new Date("2026-01-01T00:00:00.000Z"),
    hostelIds: [],
    name: "Platform Owner",
    passwordHash: "password-hash",
    phone: null,
    role: Role.SUPERADMIN,
    save: vi.fn(),
    status: "ACTIVE",
    ...overrides,
  };
}

/**
 * A stand-in for a mongoose document. `authenticateWithGoogle` reads and writes
 * through `.get`/`.set` while `publicUser` reads the plain properties, and a
 * real document is both — a double that is only one of them passes for the
 * wrong reason.
 */
function createUserDoc(overrides: Record<string, unknown> = {}) {
  const doc = createUser(overrides) as Record<string, unknown>;

  doc.get = (key: string) => doc[key];
  doc.set = (key: string, value: unknown) => {
    doc[key] = value;
  };

  return doc;
}

function createSession(overrides: Record<string, unknown> = {}) {
  return {
    _id: "session-1",
    refreshTokenHash: "pending",
    // Declared so a test can assert the service revoked the row in place, the
    // way the real mongoose document would let it.
    revokedAt: null as Date | null,
    save: vi.fn(),
    ...overrides,
  };
}

describe("auth service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serviceMocks.sessionInstances.length = 0;
    serviceMocks.signAccessToken.mockResolvedValue("access-token");
    serviceMocks.signRefreshToken.mockResolvedValue("refresh-token");
    // `clearAllMocks` keeps implementations, so an approved listing from one
    // test would otherwise answer the next one's query.
    serviceMocks.serviceProviderExists.mockResolvedValue(null);
    serviceMocks.residentExists.mockResolvedValue({ _id: "resident-1" });
    serviceMocks.sessionUpdateOne.mockResolvedValue({ modifiedCount: 1 });
  });

  it("logs in a valid user and creates a hashed refresh session", async () => {
    const user = createUser();

    serviceMocks.userFindOne.mockReturnValueOnce({
      select: vi.fn().mockResolvedValue(user),
    });
    serviceMocks.verifyPassword.mockResolvedValue(true);

    await expect(
      login({ identifier: "owner@example.com", password: "ChangeMe123!" }),
    ).resolves.toMatchObject({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      user: {
        email: "owner@example.com",
        role: Role.SUPERADMIN,
      },
    });

    const session = serviceMocks.sessionInstances.at(-1);

    expect(session?.refreshTokenHash).toBe("hash:refresh-token");
    expect(serviceMocks.sessionSave).toHaveBeenCalled();
    expect(serviceMocks.userUpdateOne).toHaveBeenCalledWith(
      { _id: expect.anything() },
      { $set: { lastLoginAt: expect.any(Date) } },
    );
  });

  it("blocks login when the email is not verified", async () => {
    const user = createUser({ emailVerified: false, emailVerifiedAt: undefined });

    serviceMocks.userFindOne.mockReturnValueOnce({
      select: vi.fn().mockResolvedValue(user),
    });
    serviceMocks.verifyPassword.mockResolvedValue(true);

    await expect(
      login({ identifier: "owner@example.com", password: "ChangeMe123!" }),
    ).rejects.toMatchObject({
      errorCode: "EMAIL_NOT_VERIFIED",
      status: 403,
    });
  });

  it("rejects a wrong password", async () => {
    serviceMocks.userFindOne.mockReturnValueOnce({
      select: vi.fn().mockResolvedValue(createUser()),
    });
    serviceMocks.verifyPassword.mockResolvedValue(false);

    await expect(
      login({ identifier: "owner@example.com", password: "wrong-password" }),
    ).rejects.toMatchObject({
      errorCode: "INVALID_CREDENTIALS",
    });
  });

  it("rotates refresh tokens when refreshing an access token", async () => {
    const session = createSession({ refreshTokenHash: "hash:old-refresh-token" });

    serviceMocks.verifyRefreshToken.mockResolvedValue({
      role: Role.SUPERADMIN,
      sessionId: "session-1",
      sub: "user-1",
      tokenType: "refresh",
    });
    serviceMocks.sessionFindOne.mockResolvedValue(session);
    serviceMocks.userFindOne.mockResolvedValue(createUser());
    serviceMocks.signAccessToken.mockResolvedValue("next-access-token");
    serviceMocks.signRefreshToken.mockResolvedValue("next-refresh-token");

    await expect(refreshAccessToken("old-refresh-token")).resolves.toMatchObject({
      accessToken: "next-access-token",
      refreshToken: "next-refresh-token",
    });
    expect(serviceMocks.sessionUpdateOne).toHaveBeenCalledWith(
      { _id: session._id, refreshTokenHash: "hash:old-refresh-token" },
      {
        $set: expect.objectContaining({
          previousRefreshTokenHash: "hash:old-refresh-token",
          refreshTokenHash: "hash:next-refresh-token",
        }),
      },
    );
  });

  function rotatedSession(rotatedMsAgo: number) {
    return createSession({
      previousRefreshTokenHash: "hash:old-refresh-token",
      refreshTokenHash: "hash:newer-refresh-token",
      refreshTokenRotatedAt: new Date(Date.now() - rotatedMsAgo),
    });
  }

  function refreshAs() {
    serviceMocks.verifyRefreshToken.mockResolvedValue({
      role: Role.SUPERADMIN,
      sessionId: "session-1",
      sub: "user-1",
      tokenType: "refresh",
    });
    serviceMocks.userFindOne.mockResolvedValue(createUser());
    serviceMocks.signAccessToken.mockResolvedValue("next-access-token");
  }

  it("lets a browser reuse a just-rotated token for an access token only", async () => {
    refreshAs();
    serviceMocks.sessionFindOne.mockResolvedValue(rotatedSession(5_000));

    await expect(
      refreshAccessToken("old-refresh-token", { cookieSession: true }),
    ).resolves.toMatchObject({ accessToken: "next-access-token", refreshToken: null });
  });

  it("gives the phone a fresh token when the reply to its rotation was lost", async () => {
    refreshAs();
    serviceMocks.sessionFindOne.mockResolvedValue(rotatedSession(5_000));

    await expect(refreshAccessToken("old-refresh-token")).resolves.toMatchObject({
      refreshToken: "refresh-token",
    });
    // Re-issued from the token it lost, inside the window it started.
    expect(serviceMocks.sessionUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        previousRefreshTokenHash: "hash:old-refresh-token",
        refreshTokenRotatedAt: { $gt: expect.any(Date) },
      }),
      { $set: expect.objectContaining({ refreshTokenHash: "hash:refresh-token" }) },
    );
  });

  it("ends the session when a token rotated away long ago is replayed", async () => {
    refreshAs();
    serviceMocks.sessionFindOne.mockResolvedValue(rotatedSession(10 * 60_000));

    await expect(
      refreshAccessToken("old-refresh-token", { cookieSession: true }),
    ).rejects.toMatchObject({ errorCode: "INVALID_SESSION" });
    expect(serviceMocks.sessionUpdateOne).toHaveBeenCalledWith(
      { _id: "session-1", revokedAt: null },
      { $set: { revokedAt: expect.any(Date) } },
    );
    expect(serviceMocks.signRefreshToken).not.toHaveBeenCalled();
  });

  it("does not hand out a rotated token when a concurrent refresh won", async () => {
    const session = createSession({ refreshTokenHash: "hash:old-refresh-token" });

    serviceMocks.verifyRefreshToken.mockResolvedValue({
      role: Role.SUPERADMIN,
      sessionId: "session-1",
      sub: "user-1",
      tokenType: "refresh",
    });
    serviceMocks.sessionFindOne.mockResolvedValue(session);
    serviceMocks.userFindOne.mockResolvedValue(createUser());
    serviceMocks.sessionUpdateOne.mockResolvedValue({ modifiedCount: 0 });

    await expect(
      refreshAccessToken("old-refresh-token", { cookieSession: true }),
    ).resolves.toMatchObject({ refreshToken: null });
  });

  it("revokes a refresh session on logout", async () => {
    await logout("refresh-token");

    expect(serviceMocks.sessionUpdateOne).toHaveBeenCalledWith(
      { refreshTokenHash: "hash:refresh-token", revokedAt: null },
      { $set: { revokedAt: expect.any(Date) } },
    );
  });

  describe("temporary access logins", () => {
    it("signs an identifier without an @ into the owner's own account", async () => {
      const owner = createUser();

      serviceMocks.authenticateTemporaryCredential.mockResolvedValue({
        credentialId: "credential-1",
        owner,
      });

      await expect(
        login({ identifier: "accountant-oct", password: "issued-password" }),
      ).resolves.toMatchObject({
        user: {
          // The very point of the feature: same account, same role.
          email: "owner@example.com",
          role: Role.SUPERADMIN,
          viaTemporaryCredential: true,
        },
      });

      // Never touched the users table on this path — the credential resolved it.
      expect(serviceMocks.userFindOne).not.toHaveBeenCalled();

      const session = serviceMocks.sessionInstances.at(-1);

      // Stamped on the session so revoking the credential can reach it, and on
      // the tokens so the API can refuse account-level actions.
      expect(session?.temporaryCredentialId).toBe("credential-1");
      expect(serviceMocks.signAccessToken).toHaveBeenCalledWith(
        expect.objectContaining({ temporaryCredentialId: "credential-1" }),
      );
    });

    it("rejects an unknown or expired temporary username as plain bad credentials", async () => {
      serviceMocks.authenticateTemporaryCredential.mockResolvedValue(null);

      await expect(
        login({ identifier: "revoked-login", password: "issued-password" }),
      ).rejects.toMatchObject({ errorCode: "INVALID_CREDENTIALS" });
    });

    it("does not retry a failed email login as a temporary username", async () => {
      serviceMocks.userFindOne.mockReturnValueOnce({
        select: vi.fn().mockResolvedValue(null),
      });

      await expect(
        login({ identifier: "owner@example.com", password: "wrong" }),
      ).rejects.toMatchObject({ errorCode: "INVALID_CREDENTIALS" });

      expect(serviceMocks.authenticateTemporaryCredential).not.toHaveBeenCalled();
    });

    it("marks an ordinary password login as not temporary", async () => {
      serviceMocks.userFindOne.mockReturnValueOnce({
        select: vi.fn().mockResolvedValue(createUser()),
      });
      serviceMocks.verifyPassword.mockResolvedValue(true);

      await expect(
        login({ identifier: "owner@example.com", password: "ChangeMe123!" }),
      ).resolves.toMatchObject({ user: { viaTemporaryCredential: false } });

      expect(serviceMocks.sessionInstances.at(-1)?.temporaryCredentialId).toBeNull();
    });

    it("re-authorises a borrowed session on every refresh", async () => {
      const session = createSession({
        refreshTokenHash: "hash:old-refresh-token",
        temporaryCredentialId: "credential-1",
      });

      serviceMocks.verifyRefreshToken.mockResolvedValue({
        role: Role.SUPERADMIN,
        sessionId: "session-1",
        sub: "user-1",
        tokenType: "refresh",
      });
      serviceMocks.sessionFindOne.mockResolvedValue(session);
      serviceMocks.userFindOne.mockResolvedValue(createUser());
      serviceMocks.isTemporaryCredentialActive.mockResolvedValue(true);

      await expect(refreshAccessToken("old-refresh-token")).resolves.toMatchObject({
        user: { viaTemporaryCredential: true },
      });
      expect(serviceMocks.isTemporaryCredentialActive).toHaveBeenCalledWith(
        "credential-1",
      );
    });

    it("kills the session when the credential behind it was revoked", async () => {
      const session = createSession({
        refreshTokenHash: "hash:old-refresh-token",
        temporaryCredentialId: "credential-1",
      });

      serviceMocks.verifyRefreshToken.mockResolvedValue({
        role: Role.SUPERADMIN,
        sessionId: "session-1",
        sub: "user-1",
        tokenType: "refresh",
      });
      serviceMocks.sessionFindOne.mockResolvedValue(session);
      serviceMocks.userFindOne.mockResolvedValue(createUser());
      serviceMocks.isTemporaryCredentialActive.mockResolvedValue(false);

      await expect(refreshAccessToken("old-refresh-token")).rejects.toMatchObject({
        errorCode: "TEMPORARY_CREDENTIAL_INVALID",
      });
      // Otherwise the holder could keep minting 30-day refresh tokens forever.
      expect(session.revokedAt).toBeInstanceOf(Date);
      expect(serviceMocks.signRefreshToken).not.toHaveBeenCalled();
    });

    it("stops reporting a signed-in user once the credential is revoked", async () => {
      serviceMocks.verifyAccessToken.mockResolvedValue({
        role: Role.SUPERADMIN,
        sub: "user-1",
        temporaryCredentialId: "credential-1",
        tokenType: "access",
      });
      serviceMocks.isTemporaryCredentialActive.mockResolvedValue(false);

      // Otherwise the portal shell keeps rendering for a revoked holder until
      // the access token expires, while every data call under it 401s.
      await expect(getCurrentUser("access-token")).rejects.toMatchObject({
        errorCode: "TEMPORARY_CREDENTIAL_INVALID",
      });
      expect(serviceMocks.userFindOne).not.toHaveBeenCalled();
    });

    it("leaves an ordinary session's refresh free of a credential check", async () => {
      const session = createSession({ refreshTokenHash: "hash:old-refresh-token" });

      serviceMocks.verifyRefreshToken.mockResolvedValue({
        role: Role.SUPERADMIN,
        sessionId: "session-1",
        sub: "user-1",
        tokenType: "refresh",
      });
      serviceMocks.sessionFindOne.mockResolvedValue(session);
      serviceMocks.userFindOne.mockResolvedValue(createUser());

      await expect(refreshAccessToken("old-refresh-token")).resolves.toMatchObject({
        user: { viaTemporaryCredential: false },
      });
      expect(serviceMocks.isTemporaryCredentialActive).not.toHaveBeenCalled();
    });
  });

  describe("google sign-in", () => {
    beforeEach(() => {
      vi.stubEnv("GOOGLE_CLIENT_ID", "google-client-id");
      serviceMocks.jwtVerify.mockResolvedValue({
        payload: {
          email: "cook@example.com",
          email_verified: true,
          name: "Hostel Cook",
          sub: "google-subject-1",
        },
      });
      serviceMocks.oauthAccountFindOne.mockResolvedValue(null);
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("matches an account that has been invited but never signed in", async () => {
      const cook = createUserDoc({
        email: "cook@example.com",
        mustChangePassword: true,
        role: Role.COOK,
        status: "INVITED",
      });

      serviceMocks.userFindOne.mockResolvedValue(cook);

      await authenticateWithGoogle({ idToken: "id-token" });

      /*
       * Matching only ACTIVE sent an INVITED cook into `UserModel.create` with
       * an email the unique index already holds — a duplicate-key 500, not a
       * signup.
       */
      expect(serviceMocks.userFindOne).toHaveBeenCalledWith(
        expect.objectContaining({ status: { $in: ["ACTIVE", "INVITED"] } }),
      );
      expect(serviceMocks.userCreate).not.toHaveBeenCalled();
      expect(cook.status).toBe("ACTIVE");
    });

    it("leaves the warden-issued password on the account it belongs to", async () => {
      const cook = createUserDoc({
        email: "cook@example.com",
        mustChangePassword: true,
        role: Role.COOK,
        status: "INVITED",
      });

      serviceMocks.userFindOne.mockResolvedValue(cook);

      await authenticateWithGoogle({ idToken: "id-token" });

      /*
       * A kitchen's username and password are issued by its warden and shared
       * by the people who use them, so signing in with Google on the same
       * address must not quietly retire the pair they have written down — and
       * must not revoke the sessions already open on it.
       */
      // The only write is the sign-in stamp; no password or session change.
      for (const [, update] of serviceMocks.userUpdateOne.mock.calls) {
        expect(Object.keys(update.$set ?? {})).toEqual(["lastLoginAt"]);
        expect(update.$unset).toBeUndefined();
      }
      expect(serviceMocks.sessionUpdateMany).not.toHaveBeenCalled();
      expect(cook.mustChangePassword).toBe(true);
    });
  });

  /**
   * A tab whose token predates a promotion is the whole reason registering
   * somebody appeared not to work: `promoteAccountToResident` raises the account
   * in the database, every API route authorises from the token, and nothing on
   * the public site 401s or 403s hard enough to make the browser refresh. So the
   * answer to "who is signed in?" has to carry the mismatch itself.
   */
  describe("stale sessions", () => {
    beforeEach(() => {
      serviceMocks.isTemporaryCredentialActive.mockResolvedValue(true);
    });

    it("reports a token whose role the account has outgrown", async () => {
      serviceMocks.verifyAccessToken.mockResolvedValue({
        hostelIds: [],
        role: Role.PUBLIC,
        sub: "user-1",
        tokenType: "access",
      });
      serviceMocks.userFindOne.mockResolvedValue(
        createUser({ hostelIds: [], role: Role.RESIDENT }),
      );

      await expect(getCurrentUser("access-token")).resolves.toMatchObject({
        role: Role.RESIDENT,
        sessionStale: true,
      });
    });

    it("reports a hostel the token does not carry yet", async () => {
      // A resident registered at a second hostel keeps their role and gains a
      // hostelId that every tenant guard reads off the token.
      serviceMocks.verifyAccessToken.mockResolvedValue({
        hostelIds: ["hostel-1"],
        role: Role.RESIDENT,
        sub: "user-1",
        tokenType: "access",
      });
      serviceMocks.userFindOne.mockResolvedValue(
        createUser({ hostelIds: ["hostel-1", "hostel-2"], role: Role.RESIDENT }),
      );

      await expect(getCurrentUser("access-token")).resolves.toMatchObject({
        sessionStale: true,
      });
    });

    it("leaves an up-to-date session alone", async () => {
      // Otherwise every /me call would rotate the refresh token, and two tabs
      // racing that is how a session dies.
      serviceMocks.verifyAccessToken.mockResolvedValue({
        hostelIds: ["hostel-1"],
        role: Role.RESIDENT,
        sub: "user-1",
        tokenType: "access",
      });
      serviceMocks.userFindOne.mockResolvedValue(
        createUser({ hostelIds: ["hostel-1"], role: Role.RESIDENT }),
      );

      await expect(getCurrentUser("access-token")).resolves.toMatchObject({
        sessionStale: false,
      });
    });
  });

  /**
   * There is no SERVICE_PROVIDER role, so this flag is the only thing that tells
   * a client which shell a PUBLIC account belongs in. Sign-ins used to leave it
   * out, and the phone routed approved providers into the browsing app until
   * the next resume moved them.
   */
  describe("service-provider flag", () => {
    function signInAs(user: Record<string, unknown>) {
      serviceMocks.userFindOne.mockReturnValueOnce({
        select: vi.fn().mockResolvedValue(user),
      });
      serviceMocks.verifyPassword.mockResolvedValue(true);

      return login({ identifier: "owner@example.com", password: "ChangeMe123!" });
    }

    it("tells a sign-in it is an approved provider", async () => {
      serviceMocks.serviceProviderExists.mockResolvedValue({ _id: "provider-1" });

      await expect(signInAs(createUser({ role: Role.PUBLIC }))).resolves.toMatchObject({
        user: { isServiceProvider: true },
      });
      expect(serviceMocks.serviceProviderExists).toHaveBeenCalledWith({
        isDeleted: false,
        status: "APPROVED",
        userId: "user-1",
      });
    });

    it("says false, not nothing, for a public account without an approved listing", async () => {
      await expect(signInAs(createUser({ role: Role.PUBLIC }))).resolves.toMatchObject({
        user: { isServiceProvider: false },
      });
    });

    it("does not look for a listing on any other role", async () => {
      await expect(signInAs(createUser({ role: Role.RESIDENT }))).resolves.toMatchObject({
        user: { isServiceProvider: false },
      });
      expect(serviceMocks.serviceProviderExists).not.toHaveBeenCalled();
    });

    it("hands a resident who lives nowhere back a public account", async () => {
      serviceMocks.residentExists.mockResolvedValue(null);

      await expect(signInAs(createUser({ role: Role.RESIDENT }))).resolves.toMatchObject({
        user: { hostelIds: [], role: Role.PUBLIC },
      });
      expect(serviceMocks.userUpdateOne).toHaveBeenCalledWith(
        { _id: "user-1", role: Role.RESIDENT },
        { $set: { hostelIds: [], role: Role.PUBLIC } },
      );
    });

    it("answers a refresh and /me the same way a sign-in does", async () => {
      serviceMocks.serviceProviderExists.mockResolvedValue({ _id: "provider-1" });
      serviceMocks.userFindOne.mockResolvedValue(createUser({ role: Role.PUBLIC }));
      serviceMocks.sessionFindOne.mockResolvedValue(
        createSession({ refreshTokenHash: "hash:refresh-token" }),
      );
      serviceMocks.verifyRefreshToken.mockResolvedValue({
        role: Role.PUBLIC,
        sessionId: "session-1",
        sub: "user-1",
        tokenType: "refresh",
      });
      serviceMocks.verifyAccessToken.mockResolvedValue({
        hostelIds: [],
        role: Role.PUBLIC,
        sub: "user-1",
        tokenType: "access",
      });

      await expect(refreshAccessToken("refresh-token")).resolves.toMatchObject({
        user: { isServiceProvider: true },
      });
      await expect(getCurrentUser("access-token")).resolves.toMatchObject({
        isServiceProvider: true,
      });
    });
  });

  describe("requestPasswordReset", () => {
    it("mails an INVITED account that has not signed in yet", async () => {
      serviceMocks.userFindOne.mockResolvedValue(
        createUserDoc({ email: "demo.guardian@softmato.com", status: "INVITED" }),
      );
      serviceMocks.signPurposeToken.mockResolvedValue("reset-token");
      serviceMocks.sendEmail.mockResolvedValue({ sent: true, id: "email-1" });

      await expect(
        requestPasswordReset({ email: "demo.guardian@softmato.com" }),
      ).resolves.toEqual({ requested: true });
      expect(serviceMocks.sendEmail).toHaveBeenCalledWith(
        expect.objectContaining({ to: "demo.guardian@softmato.com" }),
      );
    });

    it("says so when no account uses the email", async () => {
      serviceMocks.userFindOne.mockResolvedValue(null);

      await expect(
        requestPasswordReset({ email: "nobody@softmato.com" }),
      ).rejects.toMatchObject({ errorCode: "ACCOUNT_NOT_FOUND", status: 404 });
      expect(serviceMocks.sendEmail).not.toHaveBeenCalled();
    });

    it("reports a refused send instead of claiming it went", async () => {
      serviceMocks.userFindOne.mockResolvedValue(createUserDoc());
      serviceMocks.signPurposeToken.mockResolvedValue("reset-token");
      serviceMocks.sendEmail.mockResolvedValue({ sent: false, reason: "send_failed" });

      await expect(
        requestPasswordReset({ email: "owner@example.com" }),
      ).rejects.toMatchObject({ errorCode: "EMAIL_SEND_FAILED", status: 502 });
    });
  });
});

describe("verifyOtpChallenge", () => {
  it("spends the attempt in one atomic write before comparing the code", async () => {
    serviceMocks.otpExists.mockResolvedValue({ _id: "challenge-1" });
    // Five already spent: the guarded update matches nothing.
    serviceMocks.otpFindOneAndUpdate.mockReturnValue({ select: () => Promise.resolve(null) });

    await expect(
      verifyOtpChallenge({ challengeId: "challenge-1", code: "123456" }),
    ).rejects.toMatchObject({ errorCode: "OTP_ATTEMPT_LIMIT", status: 429 });
    expect(serviceMocks.otpFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ _id: "challenge-1", attempts: { $lt: 5 } }),
      { $inc: { attempts: 1 } },
      { new: true },
    );
  });
});
