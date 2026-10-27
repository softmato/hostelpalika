/**
 * Pay instructions — Block 3 item 3.3 of docs/FINANCE_IMPLEMENTATION_PLAN.md
 * (target §11.1).
 *
 * The three things that can go wrong here all cost the resident money or the
 * owner an afternoon: showing the full invoice total on a part-paid month,
 * rendering a blank card when the hostel has configured nothing, and losing the
 * reference code — without which the transfer lands in the owner's queue as an
 * unidentifiable credit.
 */
import { Types } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiPrincipal } from "@/lib/api-auth";
import { Role } from "@/lib/roles";

const mocks = vi.hoisted(() => ({
  balanceFindOne: vi.fn(),
  findCurrentResident: vi.fn(),
  getCreditAmount: vi.fn(),
  invoiceFindOne: vi.fn(),
  profileFindOne: vi.fn(),
}));

vi.mock("@/modules/finance/credit-balance.service", () => ({
  getCreditAmount: mocks.getCreditAmount,
}));

vi.mock("@/lib/db", () => ({ connectToDatabase: vi.fn() }));

vi.mock("@/modules/residents/resident-access", () => ({
  findCurrentResident: mocks.findCurrentResident,
}));

vi.mock("@hostel/db/models/Invoice", () => ({
  InvoiceModel: { findOne: mocks.invoiceFindOne },
}));

vi.mock("@hostel/db/models/InvoiceBalance", () => ({
  InvoiceBalanceModel: { findOne: mocks.balanceFindOne },
}));

/**
 * Which adapters have shipped is a Block 6 schedule detail, not something these
 * assertions are about — so the registry is stubbed to report both wallets as
 * available, and one test below covers the case where an adapter is missing.
 */
vi.mock("@/modules/finance/gateway/registry", () => ({
  hasProvider: (provider: string) => provider !== "FONEPAY",
}));

vi.mock("@hostel/db/models/HostelPaymentProfile", async () => {
  const actual = await vi.importActual<
    typeof import("@hostel/db/models/HostelPaymentProfile")
  >("@hostel/db/models/HostelPaymentProfile");

  return {
    ...actual,
    HostelPaymentProfileModel: { findOne: mocks.profileFindOne },
  };
});

const { getHostelPayMethods, getPayInstructions } = await import(
  "./pay-instructions.service"
);

const hostelId = new Types.ObjectId();
const residentId = new Types.ObjectId();
const invoiceId = new Types.ObjectId();
const qrAssetId = new Types.ObjectId();

const principal = {
  role: Role.RESIDENT,
  userId: new Types.ObjectId().toString(),
} as unknown as ApiPrincipal;

function lean<T>(value: T) {
  return { lean: () => Promise.resolve(value) };
}

const invoice = {
  _id: invoiceId,
  dueDate: new Date("2026-09-30T00:00:00.000Z"),
  hostelId,
  period: "2026-09",
  referenceCode: "EDU-0001-F",
  status: "OPEN",
  totalAmount: 10000,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findCurrentResident.mockResolvedValue({ _id: residentId, hostelId });
  mocks.invoiceFindOne.mockReturnValue(lean(invoice));
  mocks.balanceFindOne.mockReturnValue(lean(null));
  mocks.getCreditAmount.mockResolvedValue(0);
  mocks.profileFindOne.mockReturnValue(
    lean({ displayName: "Green View Hostel", esewaId: "9800000000" }),
  );
});

describe("getPayInstructions", () => {
  it("returns the reference code and the amount still owed", async () => {
    const result = await getPayInstructions(invoiceId.toString(), principal);

    expect(result.referenceCode).toBe("EDU-0001-F");
    expect(result.amountDue).toBe(10000);
    expect(result.period).toBe("2026-09");
    expect(result.tier).toBe("TIER_0");
  });

  /**
   * Both of these are on the screen so the resident can check the number before
   * they send money (target §11.1). The bed type answers "is this the right
   * rent"; the credit answers "why is this less than last month". A silent null
   * on either is a support call.
   */
  it("spells out the bed type the invoice was priced at", async () => {
    mocks.invoiceFindOne.mockReturnValue(lean({ ...invoice, bedType: "TRIPLE_SHARING" }));

    expect((await getPayInstructions(invoiceId.toString(), principal)).bedLabel).toBe(
      "Triple Sharing Room",
    );
  });

  it("leaves the bed label null rather than guessing at an unpriced invoice", async () => {
    // Migrated invoices (item 2.4) carry no bed type. Inventing one here would
    // show a resident a room they are not renting.
    expect((await getPayInstructions(invoiceId.toString(), principal)).bedLabel).toBeNull();
  });

  it("reports the resident's credit balance", async () => {
    mocks.getCreditAmount.mockResolvedValue(3000);

    expect((await getPayInstructions(invoiceId.toString(), principal)).credit).toBe(3000);
  });

  it("shows the outstanding half of a part-paid invoice, not the total", async () => {
    mocks.balanceFindOne.mockReturnValue(lean({ settledAmount: 4000 }));

    // Showing 10,000 here is how a resident pays a month twice.
    expect((await getPayInstructions(invoiceId.toString(), principal)).amountDue).toBe(
      6000,
    );
  });

  it("never returns a negative amount when more was settled than billed", async () => {
    mocks.balanceFindOne.mockReturnValue(lean({ settledAmount: 15000 }));

    expect((await getPayInstructions(invoiceId.toString(), principal)).amountDue).toBe(
      0,
    );
  });

  it("orders methods QR, eSewa, Khalti, bank", async () => {
    mocks.profileFindOne.mockReturnValue(
      lean({
        bankAccountNumber: "0123456789",
        bankName: "NIC Asia",
        esewaId: "9800000000",
        khaltiId: "9811111111",
        staticQrAssetId: qrAssetId,
      }),
    );

    expect(
      (await getPayInstructions(invoiceId.toString(), principal)).methods.map(
        (method) => method.kind,
      ),
    ).toEqual(["QR", "ESEWA", "KHALTI", "BANK"]);
  });

  it("omits methods the hostel has not configured rather than showing them empty", async () => {
    mocks.profileFindOne.mockReturnValue(lean({ bankName: "NIC Asia" }));

    const result = await getPayInstructions(invoiceId.toString(), principal);

    // A bank name with no account number is not a way to be paid.
    expect(result.methods).toEqual([]);
    expect(result.usable).toBe(false);
  });

  it("reports an unconfigured hostel as unusable rather than failing", async () => {
    mocks.profileFindOne.mockReturnValue(lean(null));

    const result = await getPayInstructions(invoiceId.toString(), principal);

    expect(result.usable).toBe(false);
    expect(result.methods).toEqual([]);
    // Still returns the code and the amount: the resident can be told what they
    // owe even when they cannot yet be told where to send it.
    expect(result.referenceCode).toBe("EDU-0001-F");
  });

  it("answers NOT_FOUND for a voided invoice, same as a missing one", async () => {
    mocks.invoiceFindOne.mockReturnValue(lean({ ...invoice, status: "VOID" }));

    await expect(
      getPayInstructions(invoiceId.toString(), principal),
    ).rejects.toMatchObject({ errorCode: "INVOICE_NOT_FOUND" });
  });

  it("answers NOT_FOUND for another resident's invoice", async () => {
    mocks.invoiceFindOne.mockReturnValue(lean(null));

    await expect(
      getPayInstructions(invoiceId.toString(), principal),
    ).rejects.toMatchObject({ errorCode: "INVOICE_NOT_FOUND" });
  });

  it("scopes the lookup to the calling resident and their hostel", async () => {
    await getPayInstructions(invoiceId.toString(), principal);

    expect(mocks.invoiceFindOne.mock.calls[0][0]).toMatchObject({
      hostelId,
      residentId,
    });
  });

  it("does not invent a reference code for a migrated invoice", async () => {
    mocks.invoiceFindOne.mockReturnValue(lean({ ...invoice, referenceCode: undefined }));

    // 2.4 deliberately left migrated invoices without one: a code invented now
    // was never written on any transfer, so it could only cause false matches.
    expect(
      (await getPayInstructions(invoiceId.toString(), principal)).referenceCode,
    ).toBeNull();
  });
});

/**
 * Item 6.1: a hostel can run several checkouts at once, and the manual methods
 * stay on the screen underneath them.
 */
describe("live gateways on the pay screen", () => {
  const enabled = (provider: "ESEWA" | "FONEPAY" | "KHALTI", extra = {}) => ({
    accountKind: "MERCHANT",
    enabledAt: new Date("2026-08-01T00:00:00.000Z"),
    merchantCode: "RUPA001",
    mode: "SANDBOX",
    provider,
    ...extra,
  });

  it("leads with the checkouts and keeps the manual methods below", async () => {
    mocks.profileFindOne.mockReturnValue(
      lean({
        bankAccountNumber: "01234567890",
        gateways: [enabled("KHALTI"), enabled("ESEWA")],
        staticQrAssetId: qrAssetId,
      }),
    );

    const result = await getPayInstructions(invoiceId.toString(), principal);

    // eSewa before Khalti regardless of stored order — it is the wider-held
    // wallet, and the order is ours to choose, not the array's.
    expect(result.methods.map((method) => method.kind)).toEqual([
      "GATEWAY",
      "GATEWAY",
      "QR",
      "BANK",
    ]);
    expect(result.methods.slice(0, 2)).toMatchObject([
      { provider: "ESEWA" },
      { provider: "KHALTI" },
    ]);
    expect(result.tier).toBe("TIER_1");
  });

  /**
   * Offering "pay with eSewa" and "transfer to this eSewa id yourself" side by
   * side asks the resident to choose between two things they cannot tell apart,
   * and the manual one costs somebody a screenshot review.
   */
  it("suppresses the manual wallet id of a provider whose checkout is live", async () => {
    mocks.profileFindOne.mockReturnValue(
      lean({
        esewaId: "9800000000",
        gateways: [enabled("ESEWA")],
        khaltiId: "9811111111",
      }),
    );

    const result = await getPayInstructions(invoiceId.toString(), principal);

    expect(result.methods.map((method) => method.kind)).toEqual([
      "GATEWAY",
      "KHALTI",
    ]);
  });

  it("does not offer a gateway that was configured but never enabled", async () => {
    mocks.profileFindOne.mockReturnValue(
      lean({ esewaId: "9800000000", gateways: [enabled("ESEWA", { enabledAt: null })] }),
    );

    const result = await getPayInstructions(invoiceId.toString(), principal);

    expect(result.methods.map((method) => method.kind)).toEqual(["ESEWA"]);
    expect(result.tier).toBe("TIER_0");
  });

  /**
   * A hostel can configure a provider whose adapter has not shipped yet.
   * Offering that button hands the resident a checkout that fails after they
   * have committed to paying.
   */
  it("does not offer a provider with no adapter behind it", async () => {
    mocks.profileFindOne.mockReturnValue(
      lean({ bankAccountNumber: "01234567890", gateways: [enabled("FONEPAY")] }),
    );

    const result = await getPayInstructions(invoiceId.toString(), principal);

    expect(result.methods.map((method) => method.kind)).toEqual(["BANK"]);
  });

  it("does not offer a personal wallet as a checkout", async () => {
    mocks.profileFindOne.mockReturnValue(
      lean({ gateways: [enabled("FONEPAY", { accountKind: "PERSONAL" })] }),
    );

    const result = await getPayInstructions(invoiceId.toString(), principal);

    expect(result.methods).toEqual([]);
    expect(result.usable).toBe(false);
  });

  /**
   * A personal Fonepay QR caps at NPR 5,000 credited per day. Scanning it for a
   * 10,000 invoice fails at the network with no explanation we control, so the
   * resident is told before they try.
   */
  it("warns on a static QR backed by a personal account that cannot take the amount", async () => {
    mocks.profileFindOne.mockReturnValue(
      lean({
        bankAccountNumber: "01234567890",
        gateways: [enabled("FONEPAY", { accountKind: "PERSONAL", enabledAt: null })],
        staticQrAssetId: qrAssetId,
      }),
    );

    const result = await getPayInstructions(invoiceId.toString(), principal);
    const qr = result.methods.find((method) => method.kind === "QR");

    expect(qr).toMatchObject({ notice: expect.stringContaining("5,000") });
  });

  it("does not warn when the amount is within the daily cap", async () => {
    mocks.balanceFindOne.mockReturnValue(lean({ settledAmount: 6000 }));
    mocks.profileFindOne.mockReturnValue(
      lean({
        gateways: [enabled("FONEPAY", { accountKind: "PERSONAL", enabledAt: null })],
        staticQrAssetId: qrAssetId,
      }),
    );

    const result = await getPayInstructions(invoiceId.toString(), principal);

    // 10,000 total less 6,000 settled leaves 4,000, which fits under the cap.
    expect(result.methods.find((method) => method.kind === "QR")).toMatchObject({
      notice: null,
    });
  });

  it("does not warn on a merchant account's QR", async () => {
    mocks.profileFindOne.mockReturnValue(
      lean({ gateways: [enabled("FONEPAY")], staticQrAssetId: qrAssetId }),
    );

    const result = await getPayInstructions(invoiceId.toString(), principal);

    expect(result.methods.find((method) => method.kind === "QR")).toMatchObject({
      notice: null,
    });
  });
});

/**
 * The intake desk asks the same question from the other side of the counter:
 * a resident has just been registered, the invoices carry reference codes, and
 * the warden has to tell them where to send the money. Same method list, same
 * order — a second answer here is a warden reading out an account number the
 * resident's own screen does not show.
 */
describe("getHostelPayMethods", () => {
  it("returns the hostel's methods without needing an invoice or a resident", async () => {
    const result = await getHostelPayMethods(hostelId, 12000);

    expect(result.displayName).toBe("Green View Hostel");
    expect(result.methods).toEqual([{ kind: "ESEWA", id: "9800000000" }]);
    expect(result.usable).toBe(true);
    // The resident's own lookup is never consulted: the caller is staff.
    expect(mocks.findCurrentResident).not.toHaveBeenCalled();
  });

  it("says a hostel with no profile cannot be paid, rather than showing nothing", async () => {
    mocks.profileFindOne.mockReturnValue(lean(null));

    const result = await getHostelPayMethods(hostelId, 12000);

    expect(result.methods).toEqual([]);
    expect(result.usable).toBe(false);
  });

  it("carries the personal-wallet cap notice, judged on the amount being collected", async () => {
    mocks.profileFindOne.mockReturnValue(
      lean({
        gateways: [{ accountKind: "PERSONAL", provider: "FONEPAY" }],
        staticQrAssetId: qrAssetId,
      }),
    );

    // A joining payment is the largest single amount a resident ever transfers,
    // so this is exactly where a 5,000/day cap has to be said at the desk.
    const capped = await getHostelPayMethods(hostelId, 12000);
    const qr = capped.methods.find((method) => method.kind === "QR");

    expect(qr?.kind === "QR" && qr.notice).toContain("5,000");

    const under = await getHostelPayMethods(hostelId, 4000);
    const smallQr = under.methods.find((method) => method.kind === "QR");

    expect(smallQr?.kind === "QR" && smallQr.notice).toBeNull();
  });
});
