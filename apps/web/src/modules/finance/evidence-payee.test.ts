/**
 * Who received the money.
 *
 * The attack this closes: a resident sends the exact rent to a friend's wallet,
 * types the invoice's reference code in the remarks, and submits the perfectly
 * genuine receipt. Amount, transaction ID and reference code all check out,
 * because all three are true. The first test below is that scenario.
 *
 * The rest of the file is the other half of the job, and it is the larger half:
 * a wrong `FOREIGN` refuses a resident who really did pay their hostel. Every
 * shape a real receipt takes — masked account numbers, the bank's spelling of the
 * name, no payee line at all, an unconfigured hostel — has to come out `MATCHED`
 * or `UNKNOWN`.
 */
import { describe, expect, it } from "vitest";

import {
  extractPayee,
  hostelPayeeIdentity,
  payeeRefusal,
  readPayeeOnEvidence,
} from "./evidence-payee";

const identity = hostelPayeeIdentity(
  {
    bankAccountName: "SUNRISE HOSTEL PVT LTD",
    bankAccountNumber: "08010017894471",
    bankName: "Global IME Bank",
    displayName: "Sunrise Boys Hostel",
    esewaId: "9801234507",
  },
  "Sunrise Boys Hostel",
);

describe("readPayeeOnEvidence — the friend's-account payment", () => {
  const toAFriend = [
    "eSewa",
    "Payment Successful",
    "Rs. 8,500.00",
    "Transaction Code: 8823119471",
    "Sent to: Ramesh Shrestha",
    "Remarks: EDU-0002-P",
  ].join("\n");

  it("reads the payee as foreign even though every other field is genuine", () => {
    const read = readPayeeOnEvidence(toAFriend, identity);

    expect(read.verdict).toBe("FOREIGN");
    expect(read.payeeOnEvidence).toBe("Ramesh Shrestha");
  });

  it("refuses it, naming the account the receipt actually shows", () => {
    const refusal = payeeRefusal(readPayeeOnEvidence(toAFriend, identity));

    expect(refusal).toContain("Ramesh Shrestha");
    expect(refusal).toMatch(/not an account this hostel collects payments in/);
  });

  it("is not fooled by the reference code being correct", () => {
    // The whole point: the code is the payer's to type, so it must carry no
    // weight at all in this verdict.
    expect(readPayeeOnEvidence(toAFriend, identity).matchedOn).toBeNull();
  });
});

describe("readPayeeOnEvidence — the receipts that must get through", () => {
  it("matches on a distinctive name token, however the provider spells the rest", () => {
    const read = readPayeeOnEvidence(
      ["eSewa", "Rs. 8,500.00", "Sent to: SUNRISE HOSTEL PVT. LTD."].join("\n"),
      identity,
    );

    expect(read.verdict).toBe("MATCHED");
    expect(read.matchedOn).toBeTruthy();
  });

  it("matches on a masked wallet number when the name is spelled unrecognisably", () => {
    const read = readPayeeOnEvidence(
      ["eSewa", "Rs. 8,500.00", "Sent to: SUNRAISE BOYZ", "98XXXXXX07", "9801234507"].join("\n"),
      identity,
    );

    expect(read.verdict).toBe("MATCHED");
    expect(read.matchedOn).toBe("9801234507");
  });

  it("matches a bank account number printed with separators", () => {
    const read = readPayeeOnEvidence(
      ["Global IME Bank", "Credited to: A/C 0801-0017-8944-71", "NPR 8,500.00"].join("\n"),
      identity,
    );

    expect(read.verdict).toBe("MATCHED");
  });

  it("stays UNKNOWN when the receipt prints no payee at all", () => {
    const read = readPayeeOnEvidence(
      ["Khalti", "Payment Successful", "Rs. 8,500.00", "Transaction ID: 8823119471"].join("\n"),
      identity,
    );

    expect(read.verdict).toBe("UNKNOWN");
    expect(payeeRefusal(read)).toBeNull();
  });

  it("stays UNKNOWN for a hostel that has not filled in its payment profile", () => {
    const unconfigured = hostelPayeeIdentity(null, null);
    const read = readPayeeOnEvidence(
      ["eSewa", "Sent to: Ramesh Shrestha", "Rs. 8,500.00"].join("\n"),
      unconfigured,
    );

    expect(read.verdict).toBe("UNKNOWN");
    expect(payeeRefusal(read)).toBeNull();
  });

  it("stays UNKNOWN when the payee line holds only an account number", () => {
    const read = readPayeeOnEvidence(
      ["Fonepay", "Sent to: 1234567890123", "NPR 8,500.00"].join("\n"),
      identity,
    );

    expect(read.verdict).toBe("UNKNOWN");
  });

  it("does not read the sender's line as the payee", () => {
    // `From` names the resident. Matching the hostel against it would produce a
    // mismatch on every genuine claim.
    const read = readPayeeOnEvidence(
      ["eSewa", "From: Suman Tamang", "Debited from: 9807777777", "Rs. 8,500.00"].join("\n"),
      identity,
    );

    expect(read.payeeOnEvidence).toBeNull();
    expect(read.verdict).toBe("UNKNOWN");
  });
});

describe("readPayeeOnEvidence — receipts laid out as a table", () => {
  /** A real Everest Bank QR receipt: two columns, no punctuation between them. */
  const eblQrReceipt = [
    "EBL EVEREST BANK",
    "Payment Receipt",
    "Reference Code 111903076",
    "Channel Online",
    "Payment Attribute 2222090020887310/chitya/194011457u4T/TEA TIME ANYTIME CAFETERIA",
    "Amount (NPR) 70.00",
    "Initiator 9709155982",
    "Qr Merchant Name TEA TIME ANYTIME CAFETERIA",
    "Remarks chitya",
    "Status SUCCESS",
  ].join("\n");

  it("reads the merchant out of a table cell with no colon", () => {
    // The layout that made the payee invisible: recognised, a two-column table
    // separates label from value with spaces or a line break, never the colon
    // the punctuated pattern needs.
    expect(extractPayee(eblQrReceipt)).toBe("TEA TIME ANYTIME CAFETERIA");
  });

  it("refuses it as a payment to somebody who is not the hostel", () => {
    const read = readPayeeOnEvidence(eblQrReceipt, identity);

    expect(read.verdict).toBe("FOREIGN");
    expect(payeeRefusal(read)).toContain("TEA TIME ANYTIME CAFETERIA");
  });

  it("reads a value that wrapped onto the next line", () => {
    expect(
      extractPayee(["Global IME Bank", "Beneficiary Name", "SUNRISE HOSTEL PVT LTD"].join("\n")),
    ).toBe("SUNRISE HOSTEL PVT LTD");
  });

  it("matches the hostel through the same tabular layout", () => {
    const read = readPayeeOnEvidence(
      [
        "EBL EVEREST BANK",
        "Qr Merchant Name SUNRISE BOYS HOSTEL",
        "Amount (NPR) 8500",
      ].join("\n"),
      identity,
    );

    expect(read.verdict).toBe("MATCHED");
  });

  it("does not read a bare `to` without a colon to anchor it", () => {
    // Unanchored, `to` matches the middle of any sentence on the page — and a
    // payee read off a footer can refuse a resident who really paid.
    expect(
      extractPayee(["Khalti", "Thank you for choosing to pay with us", "Rs. 8,500"].join("\n")),
    ).toBeNull();
  });
});

describe("hostelPayeeIdentity — what counts as an identifier", () => {
  /**
   * The QR-only hostel, which is the common one. It typed nothing: the name and
   * number were read off the poster it uploaded. Without these in the identity
   * such a hostel gets `UNKNOWN` on every claim it ever receives, which is the
   * whole check switched off for the hostels least likely to notice.
   */
  it("counts what was read off the hostel's own QR poster", () => {
    const qrOnly = hostelPayeeIdentity(
      { qrPayeeName: "GREEN VIEW HOSTEL", qrPayeeNumber: "9801234567" },
      "Green View Hostel",
    );

    expect(qrOnly.accountIds).toContain("9801234567");

    const read = readPayeeOnEvidence(
      ["eSewa", "Sent to: GREEN VIEW HOSTEL", "9801234567", "Rs. 8,500.00"].join("\n"),
      qrOnly,
    );

    expect(read.verdict).toBe("MATCHED");
  });

  it("does not treat the bank's own name as a payee name", () => {
    // Otherwise every receipt drawn on Global IME matches this hostel.
    expect(identity.names).not.toContain("Global IME Bank");
  });

  it("drops identifiers too short to identify anyone", () => {
    const thin = hostelPayeeIdentity({ esewaId: "12345" }, null);

    expect(thin.accountIds).toEqual([]);
  });

  it("refuses to match on a shared generic token alone", () => {
    // `Himalaya Boys Hostel` shares `BOYS` and `HOSTEL` with our name and
    // nothing else. If those counted, the check would pass for any hostel.
    const read = readPayeeOnEvidence(
      ["eSewa", "Sent to: Himalaya Boys Hostel", "Rs. 8,500.00"].join("\n"),
      identity,
    );

    expect(read.verdict).toBe("FOREIGN");
  });
});

describe("extractPayee — the label forms receipts actually use", () => {
  it.each([
    ["Sent to: Sunrise Boys Hostel", "Sunrise Boys Hostel"],
    ["Paid to: Sunrise Boys Hostel", "Sunrise Boys Hostel"],
    ["Beneficiary Name: Sunrise Boys Hostel", "Sunrise Boys Hostel"],
    ["Receiver's Name : Sunrise Boys Hostel", "Sunrise Boys Hostel"],
    ["Credited to - Sunrise Boys Hostel", "Sunrise Boys Hostel"],
    ["Merchant: Sunrise Boys Hostel", "Sunrise Boys Hostel"],
    ["To: Sunrise Boys Hostel", "Sunrise Boys Hostel"],
  ])("reads %s", (line, expected) => {
    expect(extractPayee(`eSewa\n${line}\nRs. 8,500.00`)).toBe(expected);
  });

  it("strips trailing punctuation but keeps a trailing account number", () => {
    expect(extractPayee("eSewa\nSent to: Sunrise Hostel (9801234507).\n")).toBe(
      "Sunrise Hostel (9801234507)",
    );
  });
});

describe("hostelPayeeIdentity — extra accounts", () => {
  it("counts a second bank's number and holder as the hostel's own", () => {
    const withSecondBank = hostelPayeeIdentity({
      bankAccountNumber: "08010017894471",
      extraAccounts: [{ accountName: "Ram Bahadur Karki", number: "0123-4567-8901" }],
    });

    expect(withSecondBank.accountIds).toContain("012345678901");
    expect(withSecondBank.names).toContain("Ram Bahadur Karki");
  });
});
