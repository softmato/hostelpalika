/**
 * "Add all" for the existing-residents list (docs/EXISTING_RESIDENTS.md, item 5).
 *
 * The cases are the ways this could hand a hostel a wrong bill: charging a
 * joining fee to somebody who joined last year, billing a month they already
 * paid, raising the same Old dues twice on a retry, or adding the same person
 * twice when the button is pressed again.
 */
import { Types } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/modules/billing/plan-limits", () => ({ assertPlanRoom: vi.fn() }));

const mocks = vi.hoisted(() => ({
  allocateReferenceCode: vi.fn(),
  audit: vi.fn(),
  claimBed: vi.fn(),
  hostelFind: vi.fn(),
  hostelFindById: vi.fn(),
  hostelFindOne: vi.fn(),
  invoiceCreate: vi.fn(),
  invoiceExists: vi.fn(),
  invoiceFindOne: vi.fn(),
  invoiceUpdateOne: vi.fn(),
  notify: vi.fn(),
  listFindOne: vi.fn(),
  listFindOneAndUpdate: vi.fn(),
  listUpdateOne: vi.fn(),
  quote: vi.fn(),
  releaseBed: vi.fn(),
  residentCreate: vi.fn(),
  residentFind: vi.fn(),
  runBillingCycle: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ connectToDatabase: vi.fn() }));
vi.mock("@/lib/after-response", () => ({ afterResponse: (work: () => unknown) => void work() }));
vi.mock("@/modules/residents/existing-resident-notify", () => ({
  notifyExistingResidentsAdded: mocks.notify,
}));
vi.mock("@/lib/hostel-day", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/hostel-day")>();

  // Aswin 2083 is "this month" for every case.
  return { ...actual, hostelPeriodOf: () => "2083-06" };
});
vi.mock("@/modules/finance/billing.service", () => ({ runBillingCycle: mocks.runBillingCycle }));
vi.mock("@/modules/finance/reference-sequence.service", () => ({
  allocateReferenceCode: mocks.allocateReferenceCode,
}));
vi.mock("@/modules/hostels/hostel-capacity.service", () => ({
  claimBedForRoomType: mocks.claimBed,
  releaseBedForRoomType: mocks.releaseBed,
}));
vi.mock("@/modules/residents/resident-intake.service", () => ({ getIntakeQuote: mocks.quote }));
vi.mock("@/modules/residents/resident.service", () => ({
  auditResidentAction: mocks.audit,
}));
vi.mock("@hostel/db/models/ExistingResidentList", () => ({
  ExistingResidentListModel: {
    findOne: mocks.listFindOne,
    findOneAndUpdate: mocks.listFindOneAndUpdate,
    updateOne: mocks.listUpdateOne,
  },
}));
vi.mock("@hostel/db/models/Hostel", () => ({
  HostelModel: {
    find: mocks.hostelFind,
    findById: mocks.hostelFindById,
    findOne: mocks.hostelFindOne,
  },
}));
vi.mock("@hostel/db/models/Invoice", () => ({
  InvoiceModel: {
    create: mocks.invoiceCreate,
    exists: mocks.invoiceExists,
    findOne: mocks.invoiceFindOne,
    updateOne: mocks.invoiceUpdateOne,
  },
}));
vi.mock("@hostel/db/models/Resident", () => ({
  ResidentModel: { create: mocks.residentCreate, find: mocks.residentFind },
}));

import {
  addExistingResidents,
  OLD_DUES_LINE,
  PART_PAID_LINE,
} from "@/modules/residents/existing-residents.service";

const hostelId = new Types.ObjectId("64f0f0f0f0f0f0f0f0f0f0a1");
const listId = new Types.ObjectId("64f0f0f0f0f0f0f0f0f0f0e1");
const principal = { userId: new Types.ObjectId("64f0f0f0f0f0f0f0f0f0f0b1") } as never;

function chain<T>(value: T) {
  const query = {
    lean: vi.fn().mockResolvedValue(value),
    select: vi.fn(),
    sort: vi.fn(),
  };

  query.select.mockReturnValue(query);
  query.sort.mockReturnValue(query);

  return query;
}

function stored(overrides: Record<string, unknown> = {}) {
  return {
    _id: new Types.ObjectId(),
    depositPaid: 10000,
    email: "",
    fullName: "Ram Thapa",
    joinedDate: null,
    monthlyRent: null,
    oldDues: 0,
    paidTill: "2083-06",
    phone: "9841234567",
    residentId: null,
    roomType: "Double",
    ...overrides,
  };
}

function withList(rows: ReturnType<typeof stored>[]) {
  mocks.listFindOneAndUpdate.mockReturnValue(
    chain({ _id: listId, rows, status: "OPEN" }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();

  mocks.hostelFindOne.mockReturnValue(
    chain({
      _id: hostelId,
      name: "Education Light",
      roomConfigurations: [{ roomType: "Double", vacantBeds: 10 }],
    }),
  );
  mocks.hostelFindById.mockReturnValue(chain({ referencePrefix: "EDL" }));
  mocks.hostelFind.mockReturnValue(chain([]));
  mocks.listFindOne.mockReturnValue(chain(null));
  mocks.residentFind.mockReturnValue(chain([]));
  mocks.quote.mockResolvedValue({ monthlyRent: 12000 });
  mocks.claimBed.mockResolvedValue(undefined);
  mocks.residentCreate.mockImplementation(async () => ({ _id: new Types.ObjectId() }));
  mocks.runBillingCycle.mockResolvedValue({ billed: [{}], failures: [], skipped: [] });
  mocks.invoiceExists.mockResolvedValue(null);
  mocks.invoiceCreate.mockResolvedValue({ _id: new Types.ObjectId() });
  mocks.allocateReferenceCode.mockResolvedValue("EDL-0001-K");
});

describe("adding the list", () => {
  it("adds residents as active, with what they paid, and no joining bill", async () => {
    withList([stored()]);

    const { result } = await addExistingResidents(hostelId, principal);

    expect(result).toEqual({ added: 1, billsRaised: 0, problems: [] });
    expect(mocks.claimBed).toHaveBeenCalledWith(hostelId, "Double");
    expect(mocks.residentCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        admissionFee: null,
        depositAmount: 10000,
        existingListId: listId,
        firstName: "Ram",
        lastName: "Thapa",
        monthlyFee: null,
        paidTill: "2083-06",
        status: "ACTIVE",
      }),
    );
    // Paid up to this month: nothing to bill, and certainly no admission invoice.
    expect(mocks.runBillingCycle).not.toHaveBeenCalled();
    expect(mocks.invoiceCreate).not.toHaveBeenCalled();
    expect(mocks.listUpdateOne).toHaveBeenLastCalledWith(
      { _id: listId },
      { $set: expect.objectContaining({ addingSince: null, status: "ADDED" }) },
    );
  });

  it("bills each unpaid month through the billing run, due at the end of this month", async () => {
    withList([
      stored({ paidTill: "2083-04" }),
      stored({ fullName: "Sita KC", paidTill: "2083-05", phone: "9801234567" }),
    ]);

    await addExistingResidents(hostelId, principal);

    const calls = mocks.runBillingCycle.mock.calls.map(([input]) => input);

    expect(calls.map((call) => call.period)).toEqual(["2083-05", "2083-06"]);
    // Bhadra is owed only by Ram; Aswin by both.
    expect(calls[0].residentIds).toHaveLength(1);
    expect(calls[1].residentIds).toHaveLength(2);
    expect(calls[0].dueDate).toEqual(calls[1].dueDate);
  });

  it("never gives a resident a rent of their own — the rate card decides", async () => {
    withList([stored({ monthlyRent: 9000 })]);

    await addExistingResidents(hostelId, principal);

    expect(mocks.residentCreate).toHaveBeenCalledWith(expect.objectContaining({ monthlyFee: null }));
    expect(mocks.residentCreate.mock.calls[0]![0]).not.toHaveProperty("feeOverrideReason");
  });

  it("raises Old dues as one bill with no month", async () => {
    withList([stored({ oldDues: 2500 })]);

    const { result } = await addExistingResidents(hostelId, principal);

    expect(mocks.invoiceCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "ADJUSTMENT",
        lines: [{ amount: 2500, basis: "MANUAL", description: OLD_DUES_LINE }],
        period: null,
        referenceCode: "EDL-0001-K",
        totalAmount: 2500,
      }),
    );
    expect(result.billsRaised).toBe(1);
  });

  it("takes a part payment off the oldest month's bill, once", async () => {
    const invoiceId = new Types.ObjectId();

    withList([stored({ paidTill: "2083-05", partPaid: 3000 })]);
    mocks.invoiceFindOne.mockReturnValue(chain({ _id: invoiceId }));

    const { result } = await addExistingResidents(hostelId, principal);

    expect(result.problems).toEqual([]);
    expect(mocks.invoiceUpdateOne).toHaveBeenCalledWith(
      {
        _id: invoiceId,
        "lines.description": { $ne: PART_PAID_LINE },
        status: "OPEN",
        totalAmount: { $gt: 3000 },
      },
      {
        $inc: { totalAmount: -3000 },
        $push: { lines: { amount: -3000, basis: "CREDIT", description: PART_PAID_LINE } },
      },
    );
  });

  it("tells each resident added in this press, with the bills made", async () => {
    withList([stored({ oldDues: 2500 }), stored({ fullName: "Sita KC", phone: "9801234567", residentId: new Types.ObjectId() })]);

    await addExistingResidents(hostelId, principal);

    expect(mocks.notify).toHaveBeenCalledWith({
      // Only Ram: Sita was added, and told, by an earlier press.
      added: [{ rent: 12000, residentId: expect.any(Types.ObjectId) }],
      billsRaised: 1,
      hostelId,
      principal,
    });
  });

  it("never links an app account itself — the person confirms it on sign-in", async () => {
    withList([stored({ email: "ram@example.com" })]);

    await addExistingResidents(hostelId, principal);

    expect(mocks.residentCreate).toHaveBeenCalledWith(
      expect.not.objectContaining({ userId: expect.anything() }),
    );
  });
});

describe("retries and refusals", () => {
  it("skips rows already added, and does not raise their Old dues twice", async () => {
    const residentId = new Types.ObjectId();

    withList([stored({ oldDues: 2500, paidTill: "2083-05", residentId })]);
    mocks.invoiceExists.mockResolvedValue({ _id: new Types.ObjectId() });

    const { result } = await addExistingResidents(hostelId, principal);

    expect(mocks.residentCreate).not.toHaveBeenCalled();
    expect(mocks.claimBed).not.toHaveBeenCalled();
    expect(mocks.invoiceCreate).not.toHaveBeenCalled();
    // The billing run is idempotent on its own, so it is simply asked again.
    expect(mocks.runBillingCycle.mock.calls[0]![0].residentIds).toEqual([residentId]);
    expect(result.added).toBe(0);
  });

  it("records each resident on its row as soon as it exists", async () => {
    const row = stored();

    withList([row]);

    await addExistingResidents(hostelId, principal);

    expect(mocks.listUpdateOne).toHaveBeenCalledWith(
      { _id: listId, "rows._id": row._id },
      { $set: { "rows.$.residentId": expect.any(Types.ObjectId) } },
    );
  });

  it("refuses a list with problems, adds nobody and lets go of the lock", async () => {
    withList([stored({ fullName: "Ram" })]);

    await expect(addExistingResidents(hostelId, principal)).rejects.toMatchObject({
      errorCode: "EXISTING_RESIDENTS_NOT_READY",
      status: 422,
    });

    expect(mocks.residentCreate).not.toHaveBeenCalled();
    expect(mocks.listUpdateOne).toHaveBeenCalledWith(
      { _id: listId },
      { $set: { addingSince: null } },
    );
  });

  it("says the list is busy when another press is already adding it", async () => {
    mocks.listFindOneAndUpdate.mockReturnValue(chain(null));
    mocks.listFindOne.mockReturnValue(
      chain({ _id: listId, addingSince: new Date(), rows: [], status: "OPEN" }),
    );

    await expect(addExistingResidents(hostelId, principal)).rejects.toMatchObject({
      errorCode: "EXISTING_RESIDENTS_BUSY",
      status: 409,
    });
  });

  it("gives the bed back and keeps the row open when a resident cannot be saved", async () => {
    withList([stored()]);
    mocks.residentCreate.mockRejectedValue(Object.assign(new Error("dup"), { code: 11000 }));

    const { result } = await addExistingResidents(hostelId, principal);

    expect(mocks.releaseBed).toHaveBeenCalledWith(hostelId, "Double");
    expect(result.problems).toEqual([
      { message: "Phone or email is already used in this hostel.", name: "Ram Thapa" },
    ]);
    expect(mocks.listUpdateOne).toHaveBeenLastCalledWith(
      { _id: listId },
      { $set: expect.objectContaining({ status: "OPEN" }) },
    );
  });
});
