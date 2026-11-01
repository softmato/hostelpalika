import { Types } from "mongoose";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Role } from "@/lib/roles";

const mocks = vi.hoisted(() => ({
  connectToDatabase: vi.fn(),
  hostelFind: vi.fn(),
  memberFind: vi.fn(),
  verifyAccessToken: vi.fn(),
}));

vi.mock("@/lib/auth", async () => ({
  ...(await vi.importActual("@/lib/auth-cookies")),
  getBearerToken: (header: string | null) =>
    header?.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : null,
  verifyAccessToken: mocks.verifyAccessToken,
}));

vi.mock("@/lib/db", () => ({ connectToDatabase: mocks.connectToDatabase }));

vi.mock("@hostel/db/models/Hostel", () => ({
  HostelModel: { find: mocks.hostelFind },
}));

vi.mock("@hostel/db/models/HostelMember", () => ({
  HostelMemberModel: { find: mocks.memberFind },
}));

import { requireHostelCapability } from "@/lib/api-auth";
import { grantingPermissionKeys } from "@/lib/warden-capability";
import {
  DEFAULT_WARDEN_PERMISSIONS,
  WARDEN_PERMISSION_KEYS,
} from "@/modules/wardens/warden.validation";

const HOSTEL_A = "64f0f0f0f0f0f0f0f0f0f0a1";
const HOSTEL_B = "64f0f0f0f0f0f0f0f0f0f0a2";

function request() {
  return new NextRequest("https://hostelpalika.local/api/v1/hostel-admin/profile", {
    headers: { authorization: "Bearer token" },
  });
}

function signedInAs(role: Role, hostelIds: string[]) {
  mocks.verifyAccessToken.mockResolvedValue({
    hostelIds,
    role,
    sessionId: "session-1",
    sub: "64f0f0f0f0f0f0f0f0f0f0a4",
    tokenType: "access",
  });
}

/**
 * Which of the token's hostels still exist. Everything is live unless a test
 * says otherwise — archiving is the exception these cases are not about.
 */
function liveHostels(hostelIds?: string[]) {
  mocks.hostelFind.mockImplementation(
    (filter: { _id: { $in: Types.ObjectId[] } }) => ({
      lean: vi.fn().mockResolvedValue(
        filter._id.$in
          .map((id) => id.toString())
          .filter((id) => !hostelIds || hostelIds.includes(id))
          .map((id) => ({ _id: new Types.ObjectId(id) })),
      ),
      select: vi.fn().mockReturnThis(),
    }),
  );
}

function membershipsIn(hostelIds: string[]) {
  mocks.memberFind.mockReturnValue({
    lean: vi
      .fn()
      .mockResolvedValue(hostelIds.map((id) => ({ hostelId: new Types.ObjectId(id) }))),
    select: vi.fn().mockReturnThis(),
  });
}

describe("warden capability enforcement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    liveHostels();
  });

  /*
   * The bug this guards: a one-hostel owner whose duplicate registration was
   * archived still carried both ids in their token, and every screen treated
   * them as a multi-hostel account — nameless dashboard, claims refused, and
   * the billing page reading the archived hostel's invoices.
   */
  it("drops an archived hostel the token still carries", async () => {
    signedInAs(Role.HOSTEL_ADMIN, [HOSTEL_A, HOSTEL_B]);
    liveHostels([HOSTEL_B]);

    const principal = await requireHostelCapability(request(), "editHostelProfile");

    expect(principal.hostelIds).toEqual([HOSTEL_B]);
  });

  it("keeps a one-hostel owner a one-hostel owner after an archive", async () => {
    signedInAs(Role.HOSTEL_ADMIN, [HOSTEL_A, HOSTEL_B]);
    liveHostels([HOSTEL_A]);

    const principal = await requireHostelCapability(request(), "editHostelProfile");

    // Exactly one — which is what `resolveAdminHostelId` needs to pick it.
    expect(principal.hostelIds).toHaveLength(1);
  });

  it("lets a hostel admin through without consulting permissions", async () => {
    signedInAs(Role.HOSTEL_ADMIN, [HOSTEL_A]);

    const principal = await requireHostelCapability(request(), "editHostelProfile");

    expect(principal.role).toBe(Role.HOSTEL_ADMIN);
    expect(principal.hostelIds).toEqual([HOSTEL_A]);
    // Admins hold every capability implicitly — no lookup should happen.
    expect(mocks.memberFind).not.toHaveBeenCalled();
  });

  it("lets a warden through when the capability is granted", async () => {
    signedInAs(Role.WARDEN, [HOSTEL_A]);
    membershipsIn([HOSTEL_A]);

    const principal = await requireHostelCapability(request(), "manageFood");

    expect(principal.hostelIds).toEqual([HOSTEL_A]);
    expect(mocks.memberFind).toHaveBeenCalledWith(
      expect.objectContaining({
        permissions: { $in: ["manageFood"] },
        status: "ACTIVE",
      }),
    );
  });

  it("rejects a warden whose flag is unchecked", async () => {
    signedInAs(Role.WARDEN, [HOSTEL_A]);
    membershipsIn([]);

    await expect(
      requireHostelCapability(request(), "editHostelProfile"),
    ).rejects.toMatchObject({ errorCode: "CAPABILITY_DENIED", status: 403 });
  });

  it("narrows a multi-hostel warden to only the hostels granting the capability", async () => {
    signedInAs(Role.WARDEN, [HOSTEL_A, HOSTEL_B]);
    membershipsIn([HOSTEL_B]);

    const principal = await requireHostelCapability(request(), "approvePayments");

    // Services scope every query by principal.hostelIds, so dropping HOSTEL_A
    // here is what actually prevents the warden from touching it.
    expect(principal.hostelIds).toEqual([HOSTEL_B]);
  });

  it("still rejects a non-staff role before any permission lookup", async () => {
    signedInAs(Role.RESIDENT, [HOSTEL_A]);

    await expect(requireHostelCapability(request(), "manageFood")).rejects.toMatchObject({
      status: 403,
    });
    expect(mocks.memberFind).not.toHaveBeenCalled();
  });

  it("rejects an unauthenticated request", async () => {
    mocks.verifyAccessToken.mockRejectedValue(new Error("Invalid authentication token."));

    await expect(requireHostelCapability(request(), "manageFood")).rejects.toMatchObject({
      status: 401,
    });
  });

  it("does not read a database fault as signed out", async () => {
    mocks.verifyAccessToken.mockRejectedValue(new Error("mongo down"));

    await expect(requireHostelCapability(request(), "manageFood")).rejects.toThrow("mongo down");
  });
});

/**
 * Plan item 0.5 / target §13.4. `verifyPayments` was one flag over eight
 * operations, granted to every warden by default. The split has to hold two
 * properties at once: an unmigrated row keeps the access a warden should have
 * had, and does not keep the access that was never meant to travel with it.
 */
describe("payment capability split", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    liveHostels();
  });

  it.each(["viewPayments", "approvePayments", "recordCash"] as const)(
    "accepts the deprecated verifyPayments key for %s",
    async (capability) => {
      signedInAs(Role.WARDEN, [HOSTEL_A]);
      membershipsIn([HOSTEL_A]);

      await requireHostelCapability(request(), capability);

      expect(grantingPermissionKeys(capability)).toContain("verifyPayments");
      expect(mocks.memberFind).toHaveBeenCalledWith(
        expect.objectContaining({
          permissions: { $in: [capability, "verifyPayments"] },
        }),
      );
    },
  );

  // The point of the split: honouring the alias for these would preserve the
  // hole it closes.
  it.each(["reversePayments", "manageFeeSchedule", "managePaymentProfile"] as const)(
    "does not let verifyPayments stand in for %s",
    async (capability) => {
      signedInAs(Role.WARDEN, [HOSTEL_A]);
      membershipsIn([HOSTEL_A]);

      await requireHostelCapability(request(), capability);

      expect(grantingPermissionKeys(capability)).toEqual([capability]);
      expect(mocks.memberFind).toHaveBeenCalledWith(
        expect.objectContaining({ permissions: { $in: [capability] } }),
      );
    },
  );

  it("gives a new warden view, approve and cash but no reversal or rate-card powers", () => {
    expect(DEFAULT_WARDEN_PERMISSIONS).toEqual(
      expect.arrayContaining(["viewPayments", "approvePayments", "recordCash"]),
    );

    for (const restricted of [
      "reversePayments",
      "manageFeeSchedule",
      "managePaymentProfile",
    ]) {
      expect(DEFAULT_WARDEN_PERMISSIONS).not.toContain(restricted);
    }
  });

  it("no longer offers the retired key when granting permissions", () => {
    expect(WARDEN_PERMISSION_KEYS).not.toContain("verifyPayments");
    expect(DEFAULT_WARDEN_PERMISSIONS).not.toContain("verifyPayments");
  });
});
