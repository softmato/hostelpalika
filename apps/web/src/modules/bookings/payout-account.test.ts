/**
 * Hostel payout accounts — docs/BOOKINGS.md item 3.
 *
 * The failures that would cost real money quietly: a number stored readable, a
 * sealed number that opens in another hostel's row, a change that keeps its old
 * "verified" badge, a re-save that throws away a verification, a full number
 * shown to somebody who is not a superadmin, and a rejection with no reason.
 */
import { randomBytes } from "node:crypto";

import { Types } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Role } from "@/lib/roles";

const store = vi.hoisted(() => ({
  accounts: [] as Array<Record<string, unknown>>,
  audit: [] as Array<Record<string, unknown>>,
  bells: [] as Array<Record<string, unknown>>,
  emails: [] as Array<{ subject: string; to: string }>,
  hostels: [] as Array<{ _id: unknown; name: string; slug: string }>,
}));

function chain<T>(value: T) {
  const query = {
    lean: async () => value,
    limit: () => query,
    select: () => query,
    sort: () => query,
  };

  return query;
}

function same(left: unknown, right: unknown) {
  return String(left) === String(right);
}

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ connectToDatabase: vi.fn() }));
vi.mock("@hostel/shared/email/sender", () => ({
  sendEmail: vi.fn(async (message: { subject: string; to: string }) => {
    store.emails.push(message);

    return { sent: true };
  }),
}));
vi.mock("@/modules/notifications/notification.service", () => ({
  createInAppNotification: vi.fn(async (row: Record<string, unknown>) => store.bells.push(row)),
}));
vi.mock("@/modules/residents/resident-notify", () => ({
  appUrl: (path: string) => `https://hostelpalika.test${path}`,
  resolveHostelAdminContacts: vi.fn(async () => [
    { email: "owner@example.test", name: "Owner", userId: new Types.ObjectId().toString() },
  ]),
}));
vi.mock("@hostel/db/models/AuditLog", () => ({
  AuditLogModel: { create: vi.fn(async (row: Record<string, unknown>) => store.audit.push(row)) },
}));
vi.mock("@hostel/db/models/User", () => ({
  UserModel: { find: () => chain([{ _id: new Types.ObjectId() }]) },
}));
vi.mock("@hostel/db/models/Hostel", () => ({
  HostelModel: {
    find: (filter: { _id: { $in: string[] } }) =>
      chain(store.hostels.filter((hostel) => filter._id.$in.some((id) => same(id, hostel._id)))),
    findById: (id: string) => chain(store.hostels.find((hostel) => same(hostel._id, id)) ?? null),
  },
}));
vi.mock("@hostel/db/models/HostelPayoutAccount", () => ({
  HostelPayoutAccountModel: {
    exists: async (filter: Record<string, unknown>) =>
      store.accounts.some((row) => same(row.hostelId, filter.hostelId) && row.status === filter.status),
    find: (filter: Record<string, unknown>) =>
      chain(
        store.accounts.filter((row) => {
          if (filter.status) return row.status === filter.status;
          if (filter.numberLookup) {
            return (filter.numberLookup as { $in: string[] }).$in.includes(row.numberLookup as string);
          }
          return true;
        }),
      ),
    findOne: (filter: Record<string, unknown>) =>
      chain(store.accounts.find((row) => same(row.hostelId, filter.hostelId)) ?? null),
    findOneAndUpdate: (
      filter: Record<string, unknown>,
      update: { $set: Record<string, unknown>; $setOnInsert?: Record<string, unknown> },
      options?: { upsert?: boolean },
    ) => {
      let row = store.accounts.find(
        (candidate) =>
          same(candidate.hostelId, filter.hostelId) &&
          (filter.status === undefined || candidate.status === filter.status),
      );

      if (!row && options?.upsert) {
        row = { _id: new Types.ObjectId(), ...update.$setOnInsert };
        store.accounts.push(row);
      }

      if (row) Object.assign(row, structuredClone(update.$set));

      return chain(row ? structuredClone(row) : null);
    },
  },
}));

process.env.FINANCE_MASTER_KEY = randomBytes(32).toString("base64");
process.env.PERSONAL_DATA_ENCRYPTION_KEY = randomBytes(32).toString("base64");

import { resetMasterKeyCache } from "@/modules/finance/gateway/secret-store";
import {
  getHostelPayoutAccount,
  isPayoutAccountVerified,
  listPayoutAccounts,
  revealHostelPayoutAccount,
  reviewHostelPayoutAccount,
  setHostelPayoutAccount,
} from "@/modules/bookings/payout-account.service";
import { payoutAccountInputSchema } from "@/lib/bookings/payout-account.validation";

const hostelA = { _id: new Types.ObjectId(), name: "Everest Boys Hostel", slug: "everest-boys" };
const hostelB = { _id: new Types.ObjectId(), name: "Lalitpur Girls Hostel", slug: "lalitpur-girls" };
const owner = { source: "HOSTEL_ADMIN" as const, userId: new Types.ObjectId().toString() };
const superadmin = { hostelIds: [], role: Role.SUPERADMIN, userId: new Types.ObjectId().toString() };

const bank = {
  bankName: "Nabil Bank",
  branch: "Baneshwor",
  holderName: "Everest Boys Hostel Pvt. Ltd.",
  method: "BANK",
  number: "0123-4567 8901",
};

beforeEach(() => {
  resetMasterKeyCache();
  store.accounts = [];
  store.audit = [];
  store.bells = [];
  store.emails = [];
  store.hostels = [hostelA, hostelB];
});

describe("payoutAccountInputSchema", () => {
  it("normalises a bank number copied with spaces and dashes", () => {
    expect(payoutAccountInputSchema.parse(bank).number).toBe("012345678901");
  });

  it("needs the bank's name for a bank account", () => {
    expect(payoutAccountInputSchema.safeParse({ ...bank, bankName: "" }).success).toBe(false);
  });

  it("needs a 10-digit mobile number for a wallet and drops bank fields", () => {
    expect(
      payoutAccountInputSchema.safeParse({ holderName: "Ram", method: "ESEWA", number: "12345" })
        .success,
    ).toBe(false);

    expect(
      payoutAccountInputSchema.parse({ ...bank, method: "KHALTI", number: "9841234567" }),
    ).toMatchObject({ bankName: "", branch: "", number: "9841234567" });
  });
});

describe("setHostelPayoutAccount", () => {
  it("seals the number and keeps only the last four readable", async () => {
    const view = await setHostelPayoutAccount(String(hostelA._id), bank, owner);

    expect(view).toMatchObject({ maskedNumber: "••••8901", status: "PENDING_REVIEW" });
    expect(JSON.stringify(store.accounts)).not.toContain("012345678901");
    expect(store.audit[0]).toMatchObject({ action: "PAYOUT_ACCOUNT_SET" });
    expect(JSON.stringify(store.audit)).not.toContain("012345678901");
  });

  it("emails the hostel's admins and tells superadmins there is one to check", async () => {
    await setHostelPayoutAccount(String(hostelA._id), bank, owner);

    expect(store.emails.map((email) => email.subject)).toEqual([
      "Payout account changed for Everest Boys Hostel",
    ]);
    expect(store.bells).toEqual(
      expect.arrayContaining([expect.objectContaining({ title: "Payout account to check" })]),
    );
  });

  it("sends no change email for the owner's own registration form", async () => {
    await setHostelPayoutAccount(String(hostelA._id), bank, { ...owner, source: "REGISTRATION" });

    expect(store.emails).toHaveLength(0);
  });

  it("keeps a verification when the same account is saved again", async () => {
    await setHostelPayoutAccount(String(hostelA._id), bank, owner);
    await reviewHostelPayoutAccount(String(hostelA._id), { approve: true }, superadmin);

    const again = await setHostelPayoutAccount(String(hostelA._id), bank, owner);

    expect(again.status).toBe("VERIFIED");
    expect(await isPayoutAccountVerified(hostelA._id)).toBe(true);
  });

  it("puts a changed account back into review", async () => {
    await setHostelPayoutAccount(String(hostelA._id), bank, owner);
    await reviewHostelPayoutAccount(String(hostelA._id), { approve: true }, superadmin);

    const changed = await setHostelPayoutAccount(
      String(hostelA._id),
      { ...bank, number: "999988887777" },
      owner,
    );

    expect(changed).toMatchObject({ maskedNumber: "••••7777", status: "PENDING_REVIEW" });
    expect(await isPayoutAccountVerified(hostelA._id)).toBe(false);
    expect(store.audit.at(-1)).toMatchObject({ action: "PAYOUT_ACCOUNT_CHANGED" });
  });
});

describe("revealHostelPayoutAccount", () => {
  it("opens the number for a superadmin and writes it to the audit log", async () => {
    await setHostelPayoutAccount(String(hostelA._id), bank, owner);

    const revealed = await revealHostelPayoutAccount(String(hostelA._id), superadmin);

    expect(revealed.number).toBe("012345678901");
    expect(store.audit.at(-1)).toMatchObject({ action: "PAYOUT_ACCOUNT_REVEALED" });
  });

  it("refuses anybody else", async () => {
    await setHostelPayoutAccount(String(hostelA._id), bank, owner);

    await expect(
      revealHostelPayoutAccount(String(hostelA._id), { ...superadmin, role: Role.PLATFORM_MODERATOR }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("will not open a number copied into another hostel's row", async () => {
    await setHostelPayoutAccount(String(hostelA._id), bank, owner);
    await setHostelPayoutAccount(
      String(hostelB._id),
      { ...bank, holderName: "Lalitpur Girls", number: "555566667777" },
      owner,
    );

    // A database write swaps hostel A's sealed number into hostel B's account.
    store.accounts[1].number = structuredClone(store.accounts[0].number);

    await expect(revealHostelPayoutAccount(String(hostelB._id), superadmin)).rejects.toThrow();
  });
});

describe("reviewHostelPayoutAccount", () => {
  it("verifies and emails the hostel", async () => {
    await setHostelPayoutAccount(String(hostelA._id), bank, owner);
    store.emails = [];

    const view = await reviewHostelPayoutAccount(String(hostelA._id), { approve: true }, superadmin);

    expect(view.status).toBe("VERIFIED");
    expect(store.emails[0].subject).toBe("Your payout account is OK — Everest Boys Hostel");
  });

  it("needs a reason to send one back", async () => {
    await setHostelPayoutAccount(String(hostelA._id), bank, owner);

    await expect(
      reviewHostelPayoutAccount(String(hostelA._id), { approve: false }, superadmin),
    ).rejects.toMatchObject({ status: 422 });

    const view = await reviewHostelPayoutAccount(
      String(hostelA._id),
      { approve: false, note: "The name does not match the hostel's registration." },
      superadmin,
    );

    expect(view).toMatchObject({ reviewNote: "The name does not match the hostel's registration.", status: "REJECTED" });
  });

  it("refuses to review an account that is not waiting", async () => {
    await expect(
      reviewHostelPayoutAccount(String(hostelA._id), { approve: true }, superadmin),
    ).rejects.toMatchObject({ errorCode: "PAYOUT_ACCOUNT_NOT_IN_REVIEW" });
  });
});

describe("listPayoutAccounts", () => {
  it("flags an account number used by two hostels", async () => {
    await setHostelPayoutAccount(String(hostelA._id), bank, owner);
    await setHostelPayoutAccount(String(hostelB._id), { ...bank, holderName: "Someone" }, owner);

    const accounts = await listPayoutAccounts({ status: "PENDING_REVIEW" });

    expect(accounts.find((row) => row.hostelName === "Everest Boys Hostel")?.sharedWith).toEqual([
      "Lalitpur Girls Hostel",
    ]);
    expect(await getHostelPayoutAccount(hostelB._id)).toMatchObject({ holderName: "Someone" });
  });
});
