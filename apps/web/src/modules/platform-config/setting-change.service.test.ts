/**
 * Money settings change only from the emailed link — docs/BOOKINGS.md item 2.
 *
 * What would go wrong silently: a change applied without the link, a link that
 * works twice or for another account, an expired link that still works, a stale
 * link that quietly undoes a newer change, a raw token sitting in the database,
 * and a change parked with no email behind it.
 */
import { createHash } from "node:crypto";

import { Types } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Role } from "@/lib/roles";

const store = vi.hoisted(() => ({
  audit: [] as unknown[],
  bookings: null as unknown,
  changes: [] as Array<Record<string, unknown>>,
  emails: [] as Array<{ html: string; to: string }>,
  emailSent: true,
}));

function matches(row: Record<string, unknown>, filter: Record<string, unknown>) {
  return Object.entries(filter).every(([key, expected]) => {
    const actual = row[key];

    if (expected && typeof expected === "object" && "$gt" in (expected as object)) {
      return (actual as Date).getTime() > ((expected as { $gt: Date }).$gt).getTime();
    }

    if (expected && typeof expected === "object" && "$ne" in (expected as object)) {
      return String(actual) !== String((expected as { $ne: unknown }).$ne);
    }

    return String(actual) === String(expected);
  });
}

function lean<T>(value: T) {
  const chain = { lean: async () => value, select: () => chain, sort: () => chain };

  return chain;
}

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ connectToDatabase: vi.fn() }));
vi.mock("@/lib/site", () => ({ siteUrl: () => "https://hostelpalika.test" }));
vi.mock("@hostel/shared/email/sender", () => ({
  sendEmail: vi.fn(async (message: { html: string; to: string }) => {
    store.emails.push(message);

    return store.emailSent ? { sent: true } : { reason: "down", sent: false };
  }),
}));
vi.mock("@hostel/db/models/AuditLog", () => ({
  AuditLogModel: { create: vi.fn(async (row: unknown) => store.audit.push(row)) },
}));
vi.mock("@hostel/db/models/User", () => ({
  UserModel: {
    findById: (id: string) =>
      lean(id === USER_WITHOUT_EMAIL ? { name: "No Mail" } : { email: "work.softmato@gmail.com", name: "Sid" }),
  },
}));
vi.mock("@hostel/db/models/PlatformSettingChange", () => ({
  PlatformSettingChangeModel: {
    create: vi.fn(async (input: Record<string, unknown>) => {
      const row = { _id: new Types.ObjectId(), createdAt: new Date(), ...input };

      store.changes.push(row);

      return { ...row, toObject: () => row };
    }),
    findOne: (filter: Record<string, unknown>) =>
      lean(store.changes.find((row) => matches(row, filter)) ?? null),
    findOneAndUpdate: (filter: Record<string, unknown>, update: { $set: Record<string, unknown> }) => {
      const row = store.changes.find((candidate) => matches(candidate, filter));

      if (row) Object.assign(row, update.$set);

      return lean(row ?? null);
    },
    updateMany: vi.fn(async (filter: Record<string, unknown>, update: { $set: Record<string, unknown> }) => {
      for (const row of store.changes.filter((candidate) => matches(candidate, filter))) {
        Object.assign(row, update.$set);
      }
    }),
    updateOne: vi.fn(
      async (
        filter: Record<string, unknown>,
        update: { $set: Record<string, unknown>; $unset?: Record<string, unknown> },
      ) => {
        const row = store.changes.find((candidate) => matches(candidate, filter));

        if (row) Object.assign(row, update.$set);
      },
    ),
  },
}));
vi.mock("@/modules/bookings/booking-config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/bookings/booking-config")>();

  return {
    ...actual,
    applyBookingConfig: vi.fn(async (value: unknown) => {
      store.bookings = value;

      return value;
    }),
    getBookingConfig: vi.fn(async () => store.bookings ?? actual.DEFAULT_BOOKING_CONFIG),
  };
});
vi.mock("@/modules/platform-config/operations-config", () => ({
  getOperationsConfig: vi.fn(async () => ({ collectionQrLabel: "", collectionQrUrl: "" })),
  saveOperationsConfig: vi.fn(),
}));

const USER_WITHOUT_EMAIL = new Types.ObjectId().toString();

import { DEFAULT_BOOKING_CONFIG } from "@/modules/bookings/booking-config";
import {
  cancelSettingChange,
  confirmSettingChange,
  getPendingSettingChange,
  maskEmail,
  previewSettingChange,
  requestSettingChange,
} from "@/modules/platform-config/setting-change.service";

const superadmin = { hostelIds: [], role: Role.SUPERADMIN, userId: new Types.ObjectId().toString() };
const otherSuperadmin = { ...superadmin, userId: new Types.ObjectId().toString() };

/** The token only ever exists in the email; read it back out of the link. */
function tokenFromLastEmail() {
  const html = store.emails.at(-1)?.html ?? "";
  const match = /confirm\?token=([A-Za-z0-9_-]+)/.exec(html);

  return decodeURIComponent(match?.[1] ?? "");
}

beforeEach(() => {
  store.audit = [];
  store.bookings = null;
  store.changes = [];
  store.emails = [];
  store.emailSent = true;
});

describe("requestSettingChange", () => {
  it("parks the change, emails a link, and saves nothing", async () => {
    const pending = await requestSettingChange(
      "bookings",
      { ...DEFAULT_BOOKING_CONFIG, feePercent: 8 },
      superadmin,
    );

    expect(store.bookings).toBeNull();
    expect(pending.rows).toEqual([{ from: "7%", label: "Booking fee", to: "8%" }]);
    expect(pending.sentTo).toBe("wo•••@gmail.com");
    expect(store.emails).toHaveLength(1);
    expect(store.emails[0].to).toBe("work.softmato@gmail.com");
  });

  it("stores only the hash of the token", async () => {
    await requestSettingChange("bookings", { ...DEFAULT_BOOKING_CONFIG, feePercent: 8 }, superadmin);

    const token = tokenFromLastEmail();

    expect(token.length).toBeGreaterThan(30);
    expect(store.changes[0].tokenHash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(JSON.stringify(store.changes[0])).not.toContain(token);
  });

  it("refuses an edit that changes nothing", async () => {
    await expect(
      requestSettingChange("bookings", DEFAULT_BOOKING_CONFIG, superadmin),
    ).rejects.toMatchObject({ errorCode: "SETTING_UNCHANGED" });
  });

  it("refuses invalid terms before any email goes out", async () => {
    await expect(
      requestSettingChange("bookings", { ...DEFAULT_BOOKING_CONFIG, holdDays: 10 }, superadmin),
    ).rejects.toThrow();
    expect(store.emails).toHaveLength(0);
  });

  it("replaces an older request for the same setting", async () => {
    await requestSettingChange("bookings", { ...DEFAULT_BOOKING_CONFIG, feePercent: 8 }, superadmin);
    await requestSettingChange("bookings", { ...DEFAULT_BOOKING_CONFIG, feePercent: 9 }, superadmin);

    expect(store.changes.map((row) => row.status)).toEqual(["SUPERSEDED", "PENDING"]);
  });

  it("leaves nothing parked when the email cannot be sent", async () => {
    store.emailSent = false;

    await expect(
      requestSettingChange("bookings", { ...DEFAULT_BOOKING_CONFIG, feePercent: 8 }, superadmin),
    ).rejects.toMatchObject({ errorCode: "SETTING_CHANGE_EMAIL_FAILED" });
    expect(store.changes[0].status).toBe("CANCELLED");
    expect(await getPendingSettingChange("bookings")).toBeNull();
  });

  it("needs an account with an email", async () => {
    await expect(
      requestSettingChange(
        "bookings",
        { ...DEFAULT_BOOKING_CONFIG, feePercent: 8 },
        { ...superadmin, userId: USER_WITHOUT_EMAIL },
      ),
    ).rejects.toMatchObject({ errorCode: "SETTING_CHANGE_NO_EMAIL" });
  });

  it("refuses a temporary login", async () => {
    await expect(
      requestSettingChange(
        "bookings",
        { ...DEFAULT_BOOKING_CONFIG, feePercent: 8 },
        { ...superadmin, temporaryCredentialId: "temp" },
      ),
    ).rejects.toMatchObject({ errorCode: "TEMPORARY_CREDENTIAL_FORBIDDEN" });
  });
});

describe("confirmSettingChange", () => {
  async function requestFeeChange(feePercent = 8) {
    await requestSettingChange("bookings", { ...DEFAULT_BOOKING_CONFIG, feePercent }, superadmin);

    return tokenFromLastEmail();
  }

  it("applies the change for the account that asked", async () => {
    const token = await requestFeeChange();
    const result = await confirmSettingChange(token, superadmin);

    expect(result.label).toBe("booking terms");
    expect(store.bookings).toMatchObject({ feePercent: 8 });
    expect(store.changes[0].status).toBe("APPLIED");
  });

  it("works once", async () => {
    const token = await requestFeeChange();

    await confirmSettingChange(token, superadmin);

    await expect(confirmSettingChange(token, superadmin)).rejects.toMatchObject({
      errorCode: "SETTING_CHANGE_CLOSED",
    });
  });

  it("refuses another superadmin", async () => {
    const token = await requestFeeChange();

    await expect(confirmSettingChange(token, otherSuperadmin)).rejects.toMatchObject({
      errorCode: "SETTING_CHANGE_WRONG_ACCOUNT",
      status: 403,
    });
    expect(store.bookings).toBeNull();
  });

  it("refuses an expired link", async () => {
    const token = await requestFeeChange();

    store.changes[0].expiresAt = new Date(Date.now() - 1000);

    await expect(confirmSettingChange(token, superadmin)).rejects.toMatchObject({
      errorCode: "SETTING_CHANGE_EXPIRED",
    });
    expect(store.bookings).toBeNull();
  });

  it("refuses a made-up token", async () => {
    await requestFeeChange();

    await expect(confirmSettingChange("not-the-token", superadmin)).rejects.toMatchObject({
      errorCode: "SETTING_CHANGE_NOT_FOUND",
    });
  });

  it("refuses a link that would undo a newer change", async () => {
    const token = await requestFeeChange(8);

    // Something else changed the terms after the email went out.
    store.bookings = { ...DEFAULT_BOOKING_CONFIG, feePercent: 9 };

    await expect(confirmSettingChange(token, superadmin)).rejects.toMatchObject({
      errorCode: "SETTING_CHANGE_STALE",
    });
    expect(store.bookings).toMatchObject({ feePercent: 9 });
  });

  it("does nothing with the superseded link once a newer one exists", async () => {
    const first = await requestFeeChange(8);
    await requestFeeChange(9);

    await expect(confirmSettingChange(first, superadmin)).rejects.toMatchObject({
      errorCode: "SETTING_CHANGE_CLOSED",
    });
  });
});

describe("previewSettingChange and cancelSettingChange", () => {
  it("shows the rows without applying anything", async () => {
    await requestSettingChange("bookings", { ...DEFAULT_BOOKING_CONFIG, feePercent: 8 }, superadmin);

    const preview = await previewSettingChange(tokenFromLastEmail(), superadmin);

    expect(preview.status).toBe("PENDING");
    expect(preview.rows).toEqual([{ from: "7%", label: "Booking fee", to: "8%" }]);
    expect(store.bookings).toBeNull();
  });

  it("cancels a waiting change so its link stops working", async () => {
    const pending = await requestSettingChange(
      "bookings",
      { ...DEFAULT_BOOKING_CONFIG, feePercent: 8 },
      superadmin,
    );
    const token = tokenFromLastEmail();

    await cancelSettingChange(pending.id, superadmin);

    await expect(confirmSettingChange(token, superadmin)).rejects.toMatchObject({
      errorCode: "SETTING_CHANGE_CLOSED",
    });
  });
});

describe("maskEmail", () => {
  it("keeps the domain and two letters", () => {
    expect(maskEmail("work.softmato@gmail.com")).toBe("wo•••@gmail.com");
  });
});
