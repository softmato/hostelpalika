import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Role } from "@/lib/roles";

const authMocks = vi.hoisted(() => ({
  hostelFind: vi.fn(),
  isTemporaryCredentialActive: vi.fn(),
  verifyAccessToken: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ connectToDatabase: vi.fn() }));

vi.mock("@hostel/db/models/Hostel", () => ({
  HostelModel: { find: authMocks.hostelFind },
}));

vi.mock("@/modules/auth/temporary-credential.service", () => ({
  isTemporaryCredentialActive: authMocks.isTemporaryCredentialActive,
}));

vi.mock("@/lib/auth", async () => ({
  ...(await vi.importActual("@/lib/auth-cookies")),
  getBearerToken: (authorizationHeader: string | null) =>
    authorizationHeader?.startsWith("Bearer ")
      ? authorizationHeader.slice("Bearer ".length).trim()
      : null,
  verifyAccessToken: authMocks.verifyAccessToken,
}));

import {
  assertHostelScopedApiAccess,
  assertPrimaryCredentialPrincipal,
  loadApiPrincipal,
  requireHostelAdminPrincipal,
  requireHostelStaffPrincipal,
  requirePlatformPrincipal,
  requireResidentPrincipal,
} from "@/lib/api-auth";

function bearerRequest() {
  return new NextRequest("https://hostelpalika.local/api/v1/protected", {
    headers: { authorization: "Bearer access-token" },
  });
}

describe("api auth guards", () => {
  beforeEach(() => {
    authMocks.verifyAccessToken.mockReset();
    authMocks.isTemporaryCredentialActive.mockReset();
  });

  it("loads a principal from a bearer access token", async () => {
    authMocks.verifyAccessToken.mockResolvedValue({
      hostelIds: ["hostel-1"],
      role: Role.HOSTEL_ADMIN,
      sessionId: "session-1",
      sub: "user-1",
      tokenType: "access",
    });

    const request = new NextRequest("https://hostelpalika.local/api/v1/protected", {
      headers: {
        authorization: "Bearer access-token",
      },
    });

    await expect(loadApiPrincipal(request)).resolves.toEqual({
      hostelIds: ["hostel-1"],
      role: Role.HOSTEL_ADMIN,
      sessionId: "session-1",
      userId: "user-1",
    });
  });

  it("rejects non-platform roles from platform-only API guards", async () => {
    authMocks.verifyAccessToken.mockResolvedValue({
      hostelIds: ["hostel-1"],
      role: Role.HOSTEL_ADMIN,
      sub: "user-1",
      tokenType: "access",
    });

    const request = new NextRequest("https://hostelpalika.local/api/v1/platform", {
      headers: {
        authorization: "Bearer access-token",
      },
    });

    await expect(requirePlatformPrincipal(request)).rejects.toMatchObject({
      errorCode: "FORBIDDEN",
      status: 403,
    });
  });

  it("enforces hostel-scoped tenant access", () => {
    expect(() =>
      assertHostelScopedApiAccess(
        {
          hostelIds: ["hostel-1"],
          role: Role.HOSTEL_ADMIN,
          userId: "user-1",
        },
        "hostel-1",
      ),
    ).not.toThrow();

    // 404 with a bare "Not found." — a 403 would confirm hostel-2 exists
    // (RULES.md §3).
    expect(() =>
      assertHostelScopedApiAccess(
        {
          hostelIds: ["hostel-1"],
          role: Role.HOSTEL_ADMIN,
          userId: "user-1",
        },
        "hostel-2",
      ),
    ).toThrow("Not found.");

    try {
      assertHostelScopedApiAccess(
        { hostelIds: ["hostel-1"], role: Role.HOSTEL_ADMIN, userId: "user-1" },
        "hostel-2",
      );
      expect.unreachable("cross-tenant access must throw");
    } catch (error) {
      expect(error).toMatchObject({ errorCode: "NOT_FOUND", status: 404 });
    }
  });

  describe("temporary credential sessions", () => {
    beforeEach(() => {
      authMocks.verifyAccessToken.mockResolvedValue({
        hostelIds: ["hostel-1"],
        role: Role.HOSTEL_ADMIN,
        sessionId: "session-1",
        sub: "user-1",
        temporaryCredentialId: "credential-1",
        tokenType: "access",
      });
    });

    it("carries the credential id onto the principal while it is live", async () => {
      authMocks.isTemporaryCredentialActive.mockResolvedValue(true);

      await expect(loadApiPrincipal(bearerRequest())).resolves.toMatchObject({
        temporaryCredentialId: "credential-1",
        userId: "user-1",
      });
    });

    it("refuses a signed token whose credential was revoked", async () => {
      // The access token is still cryptographically valid and unexpired — the
      // revocation has to be checked against the database or it would keep
      // working for the rest of its TTL.
      authMocks.isTemporaryCredentialActive.mockResolvedValue(false);

      await expect(loadApiPrincipal(bearerRequest())).resolves.toBeNull();
    });

    it("does not look up anything for an ordinary session", async () => {
      authMocks.verifyAccessToken.mockResolvedValue({
        hostelIds: ["hostel-1"],
        role: Role.HOSTEL_ADMIN,
        sub: "user-1",
        tokenType: "access",
      });

      await expect(loadApiPrincipal(bearerRequest())).resolves.toMatchObject({
        temporaryCredentialId: undefined,
      });
      expect(authMocks.isTemporaryCredentialActive).not.toHaveBeenCalled();
    });

    it("blocks account-level actions from a borrowed login", () => {
      expect(() =>
        assertPrimaryCredentialPrincipal({
          hostelIds: [],
          role: Role.RESIDENT,
          temporaryCredentialId: "credential-1",
          userId: "user-1",
        }),
      ).toThrow(/your own password/i);

      expect(() =>
        assertPrimaryCredentialPrincipal({
          hostelIds: [],
          role: Role.RESIDENT,
          userId: "user-1",
        }),
      ).not.toThrow();
    });
  });
});

describe("live-hostel narrowing", () => {
  const LIVE = "6600000000000000000000a1";
  const DELETED = "6600000000000000000000b2";

  function tokenFor(role: Role, hostelIds: string[]) {
    authMocks.verifyAccessToken.mockResolvedValue({
      hostelIds,
      role,
      sub: "user-1",
      tokenType: "access",
    });
  }

  function hostelRows(rows: Array<{ id: string; suspended?: boolean }>) {
    authMocks.hostelFind.mockReturnValue({
      select: () => ({
        lean: async () =>
          rows.map(({ id, suspended }) => ({
            _id: { toString: () => id },
            suspension: suspended
              ? { graceEndsAt: new Date(Date.now() - 1000), startedAt: new Date(0) }
              : null,
          })),
      }),
    });
  }

  beforeEach(() => {
    authMocks.hostelFind.mockReset();
  });

  it("drops a deleted hostel for the admin-only guard too", async () => {
    tokenFor(Role.HOSTEL_ADMIN, [DELETED, LIVE]);
    // The query excludes deleted hostels, so only the live one comes back.
    hostelRows([{ id: LIVE }]);

    await expect(requireHostelAdminPrincipal(bearerRequest())).resolves.toMatchObject({
      hostelIds: [LIVE],
    });
  });

  it("answers deleted and suspended in one read per staff request", async () => {
    tokenFor(Role.WARDEN, [LIVE]);
    hostelRows([{ id: LIVE }]);

    await requireHostelStaffPrincipal(bearerRequest());

    expect(authMocks.hostelFind).toHaveBeenCalledOnce();
  });

  it("works in the one hostel the switcher names, and keeps the rest for the switcher", async () => {
    const BRANCH = "6600000000000000000000c3";
    tokenFor(Role.HOSTEL_ADMIN, [LIVE, BRANCH]);
    hostelRows([{ id: LIVE }, { id: BRANCH }]);

    const request = new NextRequest("https://hostelpalika.local/api/v1/protected", {
      headers: { authorization: "Bearer access-token", "x-hostel-id": BRANCH },
    });

    await expect(requireHostelAdminPrincipal(request)).resolves.toMatchObject({
      allHostelIds: [LIVE, BRANCH],
      hostelIds: [BRANCH],
    });
  });

  it("falls back to the first hostel without a header, and ignores one the caller does not hold", async () => {
    const BRANCH = "6600000000000000000000c3";
    tokenFor(Role.HOSTEL_ADMIN, [LIVE, BRANCH]);
    hostelRows([{ id: LIVE }, { id: BRANCH }]);

    await expect(requireHostelAdminPrincipal(bearerRequest())).resolves.toMatchObject({
      hostelIds: [LIVE],
    });

    const stranger = new NextRequest("https://hostelpalika.local/api/v1/protected", {
      headers: { authorization: "Bearer access-token", "x-hostel-id": DELETED },
    });

    await expect(requireHostelAdminPrincipal(stranger)).resolves.toMatchObject({
      hostelIds: [LIVE],
    });
  });

  it("refuses with 423 when every hostel is suspended", async () => {
    tokenFor(Role.RESIDENT, [LIVE]);
    hostelRows([{ id: LIVE, suspended: true }]);

    await expect(requireResidentPrincipal(bearerRequest())).rejects.toMatchObject({
      errorCode: "HOSTEL_SUSPENDED",
      status: 423,
    });
  });
});
