import { describe, expect, it } from "vitest";

import { deskMethods, unpaidMonths } from "./desk-collect";

const profile = {
  bankAccountNumber: null,
  esewaId: "9800000000",
  extraAccounts: [{ accountName: null, bankName: "NIC", kind: "BANK", number: "123" }],
  khaltiId: null,
  staticQrAssetId: null,
} as never;

describe("desk collect", () => {
  it("shows Cash plus only the methods the hostel saved", () => {
    expect(deskMethods(null)).toEqual(["CASH"]);
    expect(deskMethods(profile)).toEqual(["CASH", "ESEWA", "BANK"]);
  });

  it("lists unpaid billed months oldest first", () => {
    const month = (period: string, due: number, paid: number, invoiceId: string | null = "i") =>
      ({ dueAmount: due, invoiceId, paidAmount: paid, period }) as never;
    const ledger = { months: [month("2083-05", 100, 0), month("2083-03", 100, 100), month("2083-04", 100, 40), month("2083-06", 0, 0, null)] } as never;

    expect(unpaidMonths(ledger).map((m) => m.period)).toEqual(["2083-04", "2083-05"]);
  });
});
