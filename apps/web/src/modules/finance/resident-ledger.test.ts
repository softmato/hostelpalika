/**
 * The per-resident payment track behind the owner's side sheet.
 *
 * The behaviour worth pinning is the spine: rows come from the calendar, not
 * from the invoice list. A month that was never billed has to appear as a gap
 * the owner can see, because a gap is almost always a billing run that skipped
 * somebody — and a list built from invoices would render that month by simply
 * not existing.
 */
import { Types } from "mongoose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  eventFind: vi.fn(),
  listResidentInvoices: vi.fn(),
  receiptFind: vi.fn(),
  residentFindOne: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ connectToDatabase: vi.fn() }));

vi.mock("@/modules/finance/ledger-read.service", () => ({
  listResidentInvoices: mocks.listResidentInvoices,
}));

vi.mock("@hostel/db/models/PaymentEvent", () => ({
  PaymentEventModel: { find: mocks.eventFind },
}));

vi.mock("@hostel/db/models/Receipt", () => ({
  ReceiptModel: { find: mocks.receiptFind },
}));

vi.mock("@hostel/db/models/Invoice", () => ({
  InvoiceModel: {
    find: () => ({ select: () => ({ lean: async () => [] }) }),
  },
}));

vi.mock("@hostel/db/models/Resident", () => ({
  ResidentModel: { findOne: mocks.residentFindOne },
}));

import { addBsMonths, bsPeriodBounds, bsPeriodOf } from "@/lib/hostel-day";
import { getResidentLedger } from "@/modules/finance/resident-ledger.service";

const hostelId = new Types.ObjectId("64f0f0f0f0f0f0f0f0f0f0a1");
const residentId = new Types.ObjectId("64f0f0f0f0f0f0f0f0f0f0c1");
const invoiceId = new Types.ObjectId("64f0f0f0f0f0f0f0f0f0f0d1");
const eventId = new Types.ObjectId("64f0f0f0f0f0f0f0f0f0f0e1");

function chain<T>(rows: T) {
  return {
    lean: vi.fn().mockResolvedValue(rows),
    limit: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    sort: vi.fn().mockReturnThis(),
  };
}

/**
 * The clock these rows are counted from.
 *
 * Frozen because the spine of this ledger is a run of **Bikram Sambat** months
 * and the fixtures have to name the same ones. Stepping a Gregorian month off a
 * live `new Date()` — which is what this did — is how the service and its test
 * agreed with each other for a year while both disagreed with the invoices.
 *
 * 5 September 2026 is Bhadra 20, 2083. Bhadra 2083 runs 17 August to 16
 * September 2026; `bs-calendar.test.ts` pins that against a published calendar.
 */
const NOW = new Date("2026-09-05T06:00:00.000Z");
const CURRENT_PERIOD = "2083-05";

/** `months` back from the frozen month, in the calendar an invoice is keyed by. */
function periodAgo(months: number) {
  return addBsMonths(CURRENT_PERIOD, -months);
}

/**
 * A move-in instant inside the BS month `periodAgo(months)` names.
 *
 * That month's own first day. The 1st of a Gregorian month lands wherever the
 * BS boundary happens to fall — BS months are 29 to 32 days and the offset moves
 * every year — so a resident whose fixture said "two months ago" could open the
 * ledger a month away from the period the assertion below names.
 */
function moveInDate(months: number) {
  return bsPeriodBounds(periodAgo(months)).start;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Only `Date`. Faking timers wholesale would stall the awaited mocks below.
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  mocks.residentFindOne.mockReturnValue(
    chain({
      _id: residentId,
      bedType: "DOUBLE",
      firstName: "Ram",
      hostelId,
      lastName: "Thapa",
      moveInDate: moveInDate(2),
      phone: "9800000000",
      roomType: "Double sharing",
    }),
  );
  mocks.listResidentInvoices.mockResolvedValue([]);
  mocks.eventFind.mockReturnValue(chain([]));
  mocks.receiptFind.mockReturnValue(chain([]));
});

afterEach(() => {
  vi.useRealTimers();
});

/** The anchor the fixtures lean on, asserted rather than assumed. */
it("puts the frozen day in Bhadra 2083", () => {
  expect(bsPeriodOf(NOW)).toBe(CURRENT_PERIOD);
});

describe("getResidentLedger", () => {
  it("returns one row per month from move-in to now, with no gaps", async () => {
    const ledger = await getResidentLedger(hostelId, residentId.toString());

    // Move-in month, the one after, and the current month.
    expect(ledger?.months).toHaveLength(3);
    expect(ledger?.months.map((month) => month.period)).toEqual([
      periodAgo(0),
      periodAgo(1),
      periodAgo(2),
    ]);
  });

  it("marks an unbilled month NOT_BILLED rather than omitting it", async () => {
    const ledger = await getResidentLedger(hostelId, residentId.toString());

    expect(ledger?.months.every((month) => month.status === "NOT_BILLED")).toBe(true);
    expect(ledger?.totals.monthsBilled).toBe(0);
  });

  it("attaches each settled payment to the month it paid for", async () => {
    mocks.listResidentInvoices.mockResolvedValue([
      {
        dueAmount: 12000,
        dueDate: new Date(),
        hostelId: hostelId.toString(),
        id: invoiceId.toString(),
        paidAmount: 12000,
        period: periodAgo(1),
        residentId: residentId.toString(),
        status: "PAID",
      },
    ]);
    mocks.eventFind.mockReturnValue(
      chain([
        {
          _id: eventId,
          amount: 12000,
          invoiceId,
          occurredAt: new Date("2026-07-05T09:00:00.000Z"),
          provider: "ESEWA",
          providerTxnId: "8823119471",
          rawPayload: {},
          settledAt: new Date("2026-07-05T10:00:00.000Z"),
        },
      ]),
    );
    mocks.receiptFind.mockReturnValue(
      chain([{ eventId, receiptNumber: "RCP-EDU-2026-07-00001" }]),
    );

    const ledger = await getResidentLedger(hostelId, residentId.toString());
    const billed = ledger?.months.find((month) => month.period === periodAgo(1));

    expect(billed?.status).toBe("PAID");
    expect(billed?.payments).toEqual([
      expect.objectContaining({
        amount: 12000,
        method: "ESEWA",
        receiptNumber: "RCP-EDU-2026-07-00001",
        transactionCode: "8823119471",
      }),
    ]);
    expect(ledger?.totals.paid).toBe(12000);
  });

  it("scopes the lookup to the hostel, so another tenant's id reads as missing", async () => {
    mocks.residentFindOne.mockReturnValue(chain(null));

    await expect(
      getResidentLedger(hostelId, residentId.toString()),
    ).resolves.toBeNull();
    expect(mocks.residentFindOne).toHaveBeenCalledWith(
      expect.objectContaining({ hostelId }),
    );
  });

  it("refuses a malformed id before touching the database", async () => {
    await expect(getResidentLedger(hostelId, "not-an-id")).resolves.toBeNull();
    expect(mocks.residentFindOne).not.toHaveBeenCalled();
  });

  it("caps the window so a bad move-in date cannot render a century of rows", async () => {
    mocks.residentFindOne.mockReturnValue(
      chain({
        _id: residentId,
        firstName: "Ram",
        hostelId,
        lastName: "Thapa",
        moveInDate: new Date("1970-01-01T00:00:00.000Z"),
      }),
    );

    const ledger = await getResidentLedger(hostelId, residentId.toString());

    expect(ledger?.months).toHaveLength(120);
  });
});
