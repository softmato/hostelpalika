import { Types } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/modules/billing/plan-limits", () => ({ assertPlanRoom: vi.fn() }));

import { Role } from "@/lib/roles";

const serviceMocks = vi.hoisted(() => ({
  auditCreate: vi.fn(),
  getIntakeQuote: vi.fn(),
  raiseAdmissionInvoice: vi.fn(),
  getHostelPayMethods: vi.fn(),
  runBillingCycle: vi.fn(),
  connectToDatabase: vi.fn(),
  emergencyContactCreate: vi.fn(),
  guardianCreate: vi.fn(),
  checkInBooking: vi.fn(),
  claimBedForRoomType: vi.fn(),
  findHeldBooking: vi.fn(),
  releaseBedForRoomType: vi.fn(),
  returnHeldBed: vi.fn(),
  takeHeldBed: vi.fn(),
  hostelFindById: vi.fn(),
  registerOrUpgradeUserByEmail: vi.fn(),
  residentCountDocuments: vi.fn(),
  residentCreate: vi.fn(),
  residentFind: vi.fn(),
  residentFindById: vi.fn(),
  residentFindOne: vi.fn(),
  residentFindOneAndUpdate: vi.fn(),
  notifyRegistered: vi.fn(),
  residentUpdateOne: vi.fn(),
  sendEmail: vi.fn(),
  userFind: vi.fn(),
  userFindOne: vi.fn(),
  promoteAccountToResident: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  connectToDatabase: serviceMocks.connectToDatabase,
}));

vi.mock("@hostel/db/models/AuditLog", () => ({
  AuditLogModel: {
    create: serviceMocks.auditCreate,
  },
}));

vi.mock("@hostel/db/models/EmergencyContact", () => ({
  EmergencyContactModel: {
    create: serviceMocks.emergencyContactCreate,
  },
}));

vi.mock("@hostel/db/models/Guardian", () => ({
  GuardianModel: {
    create: serviceMocks.guardianCreate,
  },
}));

vi.mock("@/modules/residents/resident-intake.service", () => ({
  getIntakeQuote: serviceMocks.getIntakeQuote,
  // The real one: the intake quote's period arithmetic is what decides which
  // month `raiseFirstMonthInvoice` bills, and mocking it away would leave the
  // assertion below testing nothing but itself.
  periodOfDate: (date: Date) =>
    `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`,
  raiseAdmissionInvoice: serviceMocks.raiseAdmissionInvoice,
}));

vi.mock("@/modules/finance/billing.service", () => ({
  runBillingCycle: serviceMocks.runBillingCycle,
}));

/*
 * How the hostel takes money, returned with the registration so the desk can
 * read a reference code and an account number off one screen. Mocked because
 * the real one reaches for a payment profile in Mongo, and what this file
 * asserts about it is only that an intake carries it back.
 */
vi.mock("@/modules/finance/pay-instructions.service", () => ({
  getHostelPayMethods: serviceMocks.getHostelPayMethods,
}));

/*
 * The registration's own notifications. Mocked here because what this file is
 * asserting is the *wiring* — that an intake tells somebody, and tells them the
 * right facts — while who each message reaches is
 * `resident-registered-notify.test.ts`'s question.
 */
vi.mock("@/modules/residents/resident-registered-notify", () => ({
  notifyResidentRegistered: serviceMocks.notifyRegistered,
}));

vi.mock("@/modules/hostels/hostel-capacity.service", () => ({
  claimBedForRoomType: serviceMocks.claimBedForRoomType,
  moveBedBetweenRoomTypes: vi.fn(),
  releaseBedForRoomType: serviceMocks.releaseBedForRoomType,
}));

// Which booking a card holds, and what closing it does to beds and money, is
// `booking-flow.test.ts`'s question; this file asserts the intake asks.
vi.mock("@/modules/bookings/booking-checkin.service", () => ({
  checkInBooking: serviceMocks.checkInBooking,
  findHeldBooking: serviceMocks.findHeldBooking,
  returnHeldBed: serviceMocks.returnHeldBed,
  takeHeldBed: serviceMocks.takeHeldBed,
}));

vi.mock("@hostel/db/models/Resident", () => ({
  ResidentModel: {
    countDocuments: serviceMocks.residentCountDocuments,
    create: serviceMocks.residentCreate,
    find: serviceMocks.residentFind,
    findById: serviceMocks.residentFindById,
    findOne: serviceMocks.residentFindOne,
    findOneAndUpdate: serviceMocks.residentFindOneAndUpdate,
    updateOne: serviceMocks.residentUpdateOne,
  },
}));

/*
 * Everything `linkResidentAccount` touches. Registering somebody is also the
 * moment their existing website account becomes a resident login, and that half
 * of the intake had no coverage at all — which is how it came to be looking the
 * account up by an address the resident can edit.
 */
vi.mock("@hostel/db/models/User", () => ({
  UserModel: { find: serviceMocks.userFind, findOne: serviceMocks.userFindOne },
}));

vi.mock("@hostel/db/models/Hostel", () => ({
  HostelModel: { findById: serviceMocks.hostelFindById },
}));

vi.mock("@hostel/shared/email/sender", () => ({
  sendEmail: serviceMocks.sendEmail,
}));

vi.mock("@/modules/users/resident-promotion.service", () => ({
  hasClearance: (cleared: {
    activatedInvite?: boolean;
    clearedMemberships?: unknown[];
    clearedRole?: string | null;
  }) =>
    Boolean(cleared?.clearedRole) ||
    (cleared?.clearedMemberships?.length ?? 0) > 0 ||
    Boolean(cleared?.activatedInvite),
  promoteAccountToResident: serviceMocks.promoteAccountToResident,
}));

vi.mock("@/modules/users/user.service", () => ({
  registerOrUpgradeUserByEmail: serviceMocks.registerOrUpgradeUserByEmail,
  UserServiceError: class UserServiceError extends Error {
    constructor(
      message: string,
      public errorCode = "USER_ERROR",
    ) {
      super(message);
    }
  },
}));

// The real normalizer would drag R2 and the personal-data crypto in behind it,
// and the parsing is the part that matters here: the warden may paste the whole
// scan URL, or type the id without its dashes.
vi.mock("@/modules/users/resident-identity.service", () => ({
  normalizeResidentId: (value: string) => {
    const tail = value.trim().split(/[?#]/)[0]?.split("/").filter(Boolean).pop() ?? "";
    const compact = tail.toUpperCase().replace(/[^A-Z0-9]/g, "");

    return /^HH[A-Z0-9]{8}$/.test(compact)
      ? `HH-${compact.slice(2, 6)}-${compact.slice(6, 10)}`
      : null;
  },
}));

import {
  addGuardian,
  createResident,
  listResidents,
} from "@/modules/residents/resident.service";
import { UserServiceError } from "@/modules/users/user.service";

const hostelId = "64f0f0f0f0f0f0f0f0f0f0f4";
const otherHostelId = "64f0f0f0f0f0f0f0f0f0f0f5";
const roomType = "Four Sharing";
const residentId = "64f0f0f0f0f0f0f0f0f0f0f8";

const staffPrincipal = {
  hostelIds: [hostelId],
  role: Role.HOSTEL_ADMIN,
  sessionId: "session-1",
  userId: "64f0f0f0f0f0f0f0f0f0f0f9",
};

/** A promotion that took nothing away, which is the ordinary case. */
const NO_CLEARANCE = {
  activatedInvite: false,
  clearedMemberships: [] as { hostelName: string; role: string }[],
  clearedRole: null,
};

function queryResult<T>(value: T) {
  return {
    lean: vi.fn().mockResolvedValue(value),
    limit: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    skip: vi.fn().mockReturnThis(),
    sort: vi.fn().mockReturnThis(),
  };
}

/** A hostel that levies no admission fee and prices this room type. */
function quote(overrides: Record<string, unknown> = {}) {
  return {
    admissionFee: 0,
    admissionPayable: 0,
    bedType: "FOUR_SHARING",
    currency: "NPR",
    depositAmount: 0,
    feeScheduleId: null,
    monthlyRent: 6000,
    referral: { applied: false, code: null, discount: 0, reason: null },
    rentBasis: "SCHEDULE",
    roomType,
    ...overrides,
  };
}

function residentRecord(overrides: Record<string, unknown> = {}) {
  return {
    _id: new Types.ObjectId(residentId),
    depositAmount: 5000,
    firstName: "Asha",
    hostelId: new Types.ObjectId(hostelId),
    lastName: "Rai",
    moveInDate: new Date("2030-01-01T00:00:00.000Z"),
    phone: "9800000000",
    roomType,
    status: "PENDING",
    ...overrides,
  };
}

describe("resident management service behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Intake starts with a duplicate-phone lookup; no match is the normal case.
    serviceMocks.residentFindOne.mockReturnValue(queryResult(null));
    // Then the platform-wide "do they already live somewhere" check; nobody is
    // the normal case.
    serviceMocks.residentFind.mockReturnValue(queryResult([]));
    serviceMocks.getIntakeQuote.mockResolvedValue(quote());
    serviceMocks.raiseAdmissionInvoice.mockResolvedValue({
      raised: false,
      reason: "NO_ADMISSION_FEE",
    });
    serviceMocks.residentCountDocuments.mockResolvedValue(0);
    // No account on the address, which is the shape of a hostel registering
    // somebody who has never used the website: the intake still succeeds and
    // the resident redeems an activation code instead.
    serviceMocks.userFindOne.mockReturnValue(queryResult(null));
    serviceMocks.userFind.mockReturnValue(queryResult([]));
    serviceMocks.hostelFindById.mockReturnValue(queryResult({ name: "Sunrise Hostel" }));
    serviceMocks.residentUpdateOne.mockResolvedValue({ acknowledged: true });
    serviceMocks.sendEmail.mockResolvedValue(undefined);
    // A hostel with no rate card is the shape of an empty run: nothing billed,
    // nothing skipped, and an intake that still succeeds.
    serviceMocks.runBillingCycle.mockResolvedValue({
      billed: [],
      failures: [],
      period: "2026-08",
      skipped: [],
      totalBilled: 0,
    });
    serviceMocks.getHostelPayMethods.mockResolvedValue({
      displayName: "Sunrise Hostel",
      instructions: null,
      methods: [{ id: "9800000000", kind: "ESEWA" }],
      tier: "TIER_0",
      usable: true,
    });
  });

  it("limits resident lists to the principal hostel ids", async () => {
    serviceMocks.residentFind.mockReturnValueOnce(queryResult([]));

    await listResidents({}, staffPrincipal);

    expect(serviceMocks.residentFind).toHaveBeenCalledWith({
      hostelId: {
        $in: [new Types.ObjectId(hostelId)],
      },
      isDeleted: false,
    });
  });

  it("rejects resident creation outside the admin tenant", async () => {
    await expect(
      createResident(
        {
          depositAmount: 5000,
          firstName: "Asha",
          hostelId: otherHostelId,
          lastName: "Rai",
          moveInDate: new Date("2030-01-01T00:00:00.000Z"),
          phone: "9800000000",
          residentType: "STUDENT" as const,
          roomType,
          status: "PENDING",
        },
        staffPrincipal,
      ),
    ).rejects.toMatchObject({
      errorCode: "NOT_FOUND",
      status: 404,
    });
    expect(serviceMocks.residentCreate).not.toHaveBeenCalled();
  });

  it("refuses to admit a resident into a room type with no vacancy", async () => {
    serviceMocks.claimBedForRoomType.mockRejectedValueOnce(
      Object.assign(new Error("No vacant beds left."), {
        errorCode: "ROOM_TYPE_FULL",
        status: 409,
      }),
    );

    await expect(
      createResident(
        {
          depositAmount: 5000,
          firstName: "Asha",
          lastName: "Rai",
          moveInDate: new Date("2030-01-01T00:00:00.000Z"),
          phone: "9800000000",
          residentType: "STUDENT" as const,
          roomType,
          status: "PENDING",
        },
        staffPrincipal,
      ),
    ).rejects.toMatchObject({ errorCode: "ROOM_TYPE_FULL", status: 409 });
    expect(serviceMocks.residentCreate).not.toHaveBeenCalled();
  });

  it("rejects a second resident on a phone already registered at the hostel", async () => {
    serviceMocks.residentFindOne.mockReturnValueOnce(queryResult(residentRecord()));

    await expect(
      createResident(
        {
          depositAmount: 5000,
          firstName: "Asha",
          lastName: "Rai",
          moveInDate: new Date("2030-01-01T00:00:00.000Z"),
          phone: "9800000000",
          residentType: "STUDENT" as const,
          roomType,
          status: "PENDING",
        },
        staffPrincipal,
      ),
    ).rejects.toMatchObject({ errorCode: "RESIDENT_PHONE_TAKEN", status: 409 });
    // Their own moved-out row must not count, or nobody can come back.
    expect(serviceMocks.residentFindOne).toHaveBeenCalledWith(
      expect.objectContaining({ status: { $ne: "MOVED_OUT" } }),
    );
    // The bed must never be claimed for a registration that cannot proceed.
    expect(serviceMocks.claimBedForRoomType).not.toHaveBeenCalled();
    expect(serviceMocks.residentCreate).not.toHaveBeenCalled();
  });

  /**
   * The defect, from the field: a student living at one hostel had their card
   * scanned at a second, and the second hostel's intake went through — a new
   * row, a second bed, a second bill. The one-home rule was only held by the
   * account link, which runs after all of that is written and answers a
   * conflict with `linked: false` instead of an error.
   */
  it("refuses somebody the scanned card says already lives at another hostel", async () => {
    const accountId = new Types.ObjectId("64f0f0f0f0f0f0f0f0f0f0fa");

    serviceMocks.userFindOne.mockReturnValueOnce(
      queryResult({ _id: accountId, email: "asha.login@example.com" }),
    );
    serviceMocks.residentFind.mockReturnValueOnce(
      queryResult([
        {
          _id: new Types.ObjectId(),
          hostelId: new Types.ObjectId(otherHostelId),
          status: "ACTIVE",
        },
      ]),
    );
    serviceMocks.hostelFindById.mockReturnValueOnce(
      queryResult({ name: "Education Light Hostel" }),
    );

    await expect(
      createResident(
        {
          email: "asha.profile@example.com",
          firstName: "Asha",
          lastName: "Rai",
          moveInDate: new Date("2030-01-01T00:00:00.000Z"),
          phone: "9811111111",
          residentType: "STUDENT" as const,
          roomType,
          status: "ACTIVE",
          userResidentId: "HH-4K7M-9XQ2",
        },
        staffPrincipal,
      ),
    ).rejects.toMatchObject({
      errorCode: "RESIDENT_LIVES_ELSEWHERE",
      message: expect.stringContaining("Education Light Hostel"),
      status: 409,
    });

    // Matched on the account *and* on both addresses, in any hostel.
    expect(serviceMocks.residentFind).toHaveBeenCalledWith({
      $or: [
        { userId: { $in: [accountId] } },
        {
          email: {
            $in: ["asha.profile@example.com", "asha.login@example.com"],
          },
        },
      ],
      isDeleted: { $ne: true },
      status: { $in: ["ACTIVE", "PENDING", "SUSPENDED"] },
    });
    expect(serviceMocks.claimBedForRoomType).not.toHaveBeenCalled();
    expect(serviceMocks.residentCreate).not.toHaveBeenCalled();
  });

  it("refuses a hand-typed email that is already on another hostel's roll", async () => {
    serviceMocks.residentFind.mockReturnValueOnce(
      queryResult([
        {
          _id: new Types.ObjectId(),
          hostelId: new Types.ObjectId(otherHostelId),
          status: "PENDING",
        },
      ]),
    );
    serviceMocks.hostelFindById.mockReturnValueOnce(
      queryResult({ name: "Education Light Hostel" }),
    );

    await expect(
      createResident(
        {
          email: "Asha@Example.com",
          firstName: "Asha",
          lastName: "Rai",
          moveInDate: new Date("2030-01-01T00:00:00.000Z"),
          phone: "9811111111",
          residentType: "STUDENT" as const,
          roomType,
          status: "ACTIVE",
        },
        staffPrincipal,
      ),
    ).rejects.toMatchObject({ errorCode: "RESIDENT_LIVES_ELSEWHERE", status: 409 });
    expect(serviceMocks.residentFind).toHaveBeenCalledWith(
      expect.objectContaining({
        $or: [{ email: { $in: ["asha@example.com"] } }],
      }),
    );
    expect(serviceMocks.claimBedForRoomType).not.toHaveBeenCalled();
  });

  it("lets somebody who moved out of their last hostel be registered", async () => {
    // `find` is asked for live rows only, so a MOVED_OUT row never comes back —
    // the default empty answer is that case.
    serviceMocks.residentCreate.mockResolvedValueOnce(residentRecord());

    await createResident(
      {
        email: "asha@example.com",
        firstName: "Asha",
        lastName: "Rai",
        moveInDate: new Date("2030-01-01T00:00:00.000Z"),
        phone: "9811111111",
        residentType: "STUDENT" as const,
        roomType,
        status: "ACTIVE",
      },
      staffPrincipal,
    );

    expect(serviceMocks.residentCreate).toHaveBeenCalled();
  });

  /**
   * The defect, reported from the field: an intake hit the phone conflict above,
   * the admin changed the number and pressed save again, and the same person was
   * taken onto the roll twice on one mailbox. Nothing downstream survives that —
   * `linkResidentAccount` refuses the second profile with
   * `ACCOUNT_ALREADY_LINKED`, so the duplicate can never be given a login and
   * shows as a resident who cannot sign in.
   */
  it("rejects a second resident on an email already registered at the hostel", async () => {
    serviceMocks.residentFindOne.mockReturnValueOnce(
      queryResult(residentRecord({ email: "asha@example.com", phone: "9811111111" })),
    );

    await expect(
      createResident(
        {
          depositAmount: 5000,
          email: "Asha@Example.com",
          firstName: "Asha",
          lastName: "Rai",
          moveInDate: new Date("2030-01-01T00:00:00.000Z"),
          phone: "9800000000",
          residentType: "STUDENT" as const,
          roomType,
          status: "PENDING",
        },
        staffPrincipal,
      ),
    ).rejects.toMatchObject({ errorCode: "RESIDENT_EMAIL_TAKEN", status: 409 });
    expect(serviceMocks.claimBedForRoomType).not.toHaveBeenCalled();
    expect(serviceMocks.residentCreate).not.toHaveBeenCalled();
  });

  it("sees a resident registered before `isDeleted` existed", async () => {
    /*
     * The conflict query used `isDeleted: false`, and that does not match a
     * document with no such field — so the oldest residents on a roll, the ones
     * most likely to have already collected a duplicate, were invisible to the
     * check that exists to stop one.
     *
     * The filter is Mongo's, so what is asserted is the query.
     */
    serviceMocks.residentFindOne.mockReturnValueOnce(queryResult(null));
    serviceMocks.residentCreate.mockResolvedValueOnce(residentRecord());

    await createResident(
      {
        email: "asha@example.com",
        firstName: "Asha",
        lastName: "Rai",
        moveInDate: new Date("2030-01-01T00:00:00.000Z"),
        phone: "9800000000",
        residentType: "STUDENT" as const,
        roomType,
        status: "ACTIVE" as const,
      },
      staffPrincipal,
    );

    expect(serviceMocks.residentFindOne).toHaveBeenCalledWith(
      expect.objectContaining({ isDeleted: { $ne: true } }),
    );
  });

  it("looks the email up lower-cased, the way it is stored", async () => {
    // `Resident.email` carries `lowercase: true`. A query built from raw form
    // input would miss `Asha@Gmail.com` against the `asha@gmail.com` on the roll
    // and let the duplicate straight through.
    serviceMocks.residentCreate.mockResolvedValueOnce(residentRecord());

    await createResident(
      {
        depositAmount: 5000,
        email: "  Asha@Example.COM ",
        firstName: "Asha",
        lastName: "Rai",
        moveInDate: new Date("2030-01-01T00:00:00.000Z"),
        phone: "9800000000",
        residentType: "STUDENT" as const,
        roomType,
        status: "PENDING",
      },
      staffPrincipal,
    );

    expect(serviceMocks.residentFindOne).toHaveBeenCalledWith(
      expect.objectContaining({
        $or: [{ phone: "9800000000" }, { email: "asha@example.com" }],
      }),
    );
  });

  it("asks for the phone and the email in one query", async () => {
    // Intake is the slowest path in the portal — the admin who reported this
    // said so before they said anything about duplicates. A second round trip
    // for the second field would be paid on every registration.
    serviceMocks.residentCreate.mockResolvedValueOnce(residentRecord());

    await createResident(
      {
        depositAmount: 5000,
        email: "asha@example.com",
        firstName: "Asha",
        lastName: "Rai",
        moveInDate: new Date("2030-01-01T00:00:00.000Z"),
        phone: "9800000000",
        residentType: "STUDENT" as const,
        roomType,
        status: "PENDING",
      },
      staffPrincipal,
    );

    expect(serviceMocks.residentFindOne).toHaveBeenCalledTimes(1);
  });

  it("does not collide two residents who simply have no email", async () => {
    // The common case: a hostel that registers by phone alone. `$or` must not
    // appear at all, or every second resident matches the first on a missing
    // field.
    serviceMocks.residentCreate.mockResolvedValueOnce(residentRecord());

    await createResident(
      {
        depositAmount: 5000,
        firstName: "Asha",
        lastName: "Rai",
        moveInDate: new Date("2030-01-01T00:00:00.000Z"),
        phone: "9800000000",
        residentType: "STUDENT" as const,
        roomType,
        status: "PENDING",
      },
      staffPrincipal,
    );

    expect(serviceMocks.residentFindOne).toHaveBeenCalledWith(
      expect.not.objectContaining({ $or: expect.anything() }),
    );
  });

  it("names the field the unique index actually rejected", async () => {
    // Two intakes racing land on the index, not on the check above. Mapping
    // every E11000 to the phone would tell an admin to change a number that was
    // never the problem.
    serviceMocks.residentCreate.mockRejectedValueOnce(
      Object.assign(new Error("E11000"), {
        code: 11000,
        keyPattern: { email: 1, hostelId: 1 },
      }),
    );

    await expect(
      createResident(
        {
          depositAmount: 5000,
          email: "asha@example.com",
          firstName: "Asha",
          lastName: "Rai",
          moveInDate: new Date("2030-01-01T00:00:00.000Z"),
          phone: "9800000000",
          residentType: "STUDENT" as const,
          roomType,
          status: "PENDING",
        },
        staffPrincipal,
      ),
    ).rejects.toMatchObject({ errorCode: "RESIDENT_EMAIL_TAKEN", status: 409 });
    expect(serviceMocks.releaseBedForRoomType).toHaveBeenCalled();
  });

  it("hands the bed back when creating the resident fails", async () => {
    serviceMocks.residentCreate.mockRejectedValueOnce(new Error("duplicate phone"));

    await expect(
      createResident(
        {
          depositAmount: 5000,
          firstName: "Asha",
          lastName: "Rai",
          moveInDate: new Date("2030-01-01T00:00:00.000Z"),
          phone: "9800000000",
          residentType: "STUDENT" as const,
          roomType,
          status: "PENDING",
        },
        staffPrincipal,
      ),
    ).rejects.toThrow("duplicate phone");
    expect(serviceMocks.releaseBedForRoomType).toHaveBeenCalledWith(
      new Types.ObjectId(hostelId),
      roomType,
    );
  });

  it("creates residents and claims a bed of their room type", async () => {
    serviceMocks.residentCreate.mockResolvedValueOnce(residentRecord());

    const result = await createResident(
      {
        depositAmount: 5000,
        firstName: "Asha",
        lastName: "Rai",
        moveInDate: new Date("2030-01-01T00:00:00.000Z"),
        phone: "9800000000",
        residentType: "STUDENT" as const,
        roomType,
        status: "PENDING",
      },
      staffPrincipal,
    );

    expect(result.resident).toMatchObject({
      firstName: "Asha",
      hostelId,
      roomType,
      status: "PENDING",
    });
    expect(serviceMocks.claimBedForRoomType).toHaveBeenCalledWith(
      new Types.ObjectId(hostelId),
      roomType,
    );
    expect(serviceMocks.residentCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        createdBy: staffPrincipal.userId,
        hostelId: new Types.ObjectId(hostelId),
        roomType,
      }),
    );
    expect(serviceMocks.auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "RESIDENT_CREATED",
        entityId: residentId,
        entityType: "Resident",
        hostelId: new Types.ObjectId(hostelId),
      }),
    );
  });

  it("bills the month they move into, not the month the cron next wakes in", async () => {
    /*
     * The gap this closes: nothing used to bill a new resident at all, so
     * somebody admitted mid-August was first invoiced for September and August
     * was charged to nobody. The run is restricted to this one resident and
     * their own move-in period — proration itself is `computeInvoiceAmount`'s
     * job and is asserted in `fee-schedule.test.ts`.
     */
    serviceMocks.residentCreate.mockResolvedValueOnce(residentRecord());
    serviceMocks.runBillingCycle.mockResolvedValueOnce({
      billed: [
        {
          amount: 2322,
          creditApplied: 0,
          invoiceId: "inv-1",
          referenceCode: "HH-0007",
          residentId,
        },
      ],
      failures: [],
      period: "2026-08",
      skipped: [],
      totalBilled: 2322,
    });

    const result = await createResident(
      {
        firstName: "Asha",
        lastName: "Rai",
        moveInDate: new Date("2026-08-20T00:00:00.000Z"),
        phone: "9800000000",
        residentType: "STUDENT" as const,
        roomType,
        status: "ACTIVE",
      },
      staffPrincipal,
    );

    expect(serviceMocks.runBillingCycle).toHaveBeenCalledWith(
      {
        hostelId: new Types.ObjectId(hostelId),
        period: "2026-08",
        residentIds: [new Types.ObjectId(residentId)],
      },
      staffPrincipal,
    );
    expect(result.firstMonth).toEqual({
      amount: 2322,
      invoiceId: "inv-1",
      period: "2026-08",
      raised: true,
      referenceCode: "HH-0007",
    });
  });

  it("hands the desk the reference codes and how this hostel is paid", async () => {
    /*
     * The reference code has exactly one moment where it is guaranteed to reach
     * the person who owes the money: they are standing at the desk. It was
     * allocated on both invoices and returned nowhere anybody could read it, so
     * transfers arrived unattributed and landed in the owner’s review queue.
     */
    serviceMocks.residentCreate.mockResolvedValueOnce(residentRecord());
    serviceMocks.runBillingCycle.mockResolvedValueOnce({
      billed: [
        {
          amount: 2322,
          creditApplied: 0,
          invoiceId: "inv-1",
          referenceCode: "HH-0007",
          residentId,
        },
      ],
      failures: [],
      period: "2026-08",
      skipped: [],
      totalBilled: 2322,
    });

    const result = await createResident(
      {
        firstName: "Asha",
        lastName: "Rai",
        moveInDate: new Date("2026-08-20T00:00:00.000Z"),
        phone: "9800000000",
        residentType: "STUDENT" as const,
        roomType,
        status: "ACTIVE",
      },
      staffPrincipal,
    );

    expect(result.firstMonth).toMatchObject({ referenceCode: "HH-0007" });
    expect(result.howToPay).toMatchObject({
      methods: [{ id: "9800000000", kind: "ESEWA" }],
      usable: true,
    });
    // Priced on what was actually raised, so a personal-wallet daily cap is
    // judged against the sum the resident is being asked for today.
    expect(serviceMocks.getHostelPayMethods).toHaveBeenCalledWith(
      new Types.ObjectId(hostelId),
      2322,
    );
  });

  it("registers the resident even when the payment profile cannot be read", async () => {
    // The bed is spent and the invoices are on the ledger by the time this
    // runs. A lookup that throws must not report a failed intake.
    serviceMocks.residentCreate.mockResolvedValueOnce(residentRecord());
    serviceMocks.getHostelPayMethods.mockRejectedValueOnce(new Error("mongo down"));

    const result = await createResident(
      {
        firstName: "Asha",
        lastName: "Rai",
        moveInDate: new Date("2026-08-20T00:00:00.000Z"),
        phone: "9800000000",
        residentType: "STUDENT" as const,
        roomType,
        status: "ACTIVE",
      },
      staffPrincipal,
    );

    expect(result.howToPay).toBeNull();
    expect(result.resident).toBeTruthy();
  });

  it("tells the resident and the hostel, with the figures they were quoted", async () => {
    /*
     * Registering somebody used to be the quietest write in the product: it
     * spends a bed, raises invoices and starts a rent obligation, and told
     * nobody. The resident heard about it only if they happened to already have
     * a platform account to promote — which at a desk they usually do not.
     */
    serviceMocks.residentCreate.mockResolvedValueOnce(residentRecord());
    serviceMocks.runBillingCycle.mockResolvedValueOnce({
      billed: [
        {
          amount: 2322,
          creditApplied: 0,
          invoiceId: "inv-1",
          referenceCode: "HH-0007",
          residentId,
        },
      ],
      failures: [],
      period: "2026-08",
      skipped: [],
      totalBilled: 2322,
    });

    await createResident(
      {
        firstName: "Asha",
        lastName: "Rai",
        moveInDate: new Date("2026-08-20T00:00:00.000Z"),
        phone: "9800000000",
        residentType: "STUDENT" as const,
        roomType,
        status: "ACTIVE",
      },
      staffPrincipal,
    );

    expect(serviceMocks.notifyRegistered).toHaveBeenCalledWith(
      expect.objectContaining({
        depositAmount: 5000,
        firstMonth: {
          amount: 2322,
          invoiceId: "inv-1",
          period: "2026-08",
          prorated: false,
          referenceCode: "HH-0007",
        },
        monthlyRent: 6000,
      }),
    );
  });

  it("says nothing about a first month that was never invoiced", async () => {
    // The email prints an amount owed. Passing one through for an invoice that
    // does not exist would be a claim about money that is false.
    serviceMocks.residentCreate.mockResolvedValueOnce(residentRecord());
    serviceMocks.runBillingCycle.mockResolvedValueOnce({
      billed: [],
      failures: [],
      period: "2026-08",
      skipped: [{ reason: "NOT_YET_RESIDENT", residentId }],
      totalBilled: 0,
    });

    await createResident(
      {
        firstName: "Asha",
        lastName: "Rai",
        moveInDate: new Date("2026-08-20T00:00:00.000Z"),
        phone: "9800000000",
        residentType: "STUDENT" as const,
        roomType,
        status: "PENDING",
      },
      staffPrincipal,
    );

    expect(serviceMocks.notifyRegistered).toHaveBeenCalledWith(
      expect.objectContaining({ firstMonth: null }),
    );
  });

  it("reports why the first month was not billed instead of failing the intake", async () => {
    // A pending resident is not billable, and the intake still succeeded — the
    // resident exists and their bed is spent by the time billing is attempted.
    serviceMocks.residentCreate.mockResolvedValueOnce(residentRecord());
    serviceMocks.runBillingCycle.mockResolvedValueOnce({
      billed: [],
      failures: [],
      period: "2026-08",
      skipped: [{ reason: "NOT_YET_RESIDENT", residentId }],
      totalBilled: 0,
    });

    const result = await createResident(
      {
        firstName: "Asha",
        lastName: "Rai",
        moveInDate: new Date("2026-08-20T00:00:00.000Z"),
        phone: "9800000000",
        residentType: "STUDENT" as const,
        roomType,
        status: "PENDING",
      },
      staffPrincipal,
    );

    expect(result.resident.status).toBe("PENDING");
    expect(result.firstMonth).toEqual({
      period: "2026-08",
      raised: false,
      reason: "NOT_YET_RESIDENT",
    });
  });

  it("does not fail the intake when the billing run throws", async () => {
    serviceMocks.residentCreate.mockResolvedValueOnce(residentRecord());
    serviceMocks.runBillingCycle.mockRejectedValueOnce(
      new Error("No fee schedule covers 2026-08."),
    );

    const result = await createResident(
      {
        firstName: "Asha",
        lastName: "Rai",
        moveInDate: new Date("2026-08-20T00:00:00.000Z"),
        phone: "9800000000",
        residentType: "STUDENT" as const,
        roomType,
        status: "ACTIVE",
      },
      staffPrincipal,
    );

    expect(result.resident).toMatchObject({ firstName: "Asha" });
    expect(result.firstMonth).toMatchObject({
      raised: false,
      reason: "No fee schedule covers 2026-08.",
    });
  });

  /*
   * Registering a scanned resident has to open their portal.
   *
   * The hostel holds their card up to a camera, the server resolves it to one
   * account to build the prefill — and then the intake threw that away and
   * re-found them by `Resident.email`, which is `primaryEmail` off their profile
   * form rather than the address they sign in with. When those two differed the
   * lookup found nothing, and somebody the hostel had physically just scanned
   * was registered with their account left PUBLIC and no resident portal.
   */
  it("links the account the scanned card resolved to, not the email on the form", async () => {
    const accountId = new Types.ObjectId("64f0f0f0f0f0f0f0f0f0f0fa");

    serviceMocks.residentCreate.mockResolvedValueOnce(
      residentRecord({ email: "asha.profile@example.com" }),
    );
    // The card's account signs in with a different address to the one on their
    // profile — the whole case this exists for.
    serviceMocks.userFindOne.mockReturnValueOnce(
      queryResult({ _id: accountId, email: "asha.login@example.com" }),
    );
    serviceMocks.residentFindById.mockReturnValue(
      queryResult(residentRecord({ status: "ACTIVE", userId: accountId })),
    );
    serviceMocks.promoteAccountToResident.mockResolvedValue({
      cleared: NO_CLEARANCE,
      upgraded: true,
      user: {
        email: "asha.login@example.com",
        id: accountId.toString(),
        role: Role.RESIDENT,
      },
    });

    const result = await createResident(
      {
        email: "asha.profile@example.com",
        firstName: "Asha",
        lastName: "Rai",
        moveInDate: new Date("2030-01-01T00:00:00.000Z"),
        phone: "9800000000",
        residentType: "STUDENT" as const,
        roomType,
        status: "ACTIVE",
        // Lower case and undashed, the way a QR payload or a paste arrives.
        userResidentId: "hh4k7m9xq2",
      },
      staffPrincipal,
    );

    expect(serviceMocks.userFindOne).toHaveBeenCalledWith({
      isDeleted: { $ne: true },
      userResidentId: "HH-4K7M-9XQ2",
    });
    // Promoted as the account the card named, by id. Passing the address alone
    // is what let a second row on the same mailbox be matched instead.
    expect(serviceMocks.promoteAccountToResident).toHaveBeenCalledWith(
      expect.objectContaining({ userId: accountId }),
    );
    expect(result.accountLink).toMatchObject({ linked: true });
  });

  describe("a card that holds a booking", () => {
    const accountId = new Types.ObjectId("64f0f0f0f0f0f0f0f0f0f0fc");
    const booking = {
      _id: new Types.ObjectId(),
      bedHeld: true,
      hostelId: new Types.ObjectId(hostelId),
      roomType: "Two Sharing",
      status: "CONFIRMED",
    };
    const intake = {
      email: "asha@example.com",
      firstName: "Asha",
      lastName: "Rai",
      moveInDate: new Date("2030-01-01T00:00:00.000Z"),
      phone: "9800000000",
      residentType: "STUDENT" as const,
      roomType,
      status: "ACTIVE" as const,
      userResidentId: "HH-4K7M-9XQ2",
    };

    beforeEach(() => {
      serviceMocks.userFindOne.mockReturnValueOnce(queryResult({ _id: accountId, email: "asha@example.com" }));
      serviceMocks.findHeldBooking.mockResolvedValueOnce(booking);
    });

    it("gives them the bed it holds and closes the booking", async () => {
      serviceMocks.residentCreate.mockResolvedValueOnce(residentRecord({ email: "asha@example.com" }));
      serviceMocks.residentFindById.mockReturnValue(
        queryResult(residentRecord({ status: "ACTIVE", userId: accountId })),
      );
      serviceMocks.promoteAccountToResident.mockResolvedValue({
        cleared: NO_CLEARANCE,
        upgraded: true,
        user: { email: "asha@example.com", id: accountId.toString(), role: Role.RESIDENT },
      });

      await createResident(intake, staffPrincipal);

      expect(serviceMocks.findHeldBooking).toHaveBeenCalledWith(new Types.ObjectId(hostelId), accountId);
      expect(serviceMocks.takeHeldBed).toHaveBeenCalledWith(booking, roomType);
      expect(serviceMocks.claimBedForRoomType).not.toHaveBeenCalled();
      expect(serviceMocks.checkInBooking).toHaveBeenCalledWith(
        booking,
        expect.objectContaining({ residentId: new Types.ObjectId(residentId), roomType }),
      );
    });

    it("leaves the bed with the booking when the resident cannot be written", async () => {
      serviceMocks.residentCreate.mockRejectedValueOnce(new Error("duplicate phone"));

      await expect(createResident(intake, staffPrincipal)).rejects.toThrow("duplicate phone");

      expect(serviceMocks.returnHeldBed).toHaveBeenCalledWith(booking, roomType);
      expect(serviceMocks.releaseBedForRoomType).not.toHaveBeenCalled();
      expect(serviceMocks.checkInBooking).not.toHaveBeenCalled();
    });
  });

  it("links a pre-booking's account without admitting them", async () => {
    /*
     * The regression this exists for lost a hostel a month's rent, silently and
     * on every pre-booking. The link used to `$set: { status: "ACTIVE" }`, which
     * ran *after* the intake had already declined to bill a `PENDING` resident —
     * so the move-in month was never invoiced by the intake, and never invoiced
     * by `updateResidentStatus` either, because that path only bills a
     * transition *into* ACTIVE and the resident was already there.
     */
    const accountId = new Types.ObjectId("64f0f0f0f0f0f0f0f0f0f0fb");

    serviceMocks.residentCreate.mockResolvedValueOnce(
      residentRecord({ email: "asha@example.com", status: "PENDING" }),
    );
    serviceMocks.userFindOne.mockReturnValueOnce(
      queryResult({ _id: accountId, email: "asha@example.com" }),
    );
    serviceMocks.residentFindById.mockReturnValue(
      queryResult(residentRecord({ status: "PENDING", userId: accountId })),
    );
    serviceMocks.promoteAccountToResident.mockResolvedValue({
      cleared: NO_CLEARANCE,
      upgraded: true,
      user: {
        email: "asha@example.com",
        id: accountId.toString(),
        role: Role.RESIDENT,
      },
    });

    const result = await createResident(
      {
        email: "asha@example.com",
        firstName: "Asha",
        lastName: "Rai",
        moveInDate: new Date("2030-01-01T00:00:00.000Z"),
        phone: "9800000000",
        residentType: "STUDENT" as const,
        roomType,
        status: "PENDING",
        userResidentId: "hh4k7m9xq2",
      },
      staffPrincipal,
    );

    expect(result.accountLink).toMatchObject({ linked: true });
    expect(result.resident.status).toBe("PENDING");

    for (const [, update] of serviceMocks.residentUpdateOne.mock.calls) {
      expect((update as { $set: Record<string, unknown> }).$set).not.toHaveProperty(
        "status",
      );
    }
  });

  it("falls back to the email when nobody scanned a card", async () => {
    const accountId = new Types.ObjectId("64f0f0f0f0f0f0f0f0f0f0fa");

    serviceMocks.residentCreate.mockResolvedValueOnce(
      residentRecord({ email: "asha@example.com" }),
    );
    serviceMocks.userFind.mockReturnValueOnce(
      queryResult([{ _id: accountId, email: "asha@example.com", role: Role.PUBLIC }]),
    );
    serviceMocks.residentFindById.mockReturnValue(
      queryResult(residentRecord({ status: "ACTIVE", userId: accountId })),
    );
    serviceMocks.promoteAccountToResident.mockResolvedValue({
      cleared: NO_CLEARANCE,
      upgraded: true,
      user: { email: "asha@example.com", id: accountId.toString(), role: Role.RESIDENT },
    });

    const result = await createResident(
      {
        email: "asha@example.com",
        firstName: "Asha",
        lastName: "Rai",
        moveInDate: new Date("2030-01-01T00:00:00.000Z"),
        phone: "9800000000",
        residentType: "STUDENT" as const,
        roomType,
        status: "ACTIVE",
      },
      staffPrincipal,
    );

    expect(serviceMocks.userFind).toHaveBeenCalledWith({
      email: "asha@example.com",
      isDeleted: { $ne: true },
    });
    // The account is upgraded by id, not re-found by the address — see the
    // shared-mailbox test below for why that distinction is the whole fix.
    expect(serviceMocks.promoteAccountToResident).toHaveBeenCalledWith(
      expect.objectContaining({ userId: accountId }),
    );
    expect(result.accountLink).toMatchObject({ linked: true });
  });

  /*
   * The bug an actual registration hit: one mailbox, two rows.
   *
   * An `INVITED` warden account somebody was sent months ago and never signed
   * in to, sitting beside the PUBLIC account they really use. `findOne({ email })`
   * returned the warden row, `registerOrUpgradeUserByEmail` refused to change a
   * staff account's role, and the intake reported `EMAIL_ALREADY_HAS_ROLE` — so
   * the resident was registered, was emailed their welcome, and stayed a public
   * user with no portal to sign in to.
   */
  it("promotes the public account when a staff row shares the address", async () => {
    const wardenId = new Types.ObjectId("64f0f0f0f0f0f0f0f0f0f0fb");
    const publicId = new Types.ObjectId("64f0f0f0f0f0f0f0f0f0f0fa");

    serviceMocks.residentCreate.mockResolvedValueOnce(
      residentRecord({ email: "asha@example.com" }),
    );
    serviceMocks.userFind.mockReturnValueOnce(
      queryResult([
        { _id: wardenId, email: "asha@example.com", role: Role.WARDEN },
        { _id: publicId, email: "asha@example.com", role: Role.PUBLIC },
      ]),
    );
    serviceMocks.residentFindById.mockReturnValue(
      queryResult(residentRecord({ status: "ACTIVE", userId: publicId })),
    );
    serviceMocks.promoteAccountToResident.mockResolvedValue({
      cleared: NO_CLEARANCE,
      upgraded: true,
      user: { email: "asha@example.com", id: publicId.toString(), role: Role.RESIDENT },
    });

    const result = await createResident(
      {
        email: "asha@example.com",
        firstName: "Asha",
        lastName: "Rai",
        moveInDate: new Date("2030-01-01T00:00:00.000Z"),
        phone: "9800000000",
        residentType: "STUDENT" as const,
        roomType,
        status: "ACTIVE",
      },
      staffPrincipal,
    );

    expect(serviceMocks.promoteAccountToResident).toHaveBeenCalledWith(
      expect.objectContaining({ userId: publicId }),
    );
    expect(result.accountLink).toMatchObject({ linked: true });
  });

  /*
   * Residency has no blocker.
   *
   * When the *only* account on the address is a staff row — the unaccepted
   * warden invite, months old — that is still the person standing at the desk
   * with their luggage. Refusing to link them was the defect: they were
   * registered, invoiced and welcomed, and left on a login with no portal. It is
   * promoted, whatever it held is cleared, and they are told what was cleared.
   */
  it("promotes a lone staff account and reports what it cleared", async () => {
    const wardenId = new Types.ObjectId("64f0f0f0f0f0f0f0f0f0f0fb");

    serviceMocks.residentCreate.mockResolvedValueOnce(
      residentRecord({ email: "warden@example.com" }),
    );
    serviceMocks.userFind.mockReturnValueOnce(
      queryResult([{ _id: wardenId, email: "warden@example.com", role: Role.WARDEN }]),
    );
    serviceMocks.residentFindById.mockReturnValue(
      queryResult(residentRecord({ status: "ACTIVE", userId: wardenId })),
    );
    serviceMocks.promoteAccountToResident.mockResolvedValue({
      cleared: {
        activatedInvite: true,
        clearedMemberships: [{ hostelName: "Sunrise Hostel", role: Role.WARDEN }],
        clearedRole: Role.WARDEN,
      },
      upgraded: true,
      user: {
        email: "warden@example.com",
        id: wardenId.toString(),
        role: Role.RESIDENT,
      },
    });

    const result = await createResident(
      {
        email: "warden@example.com",
        firstName: "Asha",
        lastName: "Rai",
        moveInDate: new Date("2030-01-01T00:00:00.000Z"),
        phone: "9800000000",
        residentType: "STUDENT" as const,
        roomType,
        status: "ACTIVE",
      },
      staffPrincipal,
    );

    expect(serviceMocks.promoteAccountToResident).toHaveBeenCalledWith(
      expect.objectContaining({ userId: wardenId }),
    );
    expect(result.accountLink).toMatchObject({
      cleared: { clearedRole: Role.WARDEN },
      linked: true,
    });
    // Told, not merely done: an access closed without a word sends somebody
    // looking for a dashboard that has quietly stopped existing.
    expect(serviceMocks.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: expect.stringContaining("now a resident account"),
        to: "warden@example.com",
      }),
    );
  });

  it("says nothing extra when the promotion cleared nothing", async () => {
    const accountId = new Types.ObjectId("64f0f0f0f0f0f0f0f0f0f0fa");

    serviceMocks.residentCreate.mockResolvedValueOnce(
      residentRecord({ email: "asha@example.com" }),
    );
    serviceMocks.userFind.mockReturnValueOnce(
      queryResult([{ _id: accountId, email: "asha@example.com", role: Role.PUBLIC }]),
    );
    serviceMocks.residentFindById.mockReturnValue(
      queryResult(residentRecord({ status: "ACTIVE", userId: accountId })),
    );
    serviceMocks.promoteAccountToResident.mockResolvedValue({
      cleared: NO_CLEARANCE,
      upgraded: true,
      user: { email: "asha@example.com", id: accountId.toString(), role: Role.RESIDENT },
    });

    await createResident(
      {
        email: "asha@example.com",
        firstName: "Asha",
        lastName: "Rai",
        moveInDate: new Date("2030-01-01T00:00:00.000Z"),
        phone: "9800000000",
        residentType: "STUDENT" as const,
        roomType,
        status: "ACTIVE",
      },
      staffPrincipal,
    );

    // A second mail listing an empty set is noise; the registration
    // confirmation already covers the ordinary promotion.
    expect(serviceMocks.sendEmail).not.toHaveBeenCalledWith(
      expect.objectContaining({
        subject: expect.stringContaining("now a resident account"),
      }),
    );
  });

  it("does not link a different account when the card's has no address", async () => {
    // The card is the person. Falling through to the email on the form would
    // find somebody else's account and put them in this bed.
    serviceMocks.residentCreate.mockResolvedValueOnce(
      residentRecord({ email: "someone.else@example.com" }),
    );
    serviceMocks.userFindOne.mockReturnValueOnce(
      queryResult({ _id: new Types.ObjectId("64f0f0f0f0f0f0f0f0f0f0fa") }),
    );

    const result = await createResident(
      {
        email: "someone.else@example.com",
        firstName: "Asha",
        lastName: "Rai",
        moveInDate: new Date("2030-01-01T00:00:00.000Z"),
        phone: "9800000000",
        residentType: "STUDENT" as const,
        roomType,
        status: "ACTIVE",
        userResidentId: "HH-4K7M-9XQ2",
      },
      staffPrincipal,
    );

    expect(serviceMocks.userFindOne).toHaveBeenCalledTimes(1);
    expect(serviceMocks.promoteAccountToResident).not.toHaveBeenCalled();
    expect(result.accountLink).toMatchObject({
      linked: false,
      reason: "ACCOUNT_HAS_NO_EMAIL",
    });
  });

  /*
   * The live defect (2026-09-11): a second hostel scanned somebody who already
   * lived elsewhere. The link was refused — but only after their account had
   * been promoted and handed the second hostel, so the login carried two
   * hostels for good and every "the one hostel on the token" lookup treated
   * them as unscoped.
   *
   * The intake's own lives-elsewhere check (`residentFind`, empty here) is what
   * normally stops this earlier. `updateResidentStatus` has no such check, and
   * two hostels racing on one person get past it — both land here.
   */
  it("refuses an account that lives elsewhere before promoting it", async () => {
    const accountId = new Types.ObjectId("64f0f0f0f0f0f0f0f0f0f0fa");

    serviceMocks.residentCreate.mockResolvedValueOnce(
      residentRecord({ email: "asha@example.com", status: "ACTIVE" }),
    );
    serviceMocks.userFindOne.mockReturnValueOnce(
      queryResult({ _id: accountId, email: "asha@example.com" }),
    );
    serviceMocks.residentFindOne
      // The same-hostel duplicate check: nobody.
      .mockReturnValueOnce(queryResult(null))
      // The link's one-profile-per-account check: their other home.
      .mockReturnValueOnce(
        queryResult(
          residentRecord({
            _id: new Types.ObjectId(),
            hostelId: new Types.ObjectId(otherHostelId),
            status: "ACTIVE",
            userId: accountId,
          }),
        ),
      );

    const result = await createResident(
      {
        email: "asha@example.com",
        firstName: "Asha",
        lastName: "Rai",
        moveInDate: new Date("2030-01-01T00:00:00.000Z"),
        phone: "9800000000",
        residentType: "STUDENT" as const,
        roomType,
        status: "ACTIVE",
        userResidentId: "hh4k7m9xq2",
      },
      staffPrincipal,
    );

    expect(result.accountLink).toMatchObject({
      linked: false,
      reason: "ACCOUNT_ALREADY_LINKED",
    });
    // Nothing written against the account: no role, no hostel.
    expect(serviceMocks.promoteAccountToResident).not.toHaveBeenCalled();
    // And the row was never pointed at it either.
    for (const [, update] of serviceMocks.residentUpdateOne.mock.calls) {
      expect((update as { $set?: Record<string, unknown> }).$set ?? {}).not.toHaveProperty(
        "userId",
      );
    }
  });

  /*
   * Row first, then account — so a hostel only ever lands on a login whose
   * resident row points back at it. When the promotion is refused, the row is
   * unpointed again rather than left naming an account that is not a resident.
   */
  it("links the row before promoting, and unlinks it when promotion is refused", async () => {
    const adminId = new Types.ObjectId("64f0f0f0f0f0f0f0f0f0f0fb");

    serviceMocks.residentCreate.mockResolvedValueOnce(
      residentRecord({ email: "owner@example.com", status: "ACTIVE" }),
    );
    serviceMocks.userFind.mockReturnValueOnce(
      queryResult([{ _id: adminId, email: "owner@example.com", role: Role.HOSTEL_ADMIN }]),
    );
    serviceMocks.promoteAccountToResident.mockRejectedValueOnce(
      new UserServiceError(
        "This email belongs to an administrator account, which an intake may not change.",
        "ROLE_TOO_PRIVILEGED",
        409,
      ),
    );

    const result = await createResident(
      {
        email: "owner@example.com",
        firstName: "Asha",
        lastName: "Rai",
        moveInDate: new Date("2030-01-01T00:00:00.000Z"),
        phone: "9800000000",
        residentType: "STUDENT" as const,
        roomType,
        status: "ACTIVE",
      },
      staffPrincipal,
    );

    expect(result.accountLink).toMatchObject({
      linked: false,
      reason: "ROLE_TOO_PRIVILEGED",
    });

    type Update = { $set?: Record<string, unknown>; $unset?: Record<string, unknown> };
    const calls = serviceMocks.residentUpdateOne.mock.calls as [
      Record<string, unknown>,
      Update,
    ][];
    const linkAt = calls.findIndex(([, update]) => update.$set?.userId);
    const unlinkAt = calls.findIndex(([, update]) => update.$unset?.userId !== undefined);

    expect(calls[linkAt]?.[1].$set?.userId).toEqual(adminId);
    expect(serviceMocks.residentUpdateOne.mock.invocationCallOrder[linkAt]).toBeLessThan(
      serviceMocks.promoteAccountToResident.mock.invocationCallOrder[0],
    );
    // Only while it still names this account — never another link's.
    expect(calls[unlinkAt]?.[0]).toMatchObject({ userId: adminId });
  });

  it("keeps the scanned id off the resident record", async () => {
    // It identifies the account, not the person in the bed. Written onto the
    // document it would be a second, stale copy of an id that already lives on
    // the user.
    serviceMocks.residentCreate.mockResolvedValueOnce(residentRecord());

    await createResident(
      {
        firstName: "Asha",
        lastName: "Rai",
        moveInDate: new Date("2030-01-01T00:00:00.000Z"),
        phone: "9800000000",
        residentType: "STUDENT" as const,
        roomType,
        status: "ACTIVE",
        userResidentId: "HH-4K7M-9XQ2",
      },
      staffPrincipal,
    );

    expect(serviceMocks.residentCreate).toHaveBeenCalledWith(
      expect.not.objectContaining({ userResidentId: expect.anything() }),
    );
  });
});

describe("attaching a guardian", () => {
  /*
   * Hooked to the guardian record rather than to the registration, and this is
   * the case that forces it: a scanned intake writes the resident first and
   * their guardian afterwards, so a registration-time send would have reached
   * nobody in exactly the flow it was built for.
   */
  beforeEach(() => {
    // This describe sits outside the one above, which owns the other reset.
    vi.clearAllMocks();
    serviceMocks.residentFindOne.mockReturnValue(queryResult(residentRecord()));
    serviceMocks.guardianCreate.mockResolvedValue({
      _id: new Types.ObjectId("64f0f0f0f0f0f0f0f0f0f0e1"),
      email: "bimal@example.test",
      firstName: "Bimal",
      hostelId: new Types.ObjectId(hostelId),
      isPrimary: true,
      lastName: "Rai",
      phone: "9800000001",
      relation: "FATHER",
      residentId: new Types.ObjectId(residentId),
    });
    serviceMocks.hostelFindById.mockReturnValue(
      queryResult({ contact: { phone: "9812345678" }, name: "Rupa Hostel" }),
    );
  });

  const guardian = {
    email: "bimal@example.test",
    firstName: "Bimal",
    isPrimary: true,
    lastName: "Rai",
    phone: "9800000001",
    relation: "FATHER",
  };

  it("tells the guardian their ward now lives at the hostel", async () => {
    await addGuardian(residentId, guardian, staffPrincipal);

    const [sent] = serviceMocks.sendEmail.mock.calls.at(-1)!;

    expect(sent.to).toBe("bimal@example.test");
    expect(sent.subject).toContain("Rupa Hostel");
    expect(sent.html).toContain("Asha Rai");
    // The hostel's own number, because this is the contact they would ring.
    expect(sent.html).toContain("9812345678");
  });

  it("carries no money and no login", async () => {
    // What a guardian may see is the resident's decision, made on their own
    // privacy screen. This mail is the fact, the address and who to call.
    await addGuardian(residentId, guardian, staffPrincipal);

    const [sent] = serviceMocks.sendEmail.mock.calls.at(-1)!;

    expect(sent.html).not.toMatch(/NPR|password|sign in/i);
  });

  it("sends nothing to a guardian with no email", async () => {
    await addGuardian(residentId, { ...guardian, email: undefined }, staffPrincipal);

    expect(serviceMocks.sendEmail).not.toHaveBeenCalled();
  });

  it("does not fail the write when the mail bounces", async () => {
    // The guardian record is already saved; reporting failure over it would
    // have the warden type the contact in a second time.
    serviceMocks.sendEmail.mockRejectedValueOnce(new Error("smtp is down"));

    await expect(
      addGuardian(residentId, guardian, staffPrincipal),
    ).resolves.toMatchObject({ guardian: expect.objectContaining({ relation: "FATHER" }) });
  });
});
