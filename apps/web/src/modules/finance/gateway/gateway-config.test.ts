/**
 * Gateway configuration — Block 6 item 6.1 of
 * docs/FINANCE_IMPLEMENTATION_PLAN.md (target §11.8, §6.7).
 *
 * This is the screen where an owner can misdirect their residents' money, so
 * most of what follows is about refusing to switch something on: a personal
 * wallet that would silently cap out mid-month, a live entry with no signing
 * key behind it, an entry with no merchant code. The rest is about the secret —
 * that it is written to `EncryptedSecret` and never travels back out.
 */
import { Types } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiPrincipal } from "@/lib/api-auth";
import { Role } from "@/lib/roles";

const hostelId = new Types.ObjectId("64f0f0f0f0f0f0f0f0f0f0a1");

const mocks = vi.hoisted(() => ({
  audit: vi.fn(),
  describeSecret: vi.fn(),
  profileFindOne: vi.fn(),
  profileUpdateOne: vi.fn(),
  putSecret: vi.fn(),
  secretDeleteMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ connectToDatabase: vi.fn() }));
vi.mock("@/modules/finance/audit-finance", () => ({ auditFinanceAction: mocks.audit }));
vi.mock("@/modules/finance/gateway/secret-store", async () => {
  const actual = await vi.importActual<
    typeof import("@/modules/finance/gateway/secret-store")
  >("@/modules/finance/gateway/secret-store");

  return {
    ...actual,
    describeSecret: mocks.describeSecret,
    putSecret: mocks.putSecret,
  };
});
vi.mock("@hostel/db/models/EncryptedSecret", () => ({
  EncryptedSecretModel: { deleteMany: mocks.secretDeleteMany },
}));
vi.mock("@hostel/db/models/HostelPaymentProfile", async () => {
  const actual = await vi.importActual<
    typeof import("@hostel/db/models/HostelPaymentProfile")
  >("@hostel/db/models/HostelPaymentProfile");

  return {
    ...actual,
    HostelPaymentProfileModel: {
      findOne: mocks.profileFindOne,
      updateOne: mocks.profileUpdateOne,
    },
  };
});

const { deleteGatewayConfig, listGatewayConfigs, saveGatewayConfig } = await import(
  "./gateway-config.service"
);

const principal = {
  hostelIds: [hostelId.toString()],
  role: Role.HOSTEL_ADMIN,
  userId: "64f0f0f0f0f0f0f0f0f0f0b1",
} as ApiPrincipal;

const SECRET = "esewa_live_9f3c1a7e2b8d4056";

function chain<T>(value: T) {
  return { lean: vi.fn().mockResolvedValue(value), select: vi.fn().mockReturnThis() };
}

/** No secret stored, which is where every hostel starts. */
const noSecret = { configured: false, fingerprint: null, rotatedAt: null, updatedAt: null };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NODE_ENV", "development");
  mocks.profileFindOne.mockReturnValue(chain(null));
  mocks.profileUpdateOne.mockResolvedValue({ matchedCount: 0, modifiedCount: 0 });
  mocks.describeSecret.mockResolvedValue(noSecret);
  mocks.putSecret.mockResolvedValue({ fingerprint: "abc123def456" });
  mocks.audit.mockResolvedValue(undefined);
});

describe("listing what a hostel could accept", () => {
  it("returns every provider, configured or not", async () => {
    const configs = await listGatewayConfigs(hostelId);

    expect(configs.map((config) => config.provider)).toEqual([
      "ESEWA",
      "FONEPAY",
      "KHALTI",
    ]);
    expect(configs.every((config) => !config.enabled)).toBe(true);
  });

  it("never returns a secret, only that one exists", async () => {
    mocks.describeSecret.mockResolvedValue({
      configured: true,
      fingerprint: "abc123def456",
      rotatedAt: null,
      updatedAt: new Date(),
    });

    const [esewa] = await listGatewayConfigs(hostelId);

    expect(esewa!.secret).toEqual({
      configured: true,
      fingerprint: "abc123def456",
      rotatedAt: null,
    });
    expect(JSON.stringify(esewa)).not.toContain(SECRET);
  });

  it("explains why a personal account cannot be switched on", async () => {
    mocks.profileFindOne.mockReturnValue(
      chain({
        gateways: [
          {
            accountKind: "PERSONAL",
            merchantCode: "9800000000",
            mode: "LIVE",
            provider: "FONEPAY",
          },
        ],
      }),
    );

    const fonepay = (await listGatewayConfigs(hostelId)).find(
      (config) => config.provider === "FONEPAY",
    );

    expect(fonepay!.blockedReason).toContain("5,000");
    expect(fonepay!.blockedReason).toContain("bank account");
    expect(fonepay!.payable).toBe(false);
  });

  it("asks for the merchant code when that is what is missing", async () => {
    mocks.profileFindOne.mockReturnValue(
      chain({ gateways: [{ mode: "LIVE", provider: "ESEWA" }] }),
    );

    const esewa = (await listGatewayConfigs(hostelId)).find(
      (config) => config.provider === "ESEWA",
    );

    expect(esewa!.blockedReason).toMatch(/product code/i);
  });

  it("has nothing to complain about once an entry is complete", async () => {
    mocks.profileFindOne.mockReturnValue(
      chain({
        gateways: [{ merchantCode: "EPAYTEST", mode: "SANDBOX", provider: "ESEWA" }],
      }),
    );

    const esewa = (await listGatewayConfigs(hostelId)).find(
      (config) => config.provider === "ESEWA",
    );

    expect(esewa!.blockedReason).toBeNull();
  });
});

describe("saving a provider", () => {
  const base = {
    accountKind: "MERCHANT" as const,
    merchantCode: "EPAYTEST",
    mode: "SANDBOX" as const,
    provider: "ESEWA" as const,
  };

  it("stores the secret through the secret store, never on the profile", async () => {
    await saveGatewayConfig(hostelId, { ...base, secret: SECRET }, principal);

    expect(mocks.putSecret).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "ESEWA", purpose: "GATEWAY_SECRET" }),
    );
    expect(JSON.stringify(mocks.profileUpdateOne.mock.calls)).not.toContain(SECRET);
  });

  /**
   * A crash between the two writes must leave a stored key with no enabled
   * entry — inert — rather than an entry marked live with no key behind it,
   * whose resident-facing failure is a checkout that dies after the resident has
   * committed to paying.
   */
  it("writes the secret before the entry", async () => {
    await saveGatewayConfig(
      hostelId,
      { ...base, enabled: true, secret: SECRET },
      principal,
    );

    expect(mocks.putSecret.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.profileUpdateOne.mock.invocationCallOrder[0]!,
    );
  });

  it("leaves a stored key alone when the form sends no secret", async () => {
    await saveGatewayConfig(hostelId, base, principal);

    expect(mocks.putSecret).not.toHaveBeenCalled();
  });

  it("records the change without recording the value", async () => {
    await saveGatewayConfig(hostelId, { ...base, secret: SECRET }, principal);

    const entry = mocks.audit.mock.calls[0]![1];

    expect(entry.action).toBe("GATEWAY_CONFIG_UPDATED");
    expect(entry.reason).toContain("ESEWA");
    expect(JSON.stringify(entry)).not.toContain(SECRET);
  });

  it("refuses to enable a personal wallet, with the reason", async () => {
    await expect(
      saveGatewayConfig(
        hostelId,
        { ...base, accountKind: "PERSONAL", enabled: true, provider: "FONEPAY" },
        principal,
      ),
    ).rejects.toMatchObject({ errorCode: "GATEWAY_NOT_ELIGIBLE" });
  });

  it("stores a personal wallet it will not enable", async () => {
    // The owner should be able to record what they have; what is refused is
    // sending residents to it.
    await saveGatewayConfig(
      hostelId,
      { ...base, accountKind: "PERSONAL", provider: "FONEPAY" },
      principal,
    );

    expect(mocks.profileUpdateOne).toHaveBeenCalled();
  });

  it("refuses to enable an entry with no merchant code", async () => {
    await expect(
      saveGatewayConfig(
        hostelId,
        { ...base, enabled: true, merchantCode: "" },
        principal,
      ),
    ).rejects.toMatchObject({ errorCode: "GATEWAY_NOT_CONFIGURED" });
  });

  it("enables Khalti without one, because Khalti has no merchant code", async () => {
    await saveGatewayConfig(
      hostelId,
      { accountKind: "MERCHANT", enabled: true, mode: "SANDBOX", provider: "KHALTI" },
      principal,
    );

    expect(mocks.profileUpdateOne).toHaveBeenCalled();
  });

  /**
   * The failure this prevents is the worst one available on this screen: an
   * entry marked live, taking real residents' money, signed with nothing.
   */
  it("refuses to go live without a signing key", async () => {
    await expect(
      saveGatewayConfig(
        hostelId,
        { ...base, enabled: true, mode: "LIVE" },
        principal,
      ),
    ).rejects.toMatchObject({ errorCode: "GATEWAY_NOT_CONFIGURED" });
  });

  it("goes live once the key is stored", async () => {
    mocks.describeSecret.mockResolvedValue({ ...noSecret, configured: true });

    await saveGatewayConfig(
      hostelId,
      { ...base, enabled: true, mode: "LIVE", secret: SECRET },
      principal,
    );

    expect(mocks.profileUpdateOne).toHaveBeenCalled();
  });

  it("does not need a key to run in sandbox, where the key is ours", async () => {
    await saveGatewayConfig(hostelId, { ...base, enabled: true }, principal);

    expect(mocks.profileUpdateOne).toHaveBeenCalled();
  });

  it("keeps the original enable date when an enabled entry is edited", async () => {
    const enabledAt = new Date("2026-08-01T00:00:00.000Z");

    mocks.profileFindOne.mockReturnValue(
      chain({
        gateways: [{ enabledAt, merchantCode: "EPAYTEST", provider: "ESEWA" }],
      }),
    );
    mocks.profileUpdateOne.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });

    await saveGatewayConfig(hostelId, { ...base, enabled: true }, principal);

    expect(mocks.profileUpdateOne.mock.calls[0]![1].$set).toMatchObject({
      "gateways.$.enabledAt": enabledAt,
    });
  });

  it("disables by clearing the date, which is the documented rollback", async () => {
    mocks.profileUpdateOne.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });

    await saveGatewayConfig(hostelId, { ...base, enabled: false }, principal);

    expect(mocks.profileUpdateOne.mock.calls[0]![1].$set).toMatchObject({
      "gateways.$.enabledAt": null,
    });
  });

  it("updates the matching entry in place rather than appending a second", async () => {
    mocks.profileUpdateOne.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });

    await saveGatewayConfig(hostelId, base, principal);

    // FIN-10: matched on the slot itself, positional $, no arrayFilters.
    expect(mocks.profileUpdateOne).toHaveBeenCalledTimes(1);
    expect(mocks.profileUpdateOne.mock.calls[0]![0]).toMatchObject({ "gateways.provider": "ESEWA" });
  });

  it("appends only when no entry for that provider exists", async () => {
    await saveGatewayConfig(hostelId, base, principal);

    // The push is guarded, so a concurrent save cannot produce two entries.
    expect(mocks.profileUpdateOne.mock.calls[1]![0]).toMatchObject({
      "gateways.provider": { $ne: "ESEWA" },
    });
  });
});

describe("removing a provider", () => {
  it("deletes the stored keys along with the entry", async () => {
    // A key left behind is a credential nobody is watching and nobody meant to
    // keep.
    await deleteGatewayConfig(hostelId, "ESEWA", principal);

    expect(mocks.profileUpdateOne.mock.calls[0]![1]).toEqual({
      $pull: { gateways: { provider: "ESEWA" } },
    });
    expect(mocks.secretDeleteMany).toHaveBeenCalledWith({
      hostelId,
      provider: "ESEWA",
    });
  });

  it("leaves the other providers' keys alone", async () => {
    await deleteGatewayConfig(hostelId, "ESEWA", principal);

    expect(mocks.secretDeleteMany.mock.calls[0]![0]).not.toHaveProperty("purpose");
    expect(mocks.secretDeleteMany).toHaveBeenCalledTimes(1);
  });

  it("records the removal", async () => {
    await deleteGatewayConfig(hostelId, "ESEWA", principal);

    expect(mocks.audit.mock.calls[0]![1].action).toBe("GATEWAY_CONFIG_REMOVED");
  });
});
