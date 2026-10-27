import { Types } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Who hears about a registration, and what they are told.
 *
 * The three recipients are deliberately independent of each other: a resident
 * with no linked account still gets the email, a hostel with no admins on file
 * still notifies the resident, and a phone-only registration still tells the
 * owner. Each of those was a way the old code said nothing at all.
 */
const mocks = vi.hoisted(() => ({
  createNotification: vi.fn(),
  staffUserIds: vi.fn(),
  hostelName: vi.fn(),
  residentContact: vi.fn(),
  sendEmail: vi.fn(),
}));

vi.mock("@/modules/notifications/notification.service", () => ({
  createInAppNotification: mocks.createNotification,
}));

vi.mock("@/modules/residents/resident-notify", () => ({
  appUrl: (path: string) => `https://hostelpalika.test${path}`,
  getHostelName: mocks.hostelName,
  resolveHostelStaffUserIds: mocks.staffUserIds,
  resolveResidentContact: mocks.residentContact,
  sendNotificationEmail: mocks.sendEmail,
}));

import { notifyResidentRegistered } from "@/modules/residents/resident-registered-notify";

const hostelId = new Types.ObjectId("64f0f0f0f0f0f0f0f0f0f0a1");
const residentObjectId = new Types.ObjectId("64f0f0f0f0f0f0f0f0f0f0c1");

function input(overrides: Record<string, unknown> = {}) {
  return {
    admissionFee: 2000,
    depositAmount: 5000,
    firstMonth: {
      amount: 2322,
      invoiceId: "inv-1",
      period: "2083-05",
      prorated: true,
      referenceCode: "HH-0007",
    },
    hostelId,
    monthlyRent: 6000,
    resident: {
      _id: residentObjectId,
      email: "asha@example.test",
      firstName: "Asha",
      lastName: "Rai",
      moveInDate: new Date("2026-09-04T00:00:00.000Z"),
      roomNumber: "201",
      roomType: "FOUR_SHARING",
    },
    residentUserId: "64f0f0f0f0f0f0f0f0f0f0b1",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.hostelName.mockResolvedValue("Rupa Hostel");
  mocks.staffUserIds.mockResolvedValue(["64f0f0f0f0f0f0f0f0f0f0d1"]);
  mocks.residentContact.mockResolvedValue({
    email: "asha@example.test",
    name: "Asha Rai",
    residentId: residentObjectId.toString(),
  });
  mocks.createNotification.mockResolvedValue({});
  mocks.sendEmail.mockResolvedValue(undefined);
});

describe("telling the resident", () => {
  it("pushes the amount they now owe, pointing at the invoice", async () => {
    // `createInAppNotification` fans out to their devices, so this row and the
    // push are one call — the reason no `dispatchPush` appears in the module.
    await notifyResidentRegistered(input());

    expect(mocks.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "PAYMENT",
        data: { invoiceId: "inv-1", type: "RESIDENT_REGISTERED" },
        title: "You are registered",
        userId: "64f0f0f0f0f0f0f0f0f0f0b1",
      }),
    );
  });

  it("does not send them to a payments screen when nothing was invoiced", async () => {
    await notifyResidentRegistered(input({ firstMonth: null }));

    const call = mocks.createNotification.mock.calls.find(
      (one) => one[0].userId === "64f0f0f0f0f0f0f0f0f0f0b1",
    );

    expect(call?.[0].category).toBe("ACCOUNT");
    /*
     * Still marked, with no invoice to point at. The marker is about the
     * account's *role* changing, which happened whether or not money did — and
     * it is the only thing that turns the browsing app into the resident app.
     */
    expect(call?.[0].data).toEqual({ type: "RESIDENT_REGISTERED" });
  });

  /*
   * The one push in the product that is about the recipient themselves. The
   * mobile client keys off this exact string (`marksRoleChange`), rotates its
   * access token and replaces the public shell with the resident tabs — so a
   * rename here silently strands every resident registered at a desk in the
   * browsing app until their token expires.
   */
  it("marks the payload as a role change, so the app can promote itself", async () => {
    await notifyResidentRegistered(input());

    const call = mocks.createNotification.mock.calls.find(
      (one) => one[0].userId === "64f0f0f0f0f0f0f0f0f0f0b1",
    );

    expect(call?.[0].data).toMatchObject({ type: "RESIDENT_REGISTERED" });
  });

  it("says nothing to a resident with no login, and still emails them", async () => {
    // A desk registration with no platform account has no device to push to.
    // The email is what reaches them, which is why it is not conditional.
    await notifyResidentRegistered(input({ residentUserId: null }));

    expect(
      mocks.createNotification.mock.calls.every((one) => one[0].category === "RESIDENT"),
    ).toBe(true);
    expect(mocks.sendEmail).toHaveBeenCalledOnce();
  });
});

describe("telling the hostel", () => {
  it("notifies the owner, with the room and the move-in date", async () => {
    await notifyResidentRegistered(input());

    expect(mocks.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "RESIDENT",
        data: { residentId: residentObjectId.toString() },
        title: "New resident registered",
        userId: "64f0f0f0f0f0f0f0f0f0f0d1",
      }),
    );

    const call = mocks.createNotification.mock.calls.find(
      (one) => one[0].category === "RESIDENT",
    );

    expect(call?.[0].body).toContain("Asha Rai");
    expect(call?.[0].body).toContain("Four Sharing Room · 201");
  });

  /*
   * The audience is `resolveHostelStaffUserIds`, not the email helper it used
   * to be. That is what puts wardens on it — the people who actually perform
   * intakes, and who heard nothing about one until this — and what stops an
   * owner with no email on file being dropped from their own hostel's
   * notifications.
   */
  it("tells every member of staff the hostel resolves, wardens included", async () => {
    mocks.staffUserIds.mockResolvedValue(["owner-1", "warden-1", "admin-1"]);

    await notifyResidentRegistered(input());

    const told = mocks.createNotification.mock.calls
      .filter((one) => one[0].category === "RESIDENT")
      .map((one) => one[0].userId);

    expect(told).toEqual(["owner-1", "warden-1", "admin-1"]);
  });

  it("says nothing to a hostel with no staff on file", async () => {
    mocks.staffUserIds.mockResolvedValue([]);

    await notifyResidentRegistered(input());

    expect(
      mocks.createNotification.mock.calls.some((one) => one[0].category === "RESIDENT"),
    ).toBe(false);
  });
});

describe("emailing the resident", () => {
  it("sends the confirmation with the first month on it", async () => {
    await notifyResidentRegistered(input());

    const [sent] = mocks.sendEmail.mock.calls[0]!;

    expect(sent.to).toBe("asha@example.test");
    expect(sent.subject).toContain("Rupa Hostel");
    // The part month is named, or an amount well under the rent reads as a
    // billing fault and the resident's first act is to query a correct bill.
    expect(sent.html).toContain("Only from the day you move in");
    expect(sent.html).toContain("HH-0007");
  });

  it("tells a resident with no account how they will actually get in", async () => {
    await notifyResidentRegistered(input({ residentUserId: null }));

    const [sent] = mocks.sendEmail.mock.calls[0]!;

    // Never a password: residents are not sent credentials.
    expect(sent.html).toContain("ask the hostel for your code");
  });

  it("sends nothing to a phone-only registration", async () => {
    mocks.residentContact.mockResolvedValue(null);

    await notifyResidentRegistered(input());

    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });
});

it("never throws over a registration that already succeeded", async () => {
  // The resident exists and their bed is spent by the time this runs. Throwing
  // would report "could not register" over a registration that worked, and the
  // warden would register them a second time.
  mocks.staffUserIds.mockRejectedValue(new Error("mongo is down"));

  await expect(notifyResidentRegistered(input())).resolves.toBeUndefined();
});
