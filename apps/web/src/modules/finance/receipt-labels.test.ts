import { describe, expect, it } from "vitest";

import { receiptBank, receiptCategory } from "./receipt-labels";

const none = { payee: null, remarks: null };

describe("receipt category", () => {
  it("reads the purpose a person typed in the remarks", () => {
    expect(receiptCategory("…", { payee: "Ram Shrestha", remarks: "Tarkari and chicken" })).toBe("VEGETABLES_MEAT");
    expect(receiptCategory("…", { payee: "Hari", remarks: "Cook salary Asoj" })).toBe("SALARY");
    expect(receiptCategory("…", { payee: "Landlord", remarks: "Ghar bhada" })).toBe("RENT");
  });

  it("knows billers by name anywhere on the page", () => {
    expect(receiptCategory("eSewa\nNEA Bill Payment\nAmount: 2,400", none)).toBe("ELECTRICITY");
    expect(receiptCategory("Khalti\nWorldLink Communications\nAmount: 1,500", none)).toBe("INTERNET");
    expect(receiptCategory("Fonepay\nBhat-Bhateni Supermarket\nAmount: 3,799", none)).toBe("GROCERIES");
  });

  it("does not guess from page boilerplate", () => {
    // "Utility & Bill Payment" and a service name are on most eSewa receipts.
    expect(receiptCategory("Purpose Of Payment: Utility & Bill Payment\nMerchant Name: BILL NEPAL SERVICES", { payee: "BILL NEPAL SERVICES", remarks: "Claude Pro" })).toBeNull();
    expect(receiptCategory(null, none)).toBeNull();
  });
});

describe("receipt bank", () => {
  it("names the first bank on the page", () => {
    expect(receiptBank("NIC ASIA Bank\nFund transfer to Nabil Bank A/C")).toEqual({ key: "nic-asia", name: "NIC Asia" });
    expect(receiptBank("Global IME Bank Ltd. mobile banking")).toEqual({ key: "global-ime", name: "Global IME" });
  });

  it("is null when no bank is named", () => {
    expect(receiptBank("eSewa\nPayment Successful")).toBeNull();
    expect(receiptBank(null)).toBeNull();
  });
});
