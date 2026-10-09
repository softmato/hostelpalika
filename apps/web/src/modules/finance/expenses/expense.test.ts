/**
 * Money Out — docs/EXPENSES_PLAN.md step 1.
 *
 * What these lock in is the line the whole feature is built around: the owner
 * sees the hostel's totals, and a warden or the cook adds and sees only their
 * own rows. The rest is the arithmetic that line protects — *Out* counts only
 * rows that still stand, *In* is binned by the Nepal day the money settled, and
 * a retried Save never adds a second row.
 */
import { Types } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiPrincipal } from "@/lib/api-auth";
import { fromBs } from "@/lib/hostel-day";
import { Role } from "@/lib/roles";

const hostelId = new Types.ObjectId("64f0f0f0f0f0f0f0f0f0f0a1");
const ownerId = new Types.ObjectId("64f0f0f0f0f0f0f0f0f0f0b1");
const wardenId = new Types.ObjectId("64f0f0f0f0f0f0f0f0f0f0b2");
const cookId = new Types.ObjectId("64f0f0f0f0f0f0f0f0f0f0b3");
const assetId = new Types.ObjectId("64f0f0f0f0f0f0f0f0f0f0c1");

const mocks = vi.hoisted(() => ({
  notify: vi.fn(),
  aggregate: vi.fn(),
  assetFindOne: vi.fn(),
  audit: vi.fn(),
  categoryCount: vi.fn(),
  categoryCreate: vi.fn(),
  categoryExists: vi.fn(),
  categoryFind: vi.fn(),
  categoryFindById: vi.fn(),
  categoryFindOne: vi.fn(),
  cookFind: vi.fn(),
  cookFindOne: vi.fn(),
  eventFind: vi.fn(),
  expenseCreate: vi.fn(),
  expenseFind: vi.fn(),
  expenseFindOne: vi.fn(),
  expenseFindOneAndUpdate: vi.fn(),
  hostelFindById: vi.fn(),
  memberExists: vi.fn(),
  memberFind: vi.fn(),
  settingsFindOne: vi.fn(),
  userFind: vi.fn(),
  userFindById: vi.fn(),
}));

/** A Mongoose query stand-in: every builder returns itself, `lean()` resolves. */
function query<T>(result: T) {
  const chain = {
    lean: () => Promise.resolve(result),
    limit: () => chain,
    select: () => chain,
    sort: () => chain,
  };

  return chain;
}

vi.mock("@/modules/notifications/notification.service", () => ({ createInAppNotification: mocks.notify }));
vi.mock("@/modules/finance/finance-notify", () => ({ notifyHostelAdmins: vi.fn() }));
vi.mock("@/lib/db", () => ({ connectToDatabase: vi.fn() }));
vi.mock("@/modules/finance/audit-finance", () => ({ auditFinanceAction: mocks.audit }));
vi.mock("@hostel/db/models/Expense", () => ({
  ExpenseModel: {
    aggregate: mocks.aggregate,
    create: mocks.expenseCreate,
    find: mocks.expenseFind,
    findOne: mocks.expenseFindOne,
    findOneAndUpdate: mocks.expenseFindOneAndUpdate,
  },
}));
vi.mock("@hostel/db/models/HostelExpenseCategory", () => ({
  HostelExpenseCategoryModel: {
    countDocuments: mocks.categoryCount,
    create: mocks.categoryCreate,
    exists: mocks.categoryExists,
    find: mocks.categoryFind,
    findById: mocks.categoryFindById,
    findOne: mocks.categoryFindOne,
  },
}));
vi.mock("@hostel/db/models/FileAsset", () => ({ FileAssetModel: { findOne: mocks.assetFindOne } }));
vi.mock("@hostel/db/models/Hostel", () => ({ HostelModel: { findById: mocks.hostelFindById } }));
vi.mock("@hostel/db/models/HostelSettings", () => ({
  HostelSettingsModel: { findOne: mocks.settingsFindOne },
}));
vi.mock("@hostel/db/models/HostelMember", () => ({
  HostelMemberModel: { exists: mocks.memberExists, find: mocks.memberFind },
}));
vi.mock("@hostel/db/models/CookAccount", () => ({
  CookAccountModel: { find: mocks.cookFind, findOne: mocks.cookFindOne },
}));
vi.mock("@hostel/db/models/User", () => ({
  UserModel: { find: mocks.userFind, findById: mocks.userFindById },
}));
vi.mock("@hostel/db/models/PaymentEvent", () => ({ PaymentEventModel: { find: mocks.eventFind } }));

import {
  readExpenseReceipt,
  createExpense,
  getExpenseHome,
  listStaffWallets,
  parseSpentOn,
  resolveExpenseActor,
  respondToStaffCash,
  voidExpense,
} from "@/modules/finance/expenses/expense.service";

const principal = (role: Role, userId: Types.ObjectId): ApiPrincipal => ({
  hostelIds: [hostelId.toString()],
  role,
  userId: userId.toString(),
});

const owner = principal(Role.HOSTEL_ADMIN, ownerId);
const warden = principal(Role.WARDEN, wardenId);
const cook = principal(Role.COOK, cookId);

function expense(overrides: Record<string, unknown> = {}) {
  return {
    _id: new Types.ObjectId(),
    amount: 1000,
    category: "GROCERIES",
    createdAt: new Date("2026-10-01T05:00:00Z"),
    customCategoryId: null,
    paidBy: "CASH",
    payer: "HOSTEL",
    photoAssetId: null,
    recordedBy: ownerId,
    recordedByName: "Owner",
    recordedByRole: "HOSTEL_ADMIN",
    salaryFor: null,
    spentOn: new Date("2026-10-01T00:00:00Z"),
    status: "RECORDED",
    what: "",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.categoryFind.mockReturnValue(query([]));
  mocks.memberFind.mockReturnValue(query([]));
  mocks.cookFind.mockReturnValue(query([]));
  mocks.userFind.mockReturnValue(query([]));
  mocks.userFindById.mockReturnValue(query({ name: "Hari" }));
  mocks.cookFindOne.mockReturnValue(query(null));
  mocks.eventFind.mockReturnValue(query([]));
  mocks.aggregate.mockResolvedValue([]);
  mocks.expenseFind.mockReturnValue(query([]));
  mocks.expenseFindOne.mockReturnValue(query(null));
  mocks.memberExists.mockResolvedValue(null);
  mocks.hostelFindById.mockReturnValue(query({ parentHostelId: null }));
});

/** Month totals group on `null`; the cash-box reads group per person and get nothing here. */
function monthTotalOnly(total: number) {
  return (pipeline: { $group?: { _id: unknown } }[]) =>
    Promise.resolve(pipeline[1]?.$group?._id === null ? [{ total }] : []);
}

describe("the day the money went", () => {
  const now = new Date("2026-10-01T10:00:00Z");

  it("is today in Nepal when the user does not change it", () => {
    expect(parseSpentOn(undefined, now).toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });

  it("follows Nepal's day, not UTC's, late in the evening", () => {
    // 19:00 UTC is already the next morning in Kathmandu.
    expect(parseSpentOn(undefined, new Date("2026-10-01T19:00:00Z")).toISOString()).toBe(
      "2026-10-02T00:00:00.000Z",
    );
  });

  it("refuses a day that has not happened yet", () => {
    expect(() => parseSpentOn("2026-10-02", now)).toThrow(/future/);
  });

  it("refuses a date that does not exist rather than rolling it over", () => {
    expect(() => parseSpentOn("2026-02-30", now)).toThrow(/does not exist/);
  });

  it("refuses a year that is almost certainly a typo", () => {
    expect(() => parseSpentOn("2024-10-01", now)).toThrow(/too long ago/);
  });
});

describe("who may add", () => {
  it("gives the owner the whole hostel", async () => {
    const actor = await resolveExpenseActor(owner);

    expect(actor.canSeeAll).toBe(true);
    expect(actor.role).toBe("HOSTEL_ADMIN");
  });

  it("gives a warden their own rows only", async () => {
    const actor = await resolveExpenseActor(warden);

    expect(actor.canSeeAll).toBe(false);
    expect(actor.role).toBe("WARDEN");
  });

  it("refuses the cook until the owner turns it on", async () => {
    mocks.settingsFindOne.mockReturnValue(query({ cookCanRecordExpenses: false }));

    await expect(resolveExpenseActor(cook)).rejects.toMatchObject({
      errorCode: "EXPENSES_OFF_FOR_COOK",
      status: 403,
    });
  });

  it("lets the cook add once the owner has turned it on", async () => {
    mocks.settingsFindOne.mockReturnValue(query({ cookCanRecordExpenses: true }));

    const actor = await resolveExpenseActor(cook);

    expect(actor).toMatchObject({ canSeeAll: false, role: "COOK" });
  });

  it("refuses anyone else", async () => {
    await expect(resolveExpenseActor(principal(Role.RESIDENT, ownerId))).rejects.toMatchObject({
      status: 403,
    });
  });
});

describe("the month", () => {
  const period = "2083-06";
  const asojFirst = fromBs({ day: 1, month: 6, year: 2083 });

  it("never shows a warden the hostel's totals, and reads only their rows", async () => {
    mocks.expenseFind.mockReturnValue(
      query([expense({ amount: 400, recordedBy: wardenId, recordedByRole: "WARDEN" })]),
    );

    const home = await getExpenseHome(await resolveExpenseActor(warden), period);

    expect(home.totals).toBeNull();
    expect(home.canSeeTotals).toBe(false);
    expect(home.mine).toEqual({ count: 1, out: 400 });
    // Their own rows, and cash handed to them — nobody else's.
    expect(mocks.expenseFind.mock.calls[0]?.[0]).toMatchObject({
      $or: [{ recordedBy: wardenId }, { category: "STAFF_CASH", "cashTo.userId": wardenId }],
    });
    expect(home.wallets).toBeNull();
    expect(home.wallet).toMatchObject({ left: 0 });
    expect(mocks.eventFind).not.toHaveBeenCalled();
  });

  it("gives the owner In, Out and Left, counting only rows that still stand", async () => {
    mocks.expenseFind.mockReturnValue(
      query([
        expense({ amount: 3000, category: "GROCERIES", spentOn: asojFirst }),
        expense({ amount: 1200, category: "GAS", recordedBy: wardenId, recordedByRole: "WARDEN", spentOn: asojFirst }),
        expense({ amount: 900, category: "GROCERIES", spentOn: asojFirst, status: "VOID" }),
        expense({ amount: 500, category: "GROCERIES", spentOn: asojFirst }),
      ]),
    );
    mocks.eventFind.mockReturnValue(
      query([
        { amount: 12000, direction: "CREDIT", settledAt: new Date(asojFirst.getTime() + 6 * 3600_000) },
        { amount: 2000, direction: "DEBIT", settledAt: new Date(asojFirst.getTime() + 8 * 3600_000) },
        // 18:20 UTC the evening *before* 1 Asoj is already 1 Asoj in Kathmandu.
        { amount: 5000, direction: "CREDIT", settledAt: new Date(asojFirst.getTime() - 5 * 3600_000 + 300_000) },
        // A full day earlier is Bhadra's money.
        { amount: 7000, direction: "CREDIT", settledAt: new Date(asojFirst.getTime() - 20 * 3600_000) },
      ]),
    );
    mocks.aggregate.mockImplementation(monthTotalOnly(4000));

    const home = await getExpenseHome(await resolveExpenseActor(owner), period);

    expect(home.totals).toMatchObject({
      in: 15000,
      lastMonthOut: 4000,
      left: 15000 - 4700,
      out: 4700,
      staffCount: 1,
    });
    expect(home.totals?.byCategory.map((row) => [row.category, row.amount])).toEqual([
      ["GROCERIES", 3500],
      ["GAS", 1200],
    ]);
    // The void row is still listed — the owner sees the mistake and its fix.
    expect(home.expenses).toHaveLength(4);
  });

  it("does not count cash handed to a warden as spending", async () => {
    mocks.expenseFind.mockReturnValue(
      query([
        expense({ amount: 1000, category: "GROCERIES", spentOn: asojFirst }),
        expense({
          amount: 5000,
          cashStatus: "ACCEPTED",
          cashTo: { name: "Hari", userId: wardenId },
          category: "STAFF_CASH",
          spentOn: asojFirst,
        }),
      ]),
    );
    mocks.aggregate.mockImplementation(monthTotalOnly(0));

    const home = await getExpenseHome(await resolveExpenseActor(owner), period);

    expect(home.totals?.out).toBe(1000);
    expect(home.totals?.byCategory.map((row) => row.category)).toEqual(["GROCERIES"]);
    expect(home.expenses).toHaveLength(2);
  });

  it("answers a month before the calendar floor with a sentence, not a crash", async () => {
    await expect(getExpenseHome(await resolveExpenseActor(owner), "2001-01")).rejects.toMatchObject({
      errorCode: "INVALID_PERIOD",
      status: 422,
    });
  });

  it("pulls a month that has not started back to this one", async () => {
    const home = await getExpenseHome(await resolveExpenseActor(owner), "2199-01");

    expect(home.period).toBe(home.currentPeriod);
  });
});

describe("adding an expense", () => {
  const input = { amount: 2400, category: "GROCERIES" as const, paidBy: "CASH" as const };

  beforeEach(() => {
    mocks.expenseCreate.mockImplementation(async (doc: Record<string, unknown>) => ({
      toObject: () => ({ _id: new Types.ObjectId(), createdAt: new Date(), ...doc }),
    }));
  });

  it("refuses a warden's expense without a bill photo unless the owner waived it", async () => {
    await expect(createExpense(await resolveExpenseActor(warden), input)).rejects.toMatchObject({
      errorCode: "PROOF_REQUIRED",
      status: 422,
    });
    expect(mocks.expenseCreate).not.toHaveBeenCalled();
  });

  it("lets only the owner hand cash, and only to a warden who can add expenses", async () => {
    const cash = { ...input, cashTo: { userId: wardenId.toString() }, category: "STAFF_CASH" as const };

    await expect(createExpense(await resolveExpenseActor(warden), cash)).rejects.toMatchObject({ status: 403 });

    mocks.memberFind.mockReturnValue(query([{ permissions: [], userId: wardenId }]));
    mocks.userFind.mockReturnValue(query([{ _id: wardenId, name: "Hari" }]));
    await expect(createExpense(await resolveExpenseActor(owner), cash)).rejects.toMatchObject({
      errorCode: "CASH_TO_NOT_STAFF",
    });

    mocks.memberFind.mockReturnValue(query([{ permissions: ["recordExpenses"], userId: wardenId }]));
    await createExpense(await resolveExpenseActor(owner), cash);

    expect(mocks.expenseCreate.mock.calls[0]?.[0]).toMatchObject({
      cashStatus: "PENDING",
      cashTo: { name: "Hari", userId: wardenId },
      payer: "HOSTEL",
    });
    expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({ userId: wardenId.toString() }));
  });

  it("records a warden's spending as paid by staff, under their name", async () => {
    mocks.memberExists.mockResolvedValue({ _id: wardenId });
    const row = await createExpense(await resolveExpenseActor(warden), input);

    expect(mocks.expenseCreate.mock.calls[0]?.[0]).toMatchObject({
      payer: "STAFF",
      recordedByName: "Hari",
      recordedByRole: "WARDEN",
    });
    expect(row.expense).toMatchObject({ amount: 2400, mine: true, status: "RECORDED" });
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "EXPENSE_RECORDED", amountAfter: 2400 }),
    );
  });

  it("notifies only the receipt recorder and never repeats on retry", async () => {
    mocks.assetFindOne.mockReturnValue(query({ hostelId, kind: "EXPENSE_RECEIPT", ownerId, uploadCompletedAt: new Date() }));
    const actor = await resolveExpenseActor(owner);
    const shared = { ...input, sharedReceipt: true, photoAssetId: assetId.toString(), clientRequestId: "receipt-123456" };
    const result = await createExpense(actor, shared);
    expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({
      userId: ownerId.toString(), hostelId: hostelId.toString(), kind: "NORMAL",
      data: { expenseId: result.expense.id, type: "SHARED_RECEIPT_SAVED" },
    }));
    mocks.expenseFindOne.mockReturnValue(query(expense()));
    await createExpense(actor, shared);
    expect(mocks.notify).toHaveBeenCalledTimes(1);
  });

  it("refuses a receipt already saved anywhere in the hostel group, naming the branch", async () => {
    const hash = "ab".repeat(32);
    const mainId = new Types.ObjectId();
    mocks.assetFindOne.mockReturnValue(query({ contentHash: hash, hostelId, kind: "EXPENSE_RECEIPT", ownerId, receiptTxnId: "8823119471", uploadCompletedAt: new Date() }));
    // This hostel is a branch; the row sits in the main hostel.
    mocks.hostelFindById.mockReturnValueOnce(query({ parentHostelId: mainId })).mockReturnValueOnce(query({ name: "Sunrise Main" }));
    mocks.expenseFindOne.mockReturnValueOnce(query(null)).mockReturnValueOnce(query(expense({ amount: 300, hostelId: mainId, recordedByName: "Hari" })));
    const shared = { ...input, sharedReceipt: true, photoAssetId: assetId.toString(), clientRequestId: "receipt-other-bytes" };
    await expect(createExpense(await resolveExpenseActor(owner), shared)).rejects.toMatchObject({
      errorCode: "RECEIPT_ALREADY_SAVED", message: "Already added: Rs 300 by Hari in Sunrise Main.", status: 409,
    });
    expect(mocks.expenseFindOne.mock.calls[1]?.[0]).toEqual({
      receiptGroupId: mainId, status: "RECORDED", $or: [{ receiptHash: hash }, { receiptTxnId: "8823119471" }],
    });
    expect(mocks.expenseCreate).not.toHaveBeenCalled();
  });

  it("stamps the receipt's group, hash and transaction id, and lets the device own the saved notice", async () => {
    mocks.assetFindOne.mockReturnValue(query({ contentHash: "cd".repeat(32), hostelId, kind: "EXPENSE_RECEIPT", ownerId, receiptTxnId: "8823119471", uploadCompletedAt: new Date() }));
    await createExpense(await resolveExpenseActor(owner), { ...input, sharedReceipt: true, notifiedOnDevice: true, photoAssetId: assetId.toString() });
    expect(mocks.expenseCreate.mock.calls[0]?.[0]).toMatchObject({ receiptGroupId: hostelId, receiptHash: "cd".repeat(32), receiptTxnId: "8823119471" });
    expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({ push: false }));
  });

  it("leaves ordinary photo expenses out of the receipt check", async () => {
    mocks.assetFindOne.mockReturnValue(query({ contentHash: "cd".repeat(32), hostelId, kind: "EXPENSE_RECEIPT", ownerId, uploadCompletedAt: new Date() }));
    await createExpense(await resolveExpenseActor(owner), { ...input, photoAssetId: assetId.toString() });
    expect(mocks.expenseCreate.mock.calls[0]?.[0]).toMatchObject({ receiptGroupId: null, receiptHash: null });
  });

  it("keeps Save successful if notifications fail", async () => {
    mocks.assetFindOne.mockReturnValue(query({ hostelId, kind: "EXPENSE_RECEIPT", ownerId, uploadCompletedAt: new Date() }));
    mocks.notify.mockRejectedValueOnce(new Error("offline"));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await createExpense(await resolveExpenseActor(owner), { ...input, sharedReceipt: true, photoAssetId: assetId.toString() });
      expect(result.duplicate).toBe(false);
    } finally { warning.mockRestore(); }
  });

  it("does not notify for ordinary manual expenses", async () => {
    await createExpense(await resolveExpenseActor(owner), input);
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it("records the owner's spending as the hostel's", async () => {
    await createExpense(await resolveExpenseActor(owner), input);

    expect(mocks.expenseCreate.mock.calls[0]?.[0]).toMatchObject({ payer: "HOSTEL" });
  });

  it("returns the saved row when the same Save arrives twice", async () => {
    const saved = expense({ amount: 2400, clientRequestId: "save-123456" });
    mocks.expenseFindOne.mockReturnValue(query(saved));

    const result = await createExpense(await resolveExpenseActor(owner), {
      ...input,
      clientRequestId: "save-123456",
    });

    expect(result.duplicate).toBe(true);
    expect(result.expense.id).toBe(saved._id.toString());
    expect(mocks.expenseCreate).not.toHaveBeenCalled();
  });

  it("refuses a photo somebody else uploaded", async () => {
    mocks.assetFindOne.mockReturnValue(
      query({ hostelId, kind: "EXPENSE_RECEIPT", ownerId, uploadCompletedAt: new Date() }),
    );

    await expect(
      createExpense(await resolveExpenseActor(warden), { ...input, photoAssetId: assetId.toString() }),
    ).rejects.toMatchObject({ errorCode: "ASSET_NOT_OWNED" });
  });

  it("refuses a photo that was not uploaded as an expense photo", async () => {
    mocks.assetFindOne.mockReturnValue(
      query({ hostelId, kind: "GENERIC", ownerId: wardenId, uploadCompletedAt: new Date() }),
    );

    await expect(
      createExpense(await resolveExpenseActor(warden), { ...input, photoAssetId: assetId.toString() }),
    ).rejects.toMatchObject({ errorCode: "ASSET_NOT_OWNED" });
  });

  it("refuses one of the hostel's own categories that is hidden or gone", async () => {
    mocks.categoryFindOne.mockReturnValue(query(null));

    await expect(
      createExpense(await resolveExpenseActor(owner), {
        ...input,
        category: "CUSTOM",
        customCategoryId: new Types.ObjectId().toString(),
      }),
    ).rejects.toMatchObject({ errorCode: "CATEGORY_NOT_FOUND" });
  });
});

describe("cancelling an expense", () => {
  it("lets a warden cancel only their own rows", async () => {
    const id = new Types.ObjectId().toString();

    await expect(voidExpense(await resolveExpenseActor(warden), id, "Wrong amount")).rejects.toMatchObject({
      errorCode: "EXPENSE_NOT_FOUND",
    });
    expect(mocks.expenseFindOne.mock.calls[0]?.[0]).toMatchObject({ recordedBy: wardenId });
  });

  it("refuses to cancel twice", async () => {
    mocks.expenseFindOne.mockReturnValue(query(expense({ status: "VOID" })));

    await expect(
      voidExpense(await resolveExpenseActor(owner), new Types.ObjectId().toString(), "Wrong amount"),
    ).rejects.toMatchObject({ errorCode: "EXPENSE_ALREADY_VOID", status: 409 });
  });

  it("keeps the row and the reason, and audits the change", async () => {
    const row = expense({ amount: 750 });
    mocks.expenseFindOne.mockReturnValue(query(row));
    mocks.expenseFindOneAndUpdate.mockReturnValue(
      query({ ...row, status: "VOID", voidReason: "Wrong amount", voidedAt: new Date() }),
    );

    const result = await voidExpense(await resolveExpenseActor(owner), row._id.toString(), "Wrong amount");

    expect(result).toMatchObject({ status: "VOID", voidReason: "Wrong amount" });
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "EXPENSE_VOIDED", amountAfter: 0, amountBefore: 750 }),
    );
  });
});


describe("shared expense receipt read", () => {
  it("refuses another hostel's receipt before reading its bytes", async () => {
    mocks.assetFindOne.mockReturnValue(query({ hostelId: new Types.ObjectId(), ownerId, kind: "EXPENSE_RECEIPT", uploadCompletedAt: new Date() }));
    const actor = await resolveExpenseActor(owner);
    await expect(readExpenseReceipt(actor, assetId.toString())).rejects.toMatchObject({ errorCode: "ASSET_NOT_OWNED" });
  });
  it("refuses another user's receipt in the same hostel", async () => {
    mocks.assetFindOne.mockReturnValue(query({ hostelId, ownerId: wardenId, kind: "EXPENSE_RECEIPT", uploadCompletedAt: new Date() }));
    const actor = await resolveExpenseActor(owner);
    await expect(readExpenseReceipt(actor, assetId.toString())).rejects.toMatchObject({ errorCode: "ASSET_NOT_OWNED" });
  });
});

describe("cash boxes", () => {
  it("fills a box only with cash the warden confirmed, less what they spent", async () => {
    mocks.aggregate
      .mockResolvedValueOnce([
        { _id: { status: "ACCEPTED", user: wardenId }, name: "Hari", total: 5000 },
        { _id: { status: "PENDING", user: wardenId }, name: "Hari", total: 1000 },
      ])
      .mockResolvedValueOnce([{ _id: wardenId, name: "Hari", total: 6200 }]);

    const [box] = await listStaffWallets(hostelId, []);

    // Spent past what was handed over: the hostel owes Hari Rs 1,200.
    expect(box).toEqual({ given: 5000, left: -1200, name: "Hari", pending: 1000, spent: 6200, userId: wardenId.toString() });
  });

  it("lets only the warden it was given to answer, and only once", async () => {
    mocks.expenseFindOneAndUpdate.mockReturnValue(query(null));
    const id = new Types.ObjectId().toString();

    await expect(respondToStaffCash(await resolveExpenseActor(warden), id, { accept: true })).rejects.toMatchObject({
      errorCode: "CASH_NOT_PENDING",
    });
    expect(mocks.expenseFindOneAndUpdate.mock.calls[0]?.[0]).toMatchObject({
      cashStatus: "PENDING",
      "cashTo.userId": wardenId,
      hostelId,
    });
    await expect(respondToStaffCash(await resolveExpenseActor(owner), id, { accept: true })).rejects.toMatchObject({
      status: 404,
    });
  });
});
